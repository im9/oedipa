import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  noteAt,
  trianglePcs,
  findTriadCell,
  viewportCells,
  type LatticeConfig,
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
