# ADR 003: M4L Sequencer — Lattice UI & Cell Sequencer

## Status: Proposed

**Created**: 2026-04-19
**Revised**: 2026-04-23 (absorbed planned ADR 004; restructured around the lattice as the primary UI)
**Revised**: 2026-04-26 (replaced sequence-driven walker with attractor-driven walker)
**Revised**: 2026-04-26 (replaced attractor model with short cell sequencer + jitter; concept.md rewritten in lockstep — see "Context" below for the design path)

## Context

The first revision (sequence-driven, 2026-04-23) had the user assemble a P/L/R
sequence by clicking lattice edges, with anchors pinning specific chords at
specific steps. The second revision (attractor-driven, 2026-04-26) replaced
that with a single attractor on the lattice plus probabilistic steering toward
it. Both were rejected during design review:

- **Sequence-driven** → manually authoring chord-by-chord defeats a generative
  plugin's reason for existing. Inboil could afford this because Tonnetz was
  one node in a scene graph; a standalone plugin cannot.
- **Attractor-driven** → too thin. With no authored program and only a steering
  knob, the plugin is a 3-knob random walker. Lacks character. Lacks the
  "small repeating program" core of Ornament & Crime's Automatonnetz that
  Oedipa is meant to inherit.

The third revision (this one) settles on a **short cell sequencer with seeded
jitter**:

- A short cyclic array of cells (default 4), each holding `P` / `L` / `R` /
  `hold`.
- An automaton consumes one cell per transform tick.
- A `jitter` knob (0–1) probabilistically substitutes the cell's op with a
  uniform-random one, sampled from a seeded PRNG.
- Each cell is exposed as an independent `live.*` parameter — the user can
  author a static program, animate one cell via host automation, or mix both.

This is "constrained inboil + Automatonnetz steering": short program (so it
doesn't degenerate into manual chord authoring), per-cell automation (so live
steering replaces the long-form sequence editor), and seeded jitter (so opt-in
randomness stays reproducible). It is the *minimum* shape that produces a
musically sufficient standalone plugin; richer cell schemas (`(op, count)`
repeats, `(dx, dy, flip)` vectors) are deliberately deferred — see "Future
shape extensions" below.

[concept.md](../concept.md) was rewritten on the same date to make this the
canonical model across all targets; this ADR rewrites the m4l surface to match.

## Decision

Parameters split into three groups by **musical function**, mapped onto two UI
surfaces (Live's `live.*` header and the embedded lattice).

### Group A — Transport (live.*)

| Param              | Type | Range | Live object   |
|--------------------|------|-------|---------------|
| `stepsPerTransform`| int  | 1–32  | `live.numbox` |

Held over from prior revisions. How long each triad holds, in 16th-note
transport ticks.

### Group B — Voice / MIDI output (live.*)

| Param      | Type | Range              | Live object         |
|------------|------|--------------------|---------------------|
| `voicing`  | enum | close/spread/drop2 | `live.tab` (3 tabs) |
| `seventh`  | bool | 0/1                | `live.toggle`       |
| `channel`  | int  | 1–16               | `live.numbox`       |

Held over from prior revisions. How a triad (Group C output) is rendered as
MIDI notes. `velocity` remains absent from the strip — input passthrough is
the intended source (concept.md "Velocity source"; wired in ADR 004).

### Group C — Walk generation

| Param        | Type                                   | Range  | Surface                        |
|--------------|----------------------------------------|--------|--------------------------------|
| `startChord` | triad                                  | —      | lattice (click) + pattr        |
| `cells`      | `('P' \| 'L' \| 'R' \| 'hold')[]` (4)  | enum   | 4× `live.tab` (4-option each)  |
| `jitter`     | float                                  | 0–1    | `live.dial`                    |
| `seed`       | int                                    | 0–2³¹−1| `live.numbox`                  |

`startChord` is the walker's starting triad. Set once at session start
(typically from incoming MIDI per ADR 004; via lattice click as the manual
fallback). Not directly automatable; persisted via `pattr`.

`cells` is the program. Default `['P', 'L', 'R', 'hold']` — exercises every op
once, lands on a hold each cycle so motion has a pulse. Each cell is exposed
as a separate `live.tab` (`cell0` through `cell3`), so each is independently
host-automatable. Live records `live.tab` index changes as ordinary
parameter automation. The host receives `setCell <idx> <op>` per change.

`jitter` (`live.dial`, 0–1) is the per-step probability of substituting the
cell's op with a uniform-random pick from `{P, L, R, hold}`. `seed`
(`live.numbox`) makes the substitution reproducible: for fixed
`(startChord, cells, jitter, seed)`, the walk is deterministic across playback
restarts.

### Lattice UI — interaction model

The `[jsui]` lattice keeps the logic/renderer split from the prior revision:

- **Logic layer** ([m4l/engine/lattice.ts](../../../m4l/engine/lattice.ts)):
  coordinate ↔ triad mapping, viewport math, hit testing. Pure TS, runs in Node
  tests.
- **Renderer** ([m4l/host/lattice-renderer.js](../../../m4l/host/lattice-renderer.js)):
  jsui-specific drawing. Reads state via `latticeCenter` / `latticeCurrent`
  handlers (already wired in Phase 2; no new bridge messages needed).

**Viewport**: 7-column × 3-row vertex grid (12 visible triangles), unchanged
from prior revisions.

**Interactions** (revised — minimal):

- **Click a triangle** → set `startChord` to that triad. Writes via
  `setStartChord` and the pattr-backed dict. (Modifier-free; no attractor to
  conflict with.)
- **No edge clicks. No drag. No anchor pinning.** The lattice is primarily a
  *visualization*; cell editing happens in the device strip.

**Visual state**:

- **Walker's current triangle**: primary fill (already implemented in Phase 2)
- **startChord triangle**: thin tertiary marker (lets the user see "rest
  position")
- **Path trail** (optional): last N triangles fading out. Defer to a follow-up
  pass if the renderer cost is non-trivial — voice-leading walks already
  highlight one triangle at a time and the eye fills in continuity.

### Cell sequencer UI — device strip layout

Cells live in a small panel adjacent to the lattice. Suggested layout (subject
to refinement during Phase 4 manual passes):

- 4× `live.tab` arranged in a row (1×4) or grid (2×2). Each tab has 4 options:
  `P`, `L`, `R`, `—` (hold).
- Small indicator above each cell showing which one the automaton is currently
  consuming (lights up at each transform boundary). Drives off the same
  transformIdx the engine uses.
- `jitter` `live.dial` and `seed` `live.numbox` placed nearby.

The 1×4 row is closer to a sequencer feel; the 2×2 grid is more spatial. The
device-strip horizontal budget will decide.

### State ownership & persistence

- **Group A + B + Group C `cells*` / `jitter` / `seed`** — `live.*`. Persisted
  by Live automatically; restored on device load via the existing
  `live.thisdevice` outlet 0 → dump → `setParams <key>` chain.
- **Group C `startChord`** — not representable as `live.*` (no native Live
  equivalent for "a triad"). Stored in a Max `dict` scoped to the device,
  bridged to Live's preset storage via `pattr`. On load, `pattr` fires the
  serialized startChord into `setStartChord`.

Rehydration order: all params must land in `host` before the first transport
tick. `live.thisdevice` outlet 0 sequences the live.* dumps; `pattr` follows.
Gate `step` on a `paramsReady` flag if a race appears in practice.

### Message protocol (Max → host)

- `setParams <key> <value>` — Group A / B scalars + `jitter` / `seed`
- `setStartChord <p1> <p2> <p3>` — Group C startChord
- `setCell <idx> <op>` — Group C single-cell update (idx 0..3, op string)
- `setCells <op0> <op1> <op2> <op3>` — Group C bulk update (used by `pattr` /
  initial dump)

Removed from prior revisions: `setSequence`, `setAnchors`, `setAttractor`.

### Automation & Push

Group A, Group B, and most of Group C (`cell0..cell3`, `jitter`, `seed`) are
automatable by default — they are `live.*`. `startChord` is structural (set
once per session, then driven by MIDI input) and not automatable.

The musically significant automation handle is **a single cell** — automating
`cell2`, say, gives the user a slowly-rotating "what's the third op of the
loop" without touching the rest. Combined with a low `jitter`, this is the
design's main expressive gesture.

### Future shape extensions

The cell schema is intentionally small. Two natural extensions are deferred:

- **(op, count)** per cell — repeat the op `count` times before advancing
  ("distance" along a P/L/R axis). Schema-additive; existing data migrates
  with `count = 1`.
- **(dx, dy, flip)** vector cells — full Automatonnetz-style spatial program.
  Schema-replacing; would version the pattr-backed state and sit alongside the
  current op cells via a discriminated union.

Neither is in scope for v1. Revisit only if the simple op cells prove
musically thin in real use.

## Scope

**In scope:**
- Engine API change: `walk()` takes `cells` / `jitter` / `seed`; drops
  `sequence` / `anchors`
- Host API change: `HostParams` adopts the new shape
- Lattice click → `startChord` (no modifier)
- Cell sequencer UI in the device strip (4× live.tab + dial + numbox)
- Persistence: Group C live.* automatic, `startChord` via pattr
- Shared test vectors updated to the new walk semantics

**Out of scope (future ADRs):**
- MIDI input handling (incoming notes update `startChord`, velocity
  passthrough) → ADR 004
- Rhythm patterns beyond "every step sounds" → later ADR
- Library presets (`.adv`) and cross-set device cut/paste of Group C state
- Cell schema extensions (`(op, count)`, vectors) — deferred until v1 use
  exposes a need

## Implementation checklist

Flip to Implemented and move to `archive/` once all boxes are checked.

### Phase 1 — Transport + Voice (Group A + B) — DONE in prior revision

Kept; live.* objects, dump chain, velocity removal. Manual verification
deferred to bundle with Phase 4.

### Phase 2 — Lattice renderer (view-only) — DONE in prior revision

Kept; lattice.ts logic, jsui renderer, current-step indicator. Manual
verification deferred to bundle with Phase 4.

### Phase 3 — Engine/Host API rebase

Per CLAUDE.md Gate 1, tests first. The TS engine is the reference impl; shared
test vectors get updated alongside.

- [x] Shared test vectors ([docs/ai/tonnetz-test-vectors.json](../../tonnetz-test-vectors.json)): replaced `walk` with `walk_deterministic` (jitter=0 cell cycles, hold semantics, spt=2, all-hold, single-cell). Anchor convention removed. `walk_jitter` section sketches the structural assertions; the `mulberry32` reference float table is left as `FILLED_BY_ENGINE_IMPLEMENTATION` — fill via a small dump script when adding cross-target conformance for vst/app.
- [x] Engine tests ([m4l/engine/tonnetz.test.ts](../../../m4l/engine/tonnetz.test.ts)): rewrote walk tests; consume `walk_deterministic`. Added TS-local jitter structural tests (jitter=0 ignores seed, jitter=1 ignores cells, fixed-seed reproduces, any-pos restart consistency, all-hold freeze).
- [x] Engine ([m4l/engine/tonnetz.ts](../../../m4l/engine/tonnetz.ts)): `WalkState` is `{ startChord, cells, stepsPerTransform, jitter, seed }`. `Anchor` type dropped. `walk()` rewritten per concept.md "Traversal". `mulberry32` exported; reseeded fresh from `seed` on every walk() call so any-pos restart reproduces.
- [x] Host tests ([m4l/host/host.test.ts](../../../m4l/host/host.test.ts)): anchor-override test dropped; cell-cycle, hold, jitter=0 seed-independence, fixed-seed reproducibility, setCell tests added.
- [x] Host ([m4l/host/host.ts](../../../m4l/host/host.ts), [m4l/host/index.js](../../../m4l/host/index.js)): `HostParams` adopts new shape. `setCell(idx, op)` and `setCells(...ops)` added. `setSequence` / `setAnchors` paths removed. Bridge accepts the new messages.
- [x] `pnpm -r build` regenerated `dist/`; `pnpm -r test` green (engine 103, host 23, lattice unchanged); `pnpm -r typecheck` green.

### Phase 4 — Cell sequencer wiring + lattice click

- [ ] 4× `live.tab` (4-option) added to [Oedipa.maxpat](../../../m4l/Oedipa.maxpat); dump path firing `setCell <idx> <op>`
- [ ] `live.dial` `jitter` (0–1, scaled) and `live.numbox` `seed` added; dump path firing `setParams jitter <v>` / `setParams seed <v>`
- [ ] Per-cell active-step indicator in the device strip (driven by an outlet from host emitting current cellIdx each transform)
- [x] Lattice click handler: triangle hit → `setStartChord`. ([m4l/lattice-renderer.js](../../../m4l/lattice-renderer.js) `onclick`, modifier-free primary-button only; pattr write deferred to Phase 5.)
- [x] Lattice logic tests: hit testing (point → triangle), click → triad translation. ([m4l/engine/lattice.test.ts](../../../m4l/engine/lattice.test.ts), `computeLayout` / `pointToCell` / `cellToTriad`; engine 118 green.)
- [ ] Manual: edit cells via device strip → audible walk follows
- [ ] Manual: jitter sweep (0 → 1) audibly transitions deterministic → random
- [ ] Manual: automate `cell2` on a clip → walker's cycle evolves over time
- [ ] Manual: change Group A + B live.* params → host receives update (deferred from Phase 1)
- [ ] Manual: lattice renders + current-step tracks transport (deferred from Phase 2)

### Phase 5 — startChord persistence

- [ ] `pattr` + `dict` wired for `startChord` only
- [ ] `live.thisdevice` outlet 0 sequences live.* dumps then `pattr` rehydrate before transport ticks
- [ ] Manual: save set with non-default startChord and cell automation, reopen, confirm both restored

### Phase 6 — Cleanup

- [ ] Remove any references to `sequence` / `anchors` / `attractor*` from source files / docs
- [ ] Update [m4l/engine/README.md](../../../m4l/engine/README.md) if it describes the old API
- [ ] Manual: full Live set save/reopen smoke test

## Open questions

1. **PRNG choice** — mulberry32 chosen; small, seedable, decent statistical
   properties. Lock the exact algorithm via shared test vectors so vst/app
   match bit-for-bit.
2. **Cell layout in the device strip** — 1×4 row vs 2×2 grid. Decide during
   Phase 4 with the actual horizontal budget in front of you.
3. **Active-cell indicator transport** — the host already knows the current
   transformIdx. Cleanest is a dedicated outlet from `[node.script]` emitting
   `cellIdx <n>` each transform, routed to a row of LEDs. Confirm during
   Phase 4 whether a simpler `pattr`-bound int suffices.

## Per-target notes

m4l-specific UI. The `vst/` equivalent will use `AudioProcessorValueTreeState`
for everything in Group A / B / Group C live.* (cells, jitter, seed are all
plain ints/floats; cells are 4 enum params), a small custom node for
`startChord`, and a JUCE `Component` for the lattice — all standard JUCE.
iOS (`app/`) reworks the lattice for touch; cell editing might collapse into a
horizontal swipeable strip if vertical space is at a premium.
