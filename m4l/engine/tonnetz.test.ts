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
  mulberry32,
  findTriadInHeldNotes,
  type Triad,
  type Transform,
  type Op,
  type Cell,
  type StepDirection,
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
  stepDirection?: StepDirection
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
    ...(s.stepDirection !== undefined ? { stepDirection: s.stepDirection } : {}),
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

// ── stepDirection structural assertions (ADR 005 Phase 3) ────────────────

test('walkStepEvent: stepDirection defaults to forward when omitted', () => {
  // ADR 005 §"Step direction": default 'forward'. Omitting the field must
  // produce the same cellIdx sequence as explicit 'forward'.
  const cells = [makeCell('P'), makeCell('L'), makeCell('R'), makeCell('hold')]
  const omitted: WalkState = { ...baseState, cells }
  const explicit: WalkState = { ...baseState, cells, stepDirection: 'forward' }
  for (const pos of [1, 2, 3, 4, 5, 7, 11]) {
    const a = walkStepEvent(omitted, pos)
    const b = walkStepEvent(explicit, pos)
    assert.equal(a!.cellIdx, b!.cellIdx, `pos=${pos} cellIdx`)
    assert.equal(a!.resolvedOp, b!.resolvedOp, `pos=${pos} resolvedOp`)
    assert.deepEqual(a!.chord, b!.chord, `pos=${pos} chord`)
  }
})

test('walkStepEvent: stepDirection=random — cellIdx sequence depends on seed, not authored cell ops', () => {
  // With direction=random and jitter=0, cellIdx is determined by the PRNG draw
  // alone. Varying authored cell ops (but holding cells.length and seed) must
  // produce identical cellIdx sequences. This proves the random-direction draw
  // is at the documented top of the order and is independent of cell content.
  const seed = 314
  const stateA: WalkState = {
    ...baseState,
    cells: [makeCell('P'), makeCell('L'), makeCell('R'), makeCell('hold')],
    seed,
    stepDirection: 'random',
  }
  const stateB: WalkState = {
    ...baseState,
    cells: [makeCell('hold'), makeCell('hold'), makeCell('hold'), makeCell('hold')],
    seed,
    stepDirection: 'random',
  }
  const seqA = [1, 2, 3, 4, 5, 6, 7, 8].map(p => walkStepEvent(stateA, p)!.cellIdx)
  const seqB = [1, 2, 3, 4, 5, 6, 7, 8].map(p => walkStepEvent(stateB, p)!.cellIdx)
  assert.deepEqual(seqA, seqB, 'random cellIdx draws must depend only on seed/cells.length')
  for (const idx of seqA) {
    assert.ok(idx >= 0 && idx < 4, `cellIdx ${idx} must be in [0, cells.length)`)
  }
})

test('walkStepEvent: stepDirection=random with cells.length=1 always returns cellIdx=0', () => {
  const state: WalkState = {
    ...baseState,
    cells: [makeCell('P')],
    seed: 42,
    stepDirection: 'random',
  }
  for (const pos of [1, 2, 3, 5, 11, 25]) {
    assert.equal(walkStepEvent(state, pos)!.cellIdx, 0, `pos=${pos}`)
  }
})

test('walkStepEvent: PRNG draw order — random direction consumes 1 draw before jitter', () => {
  // direction=random + jitter=1 vs. direction=forward + jitter=1, same seed.
  // The random-direction draw shifts the PRNG state seen by the jitter draws,
  // so resolvedOp sequences must differ. This is structural — the assertion
  // catches accidental reorder of PRNG draws.
  const cells = [makeCell('P'), makeCell('L'), makeCell('R'), makeCell('hold')]
  const fwd: WalkState = { ...baseState, cells, jitter: 1, seed: 42, stepDirection: 'forward' }
  const rnd: WalkState = { ...baseState, cells, jitter: 1, seed: 42, stepDirection: 'random' }
  const seqFwd = [1, 2, 3, 4, 5, 6, 7, 8].map(p => walkStepEvent(fwd, p)!.resolvedOp)
  const seqRnd = [1, 2, 3, 4, 5, 6, 7, 8].map(p => walkStepEvent(rnd, p)!.resolvedOp)
  assert.notDeepEqual(seqFwd, seqRnd, 'random must shift the jitter PRNG offset')
})

test('walk: stepDirection=reverse drives cursor through cells in reverse order', () => {
  // Single transform: walk(state, 1) should resolve cell at index cells.length-1.
  const state: WalkState = {
    startChord: [60, 64, 67],
    cells: [makeCell('P'), makeCell('L'), makeCell('R'), makeCell('hold')],
    stepsPerTransform: 1,
    jitter: 0,
    seed: 0,
    stepDirection: 'reverse',
  }
  // pos=1 consumes cell[3]=hold → C major unchanged
  assert.deepEqual(pcSet(walk(state, 1)), [0, 4, 7], 'pos=1 hold')
  // pos=2 consumes cell[2]=R → R(Cmaj) = A minor
  assert.deepEqual(pcSet(walk(state, 2)), [0, 4, 9], 'pos=2 R')
})

// ── humanize draw assertions (ADR 005 Phase 3) ───────────────────────────

test('walkStepEvent: humanize draws are uniform [0, 1) and seed-deterministic', () => {
  const state: WalkState = {
    ...baseState,
    cells: [makeCell('P'), makeCell('L'), makeCell('R'), makeCell('hold')],
    seed: 42,
  }
  for (const pos of [1, 2, 3, 4, 5, 7, 13, 17]) {
    const a = walkStepEvent(state, pos)
    const b = walkStepEvent(state, pos)
    assert.equal(a!.humanizeVel, b!.humanizeVel, `pos=${pos} vel determinism`)
    assert.equal(a!.humanizeGate, b!.humanizeGate, `pos=${pos} gate determinism`)
    assert.equal(a!.humanizeTiming, b!.humanizeTiming, `pos=${pos} timing determinism`)
    assert.equal(a!.humanizeProb, b!.humanizeProb, `pos=${pos} prob determinism`)
    for (const [name, v] of [['vel', a!.humanizeVel], ['gate', a!.humanizeGate], ['timing', a!.humanizeTiming], ['prob', a!.humanizeProb]] as const) {
      assert.ok(v >= 0 && v < 1, `pos=${pos} humanize ${name}=${v} must be in [0, 1)`)
    }
  }
})

test('walkStepEvent: humanize draws populated even on rest and probability-fail steps', () => {
  // Engine always consumes humanize draws so the cross-target stream stays
  // stable regardless of op or prob outcome (ADR 005 §"PRNG draw order").
  const restState: WalkState = { ...baseState, cells: [makeCell('rest')], seed: 5 }
  const evRest = walkStepEvent(restState, 1)!
  assert.ok(evRest.humanizeVel >= 0 && evRest.humanizeVel < 1)
  assert.ok(evRest.humanizeGate >= 0 && evRest.humanizeGate < 1)
  assert.ok(evRest.humanizeTiming >= 0 && evRest.humanizeTiming < 1)
  assert.ok(evRest.humanizeProb >= 0 && evRest.humanizeProb < 1)

  const probFailState: WalkState = {
    ...baseState,
    cells: [makeCell('P', { probability: 0 })],
    seed: 5,
  }
  const evProb = walkStepEvent(probFailState, 1)!
  assert.equal(evProb.played, false)
  assert.ok(evProb.humanizeVel >= 0 && evProb.humanizeVel < 1)
  assert.ok(evProb.humanizeGate >= 0 && evProb.humanizeGate < 1)
  assert.ok(evProb.humanizeTiming >= 0 && evProb.humanizeTiming < 1)
  assert.ok(evProb.humanizeProb >= 0 && evProb.humanizeProb < 1)
})

test('walkStepEvent: humanize draws unaffected by probability values (downstream of probability)', () => {
  // ADR 005 §"PRNG draw order": probability is drawn BEFORE humanize. So two
  // states differing only in probability produce identical humanize draws (the
  // one prob draw still happens in both — only its outcome differs).
  const cellsHi = [makeCell('P', { probability: 1 }), makeCell('L', { probability: 1 }), makeCell('R', { probability: 1 }), makeCell('hold', { probability: 1 })]
  const cellsLo = [makeCell('P', { probability: 0 }), makeCell('L', { probability: 0 }), makeCell('R', { probability: 0 }), makeCell('hold', { probability: 0 })]
  const stateA: WalkState = { ...baseState, cells: cellsHi, jitter: 0.5, seed: 99 }
  const stateB: WalkState = { ...baseState, cells: cellsLo, jitter: 0.5, seed: 99 }
  for (const pos of [1, 2, 3, 4, 5, 7, 11]) {
    const a = walkStepEvent(stateA, pos)!
    const b = walkStepEvent(stateB, pos)!
    assert.equal(a.humanizeVel, b.humanizeVel, `pos=${pos} humanize vel must match`)
    assert.equal(a.humanizeGate, b.humanizeGate, `pos=${pos} humanize gate must match`)
    assert.equal(a.humanizeTiming, b.humanizeTiming, `pos=${pos} humanize timing must match`)
    assert.equal(a.humanizeProb, b.humanizeProb, `pos=${pos} humanize prob must match`)
  }
})

test('walkStepEvent: humanizeDrift=0 (default) is identity (raw draws unchanged)', () => {
  // Drift defaults to 0 → EMA factor (1-α) = 1 → smoothed = raw. With this
  // contract, all Phase 1–5 cross-target reproducibility holds bit-identically.
  const cells = [makeCell('P'), makeCell('L'), makeCell('R'), makeCell('hold')]
  const without: WalkState = { ...baseState, cells, seed: 42 }
  const withZero: WalkState = { ...baseState, cells, seed: 42, humanizeDrift: 0 }
  for (const pos of [1, 2, 3, 4, 5, 7, 11, 17]) {
    const a = walkStepEvent(without, pos)!
    const b = walkStepEvent(withZero, pos)!
    assert.equal(a.humanizeVel, b.humanizeVel, `pos=${pos} vel must match`)
    assert.equal(a.humanizeGate, b.humanizeGate, `pos=${pos} gate must match`)
    assert.equal(a.humanizeTiming, b.humanizeTiming, `pos=${pos} timing must match`)
    assert.equal(a.humanizeProb, b.humanizeProb, `pos=${pos} prob must match`)
  }
})

test('walkStepEvent: humanizeDrift > 0 produces EMA-smoothed humanize values', () => {
  // EMA contract: v_t = drift * v_{t-1} + (1-drift) * u_t, prev_init = 0.5.
  // For drift=0.5 we can re-simulate the smoothing by hand using the raw draws
  // (which are deterministic from mulberry32(seed)).
  const drift = 0.5
  const state: WalkState = {
    ...baseState,
    cells: [makeCell('P'), makeCell('L'), makeCell('R'), makeCell('hold')],
    seed: 42,
    humanizeDrift: drift,
  }
  // Re-simulate raw draws and EMA. PRNG draw order: probability, vel, gate,
  // timing, prob (5 draws per step, with no jitter, no random direction).
  const rng = mulberry32(42)
  let prevVel = 0.5, prevGate = 0.5, prevTim = 0.5, prevProb = 0.5
  for (let step = 1; step <= 6; step++) {
    rng() // probability
    const rawVel = rng()
    const rawGate = rng()
    const rawTim = rng()
    const rawProb = rng()
    const expVel = drift * prevVel + (1 - drift) * rawVel
    const expGate = drift * prevGate + (1 - drift) * rawGate
    const expTim = drift * prevTim + (1 - drift) * rawTim
    const expProb = drift * prevProb + (1 - drift) * rawProb
    prevVel = expVel; prevGate = expGate; prevTim = expTim; prevProb = expProb
    const ev = walkStepEvent(state, step)!
    assert.ok(Math.abs(ev.humanizeVel - expVel) < 1e-12, `pos=${step} vel ${ev.humanizeVel} vs ${expVel}`)
    assert.ok(Math.abs(ev.humanizeGate - expGate) < 1e-12, `pos=${step} gate ${ev.humanizeGate} vs ${expGate}`)
    assert.ok(Math.abs(ev.humanizeTiming - expTim) < 1e-12, `pos=${step} timing`)
    assert.ok(Math.abs(ev.humanizeProb - expProb) < 1e-12, `pos=${step} prob`)
  }
})

test('walkStepEvent: humanizeDrift smoothed values stay within [0, 1)', () => {
  // EMA of [0,1) draws starting from prev=0.5 stays in [0, 1) because
  // α*v + (1-α)*u with v,u ∈ [0,1) lies in [0, α + (1-α)) = [0, 1).
  // Host's clamp01 math depends on the smoothed values being in the same
  // domain as raw uniforms — this test pins that domain invariant.
  for (const drift of [0.1, 0.5, 0.9, 0.99]) {
    const state: WalkState = {
      ...baseState,
      cells: [makeCell('P'), makeCell('L'), makeCell('R'), makeCell('hold')],
      seed: 7,
      humanizeDrift: drift,
    }
    for (let pos = 1; pos <= 64; pos++) {
      const ev = walkStepEvent(state, pos)!
      for (const [name, v] of [['vel', ev.humanizeVel], ['gate', ev.humanizeGate], ['timing', ev.humanizeTiming], ['prob', ev.humanizeProb]] as const) {
        assert.ok(v >= 0 && v < 1, `drift=${drift} pos=${pos} ${name}=${v} must be in [0, 1)`)
      }
    }
  }
})

test('walkStepEvent: humanizeDrift produces autocorrelation (adjacent values are similar)', () => {
  // The whole point of drift: independent draws have ~0 autocorrelation,
  // smoothed walks have high autocorrelation. Compare mean |Δv| between
  // adjacent steps for drift=0 (independent) vs drift=0.9 (heavy smoothing).
  // Smoothed must produce smaller adjacent gaps on average.
  const cells = [makeCell('P'), makeCell('L'), makeCell('R'), makeCell('hold')]
  const independent: WalkState = { ...baseState, cells, seed: 13, humanizeDrift: 0 }
  const smoothed: WalkState = { ...baseState, cells, seed: 13, humanizeDrift: 0.9 }
  let independentSum = 0, smoothedSum = 0
  let pairs = 0
  let prevIndep: number | null = null, prevSmooth: number | null = null
  for (let pos = 1; pos <= 200; pos++) {
    const ind = walkStepEvent(independent, pos)!.humanizeVel
    const sm = walkStepEvent(smoothed, pos)!.humanizeVel
    if (prevIndep !== null) {
      independentSum += Math.abs(ind - prevIndep)
      smoothedSum += Math.abs(sm - prevSmooth!)
      pairs++
    }
    prevIndep = ind; prevSmooth = sm
  }
  const meanIndep = independentSum / pairs
  const meanSmooth = smoothedSum / pairs
  assert.ok(meanSmooth < meanIndep * 0.5, `drift=0.9 mean adjacent Δ (${meanSmooth.toFixed(4)}) must be << drift=0 (${meanIndep.toFixed(4)})`)
})

test('walkStepEvent: humanizeProb draw is downstream of humanizeTiming (ADR 005 Phase 5)', () => {
  // Cross-target reproducibility contract: adding humanizeProbability as the
  // 7th PRNG draw must not perturb the first 6 draws — the same seed must
  // produce the same humanizeVel/Gate/Timing as before Phase 5. Pin the first
  // three humanize draws against known mulberry32(seed=7) outputs to lock in
  // the order. Values derived by running mulberry32(7) and noting which draws
  // land at the indices reserved for humanize (4, 5, 6 — after random-direction
  // skip + jitter skip + probability draw).
  //
  // Direct derivation (no jitter, forward direction, single cell, pos=1):
  //   draw 0 = probability (cell.probability=1, always passes)
  //   draw 1 = humanizeVel, draw 2 = humanizeGate,
  //   draw 3 = humanizeTiming, draw 4 = humanizeProb.
  const state: WalkState = {
    ...baseState,
    cells: [makeCell('P', { probability: 1.0 })],
    jitter: 0,
    seed: 7,
  }
  const ev = walkStepEvent(state, 1)!
  // Reproduce the expected stream from mulberry32(7) directly. Skipping draw 0
  // (probability) leaves draws 1..4 for vel/gate/timing/prob in that order.
  const rng = mulberry32(7)
  rng() // probability
  const expVel = rng()
  const expGate = rng()
  const expTiming = rng()
  const expProb = rng()
  assert.equal(ev.humanizeVel, expVel, 'humanizeVel is the 2nd draw')
  assert.equal(ev.humanizeGate, expGate, 'humanizeGate is the 3rd draw')
  assert.equal(ev.humanizeTiming, expTiming, 'humanizeTiming is the 4th draw')
  assert.equal(ev.humanizeProb, expProb, 'humanizeProb is the 5th draw (after timing)')
})
