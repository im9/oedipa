import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as path from 'node:path'
import { readFileSync } from 'node:fs'
import {
  identifyTriad,
  applyTransform,
  applyVoicing,
  addSeventh,
  walk,
  walkStepEvent,
  makeCell,
  findTriadInHeldNotes,
  type Triad,
  type Transform,
  type Op,
  type Cell,
  type Voicing,
  type WalkState,
} from './tonnetz.ts'

interface IdentifyCase {
  name: string
  input: Triad
  expected: { root_pc: number; quality: 'major' | 'minor' }
}

interface TransformCase {
  name: string
  input: Triad
  op: Transform
  expected_pcs: number[]
}

interface RoundtripCase {
  name: string
  input: Triad
  ops: Transform[]
  expected_pcs: number[]
}

interface VoicingCase {
  name: string
  input: Triad
  mode: Voicing
  expected: number[]
}

interface SeventhCase {
  name: string
  voiced: number[]
  triad: Triad
  expected: number[]
}

interface WalkSample {
  pos: number
  expected_pcs: number[]
  note?: string
}

// Test-vector cell shape: only `op` is required, every other field defaults
// per ADR 005 §"Default cell values".
interface VectorCell {
  op: Op
  velocity?: number
  gate?: number
  probability?: number
  timing?: number
}

interface VectorWalkState {
  startChord: Triad
  cells: VectorCell[]
  stepsPerTransform: number
  jitter: number
  seed: number
}

interface WalkCase {
  name: string
  description?: string
  state: VectorWalkState
  samples: WalkSample[]
}

interface FindTriadCase {
  name: string
  input: number[]
  expected: number[] | null
}

interface StepEventCase {
  name: string
  state: VectorWalkState
  events?: Array<{
    pos: number
    cellIdx: number
    resolvedOp: Op
    expected_chord_pcs: number[]
    played: boolean
  }>
  null_positions?: number[]
}

interface Vectors {
  identify_triad: IdentifyCase[]
  apply_transform: TransformCase[]
  roundtrip: RoundtripCase[]
  voicing: VoicingCase[]
  seventh: SeventhCase[]
  walk_deterministic: WalkCase[]
  walk_step_events: { description: string; cases: StepEventCase[] }
  find_triad_in_held_notes: { description: string; cases: FindTriadCase[] }
}

const vectorsPath = path.join(import.meta.dirname, '..', '..', 'docs', 'ai', 'tonnetz-test-vectors.json')
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as Vectors

function vectorState(s: VectorWalkState): WalkState {
  return {
    startChord: s.startChord,
    cells: s.cells.map(c => makeCell(c.op, {
      velocity: c.velocity,
      gate: c.gate,
      probability: c.probability,
      timing: c.timing,
    })),
    stepsPerTransform: s.stepsPerTransform,
    jitter: s.jitter,
    seed: s.seed,
  }
}

function pcSet(notes: number[]): number[] {
  const pcs = notes.map(n => ((n % 12) + 12) % 12)
  return [...new Set(pcs)].sort((a, b) => a - b)
}

test('identifyTriad', async (t) => {
  for (const tc of vectors.identify_triad) {
    await t.test(tc.name, () => {
      const result = identifyTriad(tc.input)
      assert.equal(result.rootPc, tc.expected.root_pc, 'rootPc')
      assert.equal(result.quality, tc.expected.quality, 'quality')
    })
  }
})

test('applyTransform', async (t) => {
  for (const tc of vectors.apply_transform) {
    await t.test(tc.name, () => {
      const result = applyTransform(tc.input, tc.op)
      assert.deepEqual(pcSet(result), tc.expected_pcs)
    })
  }
})

test('roundtrip (involution)', async (t) => {
  for (const tc of vectors.roundtrip) {
    await t.test(tc.name, () => {
      let result: Triad = tc.input
      for (const op of tc.ops) {
        result = applyTransform(result, op)
      }
      assert.deepEqual(pcSet(result), tc.expected_pcs)
    })
  }
})

test('applyVoicing', async (t) => {
  for (const tc of vectors.voicing) {
    await t.test(tc.name, () => {
      const result = applyVoicing(tc.input, tc.mode)
      assert.deepEqual(result, tc.expected)
    })
  }
})

test('addSeventh', async (t) => {
  for (const tc of vectors.seventh) {
    await t.test(tc.name, () => {
      const result = addSeventh(tc.voiced, tc.triad)
      assert.deepEqual(result, tc.expected)
    })
  }
})

test('walk (chord cursor)', async (t) => {
  for (const tc of vectors.walk_deterministic) {
    await t.test(tc.name, async (t2) => {
      const state = vectorState(tc.state)
      for (const sample of tc.samples) {
        const label = `pos=${sample.pos}` + (sample.note ? `: ${sample.note}` : '')
        await t2.test(label, () => {
          const result = walk(state, sample.pos)
          assert.deepEqual(pcSet(result), sample.expected_pcs)
        })
      }
    })
  }
})

test('walkStepEvent (per-step events)', async (t) => {
  for (const tc of vectors.walk_step_events.cases) {
    await t.test(tc.name, async (t2) => {
      const state = vectorState(tc.state)
      if (tc.events) {
        for (const ev of tc.events) {
          await t2.test(`pos=${ev.pos}`, () => {
            const result = walkStepEvent(state, ev.pos)
            assert.notEqual(result, null, 'expected non-null event')
            assert.equal(result!.cellIdx, ev.cellIdx, 'cellIdx')
            assert.equal(result!.resolvedOp, ev.resolvedOp, 'resolvedOp')
            assert.equal(result!.played, ev.played, 'played')
            assert.deepEqual(pcSet(result!.chord), ev.expected_chord_pcs, 'chord')
          })
        }
      }
      if (tc.null_positions) {
        for (const pos of tc.null_positions) {
          await t2.test(`pos=${pos} → null`, () => {
            assert.equal(walkStepEvent(state, pos), null)
          })
        }
      }
    })
  }
})

test('findTriadInHeldNotes', async (t) => {
  for (const tc of vectors.find_triad_in_held_notes.cases) {
    await t.test(tc.name, () => {
      const result = findTriadInHeldNotes(tc.input)
      if (tc.expected === null) {
        assert.equal(result, null, `expected null for input ${JSON.stringify(tc.input)}`)
      } else {
        assert.deepEqual(result, tc.expected)
      }
    })
  }
})

// ── walk: jitter / seed structural assertions ────────────────────────────
//
// These tests don't lock specific numerical pcs (those depend on mulberry32
// outputs); they verify the structural contract of jitter & seed — see
// tonnetz-test-vectors.json "walk_jitter" for the spec these test.

const baseState: WalkState = {
  startChord: [60, 64, 67],
  cells: [makeCell('P'), makeCell('L'), makeCell('R'), makeCell('hold')],
  stepsPerTransform: 1,
  jitter: 0,
  seed: 0,
}

test('walk: jitter=0 ignores seed', () => {
  // With jitter=0 no jitter draws are consumed; varying seed must not change output.
  const a = walk({ ...baseState, jitter: 0, seed: 1 }, 10)
  const b = walk({ ...baseState, jitter: 0, seed: 999 }, 10)
  assert.deepEqual(pcSet(a), pcSet(b), 'jitter=0 walks must be seed-independent')
})

test('walk: jitter=1 (no rest cells) ignores cell op identity', () => {
  // With jitter=1 every non-rest cell is replaced by a random pick from CELL_OPS.
  const a = walk({ ...baseState, cells: [makeCell('P'), makeCell('L'), makeCell('R'), makeCell('hold')], jitter: 1, seed: 42 }, 10)
  const b = walk({ ...baseState, cells: [makeCell('hold'), makeCell('hold'), makeCell('hold'), makeCell('hold')], jitter: 1, seed: 42 }, 10)
  assert.deepEqual(pcSet(a), pcSet(b), 'jitter=1 walks (no rest) must be cell-op-independent')
})

test('walk: rest cells excluded from jitter pool — cursor never moves', () => {
  // ADR 005: rest is excluded from substitution. Cursor stays put even with jitter=1.
  const allRest: Cell[] = [makeCell('rest'), makeCell('rest'), makeCell('rest'), makeCell('rest')]
  for (const seed of [0, 1, 42, 999]) {
    const result = walk({ ...baseState, cells: allRest, jitter: 1, seed }, 25)
    assert.deepEqual(pcSet(result), [0, 4, 7], `seed=${seed} must stay on startChord`)
  }
})

test('walk: fixed seed reproduces', () => {
  const state: WalkState = { ...baseState, jitter: 0.5, seed: 42 }
  const a = walk(state, 17)
  const b = walk(state, 17)
  assert.deepEqual(a, b, 'walk(state, pos) must be a pure function')
})

test('walk: any-pos restart consistency', () => {
  // walk(state, N) must equal stepwise advance from 0 to N. This is the
  // contract for "transport restart at arbitrary position is deterministic".
  const state: WalkState = { ...baseState, jitter: 0.7, seed: 123 }
  for (const pos of [0, 1, 5, 13, 50]) {
    const fromZero = walk(state, pos)
    let last: Triad = walk(state, 0)
    for (let p = 1; p <= pos; p++) {
      last = walk(state, p)
    }
    assert.deepEqual(fromZero, last, `walk(state, ${pos}) must match stepwise`)
  }
})

test('walk: hold-only cells with jitter=0 freeze startChord', () => {
  const state: WalkState = {
    startChord: [60, 64, 67],
    cells: [makeCell('hold'), makeCell('hold'), makeCell('hold'), makeCell('hold')],
    stepsPerTransform: 1,
    jitter: 0,
    seed: 0,
  }
  for (const pos of [0, 1, 10, 100]) {
    const result = walk(state, pos)
    assert.deepEqual(pcSet(result), [0, 4, 7], `pos ${pos} must stay on C major`)
  }
})

// ── walkStepEvent structural assertions ──────────────────────────────────

test('walkStepEvent: probability does not affect chord cursor on P/L/R', () => {
  // Two parallel states differing only in probability. Chord cursor must match.
  const stateA: WalkState = {
    ...baseState,
    cells: [makeCell('P'), makeCell('L'), makeCell('R'), makeCell('P')],
  }
  const stateB: WalkState = {
    ...baseState,
    cells: [
      makeCell('P', { probability: 0 }),
      makeCell('L', { probability: 0 }),
      makeCell('R', { probability: 0 }),
      makeCell('P', { probability: 0 }),
    ],
  }
  for (const pos of [1, 2, 3, 4, 7]) {
    const a = walkStepEvent(stateA, pos)
    const b = walkStepEvent(stateB, pos)
    assert.notEqual(a, null)
    assert.notEqual(b, null)
    assert.deepEqual(a!.chord, b!.chord, `pos=${pos} cursor must match`)
    assert.equal(a!.played, true, `pos=${pos} prob=1 plays`)
    assert.equal(b!.played, false, `pos=${pos} prob=0 silent-advances`)
  }
})

test('walkStepEvent: PRNG draw order is fixed (probability draw downstream of jitter)', () => {
  // Two states differ only in probability values. Jitter draws must produce
  // identical resolvedOps because jitter draws happen before probability in
  // the per-step PRNG sequence (ADR 005 §"PRNG draw order").
  const cellsA: Cell[] = [makeCell('P', { probability: 1 }), makeCell('L', { probability: 1 }), makeCell('R', { probability: 1 }), makeCell('hold', { probability: 1 })]
  const cellsB: Cell[] = [makeCell('P', { probability: 0 }), makeCell('L', { probability: 0 }), makeCell('R', { probability: 0 }), makeCell('hold', { probability: 0 })]
  const stateA: WalkState = { ...baseState, cells: cellsA, jitter: 0.5, seed: 42 }
  const stateB: WalkState = { ...baseState, cells: cellsB, jitter: 0.5, seed: 42 }
  for (const pos of [1, 2, 3, 4, 5, 7, 11, 17]) {
    const a = walkStepEvent(stateA, pos)
    const b = walkStepEvent(stateB, pos)
    assert.equal(a!.resolvedOp, b!.resolvedOp, `pos=${pos} resolvedOp must match`)
    assert.deepEqual(a!.chord, b!.chord, `pos=${pos} chord must match`)
  }
})

test('walkStepEvent: rest stays silent regardless of probability', () => {
  const state: WalkState = {
    ...baseState,
    cells: [makeCell('rest', { probability: 1.0 })],
  }
  for (const pos of [1, 2, 3, 5]) {
    const ev = walkStepEvent(state, pos)
    assert.equal(ev!.resolvedOp, 'rest', 'op stays rest (no jitter)')
    assert.equal(ev!.played, false, 'rest never plays')
    assert.deepEqual(pcSet(ev!.chord), [0, 4, 7], 'cursor unchanged')
  }
})

test('walkStepEvent: returns null for non-boundary positions', () => {
  const state: WalkState = {
    ...baseState,
    cells: [makeCell('P'), makeCell('L')],
    stepsPerTransform: 4,
  }
  // Boundaries are pos=4, 8, 12, ...
  for (const pos of [0, 1, 2, 3, 5, 6, 7, 9, 10, 11]) {
    assert.equal(walkStepEvent(state, pos), null, `pos=${pos} is not a boundary`)
  }
  for (const pos of [4, 8, 12]) {
    assert.notEqual(walkStepEvent(state, pos), null, `pos=${pos} IS a boundary`)
  }
})

test('makeCell: defaults applied when overrides omitted', () => {
  const c = makeCell('P')
  assert.equal(c.op, 'P')
  assert.equal(c.velocity, 1.0)
  assert.equal(c.gate, 0.9)
  assert.equal(c.probability, 1.0)
  assert.equal(c.timing, 0.0)
})

test('makeCell: overrides win', () => {
  const c = makeCell('hold', { velocity: 0.5, timing: -0.1 })
  assert.equal(c.op, 'hold')
  assert.equal(c.velocity, 0.5)
  assert.equal(c.timing, -0.1)
  // unchanged defaults
  assert.equal(c.gate, 0.9)
  assert.equal(c.probability, 1.0)
})
