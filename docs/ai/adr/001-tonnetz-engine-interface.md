# ADR 001: Tonnetz Engine Interface

## Status: Proposed

**Created**: 2026-04-18

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

## Test vectors

A shared JSON file `docs/ai/tonnetz-test-vectors.json` (to be authored in a
follow-up) will enumerate:

- `applyTransform` cases: input triad + op → expected output pitch classes
- Round-trip cases: `(t, op, op)` returns to `t`
- Voice-leading cases: distances between adjacent triads bounded as expected
- Walk cases: `WalkState + pos` → expected triad
- Anchor override cases

Each target's test suite consumes this JSON. This is the mechanism for
cross-target conformance.

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

## Per-target implementation notes

- **m4l (JS)**: Reference port from inboil's `generative.ts` (functions
  `identifyTriad`, `buildFromPc`, `applyTonnetzOp`, `applyVoicing`,
  `addSeventh`). Semantics verified against inboil before writing tests.
- **vst (C++)**: New implementation in `vst/Source/Tonnetz.{h,cpp}`. Tests in
  `vst/tests/test_Tonnetz.cpp` (Catch2). Header-only core preferred for
  reuse by `app/` later.
- **app (C++, future)**: Reuses `vst/` implementation via shared source or
  submodule; does not fork.
