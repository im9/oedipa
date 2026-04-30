// Oedipa cell strip renderer (jsui).
// Spec: docs/ai/adr/006-workflow.md "Phase 7" Step 3.
// Reference: inboil's TonnetzSheet.svelte `seq-pills` (per-cell direct
// dropdown, no global tool palette).
//
// One bottom-aligned row of N pills (1..8) + `[-] [+]` length controls.
// Click a cell → a horizontal popup of 5 ops opens above the strip,
// anchored to the clicked cell's center and clamped to the box. Click an
// option → cell op set + popup closes. Click outside → popup closes.
// Press-to-cycle is rejected (memory: feedback_avoid_cycle_press) — every
// reachable next state is visible in the popup.
//
// Pure layout & hit-test logic lives in m4l/host/cellstrip.ts (with unit
// tests). Max's [jsui] runs Max's bundled JS engine, not Node, so the
// formula is re-implemented here as plain JS rather than imported. Keep
// PAD / STRIP_H / BTN_W / POPUP_OPT_W / POPUP_OPT_H / POPUP_GAP in sync
// with cellstrip.ts.
//
// Comments and string literals are ASCII; non-ASCII glyphs ("em dash",
// "middle dot") are written as \uXXXX escapes — Max's classic JS parser
// has been observed to choke on UTF-8 in source files.

inlets = 1
outlets = 1

mgraphics.init()
mgraphics.relative_coords = 0
mgraphics.autofill = 0

post('cellstrip-renderer.js loaded build=2026-05-01\n')

// --- Constants (mirror m4l/host/cellstrip.ts) ---

var OPS = ['P', 'L', 'R', 'hold', 'rest']
var MIN_LENGTH = 1
var MAX_LENGTH = 8

var PAD = 2
var STRIP_H = 22
var BTN_W = 18
var POPUP_OPT_W = 22
var POPUP_OPT_H = 22
var POPUP_GAP = 2

// --- State ---
//
// cells: array of length up to 8. Indices >= length_ are kept (so growing
// length back doesn't lose prior ops) but not drawn.
// length_: 1..8, controls visible cell count.
// popupCellIdx: -1 when closed; otherwise the cell whose popup is open.
// playheadIdx: -1 when not playing; otherwise the cell currently sounding.

// Initial state for cells 4..7 = 'hold' to match the host's auto-extend
// default (host.ts setParams pads new cells with 'hold' on length grow).
// Slot rehydrate overwrites these via setCellOp shortly after load, so
// these defaults are only visible during the brief pre-rehydrate window.
var cells = ['P', 'L', 'L', 'R', 'hold', 'hold', 'hold', 'hold']
var length_ = 4
var popupCellIdx = -1
var playheadIdx = -1

// --- Op label rendering ---
//
// Display glyphs match the legacy cell live.tab parameter_enum so the
// pre-Phase-7 visual vocabulary is preserved ("—" = em dash for
// hold, "·" = middle dot for rest).

function opLabel(op) {
  if (op === 'hold') return '\u2014'
  if (op === 'rest') return '\u00b7'
  return op
}

// --- Message dispatch ---
//
// setCells <op0> <op1> ...   bulk set up to 8 ops (reserved; bridge does
//                            not currently emit this).
// setCellOp <idx> <code>     single-cell update by integer op code
//                            (0..4, ordered as OPS). Slot rehydrate uses
//                            this so the bridge's slot-cell-op outlet
//                            drives the strip without int-to-string
//                            translation in the patcher.
// setLength <n>              update active cell count (1..8). Closes any
//                            open popup whose source cell is now beyond
//                            length so the user can't act on a hidden
//                            cell.
// setCellIdx <n>             playhead position (-1 = stopped). Triggered
//                            by the bridge's cellIdx outlet on each tick.

function clampLength(n) {
  n = Number(n)
  if (!isFinite(n)) return MIN_LENGTH
  var r = Math.round(n)
  if (r < MIN_LENGTH) return MIN_LENGTH
  if (r > MAX_LENGTH) return MAX_LENGTH
  return r
}

function isValidOp(op) {
  for (var i = 0; i < OPS.length; i++) {
    if (OPS[i] === op) return true
  }
  return false
}

function applySetCells(args) {
  for (var i = 0; i < args.length && i < MAX_LENGTH; i++) {
    var op = String(args[i])
    if (isValidOp(op)) cells[i] = op
  }
  mgraphics.redraw()
}

function setLength(n) {
  length_ = clampLength(n)
  // Auto-close popup if its source cell is now hidden.
  if (popupCellIdx >= length_) popupCellIdx = -1
  mgraphics.redraw()
}

function setCellOp(idx, code) {
  idx = Number(idx)
  code = Number(code)
  if (!isFinite(idx) || !isFinite(code)) return
  if (idx < 0 || idx >= MAX_LENGTH) return
  if (code < 0 || code >= OPS.length) return
  cells[idx] = OPS[Math.floor(code)]
  mgraphics.redraw()
}

function setCellIdx(n) {
  n = Number(n)
  if (!isFinite(n)) return
  playheadIdx = Math.floor(n)
  mgraphics.redraw()
}

function anything() {
  var msg = messagename
  var args = arrayfromargs(arguments)
  if (msg === 'setCells') { applySetCells(args); return }
  if (msg === 'setLength') { setLength(args[0]); return }
  if (msg === 'setCellOp') { setCellOp(args[0], args[1]); return }
  if (msg === 'setCellIdx') { setCellIdx(args[0]); return }
  post('cellstrip-renderer: unhandled message ' + msg + '\n')
}

// --- Layout (mirrors host/cellstrip.ts) ---

function computeStripLayout(boxW, boxH, len) {
  len = clampLength(len)
  var stripY = Math.max(0, boxH - STRIP_H - PAD)
  var cellAvailableW = Math.max(1, boxW - 2 * PAD - 2 * BTN_W - 2)
  var cellW = cellAvailableW / len
  var cellRects = []
  for (var i = 0; i < len; i++) {
    cellRects.push({
      x: PAD + i * cellW,
      y: stripY,
      w: cellW - 1,
      h: STRIP_H
    })
  }
  var decBtn = { x: PAD + cellAvailableW + 1, y: stripY, w: BTN_W, h: STRIP_H }
  var incBtn = { x: decBtn.x + BTN_W + 1, y: stripY, w: BTN_W, h: STRIP_H }
  return { cells: cellRects, decBtn: decBtn, incBtn: incBtn }
}

function computePopupLayout(boxW, cellRect) {
  var totalW = OPS.length * POPUP_OPT_W
  var cellCenterX = cellRect.x + cellRect.w / 2
  var leftX = cellCenterX - totalW / 2
  if (leftX < PAD) leftX = PAD
  if (leftX + totalW > boxW - PAD) leftX = boxW - PAD - totalW
  var popupY = cellRect.y - POPUP_GAP - POPUP_OPT_H
  var result = []
  for (var i = 0; i < OPS.length; i++) {
    result.push({
      x: leftX + i * POPUP_OPT_W,
      y: popupY,
      w: POPUP_OPT_W - 1,
      h: POPUP_OPT_H,
      op: OPS[i]
    })
  }
  return result
}

function inside(x, y, r) {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}

function hitStrip(x, y, layout) {
  for (var i = 0; i < layout.cells.length; i++) {
    if (inside(x, y, layout.cells[i])) return { kind: 'cell', idx: i }
  }
  if (inside(x, y, layout.decBtn)) return { kind: 'decLength' }
  if (inside(x, y, layout.incBtn)) return { kind: 'incLength' }
  return null
}

function hitPopup(x, y, popup) {
  for (var i = 0; i < popup.length; i++) {
    if (inside(x, y, popup[i])) return { kind: 'popupOption', op: popup[i].op, idx: i }
  }
  return null
}

// --- Drawing ---
//
// Color reference matches lattice-renderer.js so the cell strip reads as
// part of the same device:
//   - active highlight   0.976, 0.655, 0.129  Live orange
//   - filled cell        0.314, 0.314, 0.314  medium gray (major triangle)
//   - hold (sustain)     0.24,  0.24,  0.24
//   - rest (silent)      0.13,  0.13,  0.13
//   - inactive bg        0.20,  0.20,  0.20   (popup option default)
//   - text on highlight  0.078, 0.078, 0.078  near-black
//   - text inactive      0.784, 0.784, 0.784  light gray
//   - playhead accent    0.78,  0.78,  0.78   light gray border (matches
//                                              lattice startCell accent)

function drawRect(r, fillR, fillG, fillB, fillA) {
  mgraphics.set_source_rgba(fillR, fillG, fillB, fillA)
  mgraphics.rectangle(r.x, r.y, r.w, r.h)
  mgraphics.fill()
}

function drawRectStroke(r, sR, sG, sB, lineW) {
  mgraphics.set_source_rgba(sR, sG, sB, 1)
  mgraphics.set_line_width(lineW)
  // Inset by half line width so the stroke sits inside the cell rect
  // rather than half-outside (and clipping against neighbors).
  var inset = lineW / 2
  mgraphics.rectangle(r.x + inset, r.y + inset, r.w - lineW, r.h - lineW)
  mgraphics.stroke()
}

function drawCenteredText(label, r, textR, textG, textB) {
  mgraphics.set_source_rgba(textR, textG, textB, 1)
  mgraphics.select_font_face('Arial')
  mgraphics.set_font_size(11)
  var ext = mgraphics.text_measure(label)
  var cx = r.x + r.w / 2
  var cy = r.y + r.h / 2
  mgraphics.move_to(cx - ext[0] / 2, cy + ext[1] * 0.35)
  mgraphics.show_text(label)
}

function cellFillFor(op, isPopupSource) {
  // Popup source cell wears the orange highlight so the user can see
  // which cell the popup belongs to. Otherwise color codes the op.
  if (isPopupSource) return [0.976, 0.655, 0.129]
  if (op === 'rest') return [0.13, 0.13, 0.13]
  if (op === 'hold') return [0.24, 0.24, 0.24]
  return [0.314, 0.314, 0.314]
}

function cellTextFor(op, isPopupSource) {
  if (isPopupSource) return [0.078, 0.078, 0.078]
  if (op === 'rest') return [0.50, 0.50, 0.50]
  return [0.92, 0.92, 0.92]
}

function paint() {
  var w = box.rect[2] - box.rect[0]
  var h = box.rect[3] - box.rect[1]

  var layout = computeStripLayout(w, h, length_)

  // Cell row.
  for (var j = 0; j < layout.cells.length; j++) {
    var c = layout.cells[j]
    var op = cells[j]
    var isPopupSource = (j === popupCellIdx)
    var fill = cellFillFor(op, isPopupSource)
    var text = cellTextFor(op, isPopupSource)
    drawRect(c, fill[0], fill[1], fill[2], 1)
    drawCenteredText(opLabel(op), c, text[0], text[1], text[2])
    // Playhead accent: light-gray 2px border on the currently-sounding
    // cell. Matches lattice-renderer.js startCell accent so the user
    // reads "playing now" consistently across the device.
    if (j === playheadIdx) {
      drawRectStroke(c, 0.78, 0.78, 0.78, 2)
    }
  }

  // Length controls. Disabled tone when at the bound so the user gets
  // direct visual feedback that further presses won't do anything.
  var decDisabled = (length_ <= MIN_LENGTH)
  var incDisabled = (length_ >= MAX_LENGTH)
  drawRect(layout.decBtn, decDisabled ? 0.16 : 0.24, decDisabled ? 0.16 : 0.24, decDisabled ? 0.16 : 0.24, 1)
  drawCenteredText('-', layout.decBtn, decDisabled ? 0.40 : 0.784, decDisabled ? 0.40 : 0.784, decDisabled ? 0.40 : 0.784)
  drawRect(layout.incBtn, incDisabled ? 0.16 : 0.24, incDisabled ? 0.16 : 0.24, incDisabled ? 0.16 : 0.24, 1)
  drawCenteredText('+', layout.incBtn, incDisabled ? 0.40 : 0.784, incDisabled ? 0.40 : 0.784, incDisabled ? 0.40 : 0.784)

  // Popup (only when open). Drawn last so it sits on top of any cell
  // accent strokes from the strip below.
  if (popupCellIdx >= 0 && popupCellIdx < layout.cells.length) {
    var popup = computePopupLayout(w, layout.cells[popupCellIdx])
    for (var k = 0; k < popup.length; k++) {
      var opt = popup[k]
      // Highlight the option that matches the cell's current op so the
      // user sees the existing setting at a glance.
      var isCurrent = (cells[popupCellIdx] === opt.op)
      if (isCurrent) {
        drawRect(opt, 0.314, 0.314, 0.314, 1)
        drawCenteredText(opLabel(opt.op), opt, 0.92, 0.92, 0.92)
      } else {
        drawRect(opt, 0.20, 0.20, 0.20, 1)
        drawCenteredText(opLabel(opt.op), opt, 0.784, 0.784, 0.784)
      }
      // 1px border so the popup row reads as a discrete control surface
      // rather than blending into the strip below.
      drawRectStroke(opt, 0.40, 0.40, 0.40, 1)
    }
  }
}

// --- Mouse interaction ---
//
// Single primary-button click only. Modifiers reserved for future
// per-cell expression edits (vel/gate/prob/timing) — see ADR 006 §Phase 7
// "32 hidden live.numbox". For now any modifier is a no-op.

function onclick(x, y, button, cmd, shift, capslock, option, ctrl) {
  if (button !== 1) return
  if (cmd || shift || option || ctrl) return
  var w = box.rect[2] - box.rect[0]
  var h = box.rect[3] - box.rect[1]
  var layout = computeStripLayout(w, h, length_)

  // If a popup is open, hit-test it first. A click on a popup option
  // applies that op + closes; a click anywhere else closes without
  // mutating, including clicks on cells (so the user always confirms
  // closure before re-opening on a different cell).
  if (popupCellIdx >= 0 && popupCellIdx < layout.cells.length) {
    var popup = computePopupLayout(w, layout.cells[popupCellIdx])
    var popHit = hitPopup(x, y, popup)
    if (popHit !== null) {
      var idx = popupCellIdx
      var op = popHit.op
      cells[idx] = op
      popupCellIdx = -1
      mgraphics.redraw()
      outlet(0, 'setCell', idx, op)
      return
    }
    // Outside click → close popup, no further action this click.
    popupCellIdx = -1
    mgraphics.redraw()
    return
  }

  // No popup open: strip hit test.
  var hit = hitStrip(x, y, layout)
  if (hit === null) return
  if (hit.kind === 'cell') {
    popupCellIdx = hit.idx
    mgraphics.redraw()
    return
  }
  if (hit.kind === 'decLength') {
    if (length_ <= MIN_LENGTH) return
    length_ = length_ - 1
    mgraphics.redraw()
    outlet(0, 'setParams', 'length', length_)
    return
  }
  if (hit.kind === 'incLength') {
    if (length_ >= MAX_LENGTH) return
    // Pad new cell to 'hold' to match host's auto-extend (host.ts).
    // Without this, cells[length_] would carry whatever stale value was
    // there — visible to the user as a "P" (or other) before they pick.
    cells[length_] = 'hold'
    length_ = length_ + 1
    mgraphics.redraw()
    outlet(0, 'setParams', 'length', length_)
    return
  }
}
