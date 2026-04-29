import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  noteAt,
  trianglePcs,
  findTriadCell,
  resolveStartCellWithPin,
  viewportCells,
  computeLayout,
  pointToCell,
  cellToTriad,
  LATTICE_PAD_X,
  LATTICE_PAD_Y,
  type LatticeConfig,
  type LatticeLayout,
  type TriangleCell,
} from './lattice.ts'
import { applyTransform, type Triad } from './tonnetz.ts'

// 7-col x 3-row vertex grid centered on C (centerPc = 0).
// Center vertex at (cr=1, cc=3). Per ADR 003:
//   noteAt(row, col) = centerPc + (col - cc) * 7 + (row - cr) * 4   (mod 12)
const config: LatticeConfig = { cols: 7, rows: 3, centerPc: 0 }

describe('noteAt', () => {
  // Identity at center: the center vertex is by definition centerPc.
  test('center vertex (cr, cc) returns centerPc', () => {
    assert.equal(noteAt(1, 3, config), 0)
  })

  // col axis = perfect fifth (7 semitones) — ADR 003 axis convention.
  test('col +1 = +7 semitones (perfect fifth → G when center=C)', () => {
    assert.equal(noteAt(1, 4, config), 7)
  })

  // col -1: 0 - 7 = -7 ≡ 5 mod 12. Perfect fourth = inverse of perfect fifth.
  test('col -1 = -7 semitones ≡ +5 mod 12 (perfect fourth → F when center=C)', () => {
    assert.equal(noteAt(1, 2, config), 5)
  })

  // row axis = major third (4 semitones).
  test('row +1 = +4 semitones (major third → E when center=C)', () => {
    assert.equal(noteAt(2, 3, config), 4)
  })

  // row -1: 0 - 4 = -4 ≡ 8 mod 12.
  test('row -1 = -4 semitones ≡ +8 mod 12 (minor sixth → Ab when center=C)', () => {
    assert.equal(noteAt(0, 3, config), 8)
  })

  // (row +1, col -1): -7 + 4 = -3 ≡ 9 mod 12. Minor third axis (downward-left).
  test('diagonal (row+1, col-1) = -3 semitones ≡ +9 mod 12 (→ A when center=C)', () => {
    assert.equal(noteAt(2, 2, config), 9)
  })

  // Shifting centerPc rotates the whole lattice by a constant offset.
  test('centerPc shift is a uniform offset on all vertices', () => {
    const fSharp: LatticeConfig = { ...config, centerPc: 6 }
    assert.equal(noteAt(1, 3, fSharp), 6) // center
    assert.equal(noteAt(1, 4, fSharp), 1) // 6+7=13 mod 12
    assert.equal(noteAt(2, 3, fSharp), 10) // 6+4
  })
})

describe('trianglePcs', () => {
  // Pure-logic spec: major triangle in cell (r, c) covers vertices
  // (r, c), (r, c+1), (r+1, c) — ADR 003 vertex pattern.
  test('major triangle at center = C major when centerPc=0', () => {
    const cell: TriangleCell = { row: 1, col: 3, kind: 'major' }
    const pcs = [...trianglePcs(cell, config)].sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 4, 7])
  })

  // Minor triangle in cell (r, c) covers (r+1, c), (r+1, c+1), (r, c+1).
  // At center cell with centerPc=0: vertices are 4 (E), 11 (B), 7 (G) → E minor.
  test('minor triangle at center = E minor when centerPc=0', () => {
    const cell: TriangleCell = { row: 1, col: 3, kind: 'minor' }
    const pcs = [...trianglePcs(cell, config)].sort((a, b) => a - b)
    assert.deepEqual(pcs, [4, 7, 11])
  })

  // One row up: vertices (0, 3)=8, (0, 4)=3, (1, 3)=0 → Ab major triad {0, 3, 8}.
  test('major triangle one row up from center = Ab major', () => {
    const cell: TriangleCell = { row: 0, col: 3, kind: 'major' }
    const pcs = [...trianglePcs(cell, config)].sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 3, 8])
  })

  // One col right at center row: vertices (1, 4)=7, (1, 5)=2, (2, 4)=11 → G major.
  test('major triangle one col right of center = G major', () => {
    const cell: TriangleCell = { row: 1, col: 4, kind: 'major' }
    const pcs = [...trianglePcs(cell, config)].sort((a, b) => a - b)
    assert.deepEqual(pcs, [2, 7, 11])
  })
})

describe('findTriadCell', () => {
  // Identity: triad whose pcs match a cell's pcs is found at that cell.
  test('C major lands at center major cell', () => {
    const triad: Triad = [60, 64, 67]
    assert.deepEqual(findTriadCell(triad, config), { row: 1, col: 3, kind: 'major' })
  })

  test('E minor lands at center minor cell', () => {
    const triad: Triad = [64, 67, 71]
    assert.deepEqual(findTriadCell(triad, config), { row: 1, col: 3, kind: 'minor' })
  })

  // Inversions and octave displacements should not affect lookup — only pc identity matters.
  test('C major inversion (E in bass) still resolves to center major cell', () => {
    const triad: Triad = [64, 67, 72]
    assert.deepEqual(findTriadCell(triad, config), { row: 1, col: 3, kind: 'major' })
  })

  // The 7×3 viewport with centerPc=0 has 12 major cells whose roots cover
  // pcs {0,1,2,3,5,6,7,8,10,11} — 10 of the 12 majors. Roots 4 (E) and 9 (A)
  // are not represented because their vertex placements would need either
  // (r, c+1) with c+1=7 or (r+1, c) with r+1=3, both outside the grid.
  test('returns null for triad outside viewport (A major when center=C)', () => {
    const triad: Triad = [69, 73, 76]
    assert.equal(findTriadCell(triad, config), null)
  })

  // Several triads appear at MULTIPLE cells in a 7×3 viewport because
  // the grid is shorter than the natural 12-col Tonnetz period. For these,
  // findTriadCell must return the cell whose centroid (in row,col space) is
  // closest to the center vertex (cr, cc). This makes the renderer's
  // walker-cell highlight stable and unique instead of painting every match.
  //
  // Reason: with only one highlight per chord, the user sees a single moving
  // "playhead" that they can track with their eyes; multi-highlighted chords
  // visually "duplicate" the walker and break the eye's lock.
  test('duplicate chord Bb major picks closer cell (1,1) over (0,5)', () => {
    // Bb major (pcs {2, 5, 10}) sits at (0,5,major) and (1,1,major) when
    // centerPc=0. Iteration order (r,c) hits (0,5) first; closest-match must
    // override that with (1,1) because its centroid is closer to (cr=1, cc=3).
    // Centroid distances to (1,3): (0,5)≈2.42 vs (1,1)≈1.70.
    const triad: Triad = [70, 74, 77]
    assert.deepEqual(findTriadCell(triad, config), { row: 1, col: 1, kind: 'major' })
  })

  test('duplicate chord D minor picks closer cell (1,1) over (0,5)', () => {
    // D minor (pcs {2, 5, 9}) sits at (0,5,minor) and (1,1,minor) when
    // centerPc=0. Distances to (1,3): (0,5)≈2.69 vs (1,1)≈1.49.
    const triad: Triad = [62, 65, 69]
    assert.deepEqual(findTriadCell(triad, config), { row: 1, col: 1, kind: 'minor' })
  })

  test('duplicate chord D# major picks closer cell (0,4) over (1,0)', () => {
    // D# major (pcs {3, 7, 10}) — distances: (0,4)≈1.49 vs (1,0)≈2.69.
    // First-match iteration also picks (0,4); included here so a future
    // refactor of viewportCells iteration order can't silently regress this.
    const triad: Triad = [63, 67, 70]
    assert.deepEqual(findTriadCell(triad, config), { row: 0, col: 4, kind: 'major' })
  })

  test('singleton chord (only one viewport match) still returns that cell', () => {
    // C major appears only at (1,3,major) when centerPc=0 — single match,
    // closest-of-one is itself.
    const triad: Triad = [60, 64, 67]
    assert.deepEqual(findTriadCell(triad, config), { row: 1, col: 3, kind: 'major' })
  })
})

describe('resolveStartCellWithPin', () => {
  // Bug context: with closest-to-center selection (findTriadCell), a chord
  // appearing at multiple cells in the viewport always paints at the same
  // single position regardless of where the user actually clicked. The pin
  // mechanism remembers the clicked cell so the marker stays where the user
  // pointed, until the chord identity changes (e.g. via MIDI input on the
  // next chord).

  test('returns pin verbatim when pin\'s pcs match the target triad', () => {
    // Bb major (pcs {2, 5, 10}) sits at both (0, 5, major) and (1, 1, major)
    // when centerPc=0. findTriadCell prefers (1, 1) (closer to center). If
    // the user clicked the (0, 5) cell, the pin should preserve that choice.
    const triad: Triad = [70, 74, 77]
    const pin: TriangleCell = { row: 0, col: 5, kind: 'major' }
    const result = resolveStartCellWithPin(triad, pin, config)
    assert.deepEqual(result.cell, pin, 'pin retained instead of closest-match (1,1)')
    assert.deepEqual(result.pin, pin, 'pin returned unchanged')
  })

  test('falls back to findTriadCell when pin\'s triangle no longer matches the triad', () => {
    // User pinned a Bb major cell, then the chord changes to D minor (e.g.
    // via MIDI input). The pin's triangle no longer matches the new triad,
    // so we fall back to closest-match and clear the pin.
    const oldPin: TriangleCell = { row: 0, col: 5, kind: 'major' } // Bb major
    const newTriad: Triad = [62, 65, 69] // D minor
    const result = resolveStartCellWithPin(newTriad, oldPin, config)
    assert.deepEqual(result.cell, findTriadCell(newTriad, config))
    assert.equal(result.pin, null, 'pin cleared so subsequent updates use closest-match')
  })

  test('null pin returns findTriadCell verbatim (closest-to-center)', () => {
    const triad: Triad = [70, 74, 77] // Bb major (multi-position)
    const result = resolveStartCellWithPin(triad, null, config)
    assert.deepEqual(result.cell, findTriadCell(triad, config))
    assert.equal(result.pin, null)
  })

  test('pin with mismatched kind drops the pin (e.g. major pin → minor target)', () => {
    // Pin a Bb major cell; target the Bb major chord's RELATIVE minor (G minor,
    // pcs {2, 7, 10}) — overlapping pcs but a minor triad. Pin's triangle has
    // kind=major and produces Bb major's pcs, not G minor's, so the pcs
    // shouldn't match and the pin should be cleared.
    const pin: TriangleCell = { row: 0, col: 5, kind: 'major' } // Bb major
    const gMinor: Triad = [67, 70, 74] // G minor — pcs {2, 7, 10}, no full pc-set match
    const result = resolveStartCellWithPin(gMinor, pin, config)
    assert.equal(result.pin, null)
  })

  test('pin survives across pos/walker changes that re-emit the same startChord', () => {
    // The renderer calls resolveCells() on every lattice-center / latticeRefresh.
    // If startPcs are unchanged, the pin must persist across consecutive calls.
    const triad: Triad = [70, 74, 77]
    const pin: TriangleCell = { row: 0, col: 5, kind: 'major' }
    const first = resolveStartCellWithPin(triad, pin, config)
    const second = resolveStartCellWithPin(triad, first.pin, config)
    const third = resolveStartCellWithPin(triad, second.pin, config)
    assert.deepEqual(first.cell, pin)
    assert.deepEqual(second.cell, pin)
    assert.deepEqual(third.cell, pin)
  })
})

describe('viewport coverage', () => {
  // The renderer uses a 7×4 vertex viewport (3 row-bands) because the smaller
  // 7×3 (2 row-bands) leaves four triads — E major, A major, C# minor,
  // G# minor — without a matching cell. When the walker visited those chords,
  // the playhead simply vanished. With rows=4 every Tonnetz triad has at
  // least one viewport cell; closest-match collapses any duplicates to one
  // highlight.

  function allTriads(): Triad[] {
    const out: Triad[] = []
    for (let root = 0; root < 12; root++) {
      out.push([60 + root, 64 + root, 67 + root] as Triad) // major
      out.push([60 + root, 63 + root, 67 + root] as Triad) // minor
    }
    return out
  }

  test('rows=4 covers all 24 triads', () => {
    const cfg: LatticeConfig = { cols: 7, rows: 4, centerPc: 0 }
    for (const triad of allTriads()) {
      assert.ok(
        findTriadCell(triad, cfg) !== null,
        `triad [${triad.join(', ')}] missing from rows=4 viewport`,
      )
    }
  })

  test('rows=3 misses E major, A major, C# minor, G# minor (regression doc)', () => {
    // Documents the bug that motivated rows=3 → 4. If a future change brings
    // rows=3 back, this test reminds why it broke playhead visibility.
    const cfg: LatticeConfig = { cols: 7, rows: 3, centerPc: 0 }
    assert.equal(findTriadCell([64, 68, 71] as Triad, cfg), null) // E major
    assert.equal(findTriadCell([69, 73, 76] as Triad, cfg), null) // A major
    assert.equal(findTriadCell([61, 64, 68] as Triad, cfg), null) // C# minor
    assert.equal(findTriadCell([68, 71, 75] as Triad, cfg), null) // G# (Ab) minor
  })
})

describe('lattice ↔ engine consistency', () => {
  // ADR 003: the three edges of a triangle correspond to P/L/R transforms
  // by way of which neighboring (flipped) triangle they share.
  // Spec for major center (1, 3, 'major'):
  //   P5 edge → minor cell directly above   → (0, 3, 'minor')
  //   m3 edge → minor cell in same column   → (1, 3, 'minor')   [L]
  //   M3 edge → minor cell to the left      → (1, 2, 'minor')   [R]

  test('P from C major → cell (0, 3, minor) (= C minor above)', () => {
    const transformed = applyTransform([60, 64, 67], 'P')
    assert.deepEqual(findTriadCell(transformed, config), { row: 0, col: 3, kind: 'minor' })
  })

  test('L from C major → cell (1, 3, minor) (= E minor, same cell)', () => {
    const transformed = applyTransform([60, 64, 67], 'L')
    assert.deepEqual(findTriadCell(transformed, config), { row: 1, col: 3, kind: 'minor' })
  })

  test('R from C major → cell (1, 2, minor) (= A minor, one col left)', () => {
    const transformed = applyTransform([60, 64, 67], 'R')
    assert.deepEqual(findTriadCell(transformed, config), { row: 1, col: 2, kind: 'minor' })
  })

  // Round-trip: P∘P, L∘L, R∘R = identity means we land back at the original cell.
  test('P∘P returns to original cell', () => {
    let triad: Triad = [60, 64, 67]
    triad = applyTransform(triad, 'P')
    triad = applyTransform(triad, 'P')
    assert.deepEqual(findTriadCell(triad, config), { row: 1, col: 3, kind: 'major' })
  })
})

describe('computeLayout', () => {
  // Geometry: equilateral triangles with triH = triW * sqrt(3)/2.
  // For a (cols × rows) vertex grid:
  //   spanX = (cols-1) + (rows-1)*0.5    (last col offset by row*0.5)
  //   spanY = (rows-1)
  // triW is whichever fits — width or height — after padding.

  // Width-binding: a square box (200×200) — width is the tighter constraint
  // because spanX (7) is much larger than spanY/SQRT3_OVER_2 (~2.31).
  test('width-binding: triW = (boxW - 2*padX) / spanX', () => {
    const cfg: LatticeConfig = { cols: 7, rows: 3, centerPc: 0 }
    const layout = computeLayout(200, 200, cfg)
    // spanX = (cols-1) + (rows-1)*0.5 = 6 + 1 = 7
    const spanX = 7
    const expectedTriW = (200 - 2 * LATTICE_PAD_X) / spanX
    assert.ok(Math.abs(layout.triW - expectedTriW) < 1e-9)
    // offsetX should equal padX exactly when width is binding.
    assert.ok(Math.abs(layout.offsetX - LATTICE_PAD_X) < 1e-9)
  })

  // Height-binding: a wide-but-short box (700×140). 700/7 = 100 vs
  // 140/2/0.866 ≈ 80.8 → height binds.
  test('height-binding: triW = (boxH - 2*padY) / spanY / (sqrt(3)/2)', () => {
    const cfg: LatticeConfig = { cols: 7, rows: 3, centerPc: 0 }
    const layout = computeLayout(700, 140, cfg)
    const SQRT3_OVER_2 = Math.sqrt(3) / 2
    const spanY = 2
    const expectedTriW = (140 - 2 * LATTICE_PAD_Y) / spanY / SQRT3_OVER_2
    assert.ok(Math.abs(layout.triW - expectedTriW) < 1e-9)
    // offsetY should equal padY exactly when height is binding.
    assert.ok(Math.abs(layout.offsetY - LATTICE_PAD_Y) < 1e-9)
  })

  // triH = triW * sqrt(3)/2 by construction (equilateral triangles).
  test('triH = triW * sqrt(3)/2', () => {
    const cfg: LatticeConfig = { cols: 7, rows: 3, centerPc: 0 }
    const layout = computeLayout(460, 120, cfg)
    const SQRT3_OVER_2 = Math.sqrt(3) / 2
    assert.ok(Math.abs(layout.triH - layout.triW * SQRT3_OVER_2) < 1e-9)
  })
})

describe('pointToCell', () => {
  // Use a hand-picked layout so vertex coords are easy to reason about:
  //   triW=60, triH=52, offsetX=10, offsetY=10
  //   vtxX(r, c) = 10 + c*60 + r*30
  //   vtxY(r)    = 10 + r*52
  // Center vertex (1, 3): (220, 62).
  // Cell (1, 3) parallelogram corners:
  //   (1, 3)→(220, 62), (1, 4)→(280, 62), (2, 3)→(250, 114), (2, 4)→(310, 114)
  // Major triangle (upper-left): (220, 62), (280, 62), (250, 114)
  //   → centroid (250, 79.33)
  // Minor triangle (lower-right): (250, 114), (310, 114), (280, 62)
  //   → centroid (280, 96.67)
  const cfg: LatticeConfig = { cols: 7, rows: 3, centerPc: 0 }
  const layout: LatticeLayout = { triW: 60, triH: 52, offsetX: 10, offsetY: 10 }

  test('center major triangle hit by its centroid', () => {
    assert.deepEqual(pointToCell(250, 79, layout, cfg), { row: 1, col: 3, kind: 'major' })
  })

  test('center minor triangle hit by its centroid', () => {
    assert.deepEqual(pointToCell(280, 97, layout, cfg), { row: 1, col: 3, kind: 'minor' })
  })

  // Diagonal split: a point well inside the major half vs minor half of
  // the same parallelogram cell must resolve to different kinds.
  test('major/minor split by parallelogram diagonal', () => {
    // Just inside the major half (top-left quadrant of cell).
    const major = pointToCell(235, 70, layout, cfg)
    assert.deepEqual(major, { row: 1, col: 3, kind: 'major' })
    // Just inside the minor half (bottom-right quadrant of cell).
    const minor = pointToCell(295, 105, layout, cfg)
    assert.deepEqual(minor, { row: 1, col: 3, kind: 'minor' })
  })

  // Out-of-bounds: anywhere outside the [0, cols-1) × [0, rows-1) lattice
  // returns null (caller treats as "no hit, ignore click").
  test('point above lattice (py < offsetY) returns null', () => {
    assert.equal(pointToCell(250, 0, layout, cfg), null)
  })

  test('point below lattice returns null', () => {
    assert.equal(pointToCell(250, 1000, layout, cfg), null)
  })

  test('point left of lattice returns null', () => {
    assert.equal(pointToCell(0, 50, layout, cfg), null)
  })

  test('point right of lattice returns null', () => {
    assert.equal(pointToCell(1000, 50, layout, cfg), null)
  })

  // Sanity: every triangle's centroid hits its own cell. Catches off-by-one
  // in the row/col floor logic across the full viewport.
  test('every cell centroid hits its own cell', () => {
    for (const cell of viewportCells(cfg)) {
      const v0x = layout.offsetX + cell.col * layout.triW + cell.row * layout.triW * 0.5
      const v0y = layout.offsetY + cell.row * layout.triH
      const v1x = layout.offsetX + (cell.col + 1) * layout.triW + cell.row * layout.triW * 0.5
      const v1y = v0y
      const v2x = layout.offsetX + cell.col * layout.triW + (cell.row + 1) * layout.triW * 0.5
      const v2y = layout.offsetY + (cell.row + 1) * layout.triH
      const v3x = v2x + layout.triW
      const v3y = v2y
      let cx: number, cy: number
      if (cell.kind === 'major') {
        cx = (v0x + v1x + v2x) / 3
        cy = (v0y + v1y + v2y) / 3
      } else {
        cx = (v2x + v3x + v1x) / 3
        cy = (v2y + v3y + v1y) / 3
      }
      assert.deepEqual(pointToCell(cx, cy, layout, cfg), cell, `centroid of ${JSON.stringify(cell)}`)
    }
  })
})

describe('cellToTriad', () => {
  const cfg: LatticeConfig = { cols: 7, rows: 3, centerPc: 0 }

  // Center major cell → C major; reference 60 → root at 60.
  test('center major cell → C major triad rooted at 60', () => {
    const triad = cellToTriad({ row: 1, col: 3, kind: 'major' }, cfg)
    assert.deepEqual(triad, [60, 64, 67])
  })

  // Center minor cell → E minor; root E above middle C is 64.
  test('center minor cell → E minor triad rooted at 64', () => {
    const triad = cellToTriad({ row: 1, col: 3, kind: 'minor' }, cfg)
    assert.deepEqual(triad, [64, 67, 71])
  })

  // Custom reference parameter shifts the triad register.
  test('reference parameter selects the octave', () => {
    const triad = cellToTriad({ row: 1, col: 3, kind: 'major' }, cfg, 72)
    // buildTriad clamps within ±6 of reference; 72 → root C5 = 72.
    assert.deepEqual(triad, [72, 76, 79])
  })

  // Round-trip with findTriadCell: cellToTriad must produce a triad whose
  // pc set, when fed back through findTriadCell, lands on a cell holding the
  // same pcs. The same triad can appear at multiple cells in the viewport
  // (e.g., D# major sits at both (0,4,major) and (1,0,major) when centerPc=0),
  // so we don't require cell identity — only that click semantics are
  // preserved (clicking triangle X tells the host about a chord whose pcs
  // match what was drawn at X).
  test('cellToTriad output → findTriadCell recovers the same pc set', () => {
    for (const cell of viewportCells(cfg)) {
      const triad = cellToTriad(cell, cfg)
      const found = findTriadCell(triad, cfg)
      assert.ok(found !== null, `findTriadCell returned null for ${JSON.stringify(cell)}`)
      const originalPcs = [...trianglePcs(cell, cfg)].sort((a, b) => a - b)
      const recoveredPcs = [...trianglePcs(found, cfg)].sort((a, b) => a - b)
      assert.deepEqual(recoveredPcs, originalPcs, `round-trip ${JSON.stringify(cell)}`)
    }
  })
})

describe('viewportCells', () => {
  // 7-col × 3-row vertex grid → (cols-1) × (rows-1) = 6 × 2 = 12 parallelogram
  // cells, each holding one major + one minor triangle = 24 visible triangles.
  test('enumerates 24 cells for 7×3 viewport', () => {
    const cells = viewportCells(config)
    assert.equal(cells.length, 24)
  })

  test('every cell is unique by (row, col, kind)', () => {
    const cells = viewportCells(config)
    const keys = new Set(cells.map(c => `${c.row},${c.col},${c.kind}`))
    assert.equal(keys.size, cells.length)
  })

  test('all cells fit within the vertex grid', () => {
    const cells = viewportCells(config)
    for (const { row, col } of cells) {
      assert.ok(row >= 0 && row < config.rows - 1, `row ${row} out of range`)
      assert.ok(col >= 0 && col < config.cols - 1, `col ${col} out of range`)
    }
  })
})
