import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampLength,
  computePopupLayout,
  computeStripLayout,
  hitPopup,
  hitStrip,
  MAX_LENGTH,
  MIN_LENGTH,
  OPS,
} from './cellstrip.ts'

test('OPS is the canonical 5-op order', () => {
  // Per ADR 006 §Phase 7 Step 3 (post-redesign): no global tool palette,
  // each cell shows a popup of the 5 ops. OPS index doubles as the
  // wire-format opCode used by host.ts RANDOM_OPS so slot-cell-op ints
  // round-trip without conversion.
  assert.deepEqual(OPS, ['P', 'L', 'R', 'hold', 'rest'])
})

test('clampLength clamps to [MIN_LENGTH, MAX_LENGTH]', () => {
  // Spec: variable length 1..8 (ADR 006 §Phase 7).
  assert.equal(MIN_LENGTH, 1)
  assert.equal(MAX_LENGTH, 8)
  assert.equal(clampLength(0), MIN_LENGTH)
  assert.equal(clampLength(-5), MIN_LENGTH)
  assert.equal(clampLength(9), MAX_LENGTH)
  assert.equal(clampLength(100), MAX_LENGTH)
  assert.equal(clampLength(4), 4)
})

test('clampLength rounds non-integer input to nearest integer', () => {
  // M4L pipes numbers as floats; jsui receives e.g. 4.0 from a live.numbox.
  // Round to integer before clamping so a numeric noise of ±0.4 doesn't
  // demote the length.
  assert.equal(clampLength(3.4), 3)
  assert.equal(clampLength(3.6), 4)
})

test('clampLength treats non-finite input as MIN_LENGTH', () => {
  // NaN / Infinity from a malformed Max message should not propagate; default
  // to the minimum legal length so the strip still has at least one cell.
  assert.equal(clampLength(Number.NaN), MIN_LENGTH)
  assert.equal(clampLength(Number.POSITIVE_INFINITY), MIN_LENGTH)
  assert.equal(clampLength(Number.NEGATIVE_INFINITY), MIN_LENGTH)
})

test('computeStripLayout returns exactly `length` cells', () => {
  for (const len of [1, 2, 4, 8]) {
    const layout = computeStripLayout(400, 100, len)
    assert.equal(layout.cells.length, len, `length=${len}`)
  }
})

test('computeStripLayout clamps out-of-range length', () => {
  // length=12 should produce 8 cells (clamped). length=0 produces 1 cell.
  assert.equal(computeStripLayout(400, 100, 12).cells.length, MAX_LENGTH)
  assert.equal(computeStripLayout(400, 100, 0).cells.length, MIN_LENGTH)
})

test('computeStripLayout cells fill available width without overlap', () => {
  // Cells partition the available row width equally so the user sees
  // length-vs-bars proportionality at a glance.
  const layout = computeStripLayout(400, 100, 4)
  const widths = layout.cells.map((c) => c.w)
  for (const w of widths) {
    // Equal-width within rounding noise (we use floats; tolerate 0.5px).
    assert.ok(Math.abs(w - widths[0]!) < 0.5, `widths=${widths}`)
  }
  let prevRight = -Infinity
  for (const c of layout.cells) {
    assert.ok(c.w > 0 && c.h > 0, `cell w=${c.w} h=${c.h}`)
    assert.ok(c.x >= prevRight, `cell x=${c.x} overlaps prev right=${prevRight}`)
    prevRight = c.x + c.w
  }
})

test('computeStripLayout has positive-area dec and inc buttons', () => {
  const layout = computeStripLayout(400, 100, 4)
  assert.ok(layout.decBtn.w > 0 && layout.decBtn.h > 0)
  assert.ok(layout.incBtn.w > 0 && layout.incBtn.h > 0)
})

test('computeStripLayout strip is bottom-aligned in the box', () => {
  // The strip must sit at the bottom of the jsui's box rect so the empty
  // upper region holds the popup. Without bottom-alignment the popup
  // either overflows above the box or drops into a non-existent area.
  const boxH = 100
  const layout = computeStripLayout(400, boxH, 4)
  // strip bottom edge should be near boxH (within PAD=2).
  const stripBottom = layout.cells[0]!.y + layout.cells[0]!.h
  assert.ok(stripBottom <= boxH, `stripBottom=${stripBottom} > boxH=${boxH}`)
  assert.ok(stripBottom >= boxH - 4, `stripBottom=${stripBottom} too far above boxH=${boxH}`)
})

test('hitStrip returns cell idx for click on a cell', () => {
  const layout = computeStripLayout(400, 100, 6)
  for (let i = 0; i < layout.cells.length; i++) {
    const c = layout.cells[i]!
    const cx = c.x + c.w / 2
    const cy = c.y + c.h / 2
    assert.deepEqual(hitStrip(cx, cy, layout), { kind: 'cell', idx: i })
  }
})

test('hitStrip returns incLength / decLength for the buttons', () => {
  const layout = computeStripLayout(400, 100, 4)
  const dx = layout.decBtn.x + layout.decBtn.w / 2
  const dy = layout.decBtn.y + layout.decBtn.h / 2
  assert.deepEqual(hitStrip(dx, dy, layout), { kind: 'decLength' })
  const ix = layout.incBtn.x + layout.incBtn.w / 2
  const iy = layout.incBtn.y + layout.incBtn.h / 2
  assert.deepEqual(hitStrip(ix, iy, layout), { kind: 'incLength' })
})

test('hitStrip returns null outside all regions', () => {
  const layout = computeStripLayout(400, 100, 4)
  assert.equal(hitStrip(-50, -50, layout), null)
  assert.equal(hitStrip(10_000, 10_000, layout), null)
})

test('hitStrip does not register cell hits past `length`', () => {
  // length=2: only two cell rectangles exist; clicks past them must NOT
  // return a phantom cell idx >= 2. They may return decLength (when the
  // x falls inside the dec button's column) or null otherwise.
  const layout = computeStripLayout(400, 100, 2)
  const cellsRight = layout.cells[1]!.x + layout.cells[1]!.w
  const decLeft = layout.decBtn.x
  const yMid = layout.cells[0]!.y + layout.cells[0]!.h / 2
  for (let x = cellsRight + 1; x < decLeft; x += 1) {
    const hit = hitStrip(x, yMid, layout)
    if (hit && hit.kind === 'cell') {
      assert.fail(`phantom cell hit at x=${x}, idx=${hit.idx}, length=2`)
    }
  }
})

test('hitStrip cell idx 0 is stable across length values', () => {
  // Increasing length must not invalidate cell idx 0 click semantics —
  // cell 0 is always the leftmost cell. Guards against off-by-one in
  // the layout when length changes.
  for (const len of [1, 2, 4, 8]) {
    const layout = computeStripLayout(400, 100, len)
    const c0 = layout.cells[0]!
    const hit = hitStrip(c0.x + 1, c0.y + 1, layout)
    assert.deepEqual(hit, { kind: 'cell', idx: 0 }, `length=${len}`)
  }
})

test('computePopupLayout returns one entry per op in canonical order', () => {
  // Popup options are arranged horizontally above the strip. Order matches
  // OPS left-to-right so the user reads P/L/R/hold/rest left→right.
  const cell = { x: 100, y: 80, w: 30, h: 22 }
  const popup = computePopupLayout(234, 66, cell)
  assert.equal(popup.length, OPS.length)
  for (let i = 0; i < popup.length; i++) {
    assert.equal(popup[i]!.op, OPS[i]!, `idx=${i}`)
  }
})

test('computePopupLayout sits above the cell with no overlap', () => {
  // The popup row's bottom edge must clear the cell's top edge so the
  // user perceives "popup above, source cell below".
  const cell = { x: 100, y: 80, w: 30, h: 22 }
  const popup = computePopupLayout(234, 66, cell)
  for (const opt of popup) {
    assert.ok(opt.y + opt.h <= cell.y, `opt bottom ${opt.y + opt.h} overlaps cell top ${cell.y}`)
  }
})

test('computePopupLayout options share a row (same y, ascending x)', () => {
  // Horizontal layout: one row, all options at the same y, x increases
  // strictly with i so the visual order matches OPS.
  const cell = { x: 100, y: 80, w: 30, h: 22 }
  const popup = computePopupLayout(234, 66, cell)
  const y0 = popup[0]!.y
  let prevRight = -Infinity
  for (const opt of popup) {
    assert.equal(opt.y, y0, 'options must all be at the same y')
    assert.ok(opt.w > 0 && opt.h > 0, `opt w=${opt.w} h=${opt.h}`)
    assert.ok(opt.x >= prevRight, `opt x=${opt.x} overlaps prev right=${prevRight}`)
    prevRight = opt.x + opt.w
  }
})

test('computePopupLayout centers on the cell when there is room', () => {
  // The popup row's horizontal center should track the cell's center so
  // the source-of-popup is visually adjacent. Tolerance: half an option
  // width (rounding from option-grid step).
  const cell = { x: 100, y: 80, w: 30, h: 22 }
  const boxW = 234
  const popup = computePopupLayout(boxW, 66, cell)
  const popupLeft = popup[0]!.x
  const popupRight = popup[popup.length - 1]!.x + popup[popup.length - 1]!.w
  const popupCenter = (popupLeft + popupRight) / 2
  const cellCenter = cell.x + cell.w / 2
  assert.ok(Math.abs(popupCenter - cellCenter) < 12,
    `popup center=${popupCenter} vs cell center=${cellCenter}`)
})

test('computePopupLayout clamps to box when cell is near the right edge', () => {
  // Cell at the rightmost cell position (length=4 on boxW=234): popup
  // can't extend past the box right edge. Clamp must keep the entire
  // popup visible.
  const layout = computeStripLayout(234, 66, 4)
  const lastCell = layout.cells[layout.cells.length - 1]!
  const popup = computePopupLayout(234, 66, lastCell)
  const lastOpt = popup[popup.length - 1]!
  assert.ok(lastOpt.x + lastOpt.w <= 234,
    `popup right edge ${lastOpt.x + lastOpt.w} > boxW=234`)
})

test('computePopupLayout clamps to box when cell is near the left edge', () => {
  // Symmetric clamp on the left: popup left edge must not go negative.
  const layout = computeStripLayout(234, 66, 4)
  const firstCell = layout.cells[0]!
  const popup = computePopupLayout(234, 66, firstCell)
  assert.ok(popup[0]!.x >= 0, `popup left edge ${popup[0]!.x} < 0`)
})

test('hitPopup returns the op for a click inside an option', () => {
  const cell = { x: 100, y: 80, w: 30, h: 22 }
  const popup = computePopupLayout(234, 66, cell)
  for (const opt of popup) {
    const cx = opt.x + opt.w / 2
    const cy = opt.y + opt.h / 2
    assert.deepEqual(hitPopup(cx, cy, popup), { kind: 'popupOption', op: opt.op })
  }
})

test('hitPopup returns null outside all options', () => {
  const cell = { x: 100, y: 80, w: 30, h: 22 }
  const popup = computePopupLayout(234, 66, cell)
  // Far above the popup row.
  assert.equal(hitPopup(popup[0]!.x + 1, popup[0]!.y - 100, popup), null)
  // Inside the cell itself (below the popup) — must not register as an option.
  assert.equal(hitPopup(cell.x + cell.w / 2, cell.y + cell.h / 2, popup), null)
  // Far to the side, well past the popup row.
  const lastOpt = popup[popup.length - 1]!
  assert.equal(hitPopup(lastOpt.x + lastOpt.w + 1000, lastOpt.y, popup), null)
})
