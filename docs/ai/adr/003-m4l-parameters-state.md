# ADR 003: M4L Sequencer — Lattice UI & Parameters

## Status: Proposed

**Created**: 2026-04-19
**Revised**: 2026-04-23 (absorbed planned ADR 004; restructured around the lattice as the primary UI)

## Context

[ADR 002](archive/002-m4l-device-architecture.md) stood up the m4l device:
`[node.script host/index.js @autostart 1]` hosts the walk, Live transport drives
step dispatch, notes flow through `[midiformat] → [midiout]`. Parameter values
are currently **hardcoded in [index.js](../../../m4l/host/index.js)**:

```js
const host = new Host({
  startChord: [60, 64, 67],
  sequence: ['P'],
  stepsPerTransform: 4,
  voicing: 'close',
  seventh: false,
  anchors: [],
  velocity: 100,
  channel: 1,
})
```

To ship a usable device the user must be able to change these without editing
source. Oedipa is a **Tonnetz traversal** sequencer — a chord walk on a
triangular lattice of triads — so the device's primary UI is the **lattice
itself**. Transport and voice settings are ancillary and sit in Live's native
`live.*` header; the walk is edited by direct manipulation of the lattice.

This ADR decides the full m4l device surface: what the user sees, what they
can click/drag, how state flows between Max objects and the n4m host, and how
state persists across preset save / device instantiation. An earlier draft
split the lattice UI into a separate ADR 004, but the lattice and the walk
parameters (`startChord` / `sequence` / `anchors`) are the same design
decision viewed from two angles — separating them produced circular
references with no actual architectural gain.

## Decision

Parameters split into three groups by **musical function**, which naturally
maps onto two UI surfaces.

### Group A — Transport (live.\* header)

| Param              | Type | Range | Live object    |
|--------------------|------|-------|----------------|
| `stepsPerTransform`| int  | 1–32  | `live.numbox`  |

How long each triad holds, in 16th-note transport ticks.

### Group B — Voice / MIDI output (live.\* header)

| Param      | Type | Range              | Live object         |
|------------|------|--------------------|---------------------|
| `voicing`  | enum | close/spread/drop2 | `live.tab` (3 tabs) |
| `seventh`  | bool | 0/1                | `live.toggle`       |
| `channel`  | int  | 1–16               | `live.numbox`       |

How a triad (Group C output) is rendered as MIDI notes.

**`velocity` is intentionally not a UI control** in v1. A single dial that
applies the same velocity to every chord note across every step is
musically blunt — what we actually want is for the velocity of incoming
played notes to flow through to the generated chord. That requires real
MIDI input handling and is the work of ADR 004 (input handling). Until
then, the host keeps a fixed default velocity (`100`) internally so the
engine and tests still pass; the value just has no UI surface to change.

### Group C — Walk (lattice UI)

The Tonnetz traversal — Oedipa's reason for existing. Edited only via the
lattice; not represented as `live.*` objects because the natural model is
spatial (a triad is a triangle, a sequence is a path, an anchor is a pin).

| Param        | Semantics                                                 |
|--------------|-----------------------------------------------------------|
| `startChord` | Triad where the walk begins                               |
| `sequence`   | Ordered list of P / L / R operations applied per step     |
| `anchors`    | `{step, triad}` pairs that override the computed walk     |

### Lattice UI — interaction model

The lattice is a `[jsui]` component embedded in the device's UI panel. Per
CLAUDE.md Gate 1, it splits into:

- **Logic layer** (pure TypeScript, compiled to `dist/` for jsui):
  coordinate ↔ triad mapping, hit testing, drag math, state transitions. Runs
  in Node for tests.
- **Renderer** (jsui-specific): draws the lattice, reads model state, not
  unit-tested.

**Viewport: fixed, no scroll/pan in v1.** Ableton M4L devices live in a
fixed-size strip (no native equivalent of inboil's full-screen lattice modal).
Targeting a 7-column × 3-row vertex grid (= 6 × 2 = 12 major/minor triangle
pairs visible) gives ±2–3 P/L/R steps of visibility from a centered start
chord — enough for the common case. Walks that travel further go off-screen;
v1 accepts this and revisits scroll/pan only if the limitation bites in real
use.

**Coordinate convention** (mirrors inboil's
[TonnetzSheet.svelte](https://github.com/im9/inboil/blob/main/src/lib/components/TonnetzSheet.svelte)
math so visual intuition transfers between the two tools, even though no code
is shared):

```
noteAt(row, col, centerPc) = (centerPc + (col - cc) * 7 + (row - cr) * 4) mod 12

major triangle vertices: (r, c), (r, c+1), (r+1, c)        → {root, P5, M3}
minor triangle vertices: (r+1, c), (r+1, c+1), (r, c+1)    → {root, P5, m3}
```

Axes:

- **col +1** = +7 semitones (perfect fifth)
- **row +1** = +4 semitones (major third)
- **(row +1, col −1)** = −3 semitones (minor third)

Each triangle has three edges, identified by which interval its two endpoints
span. The Neo-Riemannian operations correspond to the **shared edge** with the
adjacent flipped triangle:

- **P5 edge** (horizontal, 7 semitones, e.g. C–G) ↔ **P** — shared with the
  same-root opposite-mode triad (C major ↔ C minor)
- **M3 edge** (down-right diagonal, 4 semitones, e.g. C–E) ↔ **R** — shared
  with the relative triad (C major ↔ A minor; root and major-third in common)
- **m3 edge** (up-right diagonal, 3 semitones, e.g. E–G) ↔ **L** — shared
  with the leading-tone triad (C major ↔ E minor; major-third and fifth in
  common)

Hit-testing a P / L / R input reduces to "which edge of the current triangle
did the user click."

Interactions (draft — refined during implementation):

- **Click a triangle** → set as `startChord` [OPEN: does this jump the active walk immediately, or only take effect at the next loop start?]
- **Click an edge (P / L / R axis)** → append that operation to `sequence` [OPEN: removal / reorder — backspace key? drag off? right-click?]
- **Pin a triangle as an anchor** [OPEN: UX is the least-settled piece — candidates are long-press during playback, a dedicated "anchor mode" toggle, or shift-click on the active step]
- **Current-step indicator**: the triangle Oedipa is currently outputting highlights; the planned upcoming path is lightly overlaid

### State ownership & persistence

- **Group A + B** — `live.*` values. Persisted by Live automatically; restored on device load via `loadbang` → dump → `setParams <key>` chain into `host`.
- **Group C** — not representable as `live.*`. Stored in a Max `dict` scoped to the device, bridged to Live's preset storage via `pattr`. On load, `pattr` fires the serialized walk state into `setStartChord` / `setSequence` / `setAnchors`.

Rehydration order: all params must land in `host` before the first transport
tick. `loadbang` fires before transport ticks in practice, so natural
ordering suffices. If a race appears, gate `step` on a `paramsReady` flag set
at the end of the load sequence.

### Message protocol (Max → host)

No change from ADR 002 — `host` already accepts:

- `setParams <key> <value>` — Group A / B scalars
- `setStartChord <p1> <p2> <p3>` — Group C
- `setSequence <op> [<op> ...]` — Group C
- `setAnchors <json>` — Group C

`live.*` outlets prepend `setParams <key>`; `pattr`/`dict` load paths route
into the typed setters. The lattice UI calls the typed setters directly via
the jsui → Max → `[node.script]` bridge.

### Automation & Push

Group A and B are automatable by default (Live handles this for any
`live.*`). Group C is structural and not meaningfully automatable — no
special work.

## Scope

**In scope:**
- Full m4l device UI surface (header + lattice)
- Parameter grouping and `live.*` mapping
- Lattice logic / renderer split
- State persistence (Live presets + `pattr`/`dict`)
- Initial-value propagation on device load

**Out of scope (future ADRs):**
- MIDI input handling (seeding `startChord` from played notes, live chord re-harmonization, **velocity passthrough**) → ADR 004 (renumbered from old ADR 005 plan)
- Rhythm patterns beyond "every step sounds" → later ADR
- Library presets (`.adv`) and cross-set device cut/paste of Group C state — v1 only persists via the host Live set; revisit if users actually ask

## Implementation checklist

Flip to Implemented and move to `archive/` once all boxes are checked.

### Phase 1 — Transport + Voice (Group A + B)

- [x] `live.*` objects added to [Oedipa.maxpat](../../../m4l/Oedipa.maxpat) for `stepsPerTransform`, `voicing`, `seventh`, `velocity`, `channel`
- [x] `loadbang` → dump → `setParams <key>` chain wired for each (uses `live.thisdevice` outlet 0 instead of `loadbang` so dumps fire after Live restores stored values; voicing routes via `sel 0 1 2` → 3 message boxes since `live.tab` outputs an int and the host expects the enum string)
- [x] Remove `velocity` from the device-strip UI; keep the host param as a fixed default `100`. Velocity will be sourced from incoming MIDI in ADR 004.
- [ ] Manual: change each param in Live, confirm `host` receives update — **deferred to Phase 2 verification pass** (Group A + B device-strip UI is hard to exercise standalone; bundle with Phase 2 lattice manual checks once there's a richer feedback loop)
- [ ] Manual: save Live set, reopen, confirm values restored — **deferred to Phase 2 verification pass**

### Phase 2 — Lattice renderer (view-only)

- [x] `m4l/engine/lattice.ts` (pure logic): coordinate ↔ triad mapping, viewport math, current-step state
- [x] `m4l/engine/lattice.test.ts`: coordinate math + highlight tests (lattice ↔ engine consistency via `applyTransform` round-trips; shared `tonnetz-test-vectors.json` covers the engine, lattice tests are layout-specific)
- [x] `m4l/host/lattice-renderer.js` (jsui wrapper): draws triangles, reads walk state, highlights current step. Bridge protocol: host emits `lattice-center <pc>` / `lattice-current <pc1> <pc2> <pc3>` / `lattice-clear` via `Max.outlet`; `[jsui]` consumes them through `route` + `prepend` boxes calling `latticeCenter` / `latticeCurrent` / `latticeClear` handlers. The vertex/triangle math is duplicated in JS (Max's [jsui] runs Max's bundled JS, not Node) — kept tiny and testable on the engine side.
- [ ] Manual: lattice renders in device panel, current-step indicator tracks transport

### Phase 3 — Lattice interaction (Group C editing)

- [ ] Hit testing: point → triangle, point → edge
- [ ] Click triangle → `setStartChord`
- [ ] Click edge → `setSequence` (append)
- [ ] Anchor UX decision + implementation → `setAnchors`
- [ ] Sequence editing: removal / reorder
- [ ] Tests driving pure logic via the public interaction API
- [ ] Manual: edit walk via lattice, confirm audible output matches

### Phase 4 — Persistence (Group C state)

- [ ] `pattr` + `dict` wired for `startChord` / `sequence` / `anchors`
- [ ] Confirm `pattr` dump fires before first transport tick (measure if uncertain)
- [ ] Manual: save set with non-default walk, reopen, confirm restored

## Open questions

1. **Anchor UX** — long-press, dedicated mode, or shift-click? Least-settled part of Group C; may spin into a sub-decision if it gets complex.
2. **Sequence length cap** — soft cap ~16 ops seems reasonable for visual legibility; hard cap enforced in pure logic.

## Per-target notes

m4l-specific. The `vst/` equivalent would be `AudioProcessorValueTreeState`
for Group A + B, a custom state tree for Group C, and a JUCE `Component` for
the lattice — all standard JUCE, unlikely to need its own ADR. iOS (`app/`)
will reuse the JUCE param tree and rework the lattice for touch input.
