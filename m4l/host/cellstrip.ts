// Cell-strip jsui pure logic — ADR 006 §Phase 7 Step 3.
//
// Direct-select op palette (P / L / R / hold / rest) above a variable-length
// cell row (1..8). Click a palette entry to set selectedOp; click a cell to
// emit (idx, op); click [-]/[+] to change length. Press-to-cycle is rejected
// (memory: feedback_avoid_cycle_press) — every reachable state must be
// visible.
//
// Pure logic, no jsui or Max APIs — runs in Node.js for tests and is bundled
// into dist/ for the jsui wrapper to import via the host bundle.

import type { Op } from '../engine/tonnetz.ts'

export const PALETTE_OPS: readonly Op[] = ['P', 'L', 'R', 'hold', 'rest']

export const MIN_LENGTH = 1
export const MAX_LENGTH = 8

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface PaletteEntry extends Rect {
  op: Op
}

export interface CellStripLayout {
  paletteCells: PaletteEntry[]
  cells: Rect[]
  decBtn: Rect
  incBtn: Rect
}

export type Hit =
  | { kind: 'palette'; op: Op }
  | { kind: 'cell'; idx: number }
  | { kind: 'decLength' }
  | { kind: 'incLength' }
  | null

const PAD = 2
const ROW_GAP = 2
const PALETTE_H = 22
const CELL_H = 22
const PALETTE_W_PER = 24
const BTN_W = 18

export function clampLength(n: number): number {
  if (!Number.isFinite(n)) return MIN_LENGTH
  const r = Math.round(n)
  if (r < MIN_LENGTH) return MIN_LENGTH
  if (r > MAX_LENGTH) return MAX_LENGTH
  return r
}

export function computeLayout(boxW: number, boxH: number, length: number): CellStripLayout {
  const len = clampLength(length)

  const paletteY = PAD
  const paletteCells: PaletteEntry[] = []
  for (let i = 0; i < PALETTE_OPS.length; i++) {
    paletteCells.push({
      x: PAD + i * PALETTE_W_PER,
      y: paletteY,
      w: PALETTE_W_PER - 1,
      h: PALETTE_H,
      op: PALETTE_OPS[i]!,
    })
  }

  const cellY = paletteY + PALETTE_H + ROW_GAP
  const cellAvailableW = Math.max(1, boxW - 2 * PAD - 2 * BTN_W - 2)
  const cellW = cellAvailableW / len
  const cells: Rect[] = []
  for (let i = 0; i < len; i++) {
    cells.push({
      x: PAD + i * cellW,
      y: cellY,
      w: cellW - 1,
      h: CELL_H,
    })
  }

  const decBtn: Rect = {
    x: PAD + cellAvailableW + 1,
    y: cellY,
    w: BTN_W,
    h: CELL_H,
  }
  const incBtn: Rect = {
    x: decBtn.x + BTN_W + 1,
    y: cellY,
    w: BTN_W,
    h: CELL_H,
  }

  return { paletteCells, cells, decBtn, incBtn }
}

function inside(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}

export function hitTest(x: number, y: number, layout: CellStripLayout): Hit {
  for (const p of layout.paletteCells) {
    if (inside(x, y, p)) return { kind: 'palette', op: p.op }
  }
  for (let i = 0; i < layout.cells.length; i++) {
    if (inside(x, y, layout.cells[i]!)) return { kind: 'cell', idx: i }
  }
  if (inside(x, y, layout.decBtn)) return { kind: 'decLength' }
  if (inside(x, y, layout.incBtn)) return { kind: 'incLength' }
  return null
}
