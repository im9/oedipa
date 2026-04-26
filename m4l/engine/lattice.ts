// Tonnetz lattice geometry for Oedipa.
// Spec: docs/ai/adr/003-m4l-parameters-state.md "Lattice UI — interaction model"
//
// Pure logic, no jsui or Max APIs — runs in Node.js for tests and is bundled
// into dist/ for [node.script]/jsui consumption.
//
// The lattice is a (cols × rows) vertex grid; each parallelogram cell at (r, c)
// holds one major triangle and one minor triangle sharing a diagonal edge.
// Pitch class at vertex (row, col):
//
//   noteAt(row, col) = (centerPc + (col - cc) * 7 + (row - cr) * 4)  mod 12
//
// where (cr, cc) is the center vertex (rows/2, cols/2 floored).

import { buildTriad, identifyTriad, type MidiNote, type PitchClass, type Triad } from './tonnetz.ts'

export type TriangleKind = 'major' | 'minor'

export interface LatticeConfig {
  cols: number
  rows: number
  centerPc: PitchClass
}

export interface TriangleCell {
  row: number
  col: number
  kind: TriangleKind
}

export interface LatticeLayout {
  triW: number
  triH: number
  offsetX: number
  offsetY: number
}

// Padding around the lattice within its host box. Mirrored in
// host/lattice-renderer.js (paint()). Kept as exports so tests can derive the
// expected offsets without redefining the constants.
export const LATTICE_PAD_X = 4
export const LATTICE_PAD_Y = 4

const SQRT3_OVER_2 = Math.sqrt(3) / 2

function mod12(n: number): PitchClass {
  return ((n % 12) + 12) % 12
}

function centerVertex(config: LatticeConfig): { cr: number; cc: number } {
  return { cr: Math.floor(config.rows / 2), cc: Math.floor(config.cols / 2) }
}

export function noteAt(row: number, col: number, config: LatticeConfig): PitchClass {
  const { cr, cc } = centerVertex(config)
  return mod12(config.centerPc + (col - cc) * 7 + (row - cr) * 4)
}

export function trianglePcs(
  cell: TriangleCell,
  config: LatticeConfig,
): readonly [PitchClass, PitchClass, PitchClass] {
  const { row: r, col: c, kind } = cell
  if (kind === 'major') {
    return [noteAt(r, c, config), noteAt(r, c + 1, config), noteAt(r + 1, c, config)]
  }
  return [noteAt(r + 1, c, config), noteAt(r + 1, c + 1, config), noteAt(r, c + 1, config)]
}

export function viewportCells(config: LatticeConfig): TriangleCell[] {
  const cells: TriangleCell[] = []
  for (let r = 0; r < config.rows - 1; r++) {
    for (let c = 0; c < config.cols - 1; c++) {
      cells.push({ row: r, col: c, kind: 'major' })
      cells.push({ row: r, col: c, kind: 'minor' })
    }
  }
  return cells
}

export function computeLayout(boxW: number, boxH: number, config: LatticeConfig): LatticeLayout {
  const spanX = (config.cols - 1) + (config.rows - 1) * 0.5
  const spanY = (config.rows - 1)
  const triW = Math.min(
    (boxW - 2 * LATTICE_PAD_X) / spanX,
    (boxH - 2 * LATTICE_PAD_Y) / spanY / SQRT3_OVER_2,
  )
  const triH = triW * SQRT3_OVER_2
  return {
    triW,
    triH,
    offsetX: (boxW - spanX * triW) / 2,
    offsetY: (boxH - spanY * triH) / 2,
  }
}

export function pointToCell(
  px: number,
  py: number,
  layout: LatticeLayout,
  config: LatticeConfig,
): TriangleCell | null {
  // Invert the renderer's vertex transform:
  //   px = offsetX + col*triW + row*triW*0.5
  //   py = offsetY + row*triH
  const rowF = (py - layout.offsetY) / layout.triH
  const colF = (px - layout.offsetX - rowF * layout.triW * 0.5) / layout.triW
  const r = Math.floor(rowF)
  const c = Math.floor(colF)
  if (r < 0 || r >= config.rows - 1) return null
  if (c < 0 || c >= config.cols - 1) return null
  // Within a parallelogram cell, the diagonal from (r, c+1) to (r+1, c)
  // splits it; (fc + fr < 1) is the upper-left major half.
  const fr = rowF - r
  const fc = colF - c
  return { row: r, col: c, kind: fc + fr < 1 ? 'major' : 'minor' }
}

export function cellToTriad(
  cell: TriangleCell,
  config: LatticeConfig,
  reference: MidiNote = 60,
): Triad {
  const [a, b, c] = trianglePcs(cell, config)
  const { rootPc, quality } = identifyTriad([a, b, c] as Triad)
  return buildTriad(rootPc, quality, reference)
}

export function findTriadCell(triad: Triad, config: LatticeConfig): TriangleCell | null {
  const { rootPc, quality } = identifyTriad(triad)
  const targetKind: TriangleKind = quality
  const targetPcs = new Set(triad.map(mod12))
  for (const cell of viewportCells(config)) {
    if (cell.kind !== targetKind) continue
    const cellPcs = trianglePcs(cell, config)
    if (cellPcs.every(pc => targetPcs.has(pc))) {
      // sanity: ensure root pc is present (guards against accidental matches
      // from incomplete pc sets — every triad has 3 distinct pcs)
      if (cellPcs.includes(rootPc)) return cell
    }
  }
  return null
}
