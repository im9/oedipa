# ADR 003: M4L Sequencer — Lattice UI & Walk Generation

## Status: Proposed

**Created**: 2026-04-19
**Revised**: 2026-04-23 (absorbed planned ADR 004; restructured around the lattice as the primary UI)
**Revised**: 2026-04-26 (replaced sequence-driven walker with attractor-driven walker; concept.md rewritten in lockstep)

## Context

[ADR 002](archive/002-m4l-device-architecture.md) stood up the m4l device. The
prior revision of this ADR shipped Phase 1 (Group A+B `live.*` params) and Phase
2 (lattice renderer, view-only). Phase 3 was about to begin — sequence editing
on the lattice plus anchor UX — when a deeper question surfaced: **why are we
asking the user to assemble a P/L/R sequence by hand?**

Re-grounding on Oedipa's lineage clarified the intended product. Oedipa's
spiritual ancestor is Ornament & Crime's
[Automatonnetz](https://ornament-and-cri.me/automatonnetz/), not inboil's manual
SEQ panel:

- The user does not author a step sequence; they steer an automaton.
- Automatonnetz steers via a 2D vector grid modulated by CV. The DAW-native
  equivalent is **a single attractor on the lattice that the host can
  automate** — the walker probabilistically steers toward it.
- If the user wants hand-edited chords, they print Oedipa's output to a MIDI
  clip; Live's piano roll is a better step editor than anything we would build
  inside `[jsui]`.

This invalidated the prior revision's `sequence` / `anchors` parameters and the
lattice's edge-click / pin interactions. [concept.md](../concept.md) was
rewritten on the same date to make the attractor-driven model canonical across
all targets; this ADR rewrites the m4l surface to match.

## Decision

Parameters split into three groups by **musical function**, mapped onto two UI
surfaces (Live's `live.*` header and the embedded lattice).

### Group A — Transport (live.*)

| Param              | Type | Range | Live object   |
|--------------------|------|-------|---------------|
| `stepsPerTransform`| int  | 1–32  | `live.numbox` |

Held over from prior revision. How long each triad holds, in 16th-note
transport ticks.

### Group B — Voice / MIDI output (live.*)

| Param      | Type | Range              | Live object         |
|------------|------|--------------------|---------------------|
| `voicing`  | enum | close/spread/drop2 | `live.tab` (3 tabs) |
| `seventh`  | bool | 0/1                | `live.toggle`       |
| `channel`  | int  | 1–16               | `live.numbox`       |

Held over from prior revision. How a triad (Group C output) is rendered as
MIDI notes. `velocity` remains absent from the strip — input passthrough is the
intended source (concept.md "Velocity source"; wired in ADR 004).

### Group C — Walk generation

| Param        | Type   | Range        | Surface                           |
|--------------|--------|--------------|-----------------------------------|
| `startChord` | triad  | —            | lattice (shift+click) + pattr     |
| `attractor`  | triad  | —            | lattice (click) + live.* (3 sub)  |
| `jitter`     | float  | 0–1          | `live.dial`                       |
| `seed`       | int    | 0–2³¹−1      | `live.numbox`                     |

`startChord` is the walker's resting/start state. Set once at session start —
typically from incoming MIDI (ADR 004), via shift+click on the lattice as
fallback. Not directly automatable; persisted via `pattr`.

`attractor` is the steering control — the main automation handle Live receives.
Because Live only automates `live.*` values, the attractor is exposed as three
sub-parameters under the hood:

| Sub-param        | Live object   | Notes                                  |
|------------------|---------------|----------------------------------------|
| `attractorRow`   | `live.numbox` | int, 0..(rows−1)                       |
| `attractorCol`   | `live.numbox` | int, 0..(cols−1)                       |
| `attractorMinor` | `live.toggle` | 0 = major △, 1 = minor ▽               |

The lattice UI writes to these on click; Live records the changes as ordinary
parameter automation. On playback, Live drives the values, the lattice
visualization reflects them, and the host receives
`setAttractor <row> <col> <kind>`.

`jitter` and `seed` are plain `live.*` values, automatable like any other.

### Lattice UI — interaction model

The `[jsui]` lattice keeps the logic/renderer split from the prior revision:

- **Logic layer** ([m4l/engine/lattice.ts](../../../m4l/engine/lattice.ts)):
  coordinate ↔ triad mapping, viewport math, hit testing. Pure TS, runs in Node
  tests.
- **Renderer** ([m4l/host/lattice-renderer.js](../../../m4l/host/lattice-renderer.js)):
  jsui-specific drawing. Reads state via `latticeCenter` / `latticeCurrent` /
  `latticeAttractor` handlers (extends the prior bridge).

**Viewport**: 7-column × 3-row vertex grid (12 visible triangles), unchanged
from prior revision.

**Interactions** (revised — much smaller surface than prior Phase 3):

- **Click a triangle** → set `attractor` to that triad. Lattice writes the
  three `attractor*` `live.*` values; Live records them as automation.
- **Shift+click a triangle** → set `startChord` to that triad. Writes via
  `setStartChord` and the pattr-backed dict.
- **No edge clicks. No anchor pinning. No drag.** Smallest interaction surface
  that supports the model; revisit only if real use bites.

**Visual state**:

- **Walker's current triangle**: primary fill
- **Attractor triangle**: secondary outline (distinct color/weight); when walker
  has reached attractor, the triangle shows both fill and outline
- **startChord triangle**: thin tertiary marker (lets the user see "rest
  position")
- **Path trail** (optional): last N triangles fading out. Defer to a follow-up
  pass if the renderer cost is non-trivial.

### State ownership & persistence

- **Group A + B + Group C `attractor*` / `jitter` / `seed`** — `live.*` values.
  Persisted by Live automatically; restored on device load via the existing
  `live.thisdevice` outlet 0 → dump → `setParams <key>` chain.
- **Group C `startChord`** — not representable as `live.*` (no native Live
  equivalent for "a triad"). Stored in a Max `dict` scoped to the device,
  bridged to Live's preset storage via `pattr`. On load, `pattr` fires the
  serialized startChord into `setStartChord`.

This is materially simpler than the prior revision's persistence (which needed
`pattr` for `sequence` and `anchors` too). Only one non-`live.*` value remains.

Rehydration order: all params must land in `host` before the first transport
tick. Same mechanism as prior revision — `live.thisdevice` outlet 0 sequences
the live.* dumps; `pattr` follows. Gate `step` on a `paramsReady` flag if a race
appears in practice.

### Message protocol (Max → host)

- `setParams <key> <value>` — Group A / B scalars + `jitter` / `seed`
- `setStartChord <p1> <p2> <p3>` — Group C startChord
- `setAttractor <row> <col> <kind>` — Group C attractor (kind: 0 major,
  1 minor)

Removed from prior revision: `setSequence`, `setAnchors`.

### Automation & Push

Group A, Group B, and most of Group C (`attractor*`, `jitter`, `seed`) are
automatable by default — they are `live.*`. `startChord` is structural (set
once per session, then driven by MIDI input) and not automatable.

The musically significant automation handle is `attractor`: a single conceptual
parameter (three `live.*` under the hood) that reshapes the entire walk. This
is the design's main payoff over the prior revision.

## Scope

**In scope:**
- Engine API change: `walk()` takes `attractor` / `jitter` / `seed`; drops
  `sequence` / `anchors`
- Host API change: `HostParams` adopts the new shape
- Lattice renderer: add attractor visualization
- Lattice click / shift+click → attractor / startChord
- Persistence: Group C live.* via Live's automatic mechanism, `startChord` via
  pattr
- Shared test vectors updated to the new walk semantics

**Out of scope (future ADRs):**
- MIDI input handling (incoming notes update `startChord`, velocity passthrough)
  → ADR 004
- Rhythm patterns beyond "every step sounds" → later ADR
- Library presets (`.adv`) and cross-set device cut/paste of Group C state

## Implementation checklist

Flip to Implemented and move to `archive/` once all boxes are checked.

### Phase 1 — Transport + Voice (Group A + B) — DONE in prior revision

Kept; live.* objects, dump chain, velocity removal. Manual verification
deferred to bundle with Phase 4 below.

### Phase 2 — Lattice renderer (view-only) — DONE in prior revision

Kept; lattice.ts logic, jsui renderer, current-step indicator. Manual
verification (lattice renders + tracks transport) deferred to bundle with
Phase 4.

### Phase 3 — Engine/Host API rebase (NEW prerequisite)

Per CLAUDE.md Gate 1, tests first. The TS engine is the reference impl; shared
test vectors get updated alongside.

- [ ] Shared test vectors ([docs/ai/tonnetz-test-vectors.json](../../tonnetz-test-vectors.json)): add `walk` cases covering attractor-driven traversal — greedy at jitter=0 (deterministic given start + attractor + tie-break rule), reproducibility for fixed seed at jitter>0. Remove the `anchor` convention note.
- [ ] Engine tests ([m4l/engine/tonnetz.test.ts](../../../m4l/engine/tonnetz.test.ts)): rewrite `walk()` tests for the attractor model. P/L/R, identify, voicing tests via shared vectors stay.
- [ ] Engine ([m4l/engine/tonnetz.ts](../../../m4l/engine/tonnetz.ts)): replace `WalkState` with `{ startChord, attractor, stepsPerTransform, jitter, seed }`. Replace `walk()` body with the attractor rule (concept.md "Traversal"). Add a small seeded PRNG (mulberry32 or LCG) — pure function of `(seed, pos)`, no hidden state. Drop the `Anchor` type and `anchors` parameter.
- [ ] Host tests ([m4l/host/host.test.ts](../../../m4l/host/host.test.ts)): drop the anchor-override test, add attractor-pull and reproducibility tests.
- [ ] Host ([m4l/host/host.ts](../../../m4l/host/host.ts), [m4l/host/index.js](../../../m4l/host/index.js)): `HostParams` adopts the new shape. Add `setAttractor(row, col, kind)`. Drop `setSequence` / `setAnchors` paths. The Max → JS bridge accepts the new messages.
- [ ] `pnpm -r build` so `dist/` reflects new API; `pnpm -r test` green.

### Phase 4 — Lattice attractor wiring (replaces prior Phase 3)

- [ ] `live.numbox` `attractorRow`, `attractorCol`, `live.toggle` `attractorMinor` added to [Oedipa.maxpat](../../../m4l/Oedipa.maxpat); dump path firing `setAttractor`
- [ ] `live.dial` `jitter` (0–1, scaled), `live.numbox` `seed` added; dump path firing `setParams jitter <v>` / `setParams seed <v>`
- [ ] Lattice renderer: draw attractor outline + walker fill (handles `latticeAttractor <row> <col> <kind>`)
- [ ] Lattice click handler: triangle hit → write attractor `live.*` values
- [ ] Lattice shift+click handler: triangle hit → `setStartChord`
- [ ] Lattice logic tests: hit testing (point → triangle), click→attractor coordinate translation
- [ ] Manual: change attractor via lattice → audible walk steers toward it
- [ ] Manual: automate `attractorRow` / `attractorCol` on a clip → walker follows over time
- [ ] Manual: jitter sweep (0 → 1) audibly transitions greedy → random
- [ ] Manual: change Group A + B live.* params → host receives update (deferred from Phase 1)
- [ ] Manual: lattice renders + current-step tracks transport (deferred from Phase 2)

### Phase 5 — startChord persistence

- [ ] `pattr` + `dict` wired for `startChord` only
- [ ] `live.thisdevice` outlet 0 sequences live.* dumps then `pattr` rehydrate before transport ticks
- [ ] Manual: save set with non-default startChord and attractor automation, reopen, confirm both restored

### Phase 6 — Cleanup

- [ ] Remove prior revision's references to `sequence` / `anchors` from any remaining source files / docs
- [ ] Update [m4l/engine/README.md](../../../m4l/engine/README.md) if it describes the old API
- [ ] Manual: full Live set save/reopen smoke test

## Open questions

1. **Distance metric for "closer to attractor"** — Euclidean distance on the
   triangle's centroid in (row, col) space, or BFS hop count on the
   triangle adjacency graph? Euclidean is cheaper and probably good enough; BFS
   is more "honest" to the lattice topology. Decide in Phase 3 and lock the
   choice via shared test vectors.
2. **Tie-breaking at jitter = 0** — when two candidates have equal distance,
   pick by fixed P/L/R priority (e.g. R > L > P) or by RNG even at jitter=0?
   Lean: fixed priority, simpler and easier to test.
3. **Softmax shape** — the curve mapping user-facing `jitter` (0–1) to the
   actual probabilistic weighting needs to *feel* right at the midpoint. Pick
   something that audibly bridges greedy and uniform at jitter ≈ 0.5; lock it
   via test vectors.
4. **startChord click gesture** — shift+click chosen here. Long-press is
   laggy in `[jsui]`, right-click is unreliable in M4L. Revisit only if
   shift+click conflicts with future gestures.
5. **PRNG choice** — mulberry32 is the smallest viable seedable PRNG with good
   statistical properties; LCG is even smaller but lower quality. Lean
   mulberry32; either way, encode it in shared test vectors so vst/app match
   bit-for-bit.

## Per-target notes

m4l-specific UI. The `vst/` equivalent will use `AudioProcessorValueTreeState`
for everything in Group A / B / Group C live.* (attractor, jitter, seed are all
plain ints/floats), a small custom node for `startChord`, and a JUCE
`Component` for the lattice — all standard JUCE. iOS (`app/`) reworks the
lattice for touch; the obvious touch affordance is dragging the attractor as a
visible handle on the lattice.
