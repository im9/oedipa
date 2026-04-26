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
outlets = 0

mgraphics.init()
mgraphics.relative_coords = 0
mgraphics.autofill = 0

// Startup banner: lets us verify the script actually loaded fresh.
// If Max cached an older copy, this banner won't appear in the console.
post('lattice-renderer.js loaded build=2026-04-25-B\n')

// Print box dimensions on first paint so we can verify the fit math.
var debugFirstPaint = true

var COLS = 7
var ROWS = 3
var CC = Math.floor(COLS / 2) // 3
var CR = Math.floor(ROWS / 2) // 1

var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

var centerPc = 0
var currentPcs = null // [pc, pc, pc] or null

// --- Message dispatch ---
//
// Max routes a message named X to a global function named X. We also use
// anything() as a catch-all so missing handlers report a clear console line
// rather than silently dropping. Both styles are kept: anything() handles
// startup races where a message arrives before the named function is
// resolved by Max's symbol table.

function latticeCenter(pc) {
  centerPc = ((Number(pc) % 12) + 12) % 12
  mgraphics.redraw()
}

function latticeCurrent(p1, p2, p3) {
  currentPcs = [Number(p1), Number(p2), Number(p3)]
  mgraphics.redraw()
}

function latticeClear() {
  currentPcs = null
  mgraphics.redraw()
}

function anything() {
  var msg = messagename
  var args = arrayfromargs(arguments)
  if (msg === 'latticeCenter') { latticeCenter(args[0]); return }
  if (msg === 'latticeCurrent') { latticeCurrent(args[0], args[1], args[2]); return }
  if (msg === 'latticeClear') { latticeClear(); return }
  post('lattice-renderer: unhandled message ' + msg + '\n')
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

function isCurrentCell(r, c, kind) {
  if (currentPcs === null) return false
  return pcSetEqual(trianglePcs(r, c, kind), currentPcs)
}

// --- Drawing ---

function paint() {
  var w = box.rect[2] - box.rect[0]
  var h = box.rect[3] - box.rect[1]

  if (debugFirstPaint) {
    post('lattice paint: box.rect=' + box.rect[0] + ',' + box.rect[1] + ',' + box.rect[2] + ',' + box.rect[3] + ' w=' + w + ' h=' + h + '\n')
    debugFirstPaint = false
  }

  var padX = 4
  var padY = 4

  // Equilateral fit: triH = triW * sqrt(3)/2. Lattice is centered in the box
  // and keeps inboil-style triangle shape; corners may have wedge whitespace,
  // which is correct for a parallelogram lattice.
  var SQRT3_OVER_2 = 0.8660254
  var spanX = (COLS - 1) + (ROWS - 1) * 0.5
  var spanY = (ROWS - 1)
  var triW = Math.min(
    (w - 2 * padX) / spanX,
    (h - 2 * padY) / spanY / SQRT3_OVER_2
  )
  var triH = triW * SQRT3_OVER_2
  var offsetX = (w - spanX * triW) / 2
  var offsetY = (h - spanY * triH) / 2

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
  var isCurrent = isCurrentCell(r, c, kind)

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

  // Stroke
  mgraphics.move_to(v[0][0], v[0][1])
  mgraphics.line_to(v[1][0], v[1][1])
  mgraphics.line_to(v[2][0], v[2][1])
  mgraphics.close_path()
  mgraphics.set_source_rgba(0, 0, 0, 1) // black borders, like Live's panel separators
  mgraphics.set_line_width(1)
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
