// Tonnetz engine for Oedipa.
// Spec: docs/ai/adr/archive/001-tonnetz-engine-interface.md
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
export type Voicing = 'close' | 'spread' | 'drop2'

export interface Anchor {
  step: number
  triad: Triad
}

export interface WalkState {
  startChord: Triad
  sequence: Transform[]
  stepsPerTransform: number
  anchors?: Anchor[]
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

export function walk(state: WalkState, pos: number): Triad {
  const spt = state.stepsPerTransform
  const seq = state.sequence
  const anchors = state.anchors ?? []
  const anchorAt: { [step: number]: Triad } = {}
  for (const a of anchors) {
    anchorAt[a.step] = a.triad
  }

  let chord: Triad = [state.startChord[0], state.startChord[1], state.startChord[2]]
  let applied = 0
  for (let step = 0; step <= pos; step++) {
    const anchor = anchorAt[step]
    if (anchor !== undefined) {
      chord = [anchor[0], anchor[1], anchor[2]]
      applied = 0
    } else if (step > 0 && step % spt === 0) {
      const op = seq[applied % seq.length]!
      chord = applyTransform(chord, op)
      applied += 1
    }
  }
  return chord
}
