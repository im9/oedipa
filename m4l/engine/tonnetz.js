// Tonnetz engine for Oedipa.
// Spec: docs/ai/adr/001-tonnetz-engine-interface.md
// Runs in Node.js (CommonJS) and in Max for Live jsui (script globals).
// Avoid ES module syntax and features jsui may not support.

function mod12(n) {
  return ((n % 12) + 12) % 12
}

// Identify root pitch class and quality of a triad. Works in any inversion.
// Tries each pitch class as candidate root; a valid triad has intervals
// [0, 4, 7] (major) or [0, 3, 7] (minor) from its root.
function identifyTriad(triad) {
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

// Build a close-position triad with the given rootPc and quality, in the
// octave whose root is nearest to `reference`. Clamps to MIDI 36..84.
function buildTriad(rootPc, quality, reference) {
  let root = Math.floor(reference / 12) * 12 + rootPc
  if (root - reference > 6) root -= 12
  if (reference - root > 6) root += 12
  while (root < 36) root += 12
  while (root > 84) root -= 12
  const third = root + (quality === 'minor' ? 3 : 4)
  const fifth = root + 7
  return [root, third, fifth]
}

// Apply a single neo-Riemannian transform to a triad. Returns a new triad
// (close position) near the input's first element.
function applyTransform(triad, op) {
  const { rootPc, quality } = identifyTriad(triad)
  let newRootPc
  let newQuality
  if (op === 'P') {
    newRootPc = rootPc
    newQuality = quality === 'major' ? 'minor' : 'major'
  } else if (op === 'L') {
    newRootPc = quality === 'major' ? mod12(rootPc + 4) : mod12(rootPc + 8)
    newQuality = quality === 'major' ? 'minor' : 'major'
  } else if (op === 'R') {
    newRootPc = quality === 'major' ? mod12(rootPc + 9) : mod12(rootPc + 3)
    newQuality = quality === 'major' ? 'minor' : 'major'
  } else {
    throw new Error('applyTransform: unknown op ' + op)
  }
  return buildTriad(newRootPc, newQuality, triad[0])
}

// Apply a voicing to a close-position triad [a, b, c].
function applyVoicing(triad, mode) {
  const a = triad[0]
  const b = triad[1]
  const c = triad[2]
  if (mode === 'close') return [a, b, c]
  if (mode === 'spread') return [a, b + 12, c]
  if (mode === 'drop2') return [a, c, b + 12]
  throw new Error('applyVoicing: unknown mode ' + mode)
}

// Append a 7th above the triad's root. maj7 (+11) for major, min7 (+10) for minor.
// Quality is derived from the provided triad (not the voiced array) so that
// voicing reordering does not affect the 7th calculation.
function addSeventh(voiced, triad) {
  const isMajor = mod12(triad[1] - triad[0]) === 4
  const seventh = triad[0] + (isMajor ? 11 : 10)
  return voiced.concat([seventh])
}

// Compute the current chord at step `pos` for a walk state. Deterministic:
// replays the walk from step 0. Anchors reset the transform counter
// (see ADR 001, "Anchor semantics: deliberate divergence from inboil").
function walk(state, pos) {
  const spt = state.stepsPerTransform
  const seq = state.sequence
  const anchors = state.anchors || []
  const anchorAt = {}
  for (let i = 0; i < anchors.length; i++) {
    anchorAt[anchors[i].step] = anchors[i].triad
  }

  let chord = state.startChord.slice()
  let applied = 0
  for (let step = 0; step <= pos; step++) {
    if (anchorAt[step] !== undefined) {
      chord = anchorAt[step].slice()
      applied = 0
    } else if (step > 0 && step % spt === 0) {
      const op = seq[applied % seq.length]
      chord = applyTransform(chord, op)
      applied += 1
    }
  }
  return chord
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    identifyTriad,
    buildTriad,
    applyTransform,
    applyVoicing,
    addSeventh,
    walk,
  }
}
