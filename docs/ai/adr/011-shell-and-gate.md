# ADR 011: m4l UI Shell Alignment + Gate Sequencer

## Status: Proposed

**Created**: 2026-05-23

## Context

Oedipa v0.2.0 is the first release driven by the author's own writing
practice in techno / ambient / electronica. v0.1.x plays whatever
chord the lattice walks onto each rate tick, but composing in these
genres against an undifferentiated cell stream is awkward — there is
no rhythmic gating, no step pattern, no place to sit a 16-step groove
against the chord motion. The plug-in produces music the user does not
want to write.

This ADR carries two coupled decisions:

1. **m4l UI shell realignment** — move m4l's UI off the Live device
   strip into a floating editor window that mirrors the vst editor's
   structure. Strip becomes a minimal launcher.
2. **Gate sequencer** — a 16-step on/off gate track that runs on its
   own clock derived from `rate`, gating chord emission per step. The
   cell strip continues to govern chord progression; the gate track
   governs rhythmic pattern. Two axes, explicitly separated.

They are bundled because **(1) is the precondition for (2) and for the
v0.2.x feature roadmap that follows**. The current strip is full —
lattice (460×160), Output column, cellstrip block, Rhythm column,
Slot/Preset block all packed into ~1000×170 with single-pixel gaps. A
16-step gate row plus the broader feature plan (more sequencer
affordances aimed at the user's genre fit) cannot land on the strip;
the shell rework is what makes any of it possible. (1) without (2)
has no driver — "redo the m4l UI for its own sake" is not a fight
worth opening. (2) on the strip is geometrically infeasible. They
ride together.

### Naming note — "gate" disambiguation

"Gate" appears in two distinct senses across Oedipa's ADRs:

- **Per-cell gate** (ADR 005, implemented) — the note-length /
  articulation value on each cell strip cell. Decides how long a note
  rings *within* the cell's time slot. Local to a single cell.
- **Gate sequencer** (this ADR) — a 16-step on/off pattern that
  decides *whether* a tick emits at all. Global, lives independently
  from the cell strip.

The two compose: a gate-open step fires the current cell with the
cell's existing per-cell gate (length) applied. A gate-closed step
suppresses the emission entirely.

### Musical motivation (gate sequencer)

Techno and electronica are built from step-based gate patterns. A
typical arrangement has a 16-step pattern deciding which beats fire,
and an underlying chord engine deciding what fires on those beats.
Oedipa today has the "what" — Tonnetz cells emitted on every rate
tick — but not the "when"; every tick fires. The user has to
externally gate the output via Live MIDI effects, Note Length tricks,
or MIDI clip masking to get any rhythmic shape, which defeats the
point of an integrated chord-and-rhythm instrument.

The two-axis separation is not cosmetic. Cells are *harmonic events*;
gate steps are *rhythmic events*. Conflating them (per-cell gate flags
were considered and rejected) forces the user to express a 16-step
pattern through 8 chord slots, which is the wrong vocabulary for
polyrhythm, pattern shifting, and the offset-loop tricks that define
the genre. Keeping the axes independent lets the user write a chord
progression once and try multiple gate patterns against it — the
natural workflow.

### UI motivation (m4l shell realignment)

Two pressures converge.

**First — the strip is full.** The current strip is the implicit
"primary UI" decision distributed across ADR 003 (lattice + cells),
ADR 005 (rhythmic feel widgets), ADR 006 (slots / preset / randomize).
Adding a 16-step gate row (16 step cells + multiplier + loop length +
enable) on top would push the strip into unreadable territory. The
strip cannot absorb that without dropping existing functionality or
compressing widgets to unreadable sizes — and v0.2.x will keep adding
genre-fit features beyond the gate.

**Second — vst exists and has a working layout.** The vst editor
([vst/Source/Editor/PluginEditor.cpp:37](../../vst/Source/Editor/PluginEditor.cpp#L37))
runs at 900×540, lattice center-left, a 280px right rail
([RightRailView.h](../../vst/Source/Editor/RightRailView.h)) stacking
six group views. That layout works — the vst ships and runs in Logic
+ Bitwig + Reaper. The m4l strip and the vst editor are currently two
completely different UI languages for the same instrument; aligning
them is the correct long-term direction (per the planned standalone
suite that will share visual language with both plug-in targets).

The strip-only constraint was correct for m4l v0.1.x — quickest path
to "plays in Live", no separate window management. With vst shipped
and the v0.2.x roadmap on the table, the constraint is no longer
paying for itself. The gate sequencer gives the first concrete reason
to retire it; subsequent v0.2.x features will live inside the same
shell.

## Decision

Two-part decision. They are presented in dependency order — the shell
(A) is the substrate the gate-sequencer UI (B) lives inside.

### A. M4L UI shell — strip minimal + floating editor window

**Strip (visible by default in Live).** Reduced to the controls a
musician needs at-a-glance while the floating editor is closed, and
to the surface Live's mapping / Push hardware see by default:

- **Open** button — opens the floating editor window. `live.button`.
- **Chord readout** — current chord name (e.g. "Em7"). Read-only text
  driven by the host.
- **Slot** — slot selector (1 / 2 / 3 / 4). `live.tab`. Same parameter
  as today, just relocated.
- **Level** — output level dial. `live.dial`. Same parameter as today.

The strip retains its full Live parameter table (everything currently
in [m4l/Oedipa.maxpat](../../m4l/Oedipa.maxpat) keeps its
`parameter_longname` and parameter id); the four widgets above are
the *visible* subset. All other `live.*` parameters move to
`presentation 0` (hidden on the strip but still mappable / automatable
/ Push-routable). This preserves backward compatibility for any Live
set that already has automation lanes drawn against existing
parameters.

**Floating editor window.** A separate window opened via the strip's
Open button. Implementation in m4l: a bpatcher loaded from a new
`m4l/Oedipa-editor.maxpat`, with `[thispatcher]` driving
`window flags floating 1`, `front`, sized to **900×540** (matching
vst editor's default size). Resizable within the same limits the vst
editor uses (`640×360` ... `1800×1200`).

**Window state persistence.** A hidden `live.numbox` records the
last open/closed state (0 = closed, 1 = open). On `hostReady`, if the
state is 1 the editor reopens automatically; otherwise it stays
closed. Window *position* is not persisted — Live does not provide a
stable mechanism for restoring floating window position across
sessions, and best-effort positioning across multi-monitor setups
makes the wrong default worse than no default.

**Structural alignment with vst.** The floating window's content
mirrors the vst editor:

```
┌──────────────────────────────────────────────────────────────┐
│ Oedipa                                              v0.2.0   │
├──────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────┐ ┌─────────────────────────────┐ │
│ │                          │ │ Slots   [1][2][3][4]        │ │
│ │                          │ │ Preset  ▾ Drift             │ │
│ │                          │ │ ────────────────────────────│ │
│ │                          │ │ Sequence (8 cells)          │ │
│ │       LATTICE            │ │ Jitter ◯  Seed   [   42]    │ │
│ │       7 × 3 viewport     │ │ ────────────────────────────│ │
│ │                          │ │ Voicing ▾ Spread   7th ☐    │ │
│ │                          │ │ ────────────────────────────│ │
│ │                          │ │ Output                      │ │
│ │                          │ │ Rate [4]   Level ◯          │ │
│ │                          │ │ Out Ch [1] In Ch [0] Trig ☐ │ │
│ │                          │ │ ────────────────────────────│ │
│ │                          │ │ Rhythm    ▾ Legato          │ │
│ │                          │ │ Arp       ▾ Off             │ │
│ │                          │ │ Direction ▾ Forward         │ │
│ │                          │ │ ────────────────────────────│ │
│ │                          │ │ Gate      [▣▣ ▣ ▣ ▣ ▣▣▣ …]  │ │
│ │                          │ │           Mult [1] Len [16] │ │
│ └──────────────────────────┘ └─────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

Right-rail group ordering matches vst's
[RightRailView.h:44-50](../../vst/Source/Editor/RightRailView.h#L44-L50)
verbatim except for the new Gate group, which is inserted between
Rhythm and Preset.

**Visual identity — fresh design across both targets.** Both m4l's
current strip-era paint and vst's current `Theme.cpp` look are
placeholders the author considers unsatisfactory; neither is the
visual target. v0.2.0 introduces a *fresh* shared visual identity
(palette, font scale, group block proportions, lattice colours)
designed for the new shell and applied to both targets in lockstep.
The spec is authored fresh — vst's current Theme is *replaced*, not
extracted from. Sequencing matters: the shell migration (Phases 1–2)
proceeds with each target's current paint so the "does the shell
mechanism preserve existing functionality?" risk is isolated from
the visual-redesign risk; the visual redesign lands in later phases
(Phases 6–7) and ships with v0.2.0.

### B. Gate sequencer — 16-step pattern, rate-driven, independent of cell strip

A 16-step on/off gate pattern, advanced by a clock derived from the
existing `rate` parameter. When the gate is open at the current step,
the chord on the current cell is fired; when closed, no notes emit
for that tick.

#### Two-axis composition with the cell strip

Cell strip behaviour from ADR 005-006 is unchanged. The gate is
layered on top:

- **Cell clock**: existing `rate`. The cell strip advances one cell
  per cell-clock tick, looping the active 1..8 cells.
- **Gate clock**: `rate × gateMultiplier`. The gate pattern advances
  one step per gate-clock tick, looping over `gateLoopLength`
  positions of the 16-step buffer.
- **Emission rule**: at each gate-clock tick, if the gate-step value
  is 1, fire the current cell's chord (subject to ADR 005 per-cell
  rules); if 0, suppress emission.
- Cell advance and gate advance are decoupled. With `gateMultiplier
  = 1` they tick in lockstep; with `gateMultiplier = 2` the gate
  advances twice per cell change, etc.

This is the polyrhythm-friendly model: 8 cells × `gateLoopLength`
steps resync at LCM, and the user can dial in 7/12/15-step gate
loops against an 8-cell progression to get the offset-loop motion
characteristic of the target genre.

#### Per-slot parameters

Each of the 4 slots (ADR 006) owns its own gate pattern. Switching
slots switches the pattern, the multiplier, and the loop length.

- **`gateEnable`** — boolean. Default `on`. When `off`, every step is
  treated as gate-open (the sequencer is a no-op, identical to
  v0.1.x behaviour).
- **`gatePattern`** — 16-bit field, one bit per step. Default
  `0xFFFF` (all on).
- **`gateMultiplier`** — `{ 1/4, 1/2, 1, 2, 4 }`. Default `1`.
- **`gateLoopLength`** — `1..16`. Default `16`. Steps beyond the
  loop length are skipped each cycle.

#### Interaction with existing Rhythm / Arp / per-cell axes (ADR 005)

- **Rhythm = legato**: legato sustains across cell changes. With the
  gate sequencer enabled, legato sustains across *gate-open* cell
  changes; a gate-closed step releases the legato (next gate-open
  starts a new legato segment).
- **Arp**: arp ticks remain at the cell rate. Arp emissions are
  *only output on gate-open steps* — gate-closed mutes the arp.
- **Per-cell gate** (note length): unchanged. When a gate-open step
  fires the current cell, the cell's existing per-cell gate length
  applies to the resulting note.
- **Per-cell `rest`**: a cell flagged `rest` does not emit even on a
  gate-open step. Gate sequencer and per-cell rest both gate output;
  either being closed suppresses emission.
- **Direction**: cell direction unchanged. Gate pattern direction is
  always forward in v0.2.0 — reverse gate is a follow-up if it earns
  its weight.

#### Behavioural edge cases

- **Plug-in load mid-playback**: gate step counter starts at 0 of the
  active slot's pattern on the next gate-clock tick after load.
- **Slot change mid-loop**: gate pattern, multiplier, and loop length
  switch on the slot-change tick; step counter resets to 0 to match
  cell strip behaviour.
- **`gateEnable = off`**: equivalent to all-steps-on. Cell strip and
  Rhythm/Arp run as in v0.1.x. This is the default for any v0.1.x
  set loaded under v0.2.0 — no audible change at load.
- **`gateLoopLength = 1`**: gate fires (or suppresses) on every tick
  based on step 0 only. Useful for global mute / unmute via
  automation.

## Persistence

**Window state (new).** Hidden `live.numbox` `OedipaEditorOpen`
(0 / 1). Persisted by Live like any other parameter; restored on
`hostReady`. vst: corresponding APVTS bool `editorOpen` is *not*
exposed — the vst editor's open/closed state is host-managed via
the standard VST3 / AU / CLAP editor lifecycle, which already works.

**Gate sequencer state.**

- m4l: per-slot gate fields stored as `live.numbox` (`gatePattern`
  encoded as a single 16-bit integer 0..65535; `gateLoopLength`
  1..16) + `live.menu` (`gateMultiplier`) + `live.toggle`
  (`gateEnable`). Program string (ADR 006) gains optional segments:
  `|g=ffff` (hex pattern, omitted when `0xFFFF`), `|gm=2`
  (multiplier index, omitted when `1`), `|gl=12` (loop length,
  omitted when `16`), `|ge=0` (enable, omitted when on). All-default
  state contributes zero extra bytes to the program string.
- vst: APVTS parameters under a `gateSequencer` group; ValueTree
  state inherits. Slot bank presets pick up the additional fields;
  loading an older preset (pre-gate) defaults to all-defaults, which
  is v0.1.x-equivalent emission.

**Backward compatibility.** A v0.1.x Live set that loads under v0.2.0
sees:

- All existing automation lanes intact (parameter ids unchanged).
- All existing slot states load correctly (new gate fields default to
  all-on / mult=1 / len=16 / enable=on → identical to v0.1.x
  emission).
- The strip looks different (most widgets now in the floating editor)
  but every previously-visible parameter is still mappable / Push-
  routable; users who built mappings on hidden parameters need to
  re-establish visibility via Live's mapping mode if they want them
  on the strip.

This is a one-way migration. v0.2.0 program strings include gate
segments that v0.1.x cannot parse; importing a v0.2.0 preset into
v0.1.x silently drops gate state. Documented in release notes.

## UI

### Visual identity (fresh shared spec)

A *fresh* shared visual spec is authored as part of v0.2.0 and
applied to both targets. Neither current paint is the target; the
spec is designed for the new shell, not extracted from vst's current
Theme:

- **Palette**: new palette designed for the floating editor's
  density. Background, foreground, accent, lattice border /
  highlight, group divider — named in the shared spec.
- **Font**: monospace data font + proportional label font, scale
  tiers (`fsLg`, `fsSm` etc.) chosen for the new layout.
- **Group block proportions**: header row + content row + divider
  + padding, consistent across targets.
- **Lattice border + cell highlight colours**: identical across both
  paints. Lattice geometry math already shared via test vectors
  (ADR 001).

Painted independently per platform (m4l via `mgraphics` in
`[jsui]`; vst via `juce::Graphics` in `LookAndFeel`); the values are
shared. Sequencing: shell migration (Phases 1–2) uses each target's
current paint to isolate mechanism risk; the new spec is authored
and applied in Phases 6–7 before release.

### Floating editor window (m4l) / editor (vst)

Same layout, mirrored across targets. Right rail group ordering:

1. **Slots** — slot tabs + preset menu + randomize.
2. **Sequence** — cellstrip (8 cells) + jitter + seed.
3. **Voicing** — voicing menu + 7th toggle.
4. **Output** — rate, level, out ch, in ch, trig.
5. **Rhythm** — rhythm menu + arp menu + direction menu (+ Turing
   sub-row when rhythm = turing).
6. **Gate** — 16-step on/off row + multiplier + loop length + enable.
7. **Preset** — load / save / clear slot operations.

The Gate group's content:

```
┌─────────────────────────────────────────────────────────┐
│ Gate                                       Enable ☑     │
├─────────────────────────────────────────────────────────┤
│  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16         │
│ [▣][▣][ ][▣][ ][▣][ ][▣][▣][▣][ ][▣][ ][▣][ ][▣]        │
│                                                         │
│ Multiplier [1▾]      Loop length [16]                   │
└─────────────────────────────────────────────────────────┘
```

Step cells are click-toggle; click-drag paints contiguous steps
(drag direction starts paint or erase depending on the starting
cell). Empty square = closed, filled square = open. The active step
during playback is rendered with a brighter outline. Steps beyond
`Loop length` render in a dimmed style to show they are inactive.

### Strip (m4l only)

```
┌──────────────────────────────────────────────────────────┐
│ Oedipa  [ Open ]   Em7   Slot [2▾]   Level ◯             │
└──────────────────────────────────────────────────────────┘
```

Layout fits in a single row at ~60-80px Live strip height. Open
button toggles the floating editor (changes label to "Close" when
open). Chord readout is a non-editable text widget driven by the
host. Slot tab and Level dial are the existing parameters,
relocated.

### Renderer split (per CLAUDE.md GUI rules)

**Logic layer (testable in Node / Catch2):**

- Gate step lookup: given `(stepCounter, gateLoopLength)` →
  `activeStep`; given `(activeStep, gatePattern)` → `gateOpen`.
- Multiplier-relative step indexing: given cell-clock tick and
  multiplier → gate-clock tick.
- Click / drag → step toggle: pixel coordinate → step index, paint /
  erase state machine.
- Loop length wrap.
- Window state transitions (open / closed, hostReady restore).
- Chord-name formatting for the strip readout.

**Renderer layer (manual verification in Live + Logic + Bitwig):**

- Lattice drawing (existing geometry; repainted to the new spec in
  Phase 7 on both targets).
- Right-rail group rendering: new for m4l (initial paint in current
  m4l mgraphics style during Phases 1–2, repainted to the new spec
  in Phase 7); vst repainted from current Theme to the new spec in
  Phase 7.
- Gate row: 16-cell row, active-step highlight, dimmed beyond-loop
  cells, click-drag paint (initial m4l paint in Phase 5, vst paint
  + both-target re-paint in Phase 7).
- Strip layout in Live.

## Scope

**In scope (v0.2.0, both targets):**

- m4l shell rework: minimal strip, floating editor window,
  open/closed persistence, all `live.*` parameters relocated into
  the editor (visible) or hidden on the strip (still mappable).
- Fresh shared visual identity (palette / font / proportions /
  lattice colours) designed for the new shell, applied to both
  targets — vst's current Theme is replaced, not extracted from.
- Engine API for the gate sequencer (pure functions of `rate`, slot
  gate state, and tick counter).
- Per-slot gate UI in the m4l floating editor and the vst right
  rail, both painted to the new shared spec by release.
- Default state (all-on / mult=1 / len=16 / enable=on) → v0.1.x
  parity for any saved set loaded under v0.2.0.
- Gate-step lookup and emission rule at the cell-rate / gate-rate
  boundary.
- Program string + slot persistence including gate state.
- Demo deliverable (see "Demo deliverable").

**Out of scope, with musical reasoning:**

- **Modulation outputs (CC streams from Tonnetz geometry).** Was the
  original §B of this ADR (centroid X/Y, voice-leading delta,
  triangle orientation as MIDI CC streams). Deferred to a future
  ADR. Mod outputs is a different musical question (timbre
  modulation driven by harmonic geometry) than the gate sequencer
  (rhythmic gating); bundling them in one ADR forces two unrelated
  mental models on the reader.
- **Per-step velocity / accent / probability.** v0.2.0 ships on/off
  only. Step-value extension is a follow-up ADR once the user's
  writing practice hits the limit; adding it now bloats both the
  parameter surface and the UI before we know which dimension is
  worth the cost.
- **Multiple gate tracks per slot.** One gate track per slot for
  v0.2.0. Multi-track patterns (e.g., separate gates for arp vs.
  block-chord) are a follow-up if they earn their weight.
- **External CC input → Oedipa parameters (e.g. mapping a pedal to
  gate enable).** Different musical question. Future ADR.
- **MIDI Learn for Oedipa's own parameters.** Different concern; its
  own ADR if it lands.
- **Stencil / Pointsman gate-sequencer parity.** Each plug-in has
  its own musical model; cross-product features are not the right
  abstraction.
- **Push parameter banking redesign.** The strip's hidden parameters
  are still Push-mappable via mapping mode, but the default Push
  bank exposes only the four strip-visible widgets. Curating Push
  banks is its own design question; deferred.
- **Window position persistence across Live sessions.** Live offers
  no stable mechanism; a guessed default is worse than no default
  on multi-monitor setups.
- **Reverse / pingpong gate direction.** Forward only in v0.2.0;
  reverse is a follow-up if needed.

## Demo deliverable

Short clip (~30 seconds): Oedipa → soft synth pad in Ableton Live,
one MIDI track. Cell strip set to a 4-cell progression at a slow
rate (quarter-note tick). Gate sequencer at `multiplier=2`
(eighth-note grid). Three gate patterns against the same chord
progression:

1. ~10s — Straight on-the-grid pattern (all 16 steps on at mult=2 →
   even eighth-note pulse). Establishes the chord progression and
   default behaviour.
2. ~10s — Slot change → syncopated pattern (e.g. `1011 1010 1010
   1110` over 16 steps). Same chords, new rhythm. Demonstrates
   per-slot gate persistence and live slot recall.
3. ~10s — Slot change → sparse off-beat pattern (`0010 0000 1000
   0010`) with `loopLength=12` for a 12-against-16 polyrhythm
   against the 4-cell chord loop. Demonstrates the offset-loop trick
   that the two-axis model exists to enable.

Cuts between the three slot states should be hard (no automation
ramps) so the gate change is unambiguous.

**Pre-release checklist additions**:

- Demo video edited and uploaded.
- Maxforlive listing description rewritten to lead with the demo
  (per the maxforlive video-embed limitation: direct YouTube link
  in the description is the standard).
- KVR listing copy mentions the gate sequencer in the feature
  bullet list.
- Polar product description updated.
- im9 site product page updated with embed + screenshots of the
  new floating editor.

## Implementation checklist

Per CLAUDE.md TDD gates — tests first, then implementation, then
build/test. m4l + vst targets ship in lockstep at v0.2.0; the
engine layer lands once via shared test vectors.

**Phase ordering principle.** Three concerns are sequenced to
isolate their risks:

1. *Shell mechanism* (Phases 1–2). Move m4l UI to a floating window
   keeping the current m4l paint, so the "does existing functionality
   survive?" question gets a clean answer without visual confounds.
2. *Gate sequencer* (Phases 3–5). Engine, persistence, and m4l UI
   for the new feature — m4l-only paint at this stage.
3. *Fresh visual identity* (Phases 6–7). Design the new shared spec,
   then repaint both targets (m4l + vst) to it. By release, both
   targets share the new look.

- [ ] **Phase 1 — m4l floating window scaffold.** New file
  `m4l/Oedipa-editor.maxpat`. Floating window opened via
  `[thispatcher] window flags floating 1, front` from a bpatcher
  loaded inside the main `m4l/Oedipa.maxpat`. Hidden `live.numbox`
  `OedipaEditorOpen` records state; hostReady restores. Strip
  retains current widgets temporarily — migration happens in
  Phase 2.

- [ ] **Phase 2 — m4l widget migration + load-bearing verification.**
  Move lattice (jsui), cellstrip (jsui), all `live.*` widgets except
  the four strip-visible ones (Open, chord readout, Slot, Level)
  into `Oedipa-editor.maxpat`. **Keep the existing m4l visual style
  unchanged** — paint stays current m4l mgraphics; vst is also
  untouched at this phase. This isolates the shell-mechanism risk
  from the visual-redesign risk. Hidden widgets on the strip stay
  (still exist for the parameter table but `presentation 0`). **This
  is the verification step that the floating-window shell preserves
  existing functionality** — done against the real Oedipa widget
  surface, not synthetic stubs. Verify in Live: every parameter
  still appears in mapping mode; Push still routes; existing v0.1.x
  Live set loads without parameter loss; automation lanes survive;
  legato + arp + rhythm preset behaviour identical. If any check
  fails, this ADR's §A is unimplementable and needs revision before
  proceeding. Updates to `m4l/scripts/check-paths.test.ts` (or
  equivalent) to cover the new file's bare-sibling path discipline
  (per ADR 007).

- [ ] **Phase 3 — Engine API + shared test vectors.** Pure functions
  in `m4l/engine/` (`gateStepLookup`, `gateClockTick`,
  `gateLoopWrap`, `gatePatternToggle`) + C++ mirrors in
  `vst/Source/Engine/`. Extend
  [docs/ai/tonnetz-test-vectors.json](../../docs/ai/tonnetz-test-vectors.json)
  with `gateSequencer` cases (covering: all-on pattern, single-step
  pattern, multiplier variations, loop-length wrap, polyrhythm cell
  × gate LCM checks). Both target test suites read the vectors per
  ADR 001.

- [ ] **Phase 4 — Per-slot gate parameters + persistence.** m4l:
  program string segments, `live.numbox` + `live.menu` +
  `live.toggle` parameters, slot save / load. vst: APVTS group,
  ValueTree integration, slot bank. Default state is v0.1.x-
  equivalent.

- [ ] **Phase 5 — Gate UI in m4l.** 16-step row widget as a
  `[jsui]` in the floating editor. Click / click-drag paint,
  active-step highlight, beyond-loop dimming. Painted in the
  current m4l mgraphics style — the visual repaint comes in
  Phase 7. Logic layer covers step-toggle math and paint state
  machine; renderer is manually verified.

- [ ] **Phase 6 — Fresh shared visual spec.** Design and author
  `docs/ai/visual-spec.md` — the new palette, font scale, group
  block proportions, lattice colours. *Not* extracted from vst's
  current Theme; designed fresh for the floating editor. Spec is
  the source of truth both targets paint against in Phase 7.

- [ ] **Phase 7 — Repaint both targets to the new spec.** vst's
  [Theme.cpp](../../vst/Source/Editor/Theme.cpp) is rewritten to
  the new values. m4l's `mgraphics`-based jsui renderers (lattice,
  cellstrip, gate row, right-rail groups) are repainted to match.
  Add the vst right-rail Gate group (16-step row + multiplier +
  loop length + enable) between Rhythm and Preset, with logic
  mirroring m4l's logic-layer code from Phase 3. Both targets are
  visually unified at the end of this phase.

- [ ] **Phase 8 — Host smoke verification.** m4l: Ableton Live
  end-to-end — chord progression + gate sequencer driving a soft
  synth, all three slot patterns from the Demo deliverable audible.
  Floating window open across a full edit session, save+reopen.
  vst: Logic AU and Bitwig VST3 / CLAP with the same engine
  behaviour. Per CLAUDE.md Quality, this gates the version bump.

- [ ] **Phase 9 — Demo video.** Per "Demo deliverable". Edited and
  uploaded before any listing update.

- [ ] **Phase 10 — Release.** m4l: `make release-m4l VERSION=0.2.0`,
  manual Freeze in Max, GitHub Release with demo video linked. vst:
  `make release-vst` after `CMakeLists.txt` version bump, dmg + pkg
  uploaded to Polar. Listings updated (KVR, maxforlive, Polar, im9
  site).

## Per-target notes

- **m4l**: engine extension in `m4l/engine/`, host parameter surface
  in `m4l/host/`. The editor `.maxpat` is opened from a bpatcher
  inside the main `.amxd`; both files follow ADR 007's bare-sibling
  path discipline. jsui renderers (lattice, cellstrip, gate row)
  stay ES5-ASCII per the Max 8.6.5 jsui constraint. After every host
  change run `pnpm -r build && pnpm bake` (per established m4l
  workflow). Existing live.* parameter long-names DO NOT change —
  only their visible/hidden disposition on the strip changes — so
  automation lanes in saved Live sets remain bound.
- **vst**: engine extension in `Source/Engine/` (no JUCE includes
  per ADR 008 iOS reuse target). The `processBlock` realtime path
  reads from a pre-computed snapshot of the gate state per block
  (per CLAUDE.md "Audio plugin discipline" — no allocation /
  blocking / file I/O on the audio thread; snapshot is published
  from the message thread on slot / pattern change via std::atomic
  for the scalar fields).
- **app**: not yet created; AUv3 host already plays Oedipa's
  output, so iOS picks up the engine extension free. The shell
  decision applies once iOS implementation begins.

## Supersedes

Partial supersession of the following Implemented ADRs, scoped
narrowly to **visible widget placement on the m4l device strip**.
The parameter surface (long-names, ids, persistence, semantics)
defined in those ADRs is unchanged. The gate sequencer in §B
*extends* ADR 005's rhythmic-feel axis — it does not replace any
existing rhythmic-feel parameter.

- **ADR 003 — M4L Sequencer (Lattice UI & Cell Sequencer).** The
  "lattice on the device strip" placement is superseded — the
  lattice moves into the floating editor. The lattice's parameter
  bindings, geometry, and interaction model are unchanged.
- **ADR 005 — Rhythmic Feel.** The widget placement for cell
  sequencer / jitter / seed / level / direction / rhythm / arp on
  the device strip is superseded — these widgets move into the
  floating editor's right rail. The parameter surface, defaults,
  and behaviour are unchanged. The per-cell `gate` axis from this
  ADR is unchanged; the new gate sequencer is an additional, global
  axis layered on top (see "Naming note — 'gate' disambiguation").
- **ADR 006 — Workflow (Slots, Strings, Presets).** The device-
  strip placement of slot tab / preset menu / randomize button is
  superseded — these widgets move into the floating editor. The
  slot model, program string format, factory preset palette, and
  randomize-with-motion semantics are unchanged (program string
  format gains optional `|g=` / `|gm=` / `|gl=` / `|ge=` segments
  per this ADR's Persistence §, which is an extension, not a
  supersession).

Each of those ADRs stays in `archive/` and stays Implemented —
their code-level decisions (parameter surface, engine API,
persistence shape) remain the source of truth for the parts not
called out above.
