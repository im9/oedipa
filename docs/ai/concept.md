# Concept

Oedipa is a Tonnetz-based chord exploration MIDI tool. It walks a neo-Riemannian
lattice on every clock tick, emitting triads that move through smooth voice-
leading relationships.

This document describes the **musical model** — the parts that are shared across
all targets (`m4l/`, `vst/`, `app/`). Target-specific UI and interaction design
live in separate docs.

## What Oedipa does

On each step of the host transport, Oedipa:

1. Applies the next transform in a user-defined **sequence** to the current triad.
2. Advances by one position on the Tonnetz lattice.
3. Emits the resulting chord as MIDI notes, shaped by voicing and rhythm settings.

The user shapes the output by defining the transform sequence, the rate, the
voicing, and optional anchor points. The Tonnetz handles harmony; the user handles
motion.

## Musical model

### Tonnetz lattice

The Tonnetz is a 2D triangular lattice where each vertex is a triad (major △ or
minor ▽) and adjacent vertices are connected by one of three transforms. Major
and minor triads alternate — any single transform flips the quality.

### Neo-Riemannian transforms

Three unit operations, each swapping two notes of a triad by minimal voice
leading:

- **P (Parallel)** — flip major ↔ minor, same root.
  `C major ↔ C minor`
- **L (Leading-tone)** — shared third, opposite quality.
  `C major ↔ E minor`
- **R (Relative)** — shared root+fifth, opposite quality.
  `C major ↔ A minor`

Each transform moves exactly one note by a semitone or whole tone. Consecutive
transforms can be composed (`PL`, `LR`, `PLR`, …) to reach any triad in at most
a few steps.

### Triad representation

A triad is `[root, third, fifth]` as MIDI note numbers in any inversion. Operations
identify the triad's pitch classes, apply the transform in pitch-class space, then
reconstruct the nearest realization to the current voicing. This preserves octave
proximity and avoids large jumps.

### Traversal

Traversal is **deterministic and sequence-driven**, not random. The user specifies
an ordered list of transforms (e.g. `[P, L, R, L]`) which is applied cyclically.
This makes the output reproducible and musically intentional — randomness, if
desired, is a layer on top, not the core behavior.

**Rate**: `stepsPerTransform` controls how many host steps each chord is held
before the next transform fires. Rate = 1 yields a moving chord every step
(O&C / arpeggio feel). Rate = 4–16 yields a pad-style progression.

**Anchors**: optional (step-index, triad) pairs that override the generative walk
at specific positions. This allows mixing free traversal with fixed harmonic
landmarks — e.g. "start on C, reach F minor at bar 4, otherwise walk freely."

## Output model

### Voicing

Voicing is applied after the transform, independently of the lattice walk:

- **close** — root position, `[r, 3rd, 5th]`
- **spread** — middle voice up an octave, open sound
- **drop2** — second voice from top dropped an octave, jazz idiom

Optional **seventh** extension adds maj7 (for major) or min7 (for minor).
Further extensions (9/11/13) are out of scope for v1.

### Rhythm

Rhythm is decoupled from the transform sequence. The transform sequence defines
*which chords*; the rhythm pattern defines *when notes play*:

- **all** — notes on every step
- **legato** — notes held until the next chord boundary
- **custom patterns** — euclidean, offbeat, user-defined arrays

### MIDI semantics

Oedipa is a MIDI effect: it consumes transport (clock + position) and emits MIDI
notes. Sample-accurate timing against the host clock is expected on all targets
(M4L's scheduler, JUCE's `MidiBuffer` with sample offsets).

**Input handling** is a target-level design choice — some targets may use input
to seed the start chord, others may ignore it. Not part of the core concept.

**Velocity source** — v1 uses a single fixed velocity parameter per chord.
Rhythm-pattern-driven or input-derived velocity are future extensions.

**MIDI channel** — output channel is a target-level parameter (default 1).

**Note-off discipline** — on any chord change, transport stop, bypass, preset
change, or state restore, all currently-sounding notes must receive note-off.
A panic (all-notes-off on all channels) is required behavior, not optional.

**Polyphony / overlap** — when a new chord fires, previous chord's notes are
released *before* new notes-on, in the same processing block. No intentional
overlap in v1 (can be revisited if legato-style voice leading becomes a goal).

**Transport** — state is reset on stop; resuming from an arbitrary position
recomputes the walk deterministically from `startChord` + position, so the output
is identical regardless of where playback begins.

**MPE** — not supported in v1. The Tonnetz lattice has natural per-note
articulation potential (pitch bend from lattice position, pressure from voicing
transitions), and this is a planned extension for the iOS/touch target.
Implementations should not assume single-channel MIDI only — keep the note
emission layer abstract enough that MPE can be added without rewriting.

## What Oedipa is not

Clarifying scope by exclusion:

- **Not a chord sequencer.** The user does not enter a list of chords; they enter
  a list of transforms. Chords emerge from the walk.
- **Not a generative synth.** No oscillators, no audio. MIDI only.
- **Not a scene graph.** The inboil origin embeds Tonnetz inside a broader
  generative-node architecture. Oedipa flattens this: one Tonnetz, one output.
- **Not a randomizer.** Sequences are deterministic; anchors are explicit. Any
  randomness is opt-in on top of the deterministic base.

## Parameter surface (canonical)

The minimum parameter set each target must expose:

| Parameter         | Type                              | Notes                         |
|-------------------|-----------------------------------|-------------------------------|
| `startChord`      | triad                             | initial lattice position      |
| `sequence`        | `[P \| L \| R, …]`                | transform cycle               |
| `stepsPerTransform` | int ≥ 1                         | rate                          |
| `voicing`         | `close \| spread \| drop2`        | output voicing                |
| `seventh`         | bool                              | add 7th extension             |
| `rhythm`          | pattern                           | note trigger pattern          |
| `anchors`         | `[(step, triad), …]`              | optional fixed landmarks      |

Targets may add parameters (MIDI routing, MPE configuration, etc.) but must
support this core set for conceptual compatibility.

## Origin notes

The musical model is adapted from inboil's `generative.ts` (see `CLAUDE.md`
for references). The neo-Riemannian engine, per-step transform paradigm, and
voicing layer carry over. The scene-graph architecture, sheet/dock UI pattern,
and auxiliary features (write/live mode, freeze, merge modes) do not.
