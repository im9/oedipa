import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampLength,
  computeLayout,
  hitTest,
  MAX_LENGTH,
  MIN_LENGTH,
  PALETTE_OPS,
} from './cellstrip.ts'

test('PALETTE_OPS is the canonical 5-op order', () => {
  // Per ADR 006 §Phase 7 Step 3: direct-select palette in canonical order
  // (P / L / R / hold / rest). Index 0..4 is the visual left-to-right order.
  assert.deepEqual(PALETTE_OPS, ['P', 'L', 'R', 'hold', 'rest'])
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

test('computeLayout returns 5 palette entries in canonical order', () => {
  const layout = computeLayout(400, 50, 4)
  assert.equal(layout.paletteCells.length, 5)
  for (let i = 0; i < 5; i++) {
    assert.equal(layout.paletteCells[i]!.op, PALETTE_OPS[i])
  }
})

test('computeLayout palette entries do not overlap and have positive size', () => {
  const layout = computeLayout(400, 50, 4)
  let prevRight = -Infinity
  for (const p of layout.paletteCells) {
    // Positive-area assertion catches "0-width palette buttons" regressions.
    assert.ok(p.w > 0 && p.h > 0, `palette ${p.op}: w=${p.w} h=${p.h}`)
    // Strict left-to-right order: each entry starts at or after the previous
    // entry's right edge so the user can read P→L→R→hold→rest left-to-right.
    assert.ok(p.x >= prevRight, `palette ${p.op}: x=${p.x} < prevRight=${prevRight}`)
    prevRight = p.x + p.w
  }
})

test('computeLayout returns exactly `length` cells', () => {
  for (const len of [1, 2, 4, 8]) {
    const layout = computeLayout(400, 50, len)
    assert.equal(layout.cells.length, len, `length=${len}`)
  }
})

test('computeLayout clamps out-of-range length', () => {
  // length=12 should produce 8 cells (clamped). length=0 produces 1 cell.
  assert.equal(computeLayout(400, 50, 12).cells.length, MAX_LENGTH)
  assert.equal(computeLayout(400, 50, 0).cells.length, MIN_LENGTH)
})

test('computeLayout cells fill available cell-row width without overlap', () => {
  // Cells partition the available cell-row width equally so the user can
  // see length-vs-bars proportionality at a glance.
  const layout = computeLayout(400, 50, 4)
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

test('computeLayout has positive-area dec and inc buttons', () => {
  const layout = computeLayout(400, 50, 4)
  assert.ok(layout.decBtn.w > 0 && layout.decBtn.h > 0)
  assert.ok(layout.incBtn.w > 0 && layout.incBtn.h > 0)
})

test('computeLayout palette row sits above cell row', () => {
  // Conceptual hierarchy → visual hierarchy (memory: holistic UI design).
  // Tool palette (parent control) above the cell canvas (target).
  const layout = computeLayout(400, 50, 4)
  const paletteBottom = layout.paletteCells[0]!.y + layout.paletteCells[0]!.h
  const cellTop = layout.cells[0]!.y
  assert.ok(cellTop >= paletteBottom, `cellTop=${cellTop} paletteBottom=${paletteBottom}`)
})

test('hitTest returns palette op for click on palette entry', () => {
  const layout = computeLayout(400, 50, 4)
  for (const entry of layout.paletteCells) {
    const cx = entry.x + entry.w / 2
    const cy = entry.y + entry.h / 2
    assert.deepEqual(hitTest(cx, cy, layout), { kind: 'palette', op: entry.op })
  }
})

test('hitTest returns cell idx for click on a cell', () => {
  const layout = computeLayout(400, 50, 6)
  for (let i = 0; i < layout.cells.length; i++) {
    const c = layout.cells[i]!
    const cx = c.x + c.w / 2
    const cy = c.y + c.h / 2
    assert.deepEqual(hitTest(cx, cy, layout), { kind: 'cell', idx: i })
  }
})

test('hitTest returns incLength / decLength for the buttons', () => {
  const layout = computeLayout(400, 50, 4)
  const dx = layout.decBtn.x + layout.decBtn.w / 2
  const dy = layout.decBtn.y + layout.decBtn.h / 2
  assert.deepEqual(hitTest(dx, dy, layout), { kind: 'decLength' })
  const ix = layout.incBtn.x + layout.incBtn.w / 2
  const iy = layout.incBtn.y + layout.incBtn.h / 2
  assert.deepEqual(hitTest(ix, iy, layout), { kind: 'incLength' })
})

test('hitTest returns null outside all regions', () => {
  const layout = computeLayout(400, 50, 4)
  // Far outside the box.
  assert.equal(hitTest(-50, -50, layout), null)
  assert.equal(hitTest(10_000, 10_000, layout), null)
})

test('hitTest does not register cell hits past `length`', () => {
  // length=2 with the box-fills-cell-row layout: cells beyond idx 1 don't
  // exist as drawn rectangles, so a click past them must return null (or
  // dec/inc, but never a phantom cell idx ≥ 2).
  const layout = computeLayout(400, 50, 2)
  // Sample 30 points across the cell-row Y band, well past where cell 1 ends.
  const cellsRight = layout.cells[1]!.x + layout.cells[1]!.w
  const decLeft = layout.decBtn.x
  const yMid = layout.cells[0]!.y + layout.cells[0]!.h / 2
  for (let x = cellsRight + 1; x < decLeft; x += 1) {
    const hit = hitTest(x, yMid, layout)
    if (hit && hit.kind === 'cell') {
      assert.fail(`phantom cell hit at x=${x}, idx=${hit.idx}, length=2`)
    }
  }
})

test('hitTest cell results are stable as length grows', () => {
  // Increasing length should not invalidate cell idx 0 click semantics — cell
  // 0 is always the leftmost cell. This guards against an off-by-one in the
  // layout when length changes.
  for (const len of [1, 2, 4, 8]) {
    const layout = computeLayout(400, 50, len)
    const c0 = layout.cells[0]!
    const hit = hitTest(c0.x + 1, c0.y + 1, layout)
    assert.deepEqual(hit, { kind: 'cell', idx: 0 }, `length=${len}`)
  }
})
