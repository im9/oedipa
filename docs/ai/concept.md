# Concept

Oedipa is a Tonnetz-based chord exploration MIDI tool. On each clock tick a
**walker** traverses a neo-Riemannian lattice toward a user-placed **attractor**,
emitting triads with smooth voice leading.

This document describes the **musical model** — the parts that are shared across
all targets (`m4l/`, `vst/`, `app/`). Target-specific UI and interaction design
live in separate docs.

## What Oedipa does

On each step of the host transport, Oedipa:

1. Looks at the walker's current triad and the user-set **attractor** triad on the
   lattice.
2. Picks the next P / L / R operation that tends to move the walker closer to the
   attractor, with **jitter** controlling how often it deviates.
3. Emits the resulting chord as MIDI notes, shaped by voicing settings.

The user shapes the output by placing and moving the attractor (manually or via
host automation), tuning jitter, and choosing voicing. The Tonnetz handles
harmony and voice leading; the user steers the walker.

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

### Traversal — attractor-driven walk

At each transform step, the walker has three candidates: the P, L, and R
neighbors of the current triad. Lattice distance from each candidate to the
attractor is computed, and the walker picks among them by a probabilistic rule:

- **jitter = 0**: greedy — always pick the candidate with smallest distance to
  the attractor (ties broken deterministically by seed).
- **jitter = 1**: uniform random — distance is ignored.
- **intermediate**: probabilistic preference for nearer candidates (softmax-style;
  the engine fixes the exact formula and asserts it via shared test vectors).

When the walker has reached the attractor (current triad equals attractor), it
stays put until either the attractor moves or jitter perturbs it to an adjacent
triangle.

If `attractor` is unset, it defaults to `startChord` — the walker holds the start
chord (with jitter optionally drifting it).

The walk is **reproducible**: for fixed (`startChord`, attractor trajectory,
`jitter`, `seed`), restarting playback from any position yields the same output.
Randomness is seeded; the seed is a parameter, not a hidden runtime detail.

**Rate**: `stepsPerTransform` controls how many host steps each chord is held
before the next transform fires. Rate = 1 yields a moving chord every step
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
restarts from there and steers toward the current attractor. Targets that have
no notion of MIDI input may omit this.

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
recomputes the walk deterministically from `startChord` + attractor + seed +
position, so the output is identical regardless of where playback begins.

**MPE** — not supported in v1. The Tonnetz lattice has natural per-note
articulation potential (pitch bend from lattice position, pressure from voicing
transitions), and this is a planned extension for the iOS/touch target.
Implementations should not assume single-channel MIDI only — keep the note
emission layer abstract enough that MPE can be added without rewriting.

## What Oedipa is not

Clarifying scope by exclusion:

- **Not a chord sequencer.** The user does not enter a list of chords or a list
  of transforms; they place an attractor and let the walker steer toward it.
- **Not a generative synth.** No oscillators, no audio. MIDI only.
- **Not a scene graph.** The inboil origin embeds Tonnetz inside a broader
  generative-node architecture. Oedipa flattens this: one Tonnetz, one walker,
  one output.
- **Not an unseeded random walker.** The walk is reproducible for fixed
  (startChord, attractor, jitter, seed). "Random" here means "seeded
  pseudorandom that the user can lock down and print to a clip."

## Parameter surface (canonical)

The minimum parameter set each target must expose:

| Parameter           | Type                       | Notes                                |
|---------------------|----------------------------|--------------------------------------|
| `startChord`        | triad                      | walker's initial triad               |
| `attractor`         | triad                      | target the walker steers toward      |
| `jitter`            | float 0..1                 | greedy ↔ uniform-random mix          |
| `seed`              | int                        | RNG seed for reproducibility         |
| `stepsPerTransform` | int ≥ 1                    | rate (host steps per transform)      |
| `voicing`           | `close \| spread \| drop2` | output voicing                       |
| `seventh`           | bool                       | add 7th extension                    |
| `rhythm`            | pattern                    | note trigger pattern                 |

Targets may add parameters (MIDI routing, MPE configuration, etc.) but must
support this core set for conceptual compatibility.

## Origin notes

Oedipa has two ancestors:

- **inboil's `generative.ts`** (see `CLAUDE.md` for references) provided the
  neo-Riemannian engine, P/L/R triad math, and voicing layer. The scene-graph
  architecture, sheet/dock UI pattern, and inboil's *sequence-driven* traversal
  (user writes the P/L/R list by hand) do **not** carry over.
- **Ornament & Crime's [Automatonnetz](https://ornament-and-cri.me/automatonnetz/)**
  module provided the *traversal philosophy*: don't ask the user to write a step
  sequence — let an automaton walk the lattice and give the user a small handle
  to steer it. Automatonnetz steers via a 2D vector grid modulated by CV;
  Oedipa steers via a single attractor that a DAW can automate naturally.

inboil itself was sequence-driven. Oedipa diverges here and aligns with
Automatonnetz: the plugin's value is the autonomous walk, not a fancy step-
sequencer UI. If the user wants to hand-edit chords, they print Oedipa's output
to a MIDI clip and edit there — that is the DAW-native workflow Oedipa is
designed around.
