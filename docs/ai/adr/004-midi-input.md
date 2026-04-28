# ADR 004: MIDI Input & Note Discipline

## Status: Proposed

**Created**: 2026-04-29

## Context

ADR 003 declared MIDI input out of scope and pointed forward to this ADR.
The current device has no MIDI input handling: `startChord` is set only via
lattice click (and persisted in three hidden `live.numbox` parameters), and
outgoing notes use a fixed velocity. ADR 003's "Voice / MIDI output" group
described velocity passthrough as the intended source without specifying
which input event drives it.

This ADR settles MIDI input semantics for v1: how incoming notes update
`startChord`, when output notes start and stop, where output velocity comes
from, and which channels the device listens on.

Out of scope (split into separate ADRs to keep each ADR readable on a single
decision axis):

- Rhythmic feel — gate length, swing, subdivision, step direction → ADR 005
- Workflow — preset slots, cell-program copy/paste, named programs → ADR 006
- Cell schema extensions (`(op, count)`, vector cells) → deferred per
  ADR 003 "Future shape extensions" until v1 use exposes a need

## Decision

Five design axes. All open at draft time; each gets settled into a firm
decision via revision before implementation begins.

### Axis 1 — Input event model

How does Oedipa derive a triad from incoming MIDI?

Options under consideration:

- **Held-chord** — the set of currently-held notes is examined whenever it
  changes; if 3+ notes form a recognized triad (via
  [`identifyTriad`](../../m4l/engine/tonnetz.ts)), `startChord` updates.
  Single notes and 2-note holds are ignored or held in a pending state.
- **Time-window chord** — accumulate note-ons within a small window
  (e.g. 30–80 ms), run `identifyTriad` at window close. Works for staccato
  chord input where the user lifts before the next chord.
- **Single-note inference** — pick a triad consistent with one note
  (ambiguous; probably bad).
- **Lowest-note + context** — root from the lowest held note, quality from
  upper notes if present.

Open. Recommended starting point: held-chord (simplest semantics, works for
both legato and staccato playing as long as the user briefly overlaps notes).

### Axis 2 — Trigger model

When do output notes play?

Options:

- **Hold-to-play** — note-on starts the walker at `startChord`; output runs
  while any input is held; note-off (last held note released) stops output.
  Closest to "keyboard performs Oedipa".
- **Free-running + chord update** — the walker always runs as long as the
  Live transport is playing; incoming chords only update `startChord`, no
  gating. Closest to today's behavior with input added on top.
- **Hybrid** — note-on restarts the walker at the new `startChord`; note-off
  does NOT stop output; only transport-stop or panic ends notes.

Interactions to think through:

- Does a `startChord` update mid-walk reset the cell program (next op = cell[0])
  or continue the cycle from wherever it was?
- If trigger model is hold-to-play, does the walker pause or reset when the
  user lifts and re-presses?

Open. Recommended starting point: hybrid (note-on restarts, free-runs after);
gives keyboard players the "punch in a chord and let it run" feel without
forcing them to hold.

### Axis 3 — Velocity source

What velocity do output notes carry?

Options:

- **Most-recent note-on** — single live value, applied to every note Oedipa
  emits until a new input note-on arrives.
- **Per-input-note mapping** — map the 3 input notes' velocities onto the
  3 output triad notes (only meaningful while a chord is held; ambiguous
  for `seventh=1` voicings or when input has more than 3 notes).
- **Fixed (parameter)** — `live.numbox` `outputVelocity` 1–127, ignore input.
- **Fixed-with-input-multiplier** — fixed base, scaled by most-recent input
  velocity / 127.

Open. Recommended starting point: most-recent note-on (simple, expressive,
works regardless of voicing). Keep a fixed-velocity fallback if no input
has arrived yet (default 100).

### Axis 4 — Listen channel

Which input channel(s) does Oedipa pay attention to?

Options:

- **Omni** — accept all channels.
- **`inputChannel` parameter** — `live.numbox` 0–16, where 0 = omni and 1–16
  selects one channel. Mirrors the existing output `channel` parameter shape.

Open. Recommended starting point: `inputChannel` param defaulting to omni —
costs one parameter, gains explicit routing for users who want it.

### Axis 5 — Note-off discipline

When does Oedipa stop emitting notes?

Sub-questions:

- **Transport stop** — already handled (panic on stop, per ADR 002). No
  change.
- **Input release** — only relevant in hold-to-play; in hybrid/free-run, no
  effect.
- **Chord change while a note is sustaining** — does the previous chord's
  note-off fire before the new chord's note-on (clean transition), or is
  there overlap (legato)? Voice-leading walks already handle this within
  Oedipa's walker — the question is what the *input-driven* `startChord`
  jump does. Likely: emit note-off for the previous triad's voiced notes
  before the new triad's note-ons.
- **Cell op change mid-step** — a cell automation lane changes the next op
  to apply. Already handled by the engine; no MIDI-level concern.
- **Device unload** — already handled.

Open. Recommended starting point: clean note-off on every triad change
(input-driven or walker-driven); no overlap.

## Scope

**In scope:**

- MIDI input pipeline: incoming note-on/off → `startChord` update via
  `identifyTriad`
- Velocity passthrough from input to output
- Listen channel parameter (if axis 4 settles on parametrized)
- Trigger model gating behavior
- Note-off discipline for input-driven triad changes

**Out of scope (future ADRs):**

- Rhythmic feel — gate length, swing, subdivision, step direction → ADR 005
- Preset slots, cell-program copy/paste, named programs → ADR 006
- Cell schema extensions → deferred per ADR 003

## Implementation checklist

To be filled in after axes are settled. Phases will follow ADR 003's
tests-first pattern:

1. Engine API additions (if any) — pure functions, vectors
2. Host pipeline additions — note aggregation, triad detection, velocity
   tracking
3. Patcher wiring — `inputChannel` param if needed, MIDI input route to
   `[node.script]`
4. Manual verification in Live with a keyboard

## Open questions

All five axes above. Will be edited into firm decisions as agreed.

Other questions raised during draft:

1. **Input pre-roll** — when Live's transport starts and a chord is already
   held, does Oedipa pick it up immediately or wait for the next note-on?
   Likely "immediately at start, treat held notes as a fresh chord input".
2. **Latency** — input-event-model "time-window chord" introduces 30–80 ms
   of latency before `startChord` updates. Held-chord avoids that. Worth
   measuring once Axis 1 is decided.

## Per-target notes

m4l: incoming MIDI arrives at the patcher's `midiin` and currently routes
straight to `midiout` for monitoring. The new path forks a copy into
`[node.script]` (existing `noteIn` handler is the entry point). Aggregating
held notes lives in `host.ts`; `identifyTriad` is already exported from
the engine.

vst/app: equivalent in JUCE / AUv3 by inspecting `midiBuffer` in
`processBlock`. Same `host.ts` semantics translate directly.
