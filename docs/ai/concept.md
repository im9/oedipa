# Concept

Oedipa is a Tonnetz-based chord exploration MIDI tool. On each clock tick a
**walker** traverses a neo-Riemannian lattice, driven by a short repeating
**cell sequence** of P / L / R / hold operations and an optional **jitter**
randomness layer.

This document describes the **musical model** — the parts that are shared across
all targets (`m4l/`, `vst/`, `app/`). Target-specific UI and interaction design
live in separate docs.

## What Oedipa does

On each step of the host transport, Oedipa:

1. Looks at the current **cell** in the sequence (`cells[stepIdx % cells.length]`)
   holding an op: `P` / `L` / `R` / `hold`.
2. With probability `jitter`, replaces the op with a uniformly-random one.
3. Applies the op to the walker's current triad (or holds if `hold`).
4. Emits the resulting triad as MIDI notes, shaped by voicing settings.

The user shapes the output by writing the cells (the "program"), tuning jitter,
and choosing voicing. Each cell is independently host-automatable — the live
steering layer replaces the static authoring of long P/L/R lists.

## Musical model

### Tonnetz lattice

The Tonnetz is a 2D triangular lattice where each face is a triad (major △ or
minor ▽) and adjacent faces are connected by one of three transforms. Major and
minor triads alternate — any single transform flips the quality.

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

### Traversal — cell sequencer with jitter

The walk is driven by a small array of **cells**, each holding one of:
- `P`, `L`, `R` — apply that neo-Riemannian operation
- `hold` — leave the walker on the current triad

At each transform boundary (every `stepsPerTransform` host ticks), the walker
consumes one cell:

- The cell index advances cyclically: `cellIdx = transformIdx mod cells.length`.
- With probability `jitter`, the cell's op is replaced by a uniform-random pick
  from `{P, L, R, hold}`. The substitution is sampled from a seeded PRNG so the
  walk is reproducible for fixed `(startChord, cells, jitter, seed)`.
- The chosen op is applied (or the chord held). The new triad is the
  nearest-octave realization to the previous one, preserving voice leading.

`jitter = 0` reproduces a strict cyclic walk through the program. `jitter = 1`
ignores the program entirely (uniform random walk on the Tonnetz). Intermediate
values give a "loosely follows the program" feel.

The sequence is short by design (target convention: 4 cells). The motion comes
from the loop *plus* the cells being independently host-automatable — the user
either authors a static program and lets jitter colour it, or animates one cell
via host automation to evolve the walk over time. This is the design's
replacement for both inboil's variable-length sequence editor and the discarded
attractor model.

**Rate**: `stepsPerTransform` controls how many host steps each chord is held
before the next cell is consumed. Rate = 1 yields a moving chord every step
(O&C / arpeggio feel). Rate = 4–16 yields a pad-style progression.

## Output model

### Voicing

Voicing is applied after the transform, independently of the lattice walk:

- **close** — root position, `[r, 3rd, 5th]`
- **spread** — middle voice up an octave, open sound
- **drop2** — second voice from top dropped an octave, jazz idiom

Optional **seventh** extension adds maj7 (for major) or min7 (for minor).
Further extensions (9/11/13) are out of scope for v1.

### Rhythm

Rhythm is decoupled from the walker. The walker decides *which chords*; the
rhythm pattern decides *when notes play*:

- **all** — notes on every step
- **legato** — notes held until the next chord boundary
- **custom patterns** — euclidean, offbeat, user-defined arrays

### MIDI semantics

Oedipa is a MIDI effect: it consumes transport (clock + position) and emits MIDI
notes. Sample-accurate timing against the host clock is expected on all targets
(M4L's scheduler, JUCE's `MidiBuffer` with sample offsets).

**Input handling** is a target-level design choice. The canonical use case is
**incoming notes update `startChord`** — the user plays a chord, the walker
restarts from there and continues advancing through the cells. Targets that
have no notion of MIDI input may omit this.

**Velocity source** — v1 uses incoming MIDI note velocity when input is wired
(passthrough), and a fixed default (100) otherwise. A single static velocity
parameter is intentionally not exposed: a one-knob "all chords play at 100" is
musically blunt, and the input passthrough path is the design we want.

**MIDI channel** — output channel is a target-level parameter (default 1).

**Note-off discipline** — on any chord change, transport stop, bypass, preset
change, or state restore, all currently-sounding notes must receive note-off.
A panic (all-notes-off on all channels) is required behavior, not optional.

**Polyphony / overlap** — when a new chord fires, previous chord's notes are
released *before* new notes-on, in the same processing block. No intentional
overlap in v1 (can be revisited if legato-style voice leading becomes a goal).

**Transport** — state is reset on stop; resuming from an arbitrary position
recomputes the walk deterministically from `startChord` + cells + jitter + seed
+ position, so the output is identical regardless of where playback begins.

**MPE** — not supported in v1. The Tonnetz lattice has natural per-note
articulation potential (pitch bend from lattice position, pressure from voicing
transitions), and this is a planned extension for the iOS/touch target.
Implementations should not assume single-channel MIDI only — keep the note
emission layer abstract enough that MPE can be added without rewriting.

## What Oedipa is not

Clarifying scope by exclusion:

- **Not a chord sequencer.** The user does not enter a list of chords; they
  enter a short list of P/L/R/hold *operations* and the chords emerge from the
  walk.
- **Not a long-form sequence editor.** The cell array is intentionally short
  (target convention: 4 cells). Long P/L/R sequences are inboil's mode and not
  Oedipa's — beyond a handful of cells, "print to MIDI clip and edit there" is
  the better DAW-native workflow.
- **Not a generative synth.** No oscillators, no audio. MIDI only.
- **Not a scene graph.** The inboil origin embeds Tonnetz inside a broader
  generative-node architecture. Oedipa flattens this: one Tonnetz, one walker,
  one output.
- **Not an unseeded random walker.** The walk is reproducible for fixed
  (startChord, cells, jitter, seed). "Random" here means "seeded pseudorandom
  the user can lock down and print to a clip."

## Parameter surface (canonical)

The minimum parameter set each target must expose:

| Parameter           | Type                          | Notes                                |
|---------------------|-------------------------------|--------------------------------------|
| `startChord`        | triad                         | walker's initial triad               |
| `cells`             | `('P' \| 'L' \| 'R' \| 'hold')[]` | ordered cell sequence (4 by default) |
| `jitter`            | float 0..1                    | per-step random-substitute probability |
| `seed`              | int                           | RNG seed for reproducibility         |
| `stepsPerTransform` | int ≥ 1                       | rate (host steps per cell)           |
| `voicing`           | `close \| spread \| drop2`    | output voicing                       |
| `seventh`           | bool                          | add 7th extension                    |
| `rhythm`            | pattern                       | note trigger pattern                 |

Targets may add parameters (MIDI routing, MPE configuration, etc.) but must
support this core set for conceptual compatibility.

## Origin notes

Oedipa has two ancestors:

- **inboil's `generative.ts`** (see `CLAUDE.md` for references) provided the
  neo-Riemannian engine, P/L/R triad math, and voicing layer. inboil's variable-
  length sequence editor and anchor system **do not** carry over — they assume
  Tonnetz is one node in a scene graph that emits to a clip the user post-edits.
- **Ornament & Crime's [Automatonnetz](https://ornament-and-cri.me/automatonnetz/)**
  module provided the *steering philosophy*: don't ask the user to write a long
  step sequence — author a small repeating program and steer it live with host
  modulation. Automatonnetz uses a 5×5 grid of chord targets perturbed by CV;
  Oedipa uses 4 cells of P/L/R/hold ops with each cell exposed as an
  independently-automatable host parameter, plus seeded `jitter` as the live-
  randomness equivalent of CV perturbation. The mechanics differ; the design
  intent (small program + live steering, not long-form authoring) is shared.

Standalone MIDI plugins need to be musically sufficient on their own — the
"print and post-edit" workflow is part of their utility but not their reason
for existing. Oedipa's cells + jitter + per-cell automation is the minimum
viable program element that satisfies that bar without becoming a clip-writer
in disguise.
