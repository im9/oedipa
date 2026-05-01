# ADR 006: Workflow — Snapshot Slots, Program Strings, Factory Presets

## Status: Proposed

**Created**: 2026-04-29

## Context

ADR 003 listed "Library presets (`.adv`) and cross-set device cut/paste of
Group C state" as out of scope. With v1's musical surface complete after
ADR 004 (input) and ADR 005 (rhythm), the remaining gap before public
release is workflow: every device instance starts at default; good cell
programs cannot be saved, recalled, or shared. Live's native `.adv` preset
covers all device parameters but is heavy (operates at the device level)
and does not support the live-performance gesture of switching between a
small set of programs.

This ADR settles program management for v1.

## Decision

Four axes, all decided.

### Axis 1 — Snapshot slots (auto-save)

**4 slots** in the device. Each slot captures:

- `cells` — the 4-cell sequence (P/L/R/hold/rest with ADR 005 per-cell expression)
- `startChord` — the harmonic anchor (root + quality)
- `jitter` — random walk-bias
- `seed` — RNG seed

Other params stay **device-shared**: voicing, transport, ADR 005 feel layer
(swing, subdivision, stepDirection, humanize × 3, drift, outputLevel),
input config.

**Auto-save model.** No explicit Save action. User-driven edits to the
slot-stored fields (cells op via cell tab, jitter dial, seed numbox,
startChord via lattice click) are mirrored into the active slot
immediately. Slot switching loads the destination slot's stored state;
the previous slot's state stays intact because every prior edit was
already auto-saved. There is no "dirty / clean" distinction to manage —
the visible widgets and `slots[active]` are always in sync. Random /
factory-preset / paste-program-string actions replace the active slot's
content (Live's Cmd-Z reverts the last change).

MIDI-input-driven `startChord` updates (note-on identifies a triad) are
**live overrides**, not auto-saved — the slot keeps its anchor chord;
MIDI input is "what the player is playing right now". This preserves
the slot's identity across performance gestures.

**MIDI-input priority on slot switch.** When switching slots:

- `cells` / `jitter` / `seed` apply immediately.
- `startChord` applies only if no MIDI input is currently held. If the
  player is holding a chord, the slot's `startChord` is loaded into state
  but suppressed audibly until note-off (consistent with ADR 004's
  lattice-click vs MIDI-input rule — the held chord always wins).

This gives the player two modes from one gesture:

- **Recreate the scene**: release notes, switch slot → slot's startChord
  takes over → exact original sound.
- **Use as template**: hold a chord, switch slot → adopt rhythm/motion only.

### Axis 2 — Program string format

Compact, single-line, `|key=value` pairs:

```
"PLR-|s=42|j=0.3|c=Em"
```

- **cells** — positional, first token. Each character is one cell op:
  `P` = P, `L` = L, `R` = R, `_` = hold (continuation), `-` = rest (silence).
  ASCII-only so the program string survives copy/paste through any path.
- **`s=`** — seed (uint).
- **`j=`** — jitter (0–1 float).
- **`c=`** — startChord. Root pitch class name (accepting `C`, `C#`, `Db`,
  `D`, ... — both sharps and flats parsed). Quality: `m` suffix for minor,
  no suffix for major. Serializer emits canonical form per pitch class.
- **Unknown `|key=value` pairs ignored** for forward compatibility (e.g.
  future global params).

One format covers both slot serialization and copy/paste sharing —
program string == serialized slot.

### Axis 3 — Factory presets

**6–10 curated programs**, inlined as a const array in `host.ts`. No
sidecar JSON file, no external pack — those are out of scope for v1.

**UI**: `live.menu` dropdown placed in the slot block, separately from
the Random button (Random is a creation tool, not a library load —
they're conceptually distinct). Selecting an entry loads the program
into the active slot (replaces current content; auto-saved). After
selection, the menu resets to the placeholder so it acts as an action
picker, not a state.

**Curation** is content authoring done at implementation time. Target
range: cover the design space across P-heavy / L-heavy / R-heavy
movement, sparse-hold and dense-motion textures, jitter-led variation,
and near-static configurations.

### Axis 4 — Random generate

Single `live.button` (🎲) on the device strip. Press → randomize all four
slot fields → write to **active slot** (overwrites).

Randomization rules:

- **cells** — uniform random op per cell. Re-roll if no cell is a motion
  op (P/L/R) — i.e. constraint `≥1 motion op` per program. All-hold /
  all-rest programs have no harmonic motion and aren't useful output.
- **jitter** — uniform 0–0.6. (1.0 is chaos; 0.6 is the upper end of
  musically useful.)
- **seed** — uniform uint.
- **startChord** — uniform random root (0–11) × random quality (maj/min).

MIDI-input priority applies the same way as slot switch: a held chord
overrides random's `startChord`. Random's main effect during play is
cells/jitter/seed; the new startChord becomes audible on note-off.

The destructive nature of random (replaces active slot's content) is
bounded by Live's undo (Cmd-Z reverts the parameter changes) and by the
other 3 slots — to protect a slot's content before exploring with random,
the player switches to a different slot first.

## Scope

**In scope:**

- 4 snapshot slots holding `{cells, startChord, jitter, seed}` per slot,
  auto-saved on every user-driven edit (no explicit Save action)
- MIDI-input-priority slot switch
- Compact program-string format (parse / serialize, round-trip tested) —
  used internally for hidden-persistence representation and the program
  string is reachable from the Max patcher; not exposed on the device strip
- 6–10 inlined factory presets, accessed via `live.menu`
- Random-generate button (🎲)

**Out of scope:**

- External JSON library / cross-project pack management (future ADR if
  user demand emerges)
- MIDI program change to switch slots (future)
- Slot crossfade / morph (defer)
- Importing programs from other Tonnetz tools (future, unlikely)
- Visible program-string field on the device strip (dropped 2026-04-30 —
  the use case "share a slot's program textually across Live sets" is
  niche, the textedit added clutter without commensurate value, and the
  serialization is still available via the patcher for advanced users)
- Explicit Save button (dropped 2026-04-30 — auto-save model removes the
  need; `Host.saveCurrent` and `Bridge.saveCurrent` are deleted)

## Implementation checklist

### Phase 1 — Engine/host serialization (pure TS)

- [x] Define `Slot` type: `{ cells: string, startChord: { root: number, quality: 'maj' | 'min' }, jitter: number, seed: number }`.
- [x] `serializeSlot(slot): string` — emits compact `"cells|s=...|j=...|c=..."`.
- [x] `parseSlot(s: string): Slot | null` — parses, returns null on malformed.
- [x] Chord parsing accepts both sharps and flats (`F#`, `Gb`); serializer emits canonical form.
- [x] Tests: round-trip identity for the full grid of valid slots.
- [x] Tests: unknown `|x=y` keys are ignored, not rejected.
- [x] Tests: malformed input returns null without throwing.

Implementation: `m4l/host/slot.ts` (pure TS, no Max imports). Tests:
`m4l/host/slot.test.ts`. Cell encoding chosen ASCII so the program string
survives clipboard paste; jitter serialized at 3-decimal precision (knob
granularity below human perceptual threshold for stochastic substitution
rate). Cb / Fb / E# / B# rejected on input as notation oddities — sharps
plus the five flats Db/Eb/Gb/Ab/Bb cover every pitch class.

### Phase 2 — Slot state machine (pure TS)

Host-only, no patcher work — all logic verifiable under `node:test`.

- [x] `Host` owns 4 slots + `activeSlot` index. Slots initialize from
  the constructor's `HostParams` so a fresh device is consistent.
- [x] `switchSlot(idx)`: load slot's `cells` / `jitter` / `seed`
  unconditionally. Apply slot's `startChord` only if no MIDI input is
  currently held; otherwise stash it as pending and defer.
- [x] Pending-startChord application on the last note-off (hybrid mode);
  cleared without applying in hold-to-play (next note-on supersedes).
- [x] ~~`saveCurrent()`: capture current cells / startChord / jitter / seed
  into the active slot.~~ **Removed 2026-04-30** — auto-save model
  replaces explicit save (see Axis 1 amendment).
- [x] **Auto-save**: user-driven `setCell` and `setParams({cells, jitter,
  seed, startChord})` mirror their changes into `slots[active]`
  immediately. MIDI-input-driven `recomputeStartChord` does NOT
  auto-save (live override, slot keeps its anchor).
- [x] Accessors for active-slot index and slot contents (`activeSlot`,
  `getSlot(idx)`, `setSlot(idx, slot)` for rehydration).
- [x] Tests: state-machine behavior across switch / auto-save / pending
  apply / pending clear.

Implementation: `m4l/host/host.ts` (Slot store + state machine).
Per-cell numeric expression (velocity / gate / probability / timing) is
intentionally NOT captured in the slot — those four fields are
device-shared per ADR 006 §"Axis 1" and survive a slot switch.
`applySlotStartChord` anchors the loaded chord to the current bass-note
octave so the player stays in their register, and is a no-op when the
loaded chord matches current (preserves walker continuity).

### Phase 3 — Patcher integration

Split into a TS-side bridge layer (testable under `node:test`, no patcher
work) and the actual `.maxpat` bake. The bridge is shipped first so the
bake only has to wire patcher messages to already-tested entry points.

**Phase 3a — Bridge layer (TS, no patcher work):**

- [x] `Bridge.switchSlot(idx)` — wraps `host.switchSlot`, emits the full
  slot UI rehydrate outlet bundle.
- [x] ~~`Bridge.saveCurrent()`~~ **Removed 2026-04-30** — auto-save
  replaces it. The bridge's `setCell` / `setParams` / `setStartChord`
  paths emit `slot-store` for the active slot's hidden persistence after
  every user-driven change.
- [x] `Bridge.loadFactoryPreset(idx)` — emits full rehydrate on success,
  returns boolean.
- [x] `Bridge.randomize(rng?)` — emits full rehydrate; rng injectable for
  test determinism, defaults to `Math.random` in production.
- [x] `Bridge.loadFromProgramString(s)` — emits full rehydrate on
  success, returns boolean.
- [x] Outlet protocol for silent UI rehydrate: `slot-active <idx>`,
  `slot-program <s>`, `slot-cell-op <i> <op>` × cells.length, `slot-jitter
  <v>`, `slot-seed <v>`. Patcher routes each to the silent-rehydrate path
  on the corresponding visible widget (per memory: `live.toggle bang
  inversion` — outlet 0 = user changes, outlet 1 = silent rehydrate).

**Phase 3b — Patcher bake (one `.maxpat` pass):**

- [x] Hidden persistence: 4 slots × 8 per-field hidden `live.numbox`
  (cells × 4 + jitter + seed + root + quality), `parameter_visible: 0`.
  Seed numbox is float-typed so it can hold a full 32-bit unsigned without
  Max-int wraparound (per memory: pattr unreliable).
- [x] Hidden active-slot: the visible `live.tab` doubles as persistence
  (Live restores its value automatically), so no separate hidden param.
- [x] Visible UI: 4-segment `live.tab` for slot select (`OedipaActiveSlot`).
- [x] ~~Visible save-current `live.button`.~~ **Removed 2026-04-30** —
  auto-save model.
- [x] 🎲 random-generate `live.button` (Phase 5 UI). Visually separated
  from the Preset menu — Random is a creation tool (algorithmic),
  Preset is a library load (curated entries); they share the same
  destination (active slot) but conceptually distinct.
- [x] `live.menu` factory presets dropdown (Phase 4 UI). 7 entries:
  placeholder "—" plus 6 presets; index 0 is suppressed via `[sel 0]` so
  selecting "—" is a no-op.
- [x] ~~Visible program-string `textedit` with paste handler.~~
  **Removed 2026-04-30** — out of scope (see Scope amendment).
- [x] Visual indication of active slot via the `live.tab` selection.
- [x] Bridge → patcher: `slot-active` / `slot-program` / `slot-cell-op` /
  `slot-jitter` / `slot-seed` route through `[prepend set]` to the
  visible widgets so the rehydrate doesn't echo back through their
  user-output path (avoids switchSlot infinite loop on slot-active).
  `slot-store` routes via `[route 0..3]` + per-slot `[unpack]` to the 8
  hidden numboxes for the named slot (no `set` needed — hidden numboxes
  have no listeners on outlet 0).
- [x] Patcher → bridge on `loadbang`: bridge gains
  `setSlotFields(idx, c0..c3, jitter, seed, root, quality)` as the
  silent restoration entry point. Cascade fires AFTER the existing
  hostReady widget bangs via `[deferlow]` — otherwise the visible-widget
  cascade overwrites host params before the slot's data lands. Per-slot
  `[t b ×8]` bangs the 8 hidden numboxes in reverse order so the
  leftmost (= pack inlet 0 trigger) bang fires last; pack collects → 
  `prepend setSlotFields N` → nodescript. After all 4 slots populate,
  the cascade bangs the slot tab so its current value emits → existing
  `prepend switchSlot` chain → host applies the persisted active slot.
- [x] Devicewidth stays at 1080. Slot UI lives inside the existing
  Cells block (x=626..836): slot tab `[1|2|3|4]` at top (y=8) replaces
  the "Cells" comment header, cells/jit/seed unchanged in the middle,
  Random / Preset rows at the bottom (y=130, y=152). The slot tab IS
  the section header — "the cells/jit/seed below ARE this slot's
  content" reads naturally.

### Phase 4 — Factory presets

- [x] Curate 6–10 programs covering the design range (P/L/R-heavy,
  sparse, dense, jitter-led, near-static). 6 shipped: Steady, Drift,
  Cycle, Mixed, Pulse, Jitter Web.
- [x] Inline as const array `FACTORY_PRESETS: { name, program }[]` in
  `m4l/host/presets.ts`.
- [x] `live.menu` populated from the array (Phase 3b patcher pass).
- [x] Selection → parse program → load into active slot.
  `Host.loadFactoryPreset(idx)` composes parseSlot + setSlot +
  switchSlot.

### Phase 5 — Random generate

- [x] RNG cells with `≥1 motion op` constraint (re-roll on violation).
- [x] Random jitter (0–0.6), seed (uint), startChord (root × quality).
  Implemented as `Host.randomizeActiveSlot(rng?)` composing setSlot +
  switchSlot — symmetric with `loadFactoryPreset`. RNG injectable for
  test determinism; production callers pass `Math.random`.
- [x] `live.button` triggers `randomize` → bridge composes setSlot +
  switchSlot (Phase 3b patcher pass).

### Phase 6 — Program string copy/paste

**Phase 6 is dropped from v1 scope (2026-04-30).** The TS-side
`Host.getActiveProgramString` and `Host.loadFromProgramString` remain
because they're still used internally (program-string is the canonical
serialization for hidden persistence), but the visible device-strip
surface is removed — the use case "share a slot's program textually
across Live sets" is too niche to justify the UI clutter. The
serialization is still reachable via the Max patcher for debug/advanced
flows.

- [x] `Host.getActiveProgramString()` — serializeSlot of `slots[active]`.
- [x] `Host.loadFromProgramString(s)` — parseSlot + setSlot + switchSlot,
  symmetric with `loadFactoryPreset`. Returns false on malformed input.
- [ ] ~~Visible `textedit` field~~ **dropped** (out of scope).
- [x] On user paste + Enter → `loadFromProgramString` (Phase 3b).
- [x] Field updates whenever active slot changes via the `slot-program`
  outlet emitted by `emitSlotRehydrate` and `emitProgramString` after
  each mutation (Phase 3b).

### Phase 7 — Feel-preset RHYTHM, variable cells, chord rendering

The largest reshaping of Oedipa since Phase A: ports VOICE / RHYTHM / ARP
from inboil's Tonnetz UI (inboil's ADR 126 v2 + `src/lib/types.ts`
`TonnetzRhythm` + `generative.ts` `resolveRhythm`), expands cell sequence
length from fixed-4 to variable 1–8, and revokes under-used surface from
ADR 005 (swing + four humanize dials) plus the long-redundant subdivision
selector.

**Voicing dropdown.** `voicing ∈ {close, spread, drop2}` moves from the
122-px `live.tab` to a `live.menu`. Pure UI compaction; `applyVoicing` is
already in the engine.

**RHYTHM as preset.** Step 4 rev (2026-05-01) — palette ported verbatim
from inboil's `TonnetzRhythm` UI dropdown subset (inboil
`src/lib/components/TonnetzSheet.svelte:546`, semantics in
`generative.ts:478-496`'s `resolveRhythm`). Each preset is a pure
within-cell gating predicate; swing / humanize have **no inboil basis**
and were dropped (inboil keeps swing project-global at `Song.swing`, has
no humanize concept). Default `rhythm='legato'` matches Phase A's gate=1.0
head-attack-and-sustain feel — adding the dropdown does not change
perceived behavior at zero. Within-cell ticks evaluate on the 16th-note
sub-grid (matches inboil's per-step grid). ARP fire index resets at every
cell boundary.

| Preset       | inboil source                        | Gate predicate                          | Use                                    |
| ------------ | ------------------------------------ | --------------------------------------- | -------------------------------------- |
| `all`        | `generative.ts:483`                  | `true` (every 16th)                     | Per-step retrigger on the held chord   |
| `legato`     | `generative.ts:598` (special-cased)  | `subStepIdx === 0` (cell head)          | Pad style (Phase A default-eq)         |
| `onbeat`     | `generative.ts:489` `i % 4 === 0`    | `subStepIdx % 4 === 0`                  | Quarter-note pulse                     |
| `offbeat`    | `generative.ts:488` (spec, see note) | `subStepIdx % 4 === 2`                  | &-of-each-quarter (4 fires/bar)        |
| `syncopated` | `generative.ts:490-493` 8-step pat   | `[T,F,T,F,F,T,F,T][idx % 8]`            | Inboil's syncopated comp pattern       |
| `turing`     | `generative.ts:498-513`              | stateful shift-register, fires on `frac >= 0.5` | Stochastic comp evolving over time     |

`turing` is parameterized by `{ length, lock, seed }` (inboil
`types.ts:204`). Live params: `OedipaTuringLength` (2..32, default 8),
`OedipaTuringLock` (0..1, default 0.7), `OedipaTuringSeed`
(0..0xffff, default 0). Register state is host-owned, reseeded on
transport-start and on any of the 3 turing params changing — same
discipline as the ARP `random` PRNG.

**Future presets (deferred):** `euclidean` (`{ hits }` Bjorklund —
inboil `generative.ts:457-475`, present in inboil's type but NOT in its
UI dropdown so no user-facing parity required); explicit `boolean[]`
patterns (no clean Live-param shape for arrays).

**Implementation note — `offbeat` semantic divergence (rev 2026-05-01).**
inboil-準拠 = match the musical SPEC, not the literal code. inboil's
`offbeat` is implemented as `i % 2 === 1` (every odd 16th = 8 fires/bar,
including the e/a positions of each beat). Audibly that reads as an
8th-note tremolo, not an off-beat. The standard musical "off-beat"
semantic = the &-of-each-quarter (4 fires/bar at idx 2/6/10/14),
complementary to `onbeat` and partitioning the 8th-note grid. Oedipa
uses the spec semantic (`% 4 === 2`); inboil's literal predicate is
treated as an inboil-side bug rather than a contract to mirror. Test
vectors and tests assert the spec semantic; cross-target ports also
follow the spec, not the literal predicate.

**Implementation note (2026-05-01).** An earlier iteration of Phase 7
shipped Oedipa-only presets `chord` (= every-tick = inboil's `all` renamed
without the inboil source link), `shuffle` (offbeat + Oedipa-internal
SHUFFLE_SWING), and `loose` (every-tick + Oedipa-internal humanize across
3 axes). All three were removed in the Step 4 rev when manual smoke
revealed the 16th-tremolo behavior without grounding in inboil's actual
dropdown. If a humanize axis is reintroduced, it ships as a separate
parameter (matching inboil's project-global swing pattern), not folded
into a rhythm preset.

**ARP.** Each active rhythm tick plays one chord note instead of the full
voiced chord; advances per active tick, resets at cell boundary. Modes:
`off` (default), `up`, `down`, `updown`, `random` (seed shared with cells
RNG). ARP only "spreads" a chord when RHYTHM fires more than once per cell
(`all` / `onbeat` / `offbeat` / `syncopated`); with `legato`, ARP plays one
note at the cell head.

**Variable cell length (1–8).** The four fixed `live.tab` widgets at
`[626/750, 62/92]` are replaced by a single `jsui` cell strip rendering the
active cells dynamically. Click a pill to cycle op
`P → L → R → — → · → P` (cycling is acceptable here per memory because the
strip is high-frequency and feedback is immediate). `+` / `−` buttons
append / pop the last cell (Min 1, Max 8). Playhead drawn inside the
jsui (replaces the legacy LED-row widgets). Pure-TS logic layer in
`m4l/host/cellstrip.ts` (hit testing, layout); jsui wrapper draws. The
slot-store program format already serializes cells as a string
(Phase 1), so variable length needs no new persistence on that axis;
the slot-fields wire format gains 4 cell-op slots + a `length` field
so all 8 cells round-trip across Live save / reload (see Step 3
"Slot persistence widening").

Per-cell numeric expression (vel / gate / prob / timing) for cells
4..7 is **out of scope for Phase 7**: only the existing 16 numboxes
for cells 0..3 stay live. The remaining 16 land alongside the future
per-cell expression UI (currently unscheduled — no UI today writes
those fields, so adding 16 more dormant numboxes now would just be
dead scaffolding).

**Removed surface.** Engine logic stays where applicable; what's removed is
the device-strip widget and its wiring.

| Widget            | Origin    | Disposition                                     |
| ----------------- | --------- | ----------------------------------------------- |
| `obj-subdivision` | (initial) | `ticksPerStep` hardcoded to 6 (= 16th @ PPQN24) |
| `obj-swing`       | ADR 005   | Internal state driven by RHYTHM preset          |
| `obj-humvel`      | ADR 005   | Internal state driven by RHYTHM preset          |
| `obj-humgate`     | ADR 005   | Internal state driven by RHYTHM preset          |
| `obj-humtime`     | ADR 005   | Internal state driven by RHYTHM preset          |
| `obj-humdrift`    | ADR 005   | Removed (no preset role; long-term drift dropped) |
| `obj-cell0..3`    | ADR 003   | Replaced by jsui strip                          |

`obj-stepdir` (live.tab) compacts to `live.menu` per the
no-wastefully-flat-widgets directive. `obj-seventh` and `obj-level`
unchanged. ADR 005's open Phase 5 (humanize-axis expansion) is **canceled**
by this revocation.

**Defaults.** `voicing='spread'`, `rhythm='legato'`, `arp='off'`,
`cells=[R, L, L, R]`, `length=4`. `rhythm`, `arp`, `voicing` remain
**device-shared**; slot store keeps `cells` / `jitter` / `seed` /
`startChord` per Axis 1.

**Implementation checklist.** Ordered by the 5-step plan; voicing warm-up
ships first as a zero-risk patcher edit before engine work.

**Step 0 — Voicing dropdown warm-up (patcher only)**

- [x] `obj-voicing` `live.tab` → `live.menu`. Wiring, dimensions, enum
  unchanged.

**Step 1 — Engine: RhythmPreset, ArpMode, mapper**

- [x] `RhythmPreset` type + 6-preset palette: `legato`, `chord`,
  `straight`, `offbeat`, `shuffle`, `loose`. `RHYTHM_PRESETS` const is
  the canonical UI order.
- [x] `ArpMode` type: `off`, `up`, `down`, `updown`, `random`.
  `ARP_MODES` const is the canonical UI order.
- [x] Internal mapper `mapRhythmPreset(preset) → RhythmFeel { gating,
  swing, humanizeVelocity, humanizeGate, humanizeTiming }`. Drives
  existing ADR 005 swing/humanize engine code; no swing/humanize surface
  params. `swing` uses host convention (0.5 = none, 0.75 = max).
- [x] `gatingFires(mode, subStepIdx)` pure helper — head-only /
  every-tick / onbeat (idx % 4 === 0) / offbeat (idx % 4 === 2) on a
  16th-note sub-step grid. Host tick-loop integration tracked in Step 2.
- [x] `arpIndex(mode, chordSize, fireIdx, rng)` pure helper —
  off/up/down/updown/random with caller-managed `fireIdx` and shared
  `rng` for `random`. Cell-boundary reset of `fireIdx` is the host's
  responsibility; integration tracked in Step 2.

(Test-vector authoring `tonnetz-test-vectors.json` for RHYTHM × ARP
combinations is parked at Step 4 — it describes end-to-end behavior, so
it lands after the surface revoke when the host's swing/humanize
sourcing is final.)

**Step 2 — Host wiring**

- [x] Tick loop integrates `gatingFires` + `arpIndex`; per-cell
  `fireIdx` counter advances on each ARP-active fire, resets to 0 at
  every cell boundary.
- [x] `setParams` accepts `rhythm`, `arp`, `length` (1–8).
- [x] Slot-store routing extended to 8 cells per slot (was 4); indices
  `≥ length` ignored at engine time. Engine-side: `captureSlot` slices
  by `length`, `applySlotCells` extends the cells pool when loading a
  longer program and updates `length`, `randomizeActiveSlot` generates
  cells matching the active length. (Bridge `slot-store` / `setSlotFields`
  payload widening to 8 cells + `length` shipped in Step 3 alongside
  the cell-strip work, not Step 4 as originally planned.)
- [x] `rhythm` / `arp` / `voicing` device-shared (not slot-stored).
  Defaults: `voicing='spread'`, `rhythm='legato'`, `arp='off'`,
  `length=4`.
- [x] Old 4-cell programs load unchanged; `length` defaults to 4 on
  load.

(The engine surface revoke — `subdivision` / `swing` / 4× `humanize*`
removal from `setParams` — is parked at Step 4 because the bridge
needs to drop those param keys at the same wave the patcher loses its
matching widgets, otherwise orphan setParams calls land in the bridge.)

**Step 3 — jsui cell strip + slot persistence widening**

- [x] **Design pivot 2026-05-01.** Original "direct-select op palette"
  model (global `selectedOp` + click-cell-to-apply) superseded by
  per-cell popup after re-reading inboil's `TonnetzSheet.svelte`
  `seq-pills` (each cell is its own `<select>`, no shared tool state).
  Click cell → horizontal popup of 5 ops above the strip, anchored to
  clicked cell + clamped to box; click option → cell op set, popup
  closes. Press-to-cycle rejected (next state must be visible).
- [x] Pure-TS logic layer `m4l/host/cellstrip.ts`: `OPS`, `clampLength`,
  `computeStripLayout` (bottom-aligned pill row with inline `[-]`/`[+]`),
  `computePopupLayout`, `hitStrip`, `hitPopup`. Unit tests cover row
  layout, popup positioning, hit precedence (popup before strip when
  open), out-of-range length clamping.
- [x] jsui wrapper (`cellstrip-renderer.js`): cell row 1..8 dynamic, op
  glyphs match legacy enum (`P L R — ·`), horizontal popup, playhead
  drawn inline (light-gray border on active cell) — supersedes the
  legacy LED-row widgets. Handlers: `setCells`, `setCellOp`, `setLength`,
  `setCellIdx`. Outlets: `setCell`, `setParams length`.
- [x] Patcher: `obj-cell0..3` (live.tab) replaced with single
  `obj-jsui-cellstrip` (presentation_rect [626, 48, 234, 66], gaining
  the freed LED-band area). Legacy LED row (`obj-led-cellN`,
  `obj-eq-cellN`, `obj-route-cellidx → eq → led` cascade) removed
  entirely. cellIdx now routes into the jsui via `prepend setCellIdx`.
  `route-cell-op-idx` extended `0..7`; `prep-setCellOp-{0..7}` wired
  to jsui inlet. `route-slot` extended with `slot-length`; `prep-setLength`
  wired to jsui inlet.
- [x] Slot persistence widening (originally scheduled for Step 4 alongside
  the engine surface revoke; pulled forward when variable length
  surfaced as broken across save / reload). Bridge `emitSlotStore` /
  `setSlotFields` widened to 14 atoms (idx + c0..c7 + length + jitter +
  seed + root + quality). Patcher hidden persistence: 16 new
  `OedipaSlotMC{4..7}` + 4 new `OedipaSlotMLength` `live.numbox`;
  `pack-restore-slotN` / `unpack-storeN` / `trig-restore-slotN` widened
  8→13. `emitSlotRehydrate` emits `slot-length` before `slot-cell-op` so
  the renderer grows its visible cell count first.
- [x] **Init feedback gate.** Bridge gained a `slotsRehydrated` flag that
  suppresses `emitSlotStore` until the rehydrate cascade calls
  `setSlotFields` at least once. Without this, the patcher's
  hostReady-driven visible-widget dumps (jitter / seed / …) flowed
  through `setParams` → `emitSlotStore` and overwrote the user-saved
  hidden numboxes with bridge defaults BEFORE the silent rehydrate
  cascade could read them. Symptom (found 2026-05-01): saved
  `length=5` reverted to default `4` across reload while saved cells
  appeared to round-trip — they happened to match the bridge's
  compile-time `[R,L,L,R]` default. See
  `m4l/host/bridge.ts` near `slotsRehydrated` for the load-bearing
  comment.

**Step 4 — Patcher pass + engine surface revoke**

Single-session bundle: the engine surface revoke and the patcher widget
removal must ship together, otherwise either the bridge accepts param
keys that no longer exist on `HostParams` (TS error) or the patcher
sends to dropped widgets (orphan controls). Order: TS surface revoke
first (largest test-fixture churn — see "Migration" + ADR 005 cancel
note), then the patcher edits + bake. Test-vector authoring closes the
session.

- [x] Engine surface revoke: `ticksPerStep` hardcoded to 6 in host
  (= 16th @ PPQN24, internal constant w/ test-only constructor opt);
  `swing` / `humanizeVelocity` / `humanizeGate` / `humanizeTiming` /
  `humanizeDrift` removed from `setParams` surface and from `HostParams`.
  Engine swing/humanize values sourced from `mapRhythmPreset` only.
  `humanizeDrift` dropped from `WalkState` + `walkStepEvent` EMA logic
  entirely. Bridge `applyCellLength` reads the hardcoded `TICKS_PER_STEP=6`
  constant; `setParams('ticksPerStep')` branch removed. Test churn
  absorbed via `makeHost` / `makeBridge` helpers defaulting to
  `ticksPerStep=1` (pos arithmetic stays terse). (Was Step 2.)
- [x] **RHYTHM rewrite (rev 2026-05-01) — palette ported verbatim from
  inboil's `TonnetzRhythm` UI dropdown subset.** First-pass had
  Oedipa-only `chord/shuffle/loose` without inboil source links;
  manual smoke flagged the 16th-tremolo behavior of `chord` and the
  inboil-divergent `offbeat` semantic (`% 4 === 2` vs inboil's
  `% 2 === 1`). Rev rewrites palette to 5 presets matching inboil:
  `all / legato / onbeat / offbeat / syncopated`. Engine surface
  collapsed: `GatingMode` / `RhythmFeel` / `mapRhythmPreset` /
  `SHUFFLE_SWING` / `LOOSE_HUMANIZE_AMOUNT` removed; `gatingFires`
  takes `RhythmPreset` directly. Host `maybeFire` no longer reads
  swing/humanize — every preset is a pure deterministic gating
  predicate. `clamp01` / `clampSigned05` removed (no humanize math
  reaches them anymore). Default `rhythm='legato'`.
- [x] RHYTHM as `live.menu` — `obj-rhythm` (5 entries: All, Legato,
  Onbeat, Offbeat, Syncopated; default index 1 = Legato) at
  presentation_rect `[916, 24, 100, 18]`.
- [x] ARP as `live.menu` — `obj-arp` (5 entries: Off, Up, Down, UpDown,
  Random) at `[916, 64, 100, 18]`. New widget.
- [x] `obj-stepdir` `live.tab` → `live.menu`, relocated to
  `[916, 104, 100, 18]`; enum strings expanded to full words (Forward
  / Reverse / Pingpong / Random).
- [x] Removed `obj-subdivision` (+ `obj-sel-subdivision` + 5
  `obj-msg-subdiv-*`), `obj-swing` (+ `obj-prep-swing`), `obj-humvel`,
  `obj-humgate`, `obj-humtime`, `obj-humdrift` (+ each `obj-prep-*`).
  All associated patchlines pruned.
- [x] VOICE / RHYTHM / ARP / StepDir menus all 100×18; VOICE shrunk
  from 122→100. Labels above each (`obj-lbl-feel-rhythm` / `arp` /
  `stepdir` at presentation y=8/48/88).
- [x] Bake.
- [x] `tonnetz-test-vectors.json` v4 — `gating_fires` section ported to
  the inboil-aligned 5 presets with cases covering each modulo predicate
  + the 8-step syncopated pattern; `arp_index` table for deterministic
  modes (random is engine-TS-unit-tested with mulberry32 seeds);
  rhythm_presets section dropped (no `RhythmFeel` to test — every preset
  is a single boolean predicate now). Engine `tonnetz.test.ts` iterates
  vectors and adds direct unit tests citing inboil source lines.
- [x] **Cell-length unit + default fix (rev 2 — 2026-05-01).** Phase 4's
  cycle redesign (445050a) had `cellLength` in BARS with default 1,
  producing a 4-bar cycle that diverged 4× from inboil's default
  Tonnetz feel (1 chord/quarter = 1-bar cycle for a 4-cell pattern,
  per `sceneActions.ts:269` `stepsPerTransform: 4`). Every multi-fire
  RHYTHM preset sounded dense/tremolo at this default (chord held for
  16 sub-steps → `all` = 16 retriggers, `onbeat` = 4 same-chord
  retriggers, etc.). The bars unit also conflicted with the original
  ADR 005 §Subdivision spec ("1 transform period = 1 quarter at default
  subdivision"). Fix: align with inboil verbatim — `rate` (the
  user-facing param, label "RATE" matching inboil
  `TonnetzSheet.svelte:617`) is the chord-hold in 16th-note steps,
  range 1..64, **default 4** (= 1 quarter = inboil default). Bridge
  maps identity to `stepsPerTransform`. Patcher widget `obj-celllength`:
  `parameter_longname` was `OedipaCellLength`, renamed to
  `OedipaRateV2` (the V2 suffix forces a clean reset of any saved
  values from the rev1 OedipaRate=16 attempt — see Migration);
  `parameter_shortname` `CellLen`→`Rate`; `parameter_mmin: 1`,
  `parameter_mmax: 64`, `parameter_initial: 4`. Bridge `setParams`
  key `cellLength`→`rate`; field `cellLengthBars`→`cellLengthSteps`.
  Tests rewritten.
- [x] **Metro syntax fix (rev 2 — 2026-05-01).** Patcher metro was
  `metro 96n @quantize 96n` (intended PPQN=24); `96n` is non-standard
  Max syntax (Max's documented note values are powers of 2: `4n`, `8n`,
  `16n`, ...). User-reported "BPM not aligned" symptom traced to this:
  Max may have parsed `96n` as a fixed 96-millisecond interval rather
  than transport-relative ticks. Switched to `metro 16n @quantize 16n`
  (Max-standard, definitively transport-synced). Each metro tick is now
  1 sixteenth-note → host `DEFAULT_TICKS_PER_STEP = 1` (was 6 for the
  old PPQN=24 stream). Cell duration math unchanged: cell = `rate × 1`
  raw ticks = `rate` sixteenths, identical to before. Test suite's
  cross-target ticksPerStep>1 multiplier coverage retained for VST/AU
  port use (renamed describe to reflect this is no longer the m4l
  production path).

**Rate-vs-rhythm disconnect (inboil property, accepted).** Changing
`rate` (chord-hold in 16ths) only shifts chord-change boundaries; the
fires-per-bar count for any given non-`legato` rhythm preset is constant
regardless of rate (because the rhythm patterns are absolute on the 16th
grid, not relative to chord-hold). At default rate=4, `all` produces 4
fires/chord (= 4 chord-changes/bar × 4 = 16 fires/bar); at rate=16, `all`
produces 16 fires/chord (= 1 chord-change/bar × 16 = 16 fires/bar). This
matches inboil verbatim — inboil also has this property (rhythm fires
per absolute 16th grid regardless of `stepsPerTransform`). Long rate +
multi-fire preset = dense retriggering of a held chord; the inboil-style
musical workflow uses small rate (≤ 8) for multi-fire presets and
`legato` for slow chord progressions. Oedipa inherits this constraint
(no auto-scaling, no internal subdivision-rate concept — neither exists
in inboil). Documented here so future-me doesn't re-litigate.

**Step 5 — Manual smoke (Live)**

- [ ] Each RHYTHM preset audible & musically correct vs. its row
  description.
- [ ] ARP modes sound correct; reset at cell boundary.
- [ ] Variable cell length: 1, 4, 8 all play the right number of cells
  per loop.
- [ ] Pre-Phase-7 Live set loads with `rhythm='legato'` (no
  swing/humanize bleed-through from hidden values).
- [ ] Old 4-cell program string loads & plays unchanged.

**Migration.** Live sets saved before Phase 7 retain hidden subdivision /
swing / humanize values via Live's own param-restore mechanism; engine
ignores them. No automatic mapping from old swing/humanize values to a
RHYTHM preset guess — first device load post-Phase 7 → `rhythm='legato'`.
Old 4-cell programs load unchanged; `length` defaults to 4.

**Saved-set break (rev 2 — 2026-05-01).** The cell-length unit fix
renamed the Live param `OedipaCellLength`→`OedipaRate`, so saved sets
from Phase 7 rev 1 (or earlier) lose their cell-length value on reload —
the new param re-inits to its default (4 = 1 quarter). Pre-rev1 saved
sets had `cellLength=1` (= 1 bar = 16 sixteenths); under the rev 2 unit,
that same numeric value would mean 1 sixteenth, which is musically
wrong. Renaming the longname forces the clean reset rather than a silent
16x rate misinterpretation. Phase 7 is in beta — saved-set break is the
correct trade vs. a wrong-rate playback footgun.

## Per-target notes

**m4l**: Slot fields stored as hidden `live.*` params per slot (numbox /
menu — pattr is unreliable in this env, see memory). 4 slots × ~6
fields ≈ ~24 hidden params + 1 active-slot selector + UI controls.
Program string serialize/parse lives in `@oedipa/engine` or `@oedipa/host`
as pure TS, runnable under `node:test`. The visible `live.text` field
provides copy/paste — Max has no clipboard write API, so user does the
clipboard step manually.

**vst/app**: APVTS for slot params; preset menu and program-string
surfaces are JUCE components that reuse the host's serialization
functions ported to C++. Same MIDI-input-priority semantics.
