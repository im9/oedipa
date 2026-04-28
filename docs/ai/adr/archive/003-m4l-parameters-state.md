# ADR 003: M4L Sequencer — Lattice UI & Cell Sequencer

## Status: Implemented

**Created**: 2026-04-19
**Revised**: 2026-04-23 (absorbed planned ADR 004; restructured around the lattice as the primary UI)
**Revised**: 2026-04-26 (replaced sequence-driven walker with attractor-driven walker)
**Revised**: 2026-04-26 (replaced attractor model with short cell sequencer + jitter; concept.md rewritten in lockstep — see "Context" below for the design path)
**Implemented**: 2026-04-29 (Phases 1–6 complete; manual save/reopen smoke verified)

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

| Param        | Type                                   | Range  | Surface                                  |
|--------------|----------------------------------------|--------|------------------------------------------|
| `startChord` | triad                                  | —      | lattice (click) + 3× hidden `live.numbox`|
| `cells`      | `('P' \| 'L' \| 'R' \| 'hold')[]` (4)  | enum   | 4× `live.tab` (4-option each)            |
| `jitter`     | float                                  | 0–1    | `live.dial`                              |
| `seed`       | int                                    | 0–2³¹−1| `live.numbox`                            |

`startChord` is the walker's starting triad. Set once at session start
(typically from incoming MIDI per ADR 004; via lattice click as the manual
fallback). Persisted as three hidden `live.numbox` parameters (one per
pitch); see "State ownership & persistence" for why this won out over the
originally-planned `pattr` approach.

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

**Viewport**: 7-column × 4-row vertex grid (36 visible triangles). Phase 2
shipped 7×3 (24 triangles) but it left four triads — E major, A major,
C# minor, G# minor — without a matching cell, so the playhead silently
vanished when the walker visited those chords. Bumping rows to 4 (3
row-bands) gives every Tonnetz triad at least one viewport cell.

**Viewport center is fixed (centerPc = 0)**, independent of `startChord`.
Earlier Phase 2 wiring sent `host.centerPc` (= `startChord[0] % 12`) to the
renderer, so the lattice rotated whenever startChord changed and clicked
chords always landed near the visual center. Inboil's richer multi-layer
visualization made that rotation legible; Oedipa's lattice is sparse enough
that rotation reads as "clicks don't do anything" — every triangle ends up
near the middle. With a fixed viewport, clicking a cell moves the gray
startChord marker to that cell, which is the interaction the simpler
visual affords. `host.centerPc` is kept as an API (the musical tonal
center) but is no longer the viewport anchor — `emitLatticeCenter` sends
a hard-coded `0` (see [m4l/host/index.js](../../../m4l/host/index.js)).

**Interactions** (revised — minimal):

- **Click a triangle** → set `startChord` to that triad. Writes via
  `setStartChord` directly to the host (immediate response) and in parallel
  through the persistence triplet (`unpack 0 0 0` → 3 hidden `live.numbox`)
  so the change survives save/reopen. (Modifier-free; no attractor to
  conflict with.)
- **No edge clicks. No drag. No anchor pinning.** The lattice is primarily a
  *visualization*; cell editing happens in the device strip.

**Visual state**:

- **Walker's current triangle**: primary fill (Live orange). Implemented in
  Phase 2.
- **Highlight uniqueness**: the 7-col viewport is shorter than the natural
  12-col Tonnetz period, so several chords (Bb major, D minor, etc.) sit at
  two cells at once. The renderer resolves the walker's pcs to the *single*
  cell whose centroid is closest to the lattice center, giving the eye one
  trackable playhead instead of two. Mirrored in
  [engine/lattice.ts](../../../m4l/engine/lattice.ts) `findTriadCell`.
- **startChord triangle**: thin light-gray 2px border (overdrawn on the
  default 1px black stroke), drawn only when the walker is *not* on the same
  cell. Lets the user see the "rest position" even after the walker has
  wandered off.
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
  by Live automatically; restored on device load via the dump cascade gated
  on `hostReady` (see Rehydration order below).
- **Group C `startChord`** — three hidden `live.numbox` parameters
  (`OedipaScRoot` / `OedipaScThird` / `OedipaScFifth`, each `parameter_type 1`,
  `parameter_initial 60/64/67`, `parameter_visible 0`). The original ADR
  text proposed a Max `dict` + `pattr` bridge; that was implemented but
  values weren't actually saved with the Live set even with `autopattr
  @greedy 1`, and pattr's positional list defaults didn't survive
  uninitialized-bang either. Three plain `live.numbox` parameters use the
  same battle-tested save/restore path as `cells` / `jitter` / `seed`,
  remove the special-case dict/pattr machinery, and "just work".
  `parameter_visible 0` keeps them out of the user-facing parameter view
  so the strip still presents `startChord` as set-via-click rather than as
  an automatable parameter (see "Automation & Push" for the trade-off).

Rehydration order: node.script (`m4l/host/index.js`) emits a `hostReady 1`
message after all `Max.addHandler` registrations are in place. The patcher
routes that through `route hostReady` → `t b`, and the bang fans out to all
`live.*` params (Group A/B + cells/jitter/seed) plus the startChord-rehydrate
trigger (`t b b b` → bang the 3 `live.numbox` in reverse order so the
leftmost `pack 0 0 0` inlet fires last and emits a single combined triad to
`prepend setStartChord`). This avoids a real race we observed: live.thisdevice
outlet 0 fires before `[node.script]` finishes loading, so the dump cascade
attached directly to `live.thisdevice` reached node.script when it was still
"not ready". Routing the cascade through `hostReady` instead of
`live.thisdevice` outlet 0 guarantees node.script can handle every dumped
message. Transport ticks are independently gated on `live.observer is_playing`,
so user pressing Play happens well after host-ready in practice and no
`paramsReady` flag on `step` is needed.

The host also defends against corrupt rehydrate input: `setStartChord 0 0 0`
(or any NaN) is treated as a no-op rather than overwriting startChord. This
is a stopgap from an earlier pattr iteration where uninitialized pattrs
emitted 0 and corrupted the host's startChord; now obsolete with live.numbox
defaults but kept as a cheap safety net.

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
once per session, then driven by MIDI input) and not directly automatable
in practice: its three persistence `live.numbox` parameters are
`parameter_visible 0`, which keeps them out of the device's parameter list
(the M-mode mapping view) and out of clip automation lanes. They are still
technically Live parameters under the hood — a determined user could surface
them via Push's "all parameters" view or via Max API inspection — but no
ordinary workflow exposes them, and the click-the-lattice surface is the
only shape the UI presents for this control.

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
  Schema-replacing; would version the persisted state and sit alongside the
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
- Persistence: Group C live.* automatic, `startChord` via 3 hidden `live.numbox`
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

- [x] 4× `live.tab` (4-option) added to [Oedipa.maxpat](../../../m4l/Oedipa.maxpat); dump path firing `setCell <idx> <op>` (devicewidth 608→880; sep2 jsui + presentation column at x=626..866; voicing-style sel→msg→nodescript chain per cell; defaults P/L/R/—)
- [x] `live.dial` `jitter` (0–1, float) and `live.numbox` `seed` (0–99999, int) added; dump path firing `setParams jitter <v>` / `setParams seed <v>`
- [x] Per-cell active-step indicator in the device strip (driven by an outlet from host emitting current cellIdx each transform). Host exposes `cellIdx(pos)` returning `(numTransforms - 1) mod cells.length` (or -1 while on the start chord); index.js emits the deduped `cellIdx` outlet on every step and clears it on panic. Maxpat: `route cellIdx` → 4× `expr $i1 == N` → 4× `led` placed above each cell tab; cell tabs and seed shifted to make room.
- [x] Lattice click handler: triangle hit → `setStartChord`. ([m4l/lattice-renderer.js](../../../m4l/lattice-renderer.js) `onclick`, modifier-free primary-button only; pattr write deferred to Phase 5.)
- [x] Lattice logic tests: hit testing (point → triangle), click → triad translation. ([m4l/engine/lattice.test.ts](../../../m4l/engine/lattice.test.ts), `computeLayout` / `pointToCell` / `cellToTriad`; engine 118 green.)
- [x] Lattice viewport bug fix: rows 3 → 4 vertices ([m4l/lattice-renderer.js](../../../m4l/lattice-renderer.js), [Oedipa.maxpat](../../../m4l/Oedipa.maxpat) jsui height 120 → 160). The 7×3 grid left E major, A major, C# minor, and G# minor without a matching cell, so the playhead vanished on those chords. 7×4 covers all 24 triads. Regression test in [lattice.test.ts](../../../m4l/engine/lattice.test.ts) "viewport coverage".
- [x] Lattice playhead deduplication: [`findTriadCell`](../../../m4l/engine/lattice.ts) and the renderer's mirrored helper now pick the cell whose centroid is closest to the lattice center vertex when a chord has multiple matches in the viewport, giving the eye one trackable highlight instead of multiple synchronized ones.
- [x] Lattice startChord marker: thin light-gray 2px border on the rest-position cell, drawn only when not also the walker's current cell. Host emits startChord pcs alongside `lattice-center` so the renderer can resolve the marker without a new message route.
- [x] Manual: edit cells via device strip → audible walk follows
- [x] Manual: jitter sweep (0 → 1) audibly transitions deterministic → random
- [x] Manual: automate `cell2` on a clip → walker's cycle evolves over time
- [x] Manual: change Group A + B live.* params → host receives update (deferred from Phase 1)
- [x] Manual: lattice renders + current-step tracks transport (deferred from Phase 2)

### Phase 5 — startChord persistence

Originally specified as `pattr` + `dict` bridged to Live's preset storage.
Implemented and discarded after iteration: a list-typed `pattr` returned bad
emissions on uninitialized bang, three int-typed pattrs with positional
defaults didn't honor those defaults, and `autopattr @greedy 1` did not
actually save pattr values to the Live set in this M4L environment. Settled
on three hidden `live.numbox` parameters — same save/restore mechanism as
the rest of the device's `live.*` state, no special machinery needed.
Verified end-to-end via save/close/reopen with both startChord and a
cell-automation clip.

- [x] Three hidden `live.numbox` parameters (`OedipaScRoot` /
  `OedipaScThird` / `OedipaScFifth`, `parameter_initial 60/64/67`,
  `parameter_visible 0`) added to [Oedipa.maxpat](../../../m4l/Oedipa.maxpat).
  Click path: `jsui → route setStartChord → unpack 0 0 0 → 3 live.numbox`
  (each stores and emits) → `pack 0 0 0` → `prepend setStartChord` →
  nodescript. Rehydrate path: `trig-hostready → t b b b → 3 live.numbox`
  (banged in reverse so leftmost pack inlet fires last) → same `pack` →
  `prepend setStartChord` → nodescript.
- [x] Dump cascade gated on `hostReady` instead of `live.thisdevice` outlet
  0. node.script's [host/index.js](../../../m4l/host/index.js) emits
  `Max.outlet('hostReady', 1)` after all handlers are registered; the
  patcher routes that through `route hostReady → t b` to fan out to all
  `live.*` params (Group A/B + cells/jitter/seed) and the startChord
  rehydrate trigger. This fixes the pre-existing race where
  `live.thisdevice` outlet 0 fired before the node.script subprocess was
  ready, so the very first dump landed in a "not ready" state. The host
  additionally guards against `setStartChord 0 0 0` and NaN args (defensive
  no-op) — leftover from an earlier pattr iteration but cheap to keep.
- [x] Manual: saved set with non-default startChord (e.g. F#) plus a cell
  automation clip; closed and reopened the set; both startChord marker and
  cell automation restored as expected.

The Lattice UI section's other Phase 5–era refinements (fixed viewport
center, three-pass startCell border draw to avoid stroke-overlap chewing
the gray accent) are also in this drop; see "Lattice UI — interaction
model" and the renderer in
[m4l/lattice-renderer.js](../../../m4l/lattice-renderer.js).

### Phase 6 — Cleanup

- [x] Remove any references to `sequence` / `anchors` / `attractor*` from source files / docs (live source: lattice-renderer.js click-handler comment rephrased to describe what the click does, not what doesn't exist; archive/* and concept.md "Origin notes" intentionally retained as historical context)
- [x] Update [m4l/engine/README.md](../../../m4l/engine/README.md) if it describes the old API (now points to ADR 003 + concept.md "Traversal" for current walk semantics; archive/001 framed as v1-walker historical reference)
- [x] Manual: full Live set save/reopen smoke test

## Open questions

1. **PRNG choice** — mulberry32 chosen; small, seedable, decent statistical
   properties. Lock the exact algorithm via shared test vectors so vst/app
   match bit-for-bit.
2. **Cell layout in the device strip** — settled during Phase 4 as a 2×2
   grid (top row cells 0/1, bottom row cells 2/3) with the active-step LED
   row directly above each cell.

## Per-target notes

m4l-specific UI. The `vst/` equivalent will use `AudioProcessorValueTreeState`
for everything in Group A / B / Group C live.* (cells, jitter, seed are all
plain ints/floats; cells are 4 enum params), a small custom node for
`startChord`, and a JUCE `Component` for the lattice — all standard JUCE.
iOS (`app/`) reworks the lattice for touch; cell editing might collapse into a
horizontal swipeable strip if vertical space is at a premium.
