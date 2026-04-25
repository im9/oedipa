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

import { identifyTriad, type PitchClass, type Triad } from './tonnetz.ts'

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
