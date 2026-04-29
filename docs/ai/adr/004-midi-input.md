# ADR 004: MIDI Input & Note Discipline

## Status: Proposed

**Created**: 2026-04-29
**Revised**: 2026-04-29 (5 design axes settled in a single review pass; ready for implementation)

## Context

ADR 003 declared MIDI input out of scope and pointed forward to this ADR.
The current device has no MIDI input handling: `startChord` is set only via
lattice click (and persisted in three hidden `live.numbox` parameters), and
outgoing notes use a fixed velocity. ADR 003's "Voice / MIDI output" group
described velocity passthrough as the intended source without specifying
which input event drives it.

This ADR settles MIDI input semantics for v1: how incoming notes update
`startChord`, when output notes start and stop, where output velocity comes
from, which channels the device listens on, and how walker state resets
across chord changes.

The settled decisions favor **DAW/clip-playback determinism** as the primary
use case — recording a chord progression in Live and replaying it to drive
Oedipa should produce identical MIDI output on every transport playback. Live
keyboard performance is supported via a `triggerMode` switch (hold-to-play)
but is not the default — the user's own workflow leans toward clip-driven
composition.

Out of scope (split into separate ADRs to keep each ADR readable on a single
decision axis):

- Rhythmic feel — gate length, swing, subdivision, step direction → ADR 005
- Workflow — preset slots, cell-program copy/paste, named programs → ADR 006
- Cell schema extensions (`(op, count)`, vector cells) → deferred per
  ADR 003 "Future shape extensions" until v1 use exposes a need

## Decision

Five axes, all settled.

### Axis 1 — Input event model: held-chord with 3-subset search

The host maintains a sorted set of currently-held MIDI notes. On every
note-on / note-off, if 3 or more notes are held, run
[`identifyTriad`](../../../m4l/engine/tonnetz.ts) over every 3-element subset
of held notes; among the subsets that match a major or minor triad, pick the
one whose **root note** (the held MIDI value matching the identified
`rootPc`) has the lowest MIDI value. Use that subset's identified triad as
the new `startChord`, anchored at the matching root MIDI value via
`buildTriad(rootPc, quality, rootMidi)`.

If no subset matches, `startChord` is not updated.

Vocabulary (current `identifyTriad` only recognizes Tonnetz major/minor —
[m4l/engine/tonnetz.ts:32-44](../../../m4l/engine/tonnetz.ts#L32-L44)):

| Held input            | Matching subsets        | Adopted (lowest root MIDI) |
|-----------------------|-------------------------|----------------------------|
| C-E-G                 | Cmaj                    | Cmaj                       |
| C-E-G-B (Cmaj7)       | Cmaj (root=60), Em (64) | Cmaj                       |
| D-F-A-C (Dm7)         | Dm (62), Fmaj (65)      | Dm                         |
| C-E-G-Bb (C7)         | Cmaj                    | Cmaj                       |
| C-E-G-A (C6 / Am7/C)  | Cmaj (60), Am (69)      | Cmaj                       |
| C-D-G (Csus2)         | (none)                  | (no update)                |
| C-Eb-Gb (Cdim)        | (none)                  | (no update)                |
| C-E-G♯ (Caug)         | (none)                  | (no update)                |

Common jazz extensions (7ths, 6ths, added notes) work naturally because the
underlying triad is a subset. Sus, dim, aug, and other non-Tonnetz chords
are intentionally ignored — `identifyTriad` stays strict at the engine
layer, and the host doesn't try to "snap" non-triads to the nearest triad.
If this proves limiting in real use, revisit per the Open questions section.

The search cost is O(C(n, 3)) per held-note change; in practice n ≤ 6 so
under 20 subset evaluations, each O(1). Trivial.

Inversions and octave doublings: the rule "lowest root MIDI" picks the
subset whose root sits at the lowest octave of the user's held voicing,
which determines the octave anchor for `buildTriad`. Holding [48, 60, 64,
67] (C2 + Cmaj at C4) selects subset [48, 64, 67] → startChord rooted near
48. Holding [64, 67, 72] (Cmaj/E first inversion) selects the only subset →
startChord rooted near 72. The user's input register flows through to the
walker's starting register.

### Axis 2 — Trigger model: hybrid default, with `triggerMode` switch

Adds `triggerMode` parameter (`live.numbox`, int, range 0–1):

- **`0` — hybrid (default)**: note-on resets the walker (`pos = 0`,
  `startChord = newTriad`). Walker continues running on transport ticks
  regardless of subsequent note-offs. Only transport-stop or panic ends
  notes.
- **`1` — hold-to-play**: same as hybrid for note-on. On note-off, when the
  last held note is released, emit a panic for any sustaining walker notes
  and stop further walker emissions until the next note-on.

A third `free-running` mode (transport drives walker without any input
gating) is intentionally not exposed: it is indistinguishable from hybrid
before the first note-on arrives, and the lattice-click-only workflow
already covers it (without input, the walker uses the persisted lattice
`startChord` and runs from transport in either mode).

**`pos = 0` reset on every `startChord` update** — input-driven *and*
lattice-click-driven. This is the lever that makes clip replay
deterministic: a clip with `Cmaj → Fmaj → Gmaj` produces the same walker
output every loop, because each chord change restarts the cell program at
`cells[0]` and the engine reseeds the jitter PRNG fresh from `seed` on every
`walk()` call ([tonnetz.ts:109-110](../../../m4l/engine/tonnetz.ts#L109-L110)).

### Axis 3 — Velocity source: most-recent input note-on, persisted

The host maintains `lastInputVelocity`, initialized to **100** at device
load. Every incoming note-on (regardless of triggerMode or whether it
updated `startChord`) overwrites it. Every walker output note carries
`lastInputVelocity` as its MIDI velocity.

Rationale:

- Single source of truth — no per-output randomization, no decay, no
  interpolation. Replay determinism follows: a clip's note-on velocities
  flow through unchanged on every playback.
- "Last expressed intent persists" feels natural in performance: if you
  played soft, the walker stays soft until you express otherwise.
- Lattice-click-only users get a sane idle dynamic (vel 100) without
  needing to wire input.

No `velocity` static parameter is added — `lastInputVelocity` is the only
output-velocity source. If a user wants a fixed velocity regardless of
input, they can mute their input track or route Oedipa on a different
channel; an explicit override knob is not in v1.

### Axis 4 — Listen channel: `inputChannel` parameter, omni default

Adds `inputChannel` parameter (`live.numbox`, int, range 0–16):

- **`0` — omni (default)**: accept all channels.
- **`1`–`16`**: single-channel filter; ignore note events on other channels.

Mirrors the existing output `channel` parameter shape (Group B in ADR 003).
Default omni keeps the device "just works" out of the box. Visible in the
device strip — not hidden — so that channel-mismatch problems are easy to
diagnose ("nothing's happening" → check the strip).

### Axis 5 — Note-off discipline: clean transitions, no overlap

When `startChord` changes — input-driven, lattice-click-driven, OR
walker-driven (cell op consumed) — emit note-offs for all currently-sustaining
walker output notes BEFORE emitting any new note-ons.

Holds across:

- **Input-driven chord change mid-walk**: previous triad's voiced notes
  receive note-off; the next walker emission (immediate or on the next
  tick — see "Pre-roll & timing") emits the new triad's note-ons.
- **Walker-driven transition** (next cell op consumed): same — previous
  triad's note-off, then new triad's note-on. This was already the implicit
  behavior in ADR 003; this ADR makes it explicit.
- **Transport stop**: panic (already handled per ADR 002).
- **Hold-to-play release** (mode 1): panic on last note-off.
- **Device unload**: panic (already handled).

No overlap, no legato across boundaries. Voice-leading at the *pitch* level
already happens inside `applyTransform` (the walker only moves one note per
P/L/R step, the others stay put); note-on/off granularity stays clean for
predictable host behavior — sustain pedal handling, MIDI monitor display,
and recording Oedipa's output into a Live MIDI track all behave as expected.

### Pre-roll & timing

When transport starts:

1. Snapshot currently-held MIDI notes (any input that arrived before
   transport-start, e.g. user holding a chord on the keyboard before
   pressing Play, or a clip launched simultaneously where the first note-on
   lands at clip-time-zero).
2. Run subset search → derive `startChord`.
3. Walker starts at `pos = 0` with that `startChord`.

If no notes are held, fall back to the persisted lattice `startChord`.

This eliminates the t = 0+ε ambiguity where the walker would otherwise
emit one tick from the previously-persisted lattice `startChord` before the
first input event was processed — non-determinism that would surface as
"first note of every loop is wrong" in clip replay.

### Determinism guarantee

Combining the above with the engine's per-call PRNG reseed
([tonnetz.ts:109-110](../../../m4l/engine/tonnetz.ts#L109-L110)):

> For a fixed `(seed, jitter, cells, lattice startChord, triggerMode,
> inputChannel)` and a fixed input chord sequence (clip), Oedipa produces
> the same MIDI output on every transport playback.

This is what makes Oedipa usable for composition in Live: re-render produces
identical results, automation lanes behave predictably, and the user can
iterate on cells/jitter without their underlying chord progression drifting.

Live keyboard performance still works — but it's intrinsically
non-deterministic (humans don't replay timing exactly), so the determinism
guarantee is silently bypassed in that workflow without any setting changes.

## Scope

**In scope:**

- Held-note tracking + 3-subset `identifyTriad` search → `startChord` update
- `triggerMode` parameter (`live.numbox`, 0=hybrid / 1=hold-to-play)
- `inputChannel` parameter (`live.numbox`, 0=omni / 1–16)
- `lastInputVelocity` tracking; walker output velocity wiring
- Pre-roll: held-note snapshot at transport start
- Note-off discipline: clean transitions on `startChord` change
- Cell program reset (`pos = 0`) on every `startChord` change (input-driven
  AND lattice-click-driven)
- Patcher wiring: `triggerMode` / `inputChannel` live.* params; MIDI input
  fork into `[node.script]`; transport-start hook
- Tests for held-note aggregation, subset search, velocity tracking,
  hold-to-play release, pre-roll snapshot, cross-loop replay determinism

**Out of scope (future ADRs / revisits):**

- Rhythmic feel — gate length, swing, subdivision, step direction → ADR 005
- Preset slots, cell-program copy/paste, named programs → ADR 006
- Cell schema extensions → deferred per ADR 003
- `free-running` triggerMode (third option) — revisit if hybrid +
  hold-to-play prove insufficient
- Snap-to-nearest-triad for sus/dim/aug input — revisit if Jazz/modal users
  request it
- Per-input-note velocity mapping (3 input vels → 3 voiced output notes) —
  ambiguous for `seventh=1` voicings; revisit if requested
- Static `velocity` override parameter — `lastInputVelocity` is the single
  source

## Implementation checklist

Phases follow ADR 003's tests-first pattern (CLAUDE.md Gate 1).

### Phase 1 — Engine: `findTriadInHeldNotes` helper

Subset search is reusable across targets (m4l + future vst/app), so it
belongs in the engine, not the host.

- [x] Shared test vectors
  ([docs/ai/tonnetz-test-vectors.json](../../tonnetz-test-vectors.json)):
  added `find_triad_in_held_notes` section. 15 cases covering 3-note triad,
  Cmaj7 (Cmaj over Em), Dm7 (Dm over Fmaj), C7, C6/Am7-over-C (Cmaj over
  Am), sus/dim/aug (null), first inversion, octave doubling, input order
  independence, and 0/1/2-note edge cases.
- [x] Engine ([m4l/engine/tonnetz.ts](../../../m4l/engine/tonnetz.ts)):
  `findTriadInHeldNotes(notes: MidiNote[]): Triad | null` added. Sorts
  input ascending for deterministic enumeration, generates all 3-element
  subsets, runs `identifyTriad` (catching the throw for non-triads), tracks
  the matching subset whose root MIDI value (the held note matching the
  identified `rootPc`) is lowest, returns `buildTriad(rootPc, quality,
  rootMidi)` for the winner. `identifyTriad` itself unchanged.
- [x] Engine tests
  ([m4l/engine/tonnetz.test.ts](../../../m4l/engine/tonnetz.test.ts)):
  consume the new test vector section.
- [x] `pnpm -r test` green (engine 140, host 29); `pnpm -r typecheck`
  green; `pnpm -r build` refreshes `dist/`.

### Phase 2 — Host: input pipeline

- [x] Host tests ([m4l/host/host.test.ts](../../../m4l/host/host.test.ts)):
  added 21 tests across 4 new describes (`Host.noteIn`, `Host.noteOff`,
  `Host.transportStart`, `Host pos reset on startChord change`). Cover:
  triad-input chord update with note-offs for sustained walker output,
  next-step emits new chord at effective pos 0, `lastInputVelocity`
  tracking + default 100, non-triad / partial input no-op, omni vs single-
  channel filter, hybrid walker continues after release, hybrid noteOff
  can expose new triad subset, hold-to-play last-release panic + pause,
  hold-to-play reactivation resets cells from cells[0], pre-roll with /
  without held notes (both modes), lattice setParams startChord pos reset,
  same-triad setParams no-op, replay determinism (script-replay produces
  identical event streams).
- [x] Host ([m4l/host/host.ts](../../../m4l/host/host.ts)):
  - `HostParams`: removed `velocity` (replaced by tracked
    `lastInputVelocity`); added `triggerMode` (0|1) and `inputChannel`
    (0..16).
  - Added `noteIn(pitch, vel, channel)`, `noteOff(pitch, channel)`,
    `transportStart()`, private `recomputeStartChord()`, private
    `matchesInputChannel()`. Internal state: `inputHeld`,
    `lastInputVelocity`, `walkerActive`, `startPos`, `pendingPosReset`.
  - `step()` now gates on `walkerActive`, applies `pendingPosReset` →
    `effectivePos = pos - startPos`, and uses `this.lastInputVelocity` for
    output velocity.
  - `setParams()` detects startChord change → `pendingPosReset = true`,
    `lastTriad = null`; inputChannel change → clears `inputHeld`;
    triggerMode → 0 → reactivates walker. `triggerMode` and `inputChannel`
    flow through the existing `setParams` path — no separate setters
    needed (the patcher will fire `setParams triggerMode <v>` etc.).
  - `cellIdx()` also gates on `walkerActive` and uses effective pos.
- [x] [m4l/host/index.js](../../../m4l/host/index.js):
  - Constructor params updated (removed `velocity`, added `triggerMode: 0`,
    `inputChannel: 0`).
  - Added `noteIn` / `noteOff` / `transportStart` Max.addHandler bridges,
    each forwarding events through `emit()` and refreshing
    `lattice-current`. `noteOff` additionally clears the cellIdx LED if
    the walker just paused (hold-to-play release).
- [x] `pnpm -r test` green (engine 140, host 50); `pnpm -r typecheck`
  green; `pnpm -r build` refreshes `dist/`.

### Phase 3 — Patcher wiring

- [x] Added `triggerMode` `live.numbox` (range 0–1, int, init 0) to
  [Oedipa.maxpat](../../../m4l/Oedipa.maxpat) device strip
  (presentation_rect column at x=540, top row); `prepend setParams
  triggerMode` feeds [node.script]. Banged from the `obj-trig-hostready`
  fan-out, so it joins the rehydrate dump on `hostReady`.
- [x] Added `inputChannel` `live.numbox` (range 0–16, int, init 0 = omni)
  next to it (column x=540, second row); `prepend setParams inputChannel`
  → [node.script]. Same dump cascade.
- [x] Forked `midiin` to `[node.script]` via
  `midiin → midiparse → (outlet 0 = note pair) → unpack 0 0` and
  `(outlet 6 = channel)`, recombined through
  `if $i2 > 0 then noteIn $i1 $i2 $i3 else noteOff $i1 $i3`. Existing
  `midiin → midiout` passthrough is retained.
- [x] Hooked transport-start: extended `obj-sel-stop` from `sel 0` to
  `sel 0 1` so its second outlet bangs on `is_playing 0→1`; that bang
  drives a `transportStart` message into [node.script].
- [x] `pnpm bake` rewrote `Oedipa.amxd`; JSON validated, engine 140 / host
  50 tests still green, `pnpm -r typecheck` clean.

### Phase 4 — Manual verification in Live

- [ ] Load device, no input wired: lattice-click workflow still works,
  walker velocity = 100, no behavior regression vs. ADR 003.
- [ ] Connect MIDI keyboard, hybrid mode: play Cmaj → walker switches to C;
  release notes → walker continues on C; play Fmaj → walker switches to F.
- [ ] Switch to hold-to-play (`triggerMode = 1`): play Cmaj → walker emits
  while held; release all → walker stops mid-cell, no stuck notes; play
  again → walker restarts at the new chord.
- [ ] Record a chord progression clip (Cmaj → Fmaj → Gmaj × 4 bars) on the
  same track, replay: capture Oedipa's MIDI output to a second track on
  two consecutive playbacks; the captured MIDI streams must be
  bit-identical.
- [ ] Pre-roll: hold a chord on the keyboard, press Play with notes still
  held — walker starts on the held chord, not on the lattice's persisted
  chord.
- [ ] `inputChannel` filter: route input on channel 2, set
  `inputChannel = 1` → no chord updates. Set `inputChannel = 2` → chord
  updates resume.
- [ ] Velocity passthrough: play soft (vel ~30), then hard (vel ~100); each
  walker output thereafter carries the most-recent velocity.
- [ ] Save / close / reopen the set: `triggerMode` and `inputChannel`
  restored; behavior matches pre-save.
- [ ] Vocabulary check: hold Cmaj7, walker tracks Cmaj. Hold Csus2 → no
  change (still on previous chord). Hold first-inversion Cmaj/E → walker
  tracks Cmaj rooted near the held E.

## Open questions

None at adoption. All five axes settled 2026-04-29.

Items deferred to future revisits if real use exposes pain:

1. **Snap-to-nearest-triad for non-Tonnetz input** (sus, dim, aug, quartal).
   Currently ignored. Revisit by extending `identifyTriad` (or adding a
   sibling `nearestTriad`) if Jazz / modal players report "playing a sus
   chord does nothing" as a regression.
2. **`free-running` triggerMode** (third option). Currently hybrid covers
   the lattice-click-only case. Surface explicitly only if users request a
   "ignore all input, only use lattice" mode that prevents accidental input
   from updating `startChord`.
3. **Per-input-note velocity mapping** (3 input vels → 3 voiced output
   notes). Currently single `lastInputVelocity`. Ambiguous for `seventh=1`
   voicings (4 output notes). Revisit only if expressive-chord users
   request it.
4. **Recursive Oedipa chains** — Oedipa's output is triadic, so feeding
   Oedipa's output into another Oedipa instance via Live's MIDI routing
   would actually trigger triad recognition and chain the engines. Not a
   v1 concern, but worth noting as a fun emergent behavior.

## Per-target notes

**m4l**: Incoming MIDI arrives at the patcher's `midiin` and currently
routes straight to `midiout` for monitoring. The new path forks a copy
through `midiparse` (or equivalent unpacking) into `[node.script]`. Held-
note tracking and subset-search dispatch live in `host.ts`; the engine
exports the pure `findTriadInHeldNotes` helper. The `triggerMode` and
`inputChannel` params follow the same `live.numbox → dump → setParams`
pattern as Group A in ADR 003 and join the `hostReady` dump cascade.

**vst/app**: Equivalent in JUCE / AUv3 by inspecting `midiBuffer` in
`processBlock` — extract note-on/off events, maintain the held-note set,
call `findTriadInHeldNotes` (same engine semantics, reimplemented in C++
per ADR 001). `triggerMode` and `inputChannel` are plain
`AudioParameterInt` exposed on `AudioProcessorValueTreeState`. Velocity
passthrough is a single field on the processor. Pre-roll snapshot triggers
off the host's `playHead` transition from stopped → playing.
