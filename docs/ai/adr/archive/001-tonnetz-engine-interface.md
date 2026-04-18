# ADR 001: Tonnetz Engine Interface

## Status: Implemented

**Created**: 2026-04-18
**Implemented**: 2026-04-18 (m4l reference port; test vectors consumed by [m4l/engine/tonnetz.test.ts](../../../m4l/engine/tonnetz.test.ts))

This ADR defines only the interface contract and shared test vectors. It is
"Implemented" once a reference implementation (m4l) passes the vectors — not
once every target has shipped. Each target's engine implementation is tracked
in its own ADR (see *Scope* below).

## Context

[concept.md](../concept.md) describes Oedipa's musical model in prose: neo-
Riemannian P/L/R transforms on triads, per-step traversal, voicing as an
independent layer. But prose is not a contract. Without a specified interface:

- Each target (`m4l/` in JS, `vst/` in C++, future `app/` in C++) may implement
  divergent semantics
- Musical behavior differences between targets become hard to diagnose
- Cross-target test vectors cannot be written
- The promise of "same Tonnetz walk across all targets" is unverifiable

This ADR defines the **Tonnetz engine interface** — a pure, stateless API that
every target must implement. The host (target-specific code) carries sequencer
state and calls into the engine for each step.

## Decision

Define the engine as a set of **pure functions** operating on plain-value types.
Stateless, no I/O, no globals. Each target implements this interface in its
native language. A shared test vector file verifies cross-target conformance.

Sequencer state (position, sequence index, anchors) lives outside the engine,
in target host code. This keeps the engine trivially portable and testable.

## Interface

### Types

| Type          | Definition                                                 |
|---------------|------------------------------------------------------------|
| `PitchClass`  | integer `0..11` (C=0, C#=1, …, B=11)                       |
| `MidiNote`    | integer `0..127`                                           |
| `Quality`     | `major` \| `minor`                                         |
| `Triad`       | `[MidiNote, MidiNote, MidiNote]` in any inversion          |
| `Transform`   | `P` \| `L` \| `R`                                          |
| `Voicing`     | `close` \| `spread` \| `drop2`                             |

A `Triad` is valid iff its three pitch classes form either a major triad
(intervals 4 and 3 semitones above root) or a minor triad (intervals 3 and 4).
Order within the array is the voicing — any rotation/octave displacement is
permitted.

### Core functions

```
identifyTriad(triad: Triad) -> { rootPc: PitchClass, quality: Quality } | Error
```
Detects root pitch class and quality from any inversion by testing all three
rotations for a valid major or minor interval stack. Returns an error (or
target-idiomatic equivalent) for non-triadic inputs.

```
buildTriad(rootPc: PitchClass, quality: Quality, reference: MidiNote) -> Triad
```
Constructs a root-position triad `[r, r+3|4, r+7]` realized in the octave
nearest to `reference`. Used to rebuild a triad after a pitch-class-space
transform while preserving voice-leading proximity to the previous chord.

```
applyTransform(triad: Triad, op: Transform) -> Triad
```
The main operation. Identifies the input triad, applies the PC-space transform,
rebuilds near the input's mean pitch. See Transform semantics below.

```
applyVoicing(triad: Triad, mode: Voicing) -> MidiNote[]
```
- `close` — `[a, b, c]` (input unchanged, already in close position)
- `spread` — `[a, b + 12, c]` (middle voice up an octave)
- `drop2` — `[a, c, b + 12]` (second-from-top dropped an octave, resulting in
  `[root, fifth, third+12]` for a root-position major)

```
addSeventh(notes: MidiNote[], quality: Quality) -> MidiNote[]
```
Appends a 7th above the root: `+11` for `major` (maj7), `+10` for `minor`
(min7). Applied after voicing.

### Transform semantics

Each transform operates in pitch-class space. Given input
`{ rootPc: r, quality: q }`:

| Op  | major input                    | minor input                    |
|-----|--------------------------------|--------------------------------|
| `P` | `{ r,     minor }`             | `{ r,     major }`             |
| `L` | `{ (r+4) mod 12, minor }`      | `{ (r+8) mod 12, major }`      |
| `R` | `{ (r+9) mod 12, minor }`      | `{ (r+3) mod 12, major }`      |

Semantic notes:
- `P` (Parallel): same root, opposite quality. `C major ↔ C minor`
- `L` (Leading-tone): share the third, opposite quality. `C major ↔ E minor`
- `R` (Relative): share the root+fifth, opposite quality. `C major ↔ A minor`

All three are involutions: `applyTransform(applyTransform(t, op), op) == t`
(up to voicing re-realization).

### Determinism requirement

For any `Triad t` and `Transform op`, `applyTransform(t, op)` MUST produce the
same pitch classes across all targets. The realized octave may differ by ±12
at target boundaries (due to `buildTriad`'s nearest-neighbor rule interacting
with integer rounding), but pitch-class identity is binding.

Targets SHOULD pass the shared test vectors (see below) before any release.

## Sequencer state (reference shape)

The engine is stateless. Targets maintain walk state externally in this
canonical shape:

```
WalkState {
  startChord: Triad
  sequence: Transform[]           // non-empty
  stepsPerTransform: int >= 1
  anchors: (stepIndex, Triad)[]   // sorted by stepIndex
}
```

Given `WalkState` and a host step index `pos`, the current triad is computed:

```
chord = startChord
applied = 0
for step from 0 to pos:
    anchor = anchors.find(a => a.stepIndex == step)
    if anchor:
        chord = anchor.triad
        applied = 0              // reset transform counter at anchors
    else if step > 0 and step % stepsPerTransform == 0:
        op = sequence[applied % sequence.length]
        chord = applyTransform(chord, op)
        applied += 1
return chord
```

Because the walk is deterministic in `pos`, transport scrubbing / resume-from-
arbitrary-position works correctly: the target re-runs the loop from 0 to
current `pos` (or maintains a cache).

This algorithm is a **reference**, not part of the interface. Targets MAY
optimize (incremental update, caching) as long as output matches the reference
for all `(WalkState, pos)` pairs.

### Anchor semantics: deliberate divergence from inboil

The `applied = 0` reset at anchor positions is a **deliberate divergence from
inboil's implementation** (`generative.ts` `computeWalkPath` / `tonnetzGenerate`).
inboil treats anchors as skip-in-place overrides: `seqIdx` is not reset, so the
sequence continues from wherever it paused when the anchor fired.

Oedipa resets the counter at anchors because its target is DAW usage, where:

- Anchors typically align to structural boundaries (bar 1, 5, 9, …) and users
  expect each section to start predictably from `sequence[0]` rather than
  inherit walk state from the previous section.
- Editing the sequence after anchors are placed should have local effects per
  section, not phase-shift across anchor boundaries in non-obvious ways.
- Ableton Session view playback jumps between clips; each clip entry is a
  natural reset point.

inboil's skip-in-place semantics are valid for continuous generative walks
(the context inboil targets); Oedipa's reset semantics are valid for
compositional structure. Both are musically legitimate — the choice is
intentional.

## Test vectors

The shared JSON file [`docs/ai/tonnetz-test-vectors.json`](../tonnetz-test-vectors.json)
enumerates conformance cases across:

- `identify_triad` — triads in all inversions
- `apply_transform` — single P/L/R on major and minor from multiple roots, plus
  inversion handling
- `roundtrip` — involution property for each transform
- `voicing` — close / spread / drop2 on major and minor
- `seventh` — maj7 / min7 addition on each voicing
- `walk` — end-to-end walks including `stepsPerTransform > 1`, anchor reset,
  anchor at step 0, and multiple anchors

Each target's test suite consumes this JSON. Adding a target-specific test that
reads and iterates the cases is the primary conformance mechanism. New cases
are added to the JSON, not duplicated per target.

Binding assertion: the pitch-class set of each result equals the expected
pitch-class set (order-independent). Realized MIDI octaves are implementation-
flexible (see Determinism requirement above).

## Scope

**In scope for this ADR:**
- Triad representation, `P/L/R` semantics, voicing, 7th extension
- Pure-function interface contract
- Walk state reference shape and algorithm
- Determinism requirement

**Out of scope (future ADRs):**
- Rhythm patterns (trigger timing)
- 9/11/13 extensions and non-triadic chords
- Compound transforms as first-class operations
- MIDI I/O (target-specific)
- UI / lattice visualization (target-specific)
- Sequencer state persistence format (target-specific)
- **Per-target engine implementations** — each future target's Tonnetz engine
  gets its own ADR. This ADR covers only the shared contract and cross-target
  conformance vectors. The m4l reference implementation is an exception: it
  lives alongside this ADR because its existence is what promotes this ADR to
  *Implemented*.

## Reference implementation (m4l)

m4l is the current primary target (see [ADR 002](002-m4l-device-architecture.md)),
so its engine serves as the reference implementation for this ADR.

- [m4l/engine/tonnetz.ts](../../../m4l/engine/tonnetz.ts) — ported from
  inboil's `generative.ts` (`identifyTriad`, `buildFromPc`, `applyTonnetzOp`,
  `applyVoicing`, `addSeventh`). Semantics verified against inboil before
  writing tests.
- [m4l/engine/tonnetz.test.ts](../../../m4l/engine/tonnetz.test.ts) — consumes
  [tonnetz-test-vectors.json](../tonnetz-test-vectors.json) for conformance.

Other targets (vst, app) are not yet scoped; when they are picked up, each
will get its own implementation ADR that references this contract.
