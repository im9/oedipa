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

The largest reshaping of Oedipa since Phase A: ports VOICE / ARP from
inboil's Tonnetz UI, introduces an Oedipa-specific RHYTHM feel-preset,
expands cell sequence length from fixed-4 to variable 1–8, and revokes
under-used surface from ADR 005 (swing + four humanize dials) plus the
long-redundant subdivision selector. inboil's ADR 126 v2 is the reference
for VOICE and ARP semantics; RHYTHM intentionally diverges from inboil's
pure gating type — playable feel matters more than clean abstraction.

**Voicing dropdown.** `voicing ∈ {close, spread, drop2}` moves from the
122-px `live.tab` to a `live.menu`. Pure UI compaction; `applyVoicing` is
already in the engine.

**RHYTHM as feel preset.** Each preset bundles a gating pattern with
implicit swing + humanize side effects, driving the ADR 005 engine code
internally. Default `rhythm='legato'` matches Phase A's gate=1.0
head-attack-and-sustain feel — adding the dropdown does not change
perceived behavior at zero. Within-cell ticks evaluate against
`subdivision = 16th` (hardcoded — see "Removed surface" below). ARP and
rhythm index both reset at every cell boundary.

| Preset     | Gating       | Swing | Humanize | Use                              |
| ---------- | ------------ | ----- | -------- | -------------------------------- |
| `legato`   | head-only    | 0     | 0        | Pad style (Phase A default-eq)   |
| `chord`    | every tick   | 0     | 0        | Tight 16th chord stab            |
| `straight` | onbeat       | 0     | 0        | Quarter-note pulse               |
| `offbeat`  | offbeat      | 0     | 0        | 8th-note off-beat                |
| `shuffle`  | offbeat      | 0.6   | 0        | Built-in swung 8ths              |
| `loose`    | every tick   | 0     | mid      | Human feel, vel/gate/time wiggle |

`syncopated`, `euclidean`, `turing` deferred — additive later without
breaking compatibility.

**ARP.** Each active rhythm tick plays one chord note instead of the full
voiced chord; advances per active tick, resets at cell boundary. Modes:
`off` (default), `up`, `down`, `updown`, `random` (seed shared with cells
RNG). ARP only "spreads" a chord when RHYTHM fires more than once per cell
(`chord` / `offbeat` / `shuffle` / `loose`); with `legato`, ARP plays one
note at the cell head, with `straight`, one per quarter.

**Variable cell length (1–8).** The four fixed `live.tab` widgets at
`[626/750, 62/92]` are replaced by a single `jsui` cell strip rendering the
active cells dynamically. Click a pill to cycle op
`P → L → R → — → · → P` (cycling is acceptable here per memory because the
strip is high-frequency and feedback is immediate). `+` / `−` buttons
append / pop the last cell (Min 1, Max 8). LED row underneath extends to
N indicators. Pure-TS logic layer in `m4l/host` (hit testing, op cycling,
state); jsui wrapper draws. Hidden persistence: all
 8 cells × 4 expression
fields (vel / gate / prob / timing) = 32 hidden `live.numbox` pre-allocated;
indices `≥ length` are ignored at engine time. The slot-store program
format already serializes cells as a string (Phase 1), so variable length
needs no new persistence.

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
- [ ] New cases in `tonnetz-test-vectors.json` for RHYTHM gating × ARP
  mode combinations (per ADR 001) — added after host wiring so vectors
  describe end-to-end behavior, not pure-helper inputs.

**Step 2 — Host wiring**

- [ ] Tick loop integrates `gatingFires` + `arpIndex`; per-cell
  `fireIdx` counter advances on each ARP-active fire, resets to 0 at
  every cell boundary.
- [ ] `setParams` accepts `rhythm`, `arp`, `length` (1–8).
- [ ] Slot-store routing extended to 8 cells per slot (was 4); indices
  `≥ length` ignored at engine time.
- [ ] `rhythm` / `arp` / `voicing` device-shared (not slot-stored).
  Defaults: `voicing='spread'`, `rhythm='legato'`, `arp='off'`,
  `length=4`.
- [ ] `ticksPerStep` hardcoded to 6 in host (= 16th @ PPQN24);
  `subdivision` / `swing` / `humanizeVelocity` / `humanizeGate` /
  `humanizeTiming` / `humanizeDrift` removed from `setParams` surface.
  Engine swing/humanize values now come from `mapRhythmPreset`.
- [ ] Old 4-cell programs load unchanged; `length` defaults to 4 on
  load.

**Step 3 — jsui cell strip (highest UI risk)**

- [ ] Pure-TS logic layer in `m4l/host`: hit testing, op cycle
  `P → L → R → — → · → P`, length state, `+` / `−` append/pop (1–8).
- [ ] jsui wrapper draws cells dynamically; LED row extends to N
  indicators.
- [ ] Replaces `obj-cell0..3` in patcher; 32 hidden `live.numbox`
  pre-allocated for per-cell expression (vel / gate / prob / timing).

**Step 4 — Patcher pass**

- [ ] RHYTHM as `live.menu` (palette above).
- [ ] ARP as `live.menu`.
- [ ] `obj-stepdir` `live.tab` → `live.menu`.
- [ ] Remove `obj-subdivision`, `obj-swing`, `obj-humvel`, `obj-humgate`,
  `obj-humtime`, `obj-humdrift` widgets and wiring.
- [ ] VOICE / RHYTHM / ARP / StepDir menu widths unified.
- [ ] Bake.

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
