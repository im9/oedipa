# ADR 003: M4L Parameters & State

## Status: Proposed

**Created**: 2026-04-19

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
source. Live's native way is `live.*` parameters — they appear in the device
header, automate from clips, save with presets, and integrate with Push.

This ADR decides **which parameters to expose, how they map to `live.*`
objects, and how values flow to `host`**. Preset save/restore is in scope
because `live.*` values are persisted by Live automatically — but the
non-`live.*` state (complex structures like `sequence`, `anchors`) needs an
explicit decision.

Lattice-driven interaction (visually setting `startChord`, `anchors`,
editing `sequence` by clicking lattice edges) is **deferred to [ADR 004](#)**.
This ADR deals with the non-lattice parameter surface.

## Decision

(Draft — to be refined during implementation. Marked [OPEN] where not decided.)

### Parameter classification

Parameters split into three tiers by how Live can represent them:

**Tier 1 — Scalar, Live-native.** Expose as `live.*` objects. Automatable,
preset-saved by Live, Push-mappable.

| Param              | Type      | Range        | Live object         |
|--------------------|-----------|--------------|---------------------|
| `stepsPerTransform`| int       | 1–32         | `live.numbox`       |
| `voicing`          | enum      | close/spread/drop2 | `live.tab` (3 tabs) |
| `seventh`          | bool      | 0/1          | `live.toggle`       |
| `velocity`         | int       | 1–127        | `live.dial`         |
| `channel`          | int       | 1–16         | `live.numbox`       |

**Tier 2 — Structured, Live-native with encoding.** Complex but representable
via a small set of `live.*` objects.

| Param         | Representation                                           |
|---------------|----------------------------------------------------------|
| `sequence`    | [OPEN] Either (a) fixed max-length of N `live.tab` dropdowns over {P, L, R, none}, host compacts to the non-`none` prefix; or (b) single `live.text` string "PLR" parsed by host. |
| `startChord`  | [OPEN] Either (a) three `live.numbox` for p1/p2/p3 MIDI notes; or (b) defer fully to lattice UI (ADR 004) and treat as non-`live.*` state persisted via `pattr`/dict; or (c) seeded from MIDI input (ADR 005). |

**Tier 3 — Deferred to ADR 004.** `anchors` (list of `{step, triad}`) is not
cleanly representable in `live.*` and its natural UI is the lattice. Stored
in dict/`pattr` state, persisted with preset but edited only via the lattice.

### Message protocol (Max → host)

`host` already accepts per-key updates via the existing handlers in
[index.js](../../../m4l/host/index.js):

- `setParams <key> <value>` (scalar)
- `setStartChord <p1> <p2> <p3>`
- `setSequence <op> [<op> ...]`
- `setAnchors <json>`

No protocol change needed — each `live.*` object's outlet is prepended with
`setParams <key>` (or the appropriate typed setter) and sent to
`[node.script]`. Initial values on device load are pushed via `loadbang` →
`[live.*]` dump → `setParams` chain.

### Preset save / restore

- **Tier 1 & 2a** — Live's preset persists `live.*` values automatically. On
  load, the `loadbang` dump re-fires the values into `host`, restoring
  state.
- **Tier 2b (`live.text`) and Tier 3 (`anchors`)** — `pattr` or a `dict`
  object named into the preset storage. On load, fire into the
  `setSequence` / `setAnchors` handlers.

Rehydration order matters: params must land in `host` **before** the first
`step` message. In practice loadbang fires before transport ticks, so
natural ordering suffices — no explicit barrier needed. If this turns out
to race in practice, gate `step` handling until a `paramsReady` flag is
set by a `loadbang → set(all) → done` sequence.

### Automation & Push

Tier 1 params are automatable by default (Live does this for any `live.*`).
Tier 2 / Tier 3 are not meaningfully automatable — they're structural, not
continuous. No special work needed; the abstraction falls out naturally.

## Scope

**In scope for this ADR:**
- Which parameters to expose to Live vs. keep in host-internal state
- Tier mapping (scalar → `live.*`, structured → encoded, lattice → ADR 004)
- Message protocol between `live.*` objects and `host`
- Preset save / restore mechanism for each tier
- Initial-value propagation on device load

**Out of scope (future ADRs):**
- Lattice-driven interaction for `startChord`, `anchors`, `sequence` → ADR 004
- MIDI input handling (including input-as-start-chord-seed) → ADR 005
- Rhythm pattern representation (only "all-steps-sound" in v1)
- Preset-browser integration beyond Live's defaults

## Open questions

1. `sequence` representation — Tier 2a (fixed-length `live.tab` array) is
   more automation-friendly and preset-stable, but caps max sequence
   length. Tier 2b (`live.text` string) is unlimited but not automatable
   and requires text-parse validation. Default: Tier 2a with N=8, expand
   later if needed.
2. `startChord` — fastest-to-ship is Tier 1-ish with three `live.numbox`.
   But musically, selecting three MIDI notes feels awkward — users think
   in chord names, not note triples. Probably right to defer to ADR 004
   (lattice click-to-set) and ADR 005 (MIDI input seed), leaving a
   `live.numbox` triple as a fallback for the v1 device.
3. How many `live.*` objects fit in the default device header strip before
   needing the UI panel to open? Live's device header is cramped; some
   params may move into the embedded `[jsui]` area once ADR 004 lands.
4. Does `pattr` / `dict` for Tier 3 state survive cut/paste of the device
   across Live sets? Needs a smoke test during implementation.

## Per-target notes

This ADR is m4l-specific. Equivalent for `vst/` is `AudioProcessorValueTreeState`
with standard parameter declarations; host ↔ param bridging is already covered
by JUCE and will not need its own ADR. iOS (app/) will reuse the JUCE param tree.
