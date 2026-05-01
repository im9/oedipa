// Tonnetz engine for Oedipa.
// Spec: docs/ai/adr/archive/001-tonnetz-engine-interface.md (engine ops),
//       docs/ai/adr/005-rhythmic-feel.md (cell record, ops, probability,
//       PRNG draw order)
//
// Emitted as an ES module (see tsconfig.json, package.json "type": "module")
// and consumed in two environments:
// - Node.js tests via `node --test` (types stripped at runtime)
// - Max for Live [node.script] via dist/tonnetz.js (standard `import`)

export type PitchClass = number
export type MidiNote = number
export type Quality = 'major' | 'minor'
export type Triad = [MidiNote, MidiNote, MidiNote]
export type Transform = 'P' | 'L' | 'R'
export type Op = 'P' | 'L' | 'R' | 'hold' | 'rest'
export type Voicing = 'close' | 'spread' | 'drop2'
export type StepDirection = 'forward' | 'reverse' | 'pingpong' | 'random'

// ADR 006 §Phase 7 Step 4 — RHYTHM preset palette ported from inboil's
// TonnetzRhythm (see /src/lib/types.ts:196 + generative.ts:478-513 +
// components/TonnetzSheet.svelte:546 dropdown). Match is at the SPEC
// level (musical intent), not literal-code level. Full UI dropdown match:
//   all        → fires every 16th    (= inboil generative.ts:483)
//   legato     → fires at cell head only (= inboil tonnetzGenerate:598
//                special-cased chord-boundary). Spec-equivalent to inboil
//                even though the predicate folding differs.
//   onbeat     → fires on quarter pulse, i % 4 === 0
//                (= inboil generative.ts:489)
//   offbeat    → fires on &-of-each-quarter, i % 4 === 2 — the standard
//                musical "off-beat" (4 fires/bar, complementary to onbeat,
//                together partitioning the 8th-note grid). DIFFERS from
//                inboil's literal `i % 2 === 1` (every odd 16th = 8
//                fires/bar including e/a positions). Spec-level match
//                (off-beats), not code-level — see ADR 006 §"Implementation
//                note (rev 2026-05-01)" for rationale.
//   syncopated → 8-step pattern [T,F,T,F,F,T,F,T] repeated
//                (= inboil generative.ts:490-493, classic syncopation)
//   turing     → turingRhythm (generative.ts:498-513): stochastic shift
//                register, parameterized by length / lock / seed. Stateful
//                across sub-step boundaries (the register evolves), so
//                evaluated via turingFires() with a host-owned register
//                state, not via the pure gatingFires() predicate.
// Deferred: euclidean (in inboil's type but not in the UI dropdown — no
// user-facing parity needed yet); explicit boolean[] (no Live param shape
// for arrays). Humanize / swing as per-rhythm side effects are gone (no
// inboil basis — inboil keeps swing project-global, no humanize concept);
// if reintroduced they ship as a separate parameter axis, not folded into
// preset.
export type RhythmPreset = 'all' | 'legato' | 'onbeat' | 'offbeat' | 'syncopated' | 'turing'
export type ArpMode = 'off' | 'up' | 'down' | 'updown' | 'random'

// Iteration order for UI dropdowns. Treat as the spec — matches inboil's
// dropdown ordering verbatim.
export const RHYTHM_PRESETS: readonly RhythmPreset[] = [
  'all', 'legato', 'onbeat', 'offbeat', 'syncopated', 'turing',
] as const

export const ARP_MODES: readonly ArpMode[] = [
  'off', 'up', 'down', 'updown', 'random',
] as const

// Within-cell tick gating for the stateless presets (all/legato/onbeat/
// offbeat/syncopated). subStepIdx is a 16th-note step index within the
// current cell (head = 0). Pure function; no PRNG or state. Spec-level
// match to inboil's resolveRhythm (generative.ts:478) — `offbeat` uses
// the standard musical "& of each quarter" definition (i % 4 === 2)
// rather than inboil's literal `i % 2 === 1` (which fires every odd
// 16th, denser than the typical off-beat semantic). Turing uses a
// separate stateful path (turingFires) because its register evolves
// per step.
const SYNCOPATED_PATTERN: readonly boolean[] = [true, false, true, false, false, true, false, true]
export function gatingFires(mode: Exclude<RhythmPreset, 'turing'>, subStepIdx: number): boolean {
  switch (mode) {
    case 'all':        return true
    case 'legato':     return subStepIdx === 0
    case 'onbeat':     return subStepIdx % 4 === 0
    case 'offbeat':    return subStepIdx % 4 === 2
    case 'syncopated': return SYNCOPATED_PATTERN[subStepIdx % SYNCOPATED_PATTERN.length]!
  }
}

// Turing-machine rhythm (inboil generative.ts:498-513). Stateful: the
// register evolves on every call (one step per call). Caller owns the
// state; engine provides constructor + step function. registerToFraction
// (generative.ts:136-142) computes the unsigned-integer fraction as
// `sum(register[i] * 2^i) / (2^length - 1)`. fires when frac >= 0.5.
// After computing, the register shifts: lastBit slides off, with prob
// (1 - lock) it flips on its way to position 0; otherwise stays.
export interface TuringRhythmState {
  // 0/1 bits, length matches the configured length. index 0 = "newest".
  register: number[]
  // Seeded mulberry32 stream — same algorithm as inboil's seededRng
  // (generative.ts:678-685, mulberry32 verbatim).
  rng: () => number
}

const TURING_LENGTH_MIN = 2
const TURING_LENGTH_MAX = 32

export function makeTuringState(length: number, seed: number): TuringRhythmState {
  // inboil's turingRhythm (generative.ts:499-501) seeds an RNG and fills
  // the register from random bits before producing any output.
  const len = Math.max(TURING_LENGTH_MIN, Math.min(TURING_LENGTH_MAX, Math.floor(length)))
  const rng = mulberry32(seed >>> 0)
  const register: number[] = []
  for (let i = 0; i < len; i++) register.push(rng() < 0.5 ? 1 : 0)
  return { register, rng }
}

// Compute the fires-this-step bool, then advance the register exactly as
// inboil's turingRhythm loop body (generative.ts:504-510). lock ∈ [0, 1]:
// 1.0 = frozen loop (lastBit always carried over), 0.0 = fully random
// (lastBit always flipped before insertion).
export function turingFires(state: TuringRhythmState, lock: number): boolean {
  const len = state.register.length
  let sum = 0
  for (let i = 0; i < len; i++) sum += state.register[i]! * (1 << i)
  const max = (1 << len) - 1 || 1
  const frac = sum / max
  const fires = frac >= 0.5

  const lockClamped = lock < 0 ? 0 : lock > 1 ? 1 : lock
  const flipProb = 1 - lockClamped
  const lastBit = state.register[len - 1]!
  for (let j = len - 1; j > 0; j--) state.register[j] = state.register[j - 1]!
  state.register[0] = state.rng() < flipProb ? (1 - lastBit) : lastBit
  return fires
}

// ARP note picker. Returns the index into the voiced chord array to play
// at this fire, or null for 'off' / empty chord. fireIdx is the count of
// ARP-active fires since the cell head (caller resets to 0 at every cell
// boundary). PRNG draws: 0 for non-random modes; 1 for random when
// chordSize > 1; 0 for random when chordSize <= 1 (early-exit). Caller
// supplies the same RNG used elsewhere in the cell loop so the ARP draw
// participates in the deterministic stream.
export function arpIndex(
  mode: ArpMode,
  chordSize: number,
  fireIdx: number,
  rng: () => number,
): number | null {
  if (mode === 'off') return null
  if (chordSize <= 0) return null
  if (chordSize === 1) return 0
  switch (mode) {
    case 'up':     return fireIdx % chordSize
    case 'down':   return chordSize - 1 - (fireIdx % chordSize)
    case 'updown': {
      const period = 2 * (chordSize - 1)
      const i = fireIdx % period
      return i < chordSize ? i : period - i
    }
    case 'random': return Math.floor(rng() * chordSize)
  }
}


export interface Cell {
  op: Op
  velocity: number     // 0..1, multiplier on source velocity
  gate: number         // 0..1, fraction of step length
  probability: number  // 0..1, chance the step plays this visit
  timing: number       // -0.5..+0.5, step-length fraction
}

export const DEFAULT_CELL_FIELDS: Readonly<Omit<Cell, 'op'>> = Object.freeze({
  velocity: 1.0,
  // gate=1.0 is legato handoff: cell's noteOff coincides with the next cell's
  // noteOn, no audible gap. Combined with hold-as-silent-advance, hold cells
  // truly sustain the prior chord. The earlier 0.9 default produced a 10%
  // gap per cell, which read as "chord stab" rather than chord progression
  // and made hold cells fully silent.
  gate: 1.0,
  probability: 1.0,
  timing: 0.0,
})

export function makeCell(op: Op, overrides: Partial<Omit<Cell, 'op'>> = {}): Cell {
  return {
    op,
    velocity: overrides.velocity ?? DEFAULT_CELL_FIELDS.velocity,
    gate: overrides.gate ?? DEFAULT_CELL_FIELDS.gate,
    probability: overrides.probability ?? DEFAULT_CELL_FIELDS.probability,
    timing: overrides.timing ?? DEFAULT_CELL_FIELDS.timing,
  }
}

// Jitter substitution pool — 'rest' is intentionally excluded so random op
// substitution never injects unintended silence (ADR 005).
const CELL_OPS: readonly Op[] = ['P', 'L', 'R', 'hold']

export interface WalkState {
  startChord: Triad
  cells: Cell[]
  stepsPerTransform: number
  jitter: number
  seed: number
  // ADR 005 Phase 3 — defaults to 'forward' when omitted.
  stepDirection?: StepDirection
}

export interface StepEvent {
  cellIdx: number        // index into cells[] of the consumed cell
  resolvedOp: Op         // op after jitter substitution
  chord: Triad           // chord cursor AFTER this step's transform
  played: boolean        // false on rest or failed probability roll
  // Uniform [0, 1) values. Always populated regardless of op or probability
  // outcome — host applies preset humanize-amount and signed-noise math
  // (vel + (h*2-1)*amount, etc.) to keep the cross-target stream stable.
  humanizeVel: number
  humanizeGate: number
  humanizeTiming: number
}

function mod12(n: number): PitchClass {
  return ((n % 12) + 12) % 12
}

export function identifyTriad(triad: Triad): { rootPc: PitchClass; quality: Quality } {
  const pcs = triad.map(mod12)
  for (const pc of pcs) {
    const ints = pcs.map(p => mod12(p - pc)).sort((a, b) => a - b)
    if (ints[0] === 0 && ints[1] === 4 && ints[2] === 7) {
      return { rootPc: pc, quality: 'major' }
    }
    if (ints[0] === 0 && ints[1] === 3 && ints[2] === 7) {
      return { rootPc: pc, quality: 'minor' }
    }
  }
  throw new Error('identifyTriad: input is not a major or minor triad')
}

// Subset search for triad recognition from held MIDI notes (ADR 004 Axis 1).
// Iterates every 3-element subset of `notes` and runs identifyTriad on each.
// Among matching subsets, picks the one whose root MIDI value (the held note
// matching identifyTriad's rootPc) is lowest, and returns
// buildTriad(rootPc, quality, rootMidi). Returns null if no subset matches.
//
// Inputs are treated as a set: duplicate MIDI values produce undefined
// behavior. Sorted ascending internally so enumeration order is deterministic
// regardless of caller input order.
export function findTriadInHeldNotes(notes: MidiNote[]): Triad | null {
  if (notes.length < 3) return null
  const sorted = [...notes].sort((a, b) => a - b)
  let bestRootPc: PitchClass | null = null
  let bestQuality: Quality | null = null
  let bestRootMidi = Infinity
  for (let i = 0; i < sorted.length - 2; i++) {
    for (let j = i + 1; j < sorted.length - 1; j++) {
      for (let k = j + 1; k < sorted.length; k++) {
        const subset: Triad = [sorted[i]!, sorted[j]!, sorted[k]!]
        let id: { rootPc: PitchClass; quality: Quality }
        try {
          id = identifyTriad(subset)
        } catch {
          continue
        }
        const rootMidi = subset.find(n => mod12(n) === id.rootPc)!
        if (rootMidi < bestRootMidi) {
          bestRootPc = id.rootPc
          bestQuality = id.quality
          bestRootMidi = rootMidi
        }
      }
    }
  }
  if (bestRootPc === null) return null
  return buildTriad(bestRootPc, bestQuality!, bestRootMidi)
}

export function buildTriad(rootPc: PitchClass, quality: Quality, reference: MidiNote): Triad {
  let root = Math.floor(reference / 12) * 12 + rootPc
  if (root - reference > 6) root -= 12
  if (reference - root > 6) root += 12
  while (root < 36) root += 12
  while (root > 84) root -= 12
  const third = root + (quality === 'minor' ? 3 : 4)
  const fifth = root + 7
  return [root, third, fifth]
}

export function applyTransform(triad: Triad, op: Transform): Triad {
  const { rootPc, quality } = identifyTriad(triad)
  let newRootPc: PitchClass
  const newQuality: Quality = quality === 'major' ? 'minor' : 'major'
  if (op === 'P') {
    newRootPc = rootPc
  } else if (op === 'L') {
    newRootPc = quality === 'major' ? mod12(rootPc + 4) : mod12(rootPc + 8)
  } else if (op === 'R') {
    newRootPc = quality === 'major' ? mod12(rootPc + 9) : mod12(rootPc + 3)
  } else {
    const _exhaustive: never = op
    throw new Error('applyTransform: unknown op ' + _exhaustive)
  }
  return buildTriad(newRootPc, newQuality, triad[0])
}

export function applyVoicing(triad: Triad, mode: Voicing): MidiNote[] {
  const [a, b, c] = triad
  if (mode === 'close') return [a, b, c]
  if (mode === 'spread') return [a, b + 12, c]
  if (mode === 'drop2') return [a, c, b + 12]
  const _exhaustive: never = mode
  throw new Error('applyVoicing: unknown mode ' + _exhaustive)
}

export function addSeventh(voiced: MidiNote[], triad: Triad): MidiNote[] {
  const isMajor = mod12(triad[1] - triad[0]) === 4
  const seventh = triad[0] + (isMajor ? 11 : 10)
  return voiced.concat([seventh])
}

// mulberry32 PRNG. Cross-target conformance: the algorithm is fixed by
// docs/ai/tonnetz-test-vectors.json "mulberry32". Returns a function that
// produces successive [0, 1) floats. Pure: same seed → same stream.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6D2B79F5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Resolves which cell is consumed at a transform boundary, given the running
// transform index and the configured direction. For 'random', consumes 1 draw
// from `rng` — caller MUST invoke this BEFORE jitter draws to match the
// documented PRNG draw order (ADR 005 §"PRNG draw order").
function resolveCellIdx(
  transformIdx: number,
  cellsLength: number,
  direction: StepDirection,
  rng: () => number,
): number {
  if (direction === 'random') {
    return Math.floor(rng() * cellsLength)
  }
  if (direction === 'forward') {
    return transformIdx % cellsLength
  }
  if (direction === 'reverse') {
    return (((cellsLength - 1 - transformIdx) % cellsLength) + cellsLength) % cellsLength
  }
  // pingpong — period 2*(N-1), endpoints are NOT replayed.
  if (cellsLength <= 1) return 0
  const period = 2 * (cellsLength - 1)
  const idx = ((transformIdx % period) + period) % period
  return idx < cellsLength ? idx : period - idx
}

// Per-step boundary simulation. Advances `cursor.chord` for P/L/R, leaves
// it untouched for hold/rest, consumes PRNG draws in the documented order,
// and returns the resolved op, played flag, and humanize raw draws.
//
// PRNG draw order (ADR 005 §"PRNG draw order"):
// 1. stepDirection — 1 draw iff stepDirection=='random' (consumed by
//    resolveCellIdx in the caller, BEFORE this function runs)
// 2. jitter — 2 draws iff jitter > 0 AND cell.op !== 'rest', else 0
// 3. probability — 1 draw, always
// 4. humanizeVelocity — 1 draw, always
// 5. humanizeGate — 1 draw, always
// 6. humanizeTiming — 1 draw, always
function stepBoundary(
  cursor: { chord: Triad },
  cell: Cell,
  jitter: number,
  rng: () => number,
): {
  resolvedOp: Op
  played: boolean
  humanizeVel: number
  humanizeGate: number
  humanizeTiming: number
} {
  let op: Op = cell.op

  if (jitter > 0 && op !== 'rest') {
    const rSubstitute = rng()
    const rPick = rng()
    if (rSubstitute < jitter) {
      op = CELL_OPS[Math.floor(rPick * CELL_OPS.length)]!
    }
  }

  const rProb = rng()
  const humanizeVel = rng()
  const humanizeGate = rng()
  const humanizeTiming = rng()

  if (op === 'P' || op === 'L' || op === 'R') {
    cursor.chord = applyTransform(cursor.chord, op)
  }
  // 'hold' and 'rest' leave the cursor untouched.

  // 'hold' = sustain previous chord (silent advance, no new attack). Combined
  // with prior cell's legato handoff (gate=1.0) this extends the held chord
  // through the hold cell — the natural "this chord lasts longer" gesture.
  // With prior gate < 1.0 the prior chord has already released, so a hold
  // cell produces audible silence; that's expected — the user is asking for
  // "no new event here". 'rest' is silent by definition; for P/L/R/jittered
  // ops, probability fail also collapses to silent-advance.
  const played = op !== 'rest' && op !== 'hold' && rProb < cell.probability
  return { resolvedOp: op, played, humanizeVel, humanizeGate, humanizeTiming }
}

// Cell sequencer walk. Returns the chord cursor at `pos`.
//
// The chord cursor is independent of probability rolls (probability fail is
// silent-advance — cursor still applies the transform). Use walkStepEvent
// to observe per-step audio outcome.
//
// PRNG is reseeded fresh from `seed` on every call so any-pos restart yields
// the same triad — this is the "transport restart" contract.
export function walk(state: WalkState, pos: number): Triad {
  const { startChord, cells, stepsPerTransform: spt, jitter, seed } = state
  const direction: StepDirection = state.stepDirection ?? 'forward'
  const cursor: { chord: Triad } = { chord: [startChord[0], startChord[1], startChord[2]] }
  if (pos <= 0 || cells.length === 0) return cursor.chord

  const rng = mulberry32(seed)
  let transformIdx = 0
  for (let step = 1; step <= pos; step++) {
    if (step % spt !== 0) continue
    const cellIdx = resolveCellIdx(transformIdx, cells.length, direction, rng)
    const cell = cells[cellIdx]!
    stepBoundary(cursor, cell, jitter, rng)
    transformIdx += 1
  }
  return cursor.chord
}

// Returns the per-step event for the cell consumed at transform boundary
// `pos`. Returns null when pos <= 0, cells is empty, or pos is not a
// boundary (pos % stepsPerTransform !== 0).
//
// Re-simulates from pos=0 with a fresh PRNG, matching walk()'s reseeding
// contract. The host can call this at boundary ticks to learn cellIdx,
// resolvedOp (post-jitter), the post-step chord cursor, played, and the
// raw humanize draws.
export function walkStepEvent(state: WalkState, pos: number): StepEvent | null {
  if (pos <= 0) return null
  const { startChord, cells, stepsPerTransform: spt, jitter, seed } = state
  const direction: StepDirection = state.stepDirection ?? 'forward'
  if (cells.length === 0 || pos % spt !== 0) return null

  const cursor: { chord: Triad } = { chord: [startChord[0], startChord[1], startChord[2]] }
  const rng = mulberry32(seed)
  let transformIdx = 0
  let result: StepEvent | null = null
  for (let step = 1; step <= pos; step++) {
    if (step % spt !== 0) continue
    const cellIdx = resolveCellIdx(transformIdx, cells.length, direction, rng)
    const cell = cells[cellIdx]!
    const { resolvedOp, played, humanizeVel, humanizeGate, humanizeTiming } =
      stepBoundary(cursor, cell, jitter, rng)
    if (step === pos) {
      result = {
        cellIdx,
        resolvedOp,
        chord: [cursor.chord[0], cursor.chord[1], cursor.chord[2]],
        played,
        humanizeVel,
        humanizeGate,
        humanizeTiming,
      }
    }
    transformIdx += 1
  }
  return result
}
