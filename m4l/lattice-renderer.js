// Oedipa lattice renderer (jsui).
// Spec: docs/ai/adr/003-m4l-parameters-state.md "Lattice UI"
//
// Phase 2 view-only: receives latticeCenter <pc> and
// latticeCurrent <pc1> <pc2> <pc3> messages, draws a 7-col x 3-row Tonnetz
// lattice with the current triad highlighted.
//
// Pure logic (vertex/triangle math) is tested in m4l/engine/lattice.test.ts.
// Max's [jsui] runs Max's bundled JS engine, not Node, so the formula is
// re-implemented here as plain JS rather than imported. Keep this file's
// noteAt and trianglePcs in sync with engine/lattice.ts.
//
// All comments are ASCII-only because Max's classic JS parser has been
// observed to choke on UTF-8 in source files.

inlets = 1
outlets = 1

mgraphics.init()
mgraphics.relative_coords = 0
mgraphics.autofill = 0

// Startup banner: lets us verify the script actually loaded fresh.
// If Max cached an older copy, this banner won't appear in the console.
post('lattice-renderer.js loaded build=2026-04-28-closest-and-startmark\n')

// Print box dimensions on first paint so we can verify the fit math.
var debugFirstPaint = true

var COLS = 7
var ROWS = 3
var CC = Math.floor(COLS / 2) // 3
var CR = Math.floor(ROWS / 2) // 1

var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

var centerPc = 0
var currentPcs = null // [pc, pc, pc] or null
var startPcs = null // [pc, pc, pc] or null

// Resolved single cells (closest-to-center match for currentPcs / startPcs).
// Recomputed whenever centerPc, currentPcs, or startPcs change. Mirrors
// engine/lattice.ts findTriadCell's closest-match logic so the highlight
// remains a single, eye-trackable playhead even when a chord appears at
// multiple lattice positions due to the 7-col viewport being shorter than
// the natural 12-col Tonnetz period.
var currentCell = null // {row, col, kind} or null
var startCell = null // same

// --- Message dispatch ---
//
// Max routes a message named X to a global function named X. We also use
// anything() as a catch-all so missing handlers report a clear console line
// rather than silently dropping. Both styles are kept: anything() handles
// startup races where a message arrives before the named function is
// resolved by Max's symbol table.

function mod12(n) { return ((Number(n) % 12) + 12) % 12 }

function latticeCenter(pc, sp1, sp2, sp3) {
  centerPc = mod12(pc)
  if (sp1 !== undefined && sp2 !== undefined && sp3 !== undefined) {
    startPcs = [mod12(sp1), mod12(sp2), mod12(sp3)]
  }
  resolveCells()
  mgraphics.redraw()
}

function latticeCurrent(p1, p2, p3) {
  currentPcs = [mod12(p1), mod12(p2), mod12(p3)]
  currentCell = findClosestCell(currentPcs)
  mgraphics.redraw()
}

function latticeClear() {
  currentPcs = null
  currentCell = null
  mgraphics.redraw()
}

function anything() {
  var msg = messagename
  var args = arrayfromargs(arguments)
  if (msg === 'latticeCenter') { latticeCenter(args[0], args[1], args[2], args[3]); return }
  if (msg === 'latticeCurrent') { latticeCurrent(args[0], args[1], args[2]); return }
  if (msg === 'latticeClear') { latticeClear(); return }
  post('lattice-renderer: unhandled message ' + msg + '\n')
}

function resolveCells() {
  startCell = startPcs !== null ? findClosestCell(startPcs) : null
  // currentPcs uses the same formula; recompute since centerPc may have moved.
  currentCell = currentPcs !== null ? findClosestCell(currentPcs) : null
}

// --- Lattice math (mirror of engine/lattice.ts) ---

function noteAt(row, col) {
  return ((centerPc + (col - CC) * 7 + (row - CR) * 4) % 12 + 12) % 12
}

function trianglePcs(r, c, kind) {
  if (kind === 'major') {
    return [noteAt(r, c), noteAt(r, c + 1), noteAt(r + 1, c)]
  }
  return [noteAt(r + 1, c), noteAt(r + 1, c + 1), noteAt(r, c + 1)]
}

// --- Shared layout (mirrors engine/lattice.ts computeLayout) ---

var SQRT3_OVER_2 = 0.8660254
var PAD_X = 4
var PAD_Y = 4

function computeLayoutLocal(w, h) {
  var spanX = (COLS - 1) + (ROWS - 1) * 0.5
  var spanY = (ROWS - 1)
  var triW = Math.min(
    (w - 2 * PAD_X) / spanX,
    (h - 2 * PAD_Y) / spanY / SQRT3_OVER_2
  )
  var triH = triW * SQRT3_OVER_2
  return {
    triW: triW,
    triH: triH,
    offsetX: (w - spanX * triW) / 2,
    offsetY: (h - spanY * triH) / 2
  }
}

function pointToCell(px, py, layout) {
  var rowF = (py - layout.offsetY) / layout.triH
  var colF = (px - layout.offsetX - rowF * layout.triW * 0.5) / layout.triW
  var r = Math.floor(rowF)
  var c = Math.floor(colF)
  if (r < 0 || r >= ROWS - 1) return null
  if (c < 0 || c >= COLS - 1) return null
  var fr = rowF - r
  var fc = colF - c
  return { row: r, col: c, kind: (fc + fr < 1) ? 'major' : 'minor' }
}

function buildTriad(rootPc, isMajor, reference) {
  var root = Math.floor(reference / 12) * 12 + rootPc
  if (root - reference > 6) root -= 12
  if (reference - root > 6) root += 12
  while (root < 36) root += 12
  while (root > 84) root -= 12
  var third = root + (isMajor ? 4 : 3)
  var fifth = root + 7
  return [root, third, fifth]
}

function cellToTriad(r, c, kind) {
  var pcs = trianglePcs(r, c, kind)
  var ident = identifyTriad(pcs)
  if (ident === null) return null
  return buildTriad(ident.rootPc, ident.isMajor, 60)
}

function identifyTriad(pcs) {
  for (var i = 0; i < 3; i++) {
    var pc = pcs[i]
    var ints = []
    for (var j = 0; j < 3; j++) ints.push(((pcs[j] - pc) % 12 + 12) % 12)
    ints.sort(function (a, b) { return a - b })
    if (ints[0] === 0 && ints[1] === 4 && ints[2] === 7) return { rootPc: pc, isMajor: true }
    if (ints[0] === 0 && ints[1] === 3 && ints[2] === 7) return { rootPc: pc, isMajor: false }
  }
  return null
}

function pcSetEqual(a, b) {
  if (a.length !== b.length) return false
  var aSorted = a.slice().sort(function (x, y) { return x - y })
  var bSorted = b.slice().sort(function (x, y) { return x - y })
  for (var i = 0; i < aSorted.length; i++) {
    if (aSorted[i] !== bSorted[i]) return false
  }
  return true
}

// Mirrors engine/lattice.ts findTriadCell — returns the visible cell whose
// pc set equals targetPcs, choosing the cell whose centroid (in row,col
// space) is closest to the center vertex (CR, CC). Returns null if no
// matching cell is found in the visible viewport.
function findClosestCell(targetPcs) {
  if (targetPcs === null) return null
  var best = null
  var bestDistSq = 1e30
  for (var r = 0; r < ROWS - 1; r++) {
    for (var c = 0; c < COLS - 1; c++) {
      for (var k = 0; k < 2; k++) {
        var kind = k === 0 ? 'major' : 'minor'
        if (!pcSetEqual(trianglePcs(r, c, kind), targetPcs)) continue
        var dr = (kind === 'major' ? r + 1 / 3 : r + 2 / 3) - CR
        var dc = (kind === 'major' ? c + 1 / 3 : c + 2 / 3) - CC
        var distSq = dr * dr + dc * dc
        if (distSq < bestDistSq) {
          bestDistSq = distSq
          best = { row: r, col: c, kind: kind }
        }
      }
    }
  }
  return best
}

function cellEq(a, b) {
  return a !== null && b !== null && a.row === b.row && a.col === b.col && a.kind === b.kind
}

// --- Drawing ---

function paint() {
  var w = box.rect[2] - box.rect[0]
  var h = box.rect[3] - box.rect[1]

  if (debugFirstPaint) {
    post('lattice paint: box.rect=' + box.rect[0] + ',' + box.rect[1] + ',' + box.rect[2] + ',' + box.rect[3] + ' w=' + w + ' h=' + h + '\n')
    debugFirstPaint = false
  }

  // Equilateral fit centered in box; corners may have wedge whitespace, which
  // is correct for a parallelogram lattice.
  var layout = computeLayoutLocal(w, h)
  var triW = layout.triW
  var triH = layout.triH
  var offsetX = layout.offsetX
  var offsetY = layout.offsetY

  function vtxX(row, col) { return offsetX + col * triW + row * triW * 0.5 }
  function vtxY(row) { return offsetY + row * triH }

  // No bg paint — let device strip show through, so lattice doesn't read
  // as a contained box (Ableton native devices don't use sub-panels).

  for (var r = 0; r < ROWS - 1; r++) {
    for (var c = 0; c < COLS - 1; c++) {
      drawCell(r, c, 'major', vtxX, vtxY)
      drawCell(r, c, 'minor', vtxX, vtxY)
    }
  }
}

// --- Mouse interaction ---
//
// ADR 003 "Lattice UI": modifier-free click sets startChord. No edge clicks,
// no drag, no anchors.

function onclick(x, y, button, cmd, shift, capslock, option, ctrl) {
  if (button !== 0) return
  if (cmd || shift || option || ctrl) return
  var w = box.rect[2] - box.rect[0]
  var h = box.rect[3] - box.rect[1]
  var layout = computeLayoutLocal(w, h)
  var cell = pointToCell(x, y, layout)
  if (cell === null) return
  var triad = cellToTriad(cell.row, cell.col, cell.kind)
  if (triad === null) return
  outlet(0, 'setStartChord', triad[0], triad[1], triad[2])
}

function drawCell(r, c, kind, vtxX, vtxY) {
  var v
  if (kind === 'major') {
    v = [
      [vtxX(r, c), vtxY(r)],
      [vtxX(r, c + 1), vtxY(r)],
      [vtxX(r + 1, c), vtxY(r + 1)]
    ]
  } else {
    v = [
      [vtxX(r + 1, c), vtxY(r + 1)],
      [vtxX(r + 1, c + 1), vtxY(r + 1)],
      [vtxX(r, c + 1), vtxY(r)]
    ]
  }

  var pcs = trianglePcs(r, c, kind)
  var ident = identifyTriad(pcs)
  var thisCell = { row: r, col: c, kind: kind }
  var isCurrent = cellEq(thisCell, currentCell)
  var isStart = cellEq(thisCell, startCell)

  // Fill
  mgraphics.move_to(v[0][0], v[0][1])
  mgraphics.line_to(v[1][0], v[1][1])
  mgraphics.line_to(v[2][0], v[2][1])
  mgraphics.close_path()
  if (isCurrent) {
    mgraphics.set_source_rgba(0.976, 0.655, 0.129, 1) // Live orange
  } else if (kind === 'major') {
    mgraphics.set_source_rgba(0.314, 0.314, 0.314, 1) // medium gray
  } else {
    mgraphics.set_source_rgba(0.275, 0.275, 0.275, 1) // slightly darker for minor
  }
  mgraphics.fill()

  // Stroke (default black 1px). For startChord cells (when not also the
  // walker's current cell) overdraw with a slightly thicker, lighter line so
  // the user can see the "rest position" even when the walker has moved away.
  mgraphics.move_to(v[0][0], v[0][1])
  mgraphics.line_to(v[1][0], v[1][1])
  mgraphics.line_to(v[2][0], v[2][1])
  mgraphics.close_path()
  if (isStart && !isCurrent) {
    mgraphics.set_source_rgba(0.78, 0.78, 0.78, 1) // light gray accent
    mgraphics.set_line_width(2)
  } else {
    mgraphics.set_source_rgba(0, 0, 0, 1)
    mgraphics.set_line_width(1)
  }
  mgraphics.stroke()

  // Label
  if (ident !== null) {
    var label = NOTE_NAMES[ident.rootPc] + (ident.isMajor ? '' : 'm')
    var cx = (v[0][0] + v[1][0] + v[2][0]) / 3
    var cy = (v[0][1] + v[1][1] + v[2][1]) / 3
    if (isCurrent) {
      mgraphics.set_source_rgba(0.078, 0.078, 0.078, 1) // dark text on orange
    } else {
      mgraphics.set_source_rgba(0.784, 0.784, 0.784, 1) // light gray text
    }
    mgraphics.select_font_face('Arial')
    mgraphics.set_font_size(11)
    var ext = mgraphics.text_measure(label)
    mgraphics.move_to(cx - ext[0] / 2, cy + ext[1] * 0.35)
    mgraphics.show_text(label)
  }
}
