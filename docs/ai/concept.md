# Concept

Oedipa is a Tonnetz-based chord exploration MIDI tool. On each clock tick a
**walker** traverses a neo-Riemannian lattice, driven by a short repeating
**cell sequence** of P / L / R / hold / rest operations carrying per-cell
expression (velocity, gate, probability, timing), an optional **jitter**
randomness layer, and a global rhythmic layer (swing, subdivision, step
direction, humanize) on top.

This document describes the **musical model** — the parts that are shared across
all targets (`m4l/`, `vst/`, `app/`). Target-specific UI and interaction design
live in separate docs.

## What Oedipa does

On each step of the host transport, Oedipa:

1. Looks at the current **cell** in the sequence — a record `{ op, velocity,
   gate, probability, timing }` where `op ∈ { P, L, R, hold, rest }`.
2. With probability `jitter`, replaces the op with a uniformly-random pick from
   `{ P, L, R, hold }` (rest is excluded so jitter never injects unintended
   silence).
3. Rolls the per-cell `probability`; on fail the chord cursor still advances
   for P/L/R but no audio is emitted (silent-advance — keeps timing
   deterministic across playback restarts).
4. Applies the op (or holds the cursor for `hold`/`rest`).
5. Emits the resulting triad as MIDI notes, scaled by per-cell `velocity`,
   sustained for per-cell `gate`, offset by per-cell `timing` (and the global
   swing offset on off-beat subdivision steps), and optionally perturbed by the
   global humanize layer (velocity / gate / timing / probability — opt-in,
   default 0).

The user shapes the output by writing the cells (the "program"), tuning jitter
and humanize, and choosing voicing. Each cell field is independently
host-automatable — the live steering layer replaces the static authoring of
long P/L/R lists.

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

The walk is driven by a small array of **cells**, each a record
`{ op, velocity, gate, probability, timing }` where:

- `op ∈ { P, L, R }` — apply that neo-Riemannian operation
- `op = hold` — leave the walker on the current triad, re-emit it
- `op = rest` — leave the walker untouched and emit nothing (authored silence;
  excluded from the jitter substitution pool so random op replacement never
  injects unintended silence)
- `velocity` (0..1) multiplies the source velocity (input passthrough or
  default 100)
- `gate` (0..1) is the fraction of the step length the note sustains; `1.0`
  means the note-off coincides with the next note-on (legato handoff)
- `probability` (0..1) is the chance the step plays this visit; on fail, the
  chord cursor still applies the transform for P/L/R (silent-advance), keeping
  rhythmic position deterministic across playback restarts
- `timing` (-0.5..+0.5) is a step-length-fraction offset; composes additively
  with the global swing offset

At each transform boundary (every `stepsPerTransform` host ticks), the walker
consumes one cell. Two pieces of state advance at different rates:

- **Cell pointer** — index into `cells[]`, always advances exactly one position
  per step (modulated by `stepDirection` — see §Rhythm below). Never affected
  by op, probability, or rest.
- **Tonnetz chord cursor** — the current triad. Whether it changes depends on
  the resolved op (P/L/R move it, hold/rest leave it).

With probability `jitter`, the cell's op is replaced by a uniform-random pick
from `{ P, L, R, hold }`. The substitution is sampled from a seeded PRNG so
the walk is reproducible for fixed
`(startChord, cells, jitter, seed, stepDirection)`. The chosen op is applied
(or the chord held). The new triad is the nearest-octave realization to the
previous one, preserving voice leading.

`jitter = 0` reproduces a strict cyclic walk through the program. `jitter = 1`
ignores the program entirely (uniform random walk on the Tonnetz). Intermediate
values give a "loosely follows the program" feel.

The sequence is short by design (target convention: 4 cells). The motion comes
from the loop *plus* every cell field being independently host-automatable —
the user either authors a static program and lets jitter and humanize colour
it, or animates one cell field via host automation to evolve the walk over
time. This is the design's replacement for both inboil's variable-length
sequence editor and the discarded attractor model.

**Rate**: `stepsPerTransform` controls how many subdivision steps each chord
is held before the next cell is consumed. Rate = 1 yields a moving chord
every step (O&C / arpeggio feel). Rate = 4–16 yields a pad-style progression.
The subdivision unit is set by the global `subdivision` parameter (see
§Rhythm).

## Output model

### Voicing

Voicing is applied after the transform, independently of the lattice walk:

- **close** — root position, `[r, 3rd, 5th]`
- **spread** — middle voice up an octave, open sound
- **drop2** — second voice from top dropped an octave, jazz idiom

Optional **seventh** extension adds maj7 (for major) or min7 (for minor).
Further extensions (9/11/13) are out of scope for v1.

### Rhythm

Rhythm splits into two layers — the per-cell expression that lives inside
each cell record (§Traversal) and a small global layer that frames the grid
the cells fire against:

- **subdivision** — the unit step length the walker advances by. Five options:
  `8th`, `16th` (default), `32nd`, `8T` (eighth triplet), `16T` (sixteenth
  triplet). Implemented host-side as a tick multiplier over a fixed PPQN=24
  feed, which leaves room for ratchet and polyrhythm extensions later.
- **swing** — pushes off-beat subdivision steps later. `0.5` is straight,
  `0.75` is heavy swing. Composes additively with each cell's `timing`
  offset.
- **stepDirection** — `forward` (default), `reverse`, `pingpong` (traverse
  without replaying endpoints), or `random` (each step picks the next cell
  uniformly from the seeded PRNG; consecutive same-cell picks allowed).
- **humanize** — opt-in non-authored variation. Three independent axes:
  `humanizeVelocity`, `humanizeGate`, `humanizeTiming`, each `0..1`. Per
  output event, each axis applies signed uniform noise of amplitude
  `(amount × ±1)` to the corresponding per-cell field, then clamps per the
  field's range. Defaults are 0 — authored phrasing is the primary expression
  source; humanize is the layer that takes the edge off the grid.
- **humanizeDrift** — global EMA factor (`0..1`, default 0) shared across all
  humanize axes. With `drift = 0` the humanize draws are independent
  uniforms (default behavior). As drift rises, each axis becomes a smoothed
  random walk: `v_t = drift × v_{t-1} + (1-drift) × raw_t`. Independent
  noise sounds jittery; smoothed walks sound like drift / breath — the
  parameter's job is to swap "jittery humanize" for "breathing humanize"
  without giving up the seeded determinism contract.
- **outputLevel** — global multiplier (`0..1`, default 1.0) on the output
  MIDI velocity stack. Composes as
  `velocity = source × cell.velocity × (1 + signed_humanize) × outputLevel`,
  applied last. Single dial for "make everything quieter" without touching
  per-cell automation; useful in particular when no MIDI input is wired
  (source velocity defaults to 100 with no other quick way to scale the
  whole output down).

The humanize draws share the same seeded PRNG as `jitter`, per-cell
`probability`, and `random` step direction — same `seed` reproduces the same
output bit-for-bit. Drift smoothing is also seeded-deterministic (per-axis
`prev` state initialized at 0.5 and rebuilt from pos=0 on every walk call).

### MIDI semantics

Oedipa is a MIDI effect: it consumes transport (clock + position) and emits MIDI
notes. Sample-accurate timing against the host clock is expected on all targets
(M4L's scheduler, JUCE's `MidiBuffer` with sample offsets).

**Input handling** is a target-level design choice. The canonical use case is
**incoming notes update `startChord`** — the user plays a chord, the walker
restarts from there and continues advancing through the cells. Targets that
have no notion of MIDI input may omit this.

**Velocity stack** — output velocity per emitted note is
`source × cell.velocity × (1 + (humanizeVel*2-1) × humanizeVelocity) × outputLevel`,
clamped to MIDI 1..127. Four layers compose:

- **Source velocity** — incoming MIDI note velocity (most recent note-on
  within the held set when input is wired, default 100 otherwise). The
  player's touch is the primary expression input.
- **Per-cell `velocity` (0..1)** — the program's authored shape: cell 0 louder
  than cell 1, cell 3 ducked for breath, etc. Available per cell via host
  automation.
- **Global `humanizeVelocity` (0..1)** — opt-in signed uniform noise on top.
  Default 0; the player turns it up when the grid feels too rigid.
- **Global `outputLevel` (0..1, default 1.0)** — single dial that scales the
  entire stack uniformly. Useful in particular for the "no MIDI input wired"
  use case where source velocity is fixed at 100 and there's no other knob
  to bring the whole output down.

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
  enter a short list of P/L/R/hold/rest *operations* with per-cell expression
  and the chords emerge from the walk.
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

**Walk core:**

| Parameter           | Type                                 | Notes                                       |
|---------------------|--------------------------------------|---------------------------------------------|
| `startChord`        | triad                                | walker's initial triad                      |
| `cells`             | `Cell[]`                             | ordered cell sequence (4 by default)        |
| `jitter`            | float 0..1                           | per-step random-substitute probability      |
| `seed`              | int                                  | RNG seed for reproducibility                |
| `stepsPerTransform` | int ≥ 1                              | rate (subdivision steps per cell)           |
| `voicing`           | `close \| spread \| drop2`           | output voicing                              |
| `seventh`           | bool                                 | add 7th extension                           |

**Per-cell record:**

| Field         | Type                                    | Notes                                                |
|---------------|-----------------------------------------|------------------------------------------------------|
| `op`          | `'P' \| 'L' \| 'R' \| 'hold' \| 'rest'` | operation; `rest` excluded from jitter pool          |
| `velocity`    | float 0..1                              | source-velocity multiplier                           |
| `gate`        | float 0..1                              | step-length fraction; 1.0 = legato handoff           |
| `probability` | float 0..1                              | per-visit play chance; fail = silent-advance         |
| `timing`      | float -0.5..+0.5                        | step-length-fraction offset; composes with swing     |

**Global rhythmic layer:**

| Parameter              | Type                                                           | Notes                                              |
|------------------------|----------------------------------------------------------------|----------------------------------------------------|
| `subdivision`          | `8th \| 16th \| 32nd \| 8T \| 16T`                             | step unit; default 16th                            |
| `swing`                | float 0.5..0.75                                                | off-beat shift; default 0.5 (straight)             |
| `stepDirection`        | `forward \| reverse \| pingpong \| random`                     | cell-pointer traversal; default forward            |
| `humanizeVelocity`     | float 0..1                                                     | signed-noise amplitude on per-cell velocity        |
| `humanizeGate`         | float 0..1                                                     | signed-noise amplitude on per-cell gate            |
| `humanizeTiming`       | float 0..1                                                     | signed-noise amplitude on per-cell timing          |
| `humanizeDrift`        | float 0..1                                                     | EMA smoothing factor for all humanize axes         |
| `outputLevel`          | float 0..1                                                     | global output velocity multiplier (default 1.0)    |

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
  Oedipa uses 4 cells of P/L/R/hold/rest ops with per-cell expression
  (velocity, gate, probability, timing), each field exposed as an
  independently-automatable host parameter, plus seeded `jitter` and a global
  humanize layer as the live-randomness equivalent of CV perturbation. The
  mechanics differ; the design intent (small program + live steering, not
  long-form authoring) is shared.

Standalone MIDI plugins need to be musically sufficient on their own — the
"print and post-edit" workflow is part of their utility but not their reason
for existing. Oedipa's cells + per-cell expression + global rhythmic layer +
jitter + humanize is the minimum viable program element that satisfies that
bar without becoming a clip-writer in disguise.
