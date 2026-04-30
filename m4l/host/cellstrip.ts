// Cell-strip jsui pure logic — ADR 006 §Phase 7 Step 3.
//
// Per-cell direct dropdown model (ported from inboil's TonnetzSheet.svelte
// `seq-pills`): each cell is its own selector. Click a cell → an in-jsui
// popup opens above it showing the 5 ops (P / L / R / hold / rest); click
// an option → cell op set + popup closes; click outside → popup closes.
// No global "selected tool" state. `[-]` / `[+]` adjust length 1..8 inline
// at the right edge of the pill row.
//
// Pure logic, no jsui or Max APIs — runs in Node.js for tests and is
// mirrored byte-for-byte in cellstrip-renderer.js (ES5/ASCII for Max's
// classic JS parser).

import type { Op } from '../engine/tonnetz.ts'

// Ordered list of selectable ops. Index doubles as the wire-format opCode
// used by host.ts RANDOM_OPS / bridge slot-cell-op so the patcher can
// route ints without symbol conversion.
export const OPS: readonly Op[] = ['P', 'L', 'R', 'hold', 'rest']

export const MIN_LENGTH = 1
export const MAX_LENGTH = 8

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface StripLayout {
  cells: Rect[]
  decBtn: Rect
  incBtn: Rect
}

export interface PopupOption extends Rect {
  op: Op
}

export type StripHit =
  | { kind: 'cell'; idx: number }
  | { kind: 'decLength' }
  | { kind: 'incLength' }
  | null

// Layout constants. The strip is a single row of pills bottom-aligned in
// the box; the empty space above is reserved for the popup. The Live
// device strip vertical budget (~66px between Slot labels above and
// Seed/Jitter below) doesn't fit a 5-tall vertical popup column at
// readable per-option height — so the popup is a HORIZONTAL row of 5
// option buttons above the strip, anchored to the clicked cell. The
// "modal feel" comes from highlighting the source cell while the popup
// is open, not from positional adjacency at the cell's exact column.
const PAD = 2
const STRIP_H = 22
const BTN_W = 18
const POPUP_OPT_W = 22
const POPUP_OPT_H = 22
const POPUP_GAP = 2

export function clampLength(n: number): number {
  if (!Number.isFinite(n)) return MIN_LENGTH
  const r = Math.round(n)
  if (r < MIN_LENGTH) return MIN_LENGTH
  if (r > MAX_LENGTH) return MAX_LENGTH
  return r
}

export function computeStripLayout(boxW: number, boxH: number, length: number): StripLayout {
  const len = clampLength(length)

  // Bottom-aligned strip: stripY = box bottom - strip - 1px padding.
  // This gives the popup the entire upper region of the box to expand into.
  const stripY = Math.max(0, boxH - STRIP_H - PAD)
  const cellAvailableW = Math.max(1, boxW - 2 * PAD - 2 * BTN_W - 2)
  const cellW = cellAvailableW / len
  const cells: Rect[] = []
  for (let i = 0; i < len; i++) {
    cells.push({
      x: PAD + i * cellW,
      y: stripY,
      w: cellW - 1,
      h: STRIP_H,
    })
  }
  const decBtn: Rect = {
    x: PAD + cellAvailableW + 1,
    y: stripY,
    w: BTN_W,
    h: STRIP_H,
  }
  const incBtn: Rect = {
    x: decBtn.x + BTN_W + 1,
    y: stripY,
    w: BTN_W,
    h: STRIP_H,
  }
  return { cells, decBtn, incBtn }
}

// Popup layout: a horizontal row of opCount option buttons above the
// strip, centered horizontally on the clicked cell's center, clamped so
// the popup stays within the box. Vertical position: directly above the
// strip with a small gap.
//
// Width = ops.length * POPUP_OPT_W; if the box is narrower than that the
// popup just left-aligns to PAD (clamping degenerates). Caller is
// responsible for the box being at least POPUP_OPT_H + STRIP_H + 2*PAD
// tall; otherwise the popup row will overlap the strip vertically.
export function computePopupLayout(boxW: number, boxH: number, cellRect: Rect, ops: readonly Op[] = OPS): PopupOption[] {
  const totalW = ops.length * POPUP_OPT_W
  const cellCenterX = cellRect.x + cellRect.w / 2
  let leftX = cellCenterX - totalW / 2
  // Clamp horizontally so the entire popup stays within [PAD, boxW - PAD].
  if (leftX < PAD) leftX = PAD
  if (leftX + totalW > boxW - PAD) leftX = boxW - PAD - totalW
  // Vertical: directly above the strip with POPUP_GAP between.
  const popupY = cellRect.y - POPUP_GAP - POPUP_OPT_H
  const result: PopupOption[] = []
  for (let i = 0; i < ops.length; i++) {
    result.push({
      x: leftX + i * POPUP_OPT_W,
      y: popupY,
      w: POPUP_OPT_W - 1,
      h: POPUP_OPT_H,
      op: ops[i]!,
    })
  }
  return result
}

function inside(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}

export function hitStrip(x: number, y: number, layout: StripLayout): StripHit {
  for (let i = 0; i < layout.cells.length; i++) {
    if (inside(x, y, layout.cells[i]!)) return { kind: 'cell', idx: i }
  }
  if (inside(x, y, layout.decBtn)) return { kind: 'decLength' }
  if (inside(x, y, layout.incBtn)) return { kind: 'incLength' }
  return null
}

export function hitPopup(x: number, y: number, popup: PopupOption[]): { kind: 'popupOption'; op: Op } | null {
  for (let i = 0; i < popup.length; i++) {
    if (inside(x, y, popup[i]!)) return { kind: 'popupOption', op: popup[i]!.op }
  }
  return null
}
