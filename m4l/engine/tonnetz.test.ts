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
  makeTuringState,
  mulberry32,
  findTriadInHeldNotes,
  gatingFires,
  arpIndex,
  turingFires,
  type Triad,
  type Transform,
  type Op,
  type Cell,
  type StepDirection,
  type Voicing,
  type WalkState,
  type RhythmPreset,
  type ArpMode,
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

interface GatingFiresCase {
  preset: RhythmPreset
  subStepIdx: number
  fires: boolean
}

interface ArpIndexCase {
  mode: ArpMode
  chordSize: number
  fireIdx: number
  expected: number | null
}

interface TuringRhythmCase {
  length: number
  lock: number
  seed: number
  stream: number[]
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
  gating_fires: { description: string; cases: GatingFiresCase[] }
  arp_index: { description: string; cases: ArpIndexCase[] }
  turing_rhythm: { description: string; cases: TuringRhythmCase[] }
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

test('findTriadInHeldNotes — caps input at 12 notes (audit High #3, 2026-05-10)', () => {
  // Sustain-pedal pile-up can stack 20-30 notes; at that input size the
  // O(N³) search costs ~27 000 iterations per noteIn. Cap at 12 — beyond
  // that, treat as "not a recognisable held chord" and return null so
  // the caller leaves startChord alone.
  const c_major = [60, 64, 67]
  // 12 notes — exactly at the cap, search runs.
  const at_cap = [...c_major, 50, 52, 53, 55, 57, 58, 59, 61, 62]
  assert.ok(at_cap.length === 12)
  const inCap = findTriadInHeldNotes(at_cap)
  assert.ok(inCap !== null, 'at-cap input still searches')
  // 13 notes — over the cap, search bails.
  const over_cap = [...at_cap, 65]
  assert.ok(over_cap.length === 13)
  assert.equal(findTriadInHeldNotes(over_cap), null,
    'over-cap input returns null without searching')
})

test('gatingFires (Phase 7 Step 4 within-cell predicate, inboil-aligned)', async (t) => {
  for (const tc of vectors.gating_fires.cases) {
    await t.test(`${tc.preset} idx=${tc.subStepIdx} → ${tc.fires}`, () => {
      assert.equal(gatingFires(tc.preset, tc.subStepIdx), tc.fires)
    })
  }
})

test('arpIndex (Phase 7 Step 4 deterministic modes)', async (t) => {
  // Cross-target conformance for off / up / down / updown. Random consumes
  // a PRNG draw and is verified separately (engine TS unit tests pin the
  // mulberry32-seeded draw stream).
  const rng = (): number => { throw new Error('rng must not be called for deterministic arp modes') }
  for (const tc of vectors.arp_index.cases) {
    await t.test(`${tc.mode} chordSize=${tc.chordSize} fireIdx=${tc.fireIdx} → ${tc.expected}`, () => {
      assert.equal(arpIndex(tc.mode, tc.chordSize, tc.fireIdx, rng), tc.expected)
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
  assert.equal(c.gate, 1.0)
  assert.equal(c.probability, 1.0)
  assert.equal(c.timing, 0.0)
})

test('makeCell: overrides win', () => {
  const c = makeCell('hold', { velocity: 0.5, timing: -0.1 })
  assert.equal(c.op, 'hold')
  assert.equal(c.velocity, 0.5)
  assert.equal(c.timing, -0.1)
  // unchanged defaults
  assert.equal(c.gate, 1.0)
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
    for (const [name, v] of [['vel', a!.humanizeVel], ['gate', a!.humanizeGate], ['timing', a!.humanizeTiming]] as const) {
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
  }
})

test('walkStepEvent: PRNG draw order pins humanize draws at fixed indices', () => {
  // Cross-target reproducibility contract: the per-step PRNG sequence is
  // (1) probability, (2) humanizeVel, (3) humanizeGate, (4) humanizeTiming.
  // Direct derivation (no jitter, forward direction, single cell, pos=1):
  //   draw 0 = probability (cell.probability=1, always passes)
  //   draw 1 = humanizeVel, draw 2 = humanizeGate, draw 3 = humanizeTiming.
  const state: WalkState = {
    ...baseState,
    cells: [makeCell('P', { probability: 1.0 })],
    jitter: 0,
    seed: 7,
  }
  const ev = walkStepEvent(state, 1)!
  // Reproduce the expected stream from mulberry32(7) directly. Skipping draw 0
  // (probability) leaves draws 1..3 for vel/gate/timing in that order.
  const rng = mulberry32(7)
  rng() // probability
  const expVel = rng()
  const expGate = rng()
  const expTiming = rng()
  assert.equal(ev.humanizeVel, expVel, 'humanizeVel is the 2nd draw')
  assert.equal(ev.humanizeGate, expGate, 'humanizeGate is the 3rd draw')
  assert.equal(ev.humanizeTiming, expTiming, 'humanizeTiming is the 4th draw')
})

// --- ADR 006 Phase 7 Step 4 (rev 2026-05-01): RHYTHM preset, inboil-exact ---
//
// gatingFires(preset, subStepIdx) — within-cell tick gating, mirrors
// inboil's resolveRhythm (src/lib/generative.ts:478). subStepIdx is a
// 16th-note step index within the cell (head=0). 'all' fires every
// sub-step, 'legato' only at the cell head, 'onbeat'/'offbeat' use
// inboil's modulo predicates verbatim, 'syncopated' uses inboil's 8-step
// pattern. Spec: docs/ai/adr/006-workflow.md §"Phase 7" RHYTHM table.

test('gatingFires: all fires at every sub-step (inboil resolveRhythm `all`)', () => {
  for (let i = 0; i < 32; i++) {
    assert.strictEqual(gatingFires('all', i), true, `idx=${i}`)
  }
})

test('gatingFires: legato fires at idx=0 only (cell-head only)', () => {
  // inboil's tonnetzGenerate (generative.ts:598) treats legato as
  // "active only at chord boundary" — Oedipa cell boundary is idx=0.
  assert.strictEqual(gatingFires('legato', 0), true)
  for (let i = 1; i < 32; i++) {
    assert.strictEqual(gatingFires('legato', i), false, `idx=${i}`)
  }
})

test('gatingFires: onbeat fires on idx % 4 === 0 (inboil `onbeat`)', () => {
  // inboil generative.ts:489 — `i % 4 === 0`. 16th grid: fires on quarter
  // pulse (idx 0, 4, 8, 12, ...).
  for (let i = 0; i < 32; i++) {
    assert.strictEqual(gatingFires('onbeat', i), i % 4 === 0, `idx=${i}`)
  }
})

test('gatingFires: offbeat fires on `&-of-each-quarter` (idx % 4 === 2)', () => {
  // Standard musical "off-beat" semantic: 4 fires/bar at the &-positions
  // (16th idx 2, 6, 10, 14), complementary to onbeat (idx 0, 4, 8, 12).
  // INTENTIONAL DIVERGENCE from inboil's literal `i % 2 === 1` (every odd
  // 16th = 8 fires/bar including e/a positions), which audibly reads as
  // 8th-note tremolo rather than off-beats. We match inboil's spec
  // (off-beats), not its literal predicate. ADR 006 §"Implementation note".
  for (let i = 0; i < 32; i++) {
    assert.strictEqual(gatingFires('offbeat', i), i % 4 === 2, `idx=${i}`)
  }
})

test('gatingFires: syncopated follows inboil 8-step pattern [T,F,T,F,F,T,F,T]', () => {
  // inboil generative.ts:490–493 — `[true,false,true,false,false,true,false,true]`
  // repeated. Fires at idx % 8 ∈ {0, 2, 5, 7}.
  const pat = [true, false, true, false, false, true, false, true]
  for (let i = 0; i < 32; i++) {
    assert.strictEqual(gatingFires('syncopated', i), pat[i % 8], `idx=${i}`)
  }
})

// arpIndex(mode, chordSize, fireIdx, rng) — pure ARP note picker. Returns
// the index into the voiced chord array to play (or null for 'off' /
// degenerate empty chord). Caller manages fireIdx (0 at cell head,
// post-incremented per ARP-active fire). Spec: ADR 006 §"Phase 7" ARP.

test('arpIndex: off returns null regardless of inputs', () => {
  const rng = mulberry32(1)
  for (const cs of [0, 1, 3, 7]) {
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(arpIndex('off', cs, i, rng), null)
    }
  }
})

test('arpIndex: up cycles 0..chordSize-1 (low-to-high, wraps)', () => {
  const rng = mulberry32(0)
  for (let i = 0; i < 9; i++) {
    assert.strictEqual(arpIndex('up', 3, i, rng), i % 3)
  }
})

test('arpIndex: down cycles chordSize-1..0 (high-to-low, wraps)', () => {
  const rng = mulberry32(0)
  const expected = [2, 1, 0, 2, 1, 0]
  for (let i = 0; i < expected.length; i++) {
    assert.strictEqual(arpIndex('down', 3, i, rng), expected[i])
  }
})

test('arpIndex: updown traverses 0..top..1 without endpoint repeat', () => {
  const rng = mulberry32(0)
  const expected = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0]
  for (let i = 0; i < expected.length; i++) {
    assert.strictEqual(arpIndex('updown', 4, i, rng), expected[i])
  }
})

test('arpIndex: random returns int in [0, chordSize) and consumes 1 rng draw', () => {
  const rng = mulberry32(42)
  const fresh = mulberry32(42)
  const got = arpIndex('random', 3, 0, rng)!
  const expected = Math.floor(fresh() * 3)
  assert.ok(Number.isInteger(got) && got >= 0 && got < 3, `got=${got}`)
  assert.strictEqual(got, expected, 'matches Math.floor(rng() * chordSize)')
  assert.strictEqual(rng(), fresh(), 'arpIndex consumed exactly 1 draw')
})

test('arpIndex: chordSize=1 always returns 0 for non-off modes', () => {
  const rng = mulberry32(0)
  for (const mode of ['up', 'down', 'updown', 'random'] as const) {
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(arpIndex(mode, 1, i, rng), 0, `mode=${mode} i=${i}`)
    }
  }
})

test('turingFires (Phase 7 Step 4 rev 2 — cross-target stream)', async (t) => {
  for (const tc of vectors.turing_rhythm.cases) {
    await t.test(`length=${tc.length} lock=${tc.lock} seed=${tc.seed}`, () => {
      const state = makeTuringState(tc.length, tc.seed)
      const got: number[] = []
      for (let i = 0; i < tc.stream.length; i++) {
        got.push(turingFires(state, tc.lock) ? 1 : 0)
      }
      assert.deepStrictEqual(got, tc.stream)
    })
  }
})

test('arpIndex: chordSize=0 returns null for every mode', () => {
  const rng = mulberry32(0)
  const modes: ArpMode[] = ['off', 'up', 'down', 'updown', 'random']
  for (const mode of modes) {
    assert.strictEqual(arpIndex(mode, 0, 0, rng), null, `mode=${mode}`)
  }
})

// ── ADR 006 Phase 7 Step 4 rev 2 — Turing rhythm (inboil generative.ts:498-513) ──
//
// Reference port of inboil's turingRhythm(length, lock, steps, seed) — used as
// a ground-truth oracle so any engine drift from inboil's algorithm trips a
// test. The implementation must match inboil verbatim including PRNG
// (mulberry32) and register-shift order.

function inboilTuringRhythm(length: number, lock: number, steps: number, seed: number): boolean[] {
  const rng = mulberry32(seed >>> 0)
  const register: number[] = []
  for (let i = 0; i < length; i++) register.push(rng() < 0.5 ? 1 : 0)
  const result: boolean[] = []
  for (let i = 0; i < steps; i++) {
    let sum = 0
    for (let j = 0; j < length; j++) sum += register[j]! * (1 << j)
    const max = (1 << length) - 1 || 1
    result.push(sum / max >= 0.5)
    const flipProb = 1 - lock
    const lastBit = register[length - 1]!
    for (let j = length - 1; j > 0; j--) register[j] = register[j - 1]!
    register[0] = rng() < flipProb ? (1 - lastBit) : lastBit
  }
  return result
}

test('turingFires: matches inboil turingRhythm output verbatim (cross-target ground truth)', () => {
  // Sweep multiple (length, lock, seed) combos to lock the algorithm to
  // inboil's exact behavior — same PRNG draw order, register shift,
  // fraction-threshold predicate.
  const cases: Array<[number, number, number, number]> = [
    [4, 0.7, 1, 32],   // small length, default lock
    [8, 0.7, 0, 32],   // inboil UI default (length=8, lock=0.7)
    [8, 1.0, 7, 32],   // lock=1 (frozen)
    [8, 0.0, 7, 32],   // lock=0 (max chaos)
    [16, 0.5, 42, 64], // larger length, mid lock
    [2, 0.7, 99, 16],  // minimum length
  ]
  for (const [length, lock, seed, steps] of cases) {
    const expected = inboilTuringRhythm(length, lock, steps, seed)
    const state = makeTuringState(length, seed)
    const got: boolean[] = []
    for (let i = 0; i < steps; i++) got.push(turingFires(state, lock))
    assert.deepStrictEqual(got, expected, `length=${length} lock=${lock} seed=${seed}`)
  }
})

test('turingFires: same seed → same stream across two fresh states (determinism)', () => {
  const a = makeTuringState(8, 42)
  const b = makeTuringState(8, 42)
  for (let i = 0; i < 64; i++) {
    assert.strictEqual(turingFires(a, 0.7), turingFires(b, 0.7), `step ${i} must match`)
  }
})

test('turingFires: lock=1.0 produces a periodic loop (register frozen)', () => {
  // With lock=1, lastBit always carries over → register cycles every `length`
  // shifts and produces an exactly-periodic output.
  const length = 6
  const state = makeTuringState(length, 13)
  const stream: boolean[] = []
  for (let i = 0; i < length * 4; i++) stream.push(turingFires(state, 1.0))
  // The output should have period `length` exactly: stream[i] === stream[i + length].
  for (let i = 0; i < length * 3; i++) {
    assert.strictEqual(stream[i], stream[i + length], `period mismatch at i=${i}`)
  }
})

test('turingFires: makeTuringState clamps length to [2, 32]', () => {
  // Defensive: out-of-range length defaults must not throw or produce a
  // zero-length register (which would crash the bit-sum loop).
  const tooSmall = makeTuringState(1, 0)
  assert.strictEqual(tooSmall.register.length, 2, 'length=1 clamps up to 2')
  const tooBig = makeTuringState(100, 0)
  assert.strictEqual(tooBig.register.length, 32, 'length=100 clamps down to 32')
})
