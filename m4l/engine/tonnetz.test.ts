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
  type Triad,
  type Transform,
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

interface WalkCase {
  name: string
  description?: string
  state: WalkState
  samples: WalkSample[]
}

interface Vectors {
  identify_triad: IdentifyCase[]
  apply_transform: TransformCase[]
  roundtrip: RoundtripCase[]
  voicing: VoicingCase[]
  seventh: SeventhCase[]
  walk_deterministic: WalkCase[]
}

const vectorsPath = path.join(import.meta.dirname, '..', '..', 'docs', 'ai', 'tonnetz-test-vectors.json')
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as Vectors

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

test('walk (deterministic, jitter=0)', async (t) => {
  for (const tc of vectors.walk_deterministic) {
    await t.test(tc.name, async (t2) => {
      for (const sample of tc.samples) {
        const label = `pos=${sample.pos}` + (sample.note ? `: ${sample.note}` : '')
        await t2.test(label, () => {
          const result = walk(tc.state, sample.pos)
          assert.deepEqual(pcSet(result), sample.expected_pcs)
        })
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
  cells: ['P', 'L', 'R', 'hold'],
  stepsPerTransform: 1,
  jitter: 0,
  seed: 0,
}

test('walk: jitter=0 ignores seed', () => {
  // With jitter=0 the seed is never consulted; varying seed must not change output.
  const a = walk({ ...baseState, jitter: 0, seed: 1 }, 10)
  const b = walk({ ...baseState, jitter: 0, seed: 999 }, 10)
  assert.deepEqual(pcSet(a), pcSet(b), 'jitter=0 walks must be seed-independent')
})

test('walk: jitter=1 ignores cells', () => {
  // With jitter=1 every cell is replaced by a random pick; cells contents must not influence output.
  const a = walk({ ...baseState, cells: ['P', 'L', 'R', 'hold'], jitter: 1, seed: 42 }, 10)
  const b = walk({ ...baseState, cells: ['hold', 'hold', 'hold', 'hold'], jitter: 1, seed: 42 }, 10)
  assert.deepEqual(pcSet(a), pcSet(b), 'jitter=1 walks must be cells-independent')
})

test('walk: fixed seed reproduces', () => {
  // Two calls with the same state and pos must yield identical triads.
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
    // Advance position-by-position; final must match.
    let last: Triad = walk(state, 0)
    for (let p = 1; p <= pos; p++) {
      last = walk(state, p)
    }
    assert.deepEqual(fromZero, last, `walk(state, ${pos}) must match stepwise`)
  }
})

test('walk: hold-only cells with jitter=0 freeze startChord', () => {
  // Sanity: with all-hold cells and no jitter, walker never moves.
  const state: WalkState = {
    startChord: [60, 64, 67],
    cells: ['hold', 'hold', 'hold', 'hold'],
    stepsPerTransform: 1,
    jitter: 0,
    seed: 0,
  }
  for (const pos of [0, 1, 10, 100]) {
    const result = walk(state, pos)
    assert.deepEqual(pcSet(result), [0, 4, 7], `pos ${pos} must stay on C major`)
  }
})
