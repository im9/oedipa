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

export interface Cell {
  op: Op
  velocity: number     // 0..1, multiplier on source velocity
  gate: number         // 0..1, fraction of step length
  probability: number  // 0..1, chance the step plays this visit
  timing: number       // -0.5..+0.5, step-length fraction
}

export const DEFAULT_CELL_FIELDS: Readonly<Omit<Cell, 'op'>> = Object.freeze({
  velocity: 1.0,
  gate: 0.9,
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
  // ADR 005 Phase 5 — time-correlated humanize. EMA factor in [0, 1] applied
  // independently to each of the 4 humanize axes:
  //   v_t = drift * v_{t-1} + (1 - drift) * raw_t,  prev_init = 0.5
  // drift=0 (default/omitted) → identity (raw uniform draws). drift→1 → frozen.
  humanizeDrift?: number
}

export interface StepEvent {
  cellIdx: number        // index into cells[] of the consumed cell
  resolvedOp: Op         // op after jitter substitution
  chord: Triad           // chord cursor AFTER this step's transform
  played: boolean        // false on rest or failed probability roll
  // Uniform [0, 1) values. Always populated regardless of op or probability
  // outcome — host applies cell humanize-amount and signed-noise math
  // (vel + (h*2-1)*amount, etc.) to keep the cross-target stream stable.
  // When WalkState.humanizeDrift > 0, these are EMA-smoothed (per-axis prev
  // state initialized at 0.5, see walkStepEvent); drift=0 → raw uniforms.
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

  // rest is silent by definition; otherwise probability fail = silent-advance.
  const played = op !== 'rest' && rProb < cell.probability
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
  // ADR 005 Phase 5 — per-axis EMA prev state for time-correlated humanize.
  // Initialized at 0.5 (the midpoint of the [0, 1) raw-draw domain → maps to
  // signed 0.0). Reseed-fresh-per-call (matching the chord cursor + PRNG
  // contract) means any-pos restart reproduces identical smoothed sequences.
  const drift = state.humanizeDrift ?? 0
  let prevVel = 0.5, prevGate = 0.5, prevTim = 0.5
  for (let step = 1; step <= pos; step++) {
    if (step % spt !== 0) continue
    const cellIdx = resolveCellIdx(transformIdx, cells.length, direction, rng)
    const cell = cells[cellIdx]!
    const { resolvedOp, played, humanizeVel: rawVel, humanizeGate: rawGate, humanizeTiming: rawTim } =
      stepBoundary(cursor, cell, jitter, rng)
    const humanizeVel = drift * prevVel + (1 - drift) * rawVel
    const humanizeGate = drift * prevGate + (1 - drift) * rawGate
    const humanizeTiming = drift * prevTim + (1 - drift) * rawTim
    prevVel = humanizeVel; prevGate = humanizeGate; prevTim = humanizeTiming
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
