// Tonnetz engine for Oedipa.
// Spec: docs/ai/adr/archive/001-tonnetz-engine-interface.md (engine ops),
//       docs/ai/adr/003-m4l-parameters-state.md (cell sequencer + jitter)
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
export type Cell = Transform | 'hold'
export type Voicing = 'close' | 'spread' | 'drop2'

export interface WalkState {
  startChord: Triad
  cells: Cell[]
  stepsPerTransform: number
  jitter: number
  seed: number
}

const CELL_OPS: readonly Cell[] = ['P', 'L', 'R', 'hold']

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

// Cell sequencer walk.
// At each transform boundary the next cell is consumed. With probability
// `jitter`, the cell's op is replaced by a uniformly-random pick from CELL_OPS
// (using two PRNG floats per transform: substitute-or-not, then which op).
// `hold` (whether authored or rolled) leaves the chord unchanged.
//
// PRNG is reseeded fresh from `seed` on every call so any-pos restart yields
// the same triad — this is the "transport restart" contract.
export function walk(state: WalkState, pos: number): Triad {
  const { startChord, cells, stepsPerTransform: spt, jitter, seed } = state
  let chord: Triad = [startChord[0], startChord[1], startChord[2]]
  if (pos <= 0 || cells.length === 0) return chord

  const rng = mulberry32(seed)
  let transformIdx = 0
  for (let step = 1; step <= pos; step++) {
    if (step % spt !== 0) continue

    let op: Cell = cells[transformIdx % cells.length]!
    const rSubstitute = rng()
    const rPick = rng()
    if (rSubstitute < jitter) {
      op = CELL_OPS[Math.floor(rPick * CELL_OPS.length)]!
    }

    if (op !== 'hold') {
      chord = applyTransform(chord, op)
    }
    transformIdx += 1
  }
  return chord
}
