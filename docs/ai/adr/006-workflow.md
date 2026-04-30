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

### Axis 1 — Snapshot slots

**4 slots** in the device. Each slot captures:

- `cells` — the 4-cell sequence (P/L/R/hold/rest with ADR 005 per-cell expression)
- `startChord` — the harmonic anchor (root + quality)
- `jitter` — random walk-bias
- `seed` — RNG seed

Other params stay **device-shared**: voicing, transport, ADR 005 feel layer
(swing, subdivision, stepDirection, humanize × 3, drift, outputLevel),
input config.

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

**UI**: `live.menu` dropdown. Selecting an entry loads the program into
the **active slot** (overwrites). The user can then tweak, save (= leave
it), or switch to another slot and load a different preset.

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

The destructive nature of random (overwrites the active slot) is bounded
by slots themselves — the player retains 3 other slots as safety, and
the gesture for protecting a program is "save it to a different slot
before pressing random."

## Scope

**In scope:**

- 4 snapshot slots holding `{cells, startChord, jitter, seed}` per slot
- MIDI-input-priority slot switch
- Compact program-string format (parse / serialize, round-trip tested)
- 6–10 inlined factory presets, accessed via `live.menu`
- Random-generate button (🎲)
- Program-string copy/paste affordance (visible `live.text` field)

**Out of scope:**

- External JSON library / cross-project pack management (future ADR if
  user demand emerges)
- MIDI program change to switch slots (future)
- Slot crossfade / morph (defer)
- Importing programs from other Tonnetz tools (future, unlikely)
- Clipboard automation (Max has no first-class clipboard write API; the
  visible `live.text` field is sufficient — user copies/pastes manually)

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
- [x] `saveCurrent()`: capture current cells (op pattern), startChord
  (root + quality from `identifyTriad`), jitter, seed into the active
  slot.
- [x] Accessors for active-slot index and slot contents (`activeSlot`,
  `getSlot(idx)`, `setSlot(idx, slot)` for rehydration).
- [x] Tests: state-machine behavior across switch / save / pending
  apply / pending clear.

Implementation: `m4l/host/host.ts` (Slot store + state machine).
Per-cell numeric expression (velocity / gate / probability / timing) is
intentionally NOT captured in the slot — those four fields are
device-shared per ADR 006 §"Axis 1" and survive a slot switch.
`applySlotStartChord` anchors the loaded chord to the current bass-note
octave so the player stays in their register, and is a no-op when the
loaded chord matches current (preserves walker continuity).

### Phase 3 — Patcher integration (one bake)

Hidden persistence + visible UI + bridge wiring in a single patcher
pass — same `.maxpat` file, one `pnpm bake`.

- [ ] Hidden persistence: 4 slots × per-field hidden `live.*` params
  (per memory: pattr unreliable; use hidden `live.numbox` / `live.menu`).
- [ ] Hidden active-slot index param.
- [ ] Visible UI: 4 slot select controls (`live.tab` or 4 × `live.button`).
- [ ] Visible save-current button.
- [ ] Visual indication of active slot.
- [ ] Bridge wires: patcher → `bridge.switchSlot(idx)` /
  `bridge.saveCurrent()`; rehydrate hidden params on device load.

### Phase 4 — Factory presets

- [x] Curate 6–10 programs covering the design range (P/L/R-heavy,
  sparse, dense, jitter-led, near-static). 6 shipped: Steady, Drift,
  Cycle, Mixed, Pulse, Jitter Web.
- [x] Inline as const array `FACTORY_PRESETS: { name, program }[]` in
  `m4l/host/presets.ts`.
- [ ] `live.menu` populated from the array. **Deferred to Phase 3
  (patcher pass).**
- [x] Selection → parse program → load into active slot.
  `Host.loadFactoryPreset(idx)` composes parseSlot + setSlot +
  switchSlot.

### Phase 5 — Random generate

- [x] RNG cells with `≥1 motion op` constraint (re-roll on violation).
- [x] Random jitter (0–0.6), seed (uint), startChord (root × quality).
  Implemented as `Host.randomizeActiveSlot(rng?)` composing setSlot +
  switchSlot — symmetric with `loadFactoryPreset`. RNG injectable for
  test determinism; production callers pass `Math.random`.
- [ ] `live.button` triggers gen → serialize → load into active slot.
  **Deferred to Phase 3 (patcher pass).**

### Phase 6 — Program string copy/paste

- [x] `Host.getActiveProgramString()` — serializeSlot of the saved active
  slot. Reflects switchSlot / saveCurrent / random / factory load. Does
  NOT track un-saved per-param edits.
- [x] `Host.loadFromProgramString(s)` — parseSlot + setSlot + switchSlot,
  symmetric with `loadFactoryPreset`. Returns false on malformed input.
- [ ] Visible `live.text` field showing the active slot's serialized form.
  **Deferred to Phase 3 (patcher pass).**
- [ ] On user paste + commit → parse → load into active slot.
  **Deferred to Phase 3 (patcher pass).**
- [ ] Field updates whenever active slot changes (incl. after random,
  factory load, save-current). **Deferred to Phase 3 (bridge wiring will
  push `getActiveProgramString()` to the `live.text` after each mutation).**

### Phase 7 — Manual smoke

- [ ] Save a Live set with non-default slots; reopen; verify recall.
- [ ] Paste a string from another Live set; verify load.
- [ ] During play (chord held), switch slots → cells change, audible
  chord stays; release → slot's startChord takes over.
- [ ] Random button → produces different programs each press; ≥1 motion
  op always present.

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
