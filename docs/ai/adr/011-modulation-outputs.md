# ADR 011: Modulation Outputs + m4l UI Shell Alignment

## Status: Proposed

**Created**: 2026-05-23

## Context

This ADR carries two coupled decisions:

1. **Modulation outputs** — expose Tonnetz geometry (centroid, voice-leading
   delta, triangle orientation) as MIDI CC streams, so a downstream synth's
   timbre can be driven by the harmonic path the lattice walks.
2. **m4l UI shell realignment** — move m4l's UI off the Live device strip
   into a floating editor window that mirrors the vst editor's structure.
   Strip becomes a minimal launcher.

They are bundled because **(2) is the trigger-of-opportunity for (1)**.
The current strip layout is dense — lattice (460×160), Output column,
cellstrip block, Rhythm column, Slot/Preset block all packed into a
~1000×170 strip with single-pixel gaps. Adding four mod-output streams
with per-stream controls (enable, CC#, channel, range, mode, slew /
decay, invert) on top of that is cramming on cramming. The shell rework
is what makes mod outputs land cleanly; mod outputs is what makes the
shell rework worth doing now rather than continuing to defer it. Without
the feature add, the shell rework has no independent driver — Oedipa is
in maintenance mode (per the focus shift to Slothrop) and "redo the m4l
UI for its own sake" is not a fight worth opening. So both changes ride
together or neither happens.

### Musical motivation (modulation outputs)

Oedipa traces a path across a Tonnetz lattice and emits the resulting
chord as MIDI notes. The traversal carries information that the note
stream alone does not: where on the lattice the current triangle sits,
how far the voices moved to get there, whether the new chord is major or
minor. Those quantities exist continuously while the note stream is the
discrete shadow they cast.

The downstream synth that plays Oedipa's notes does not see any of
this. A Juno-106 (or any external polysynth) receives note + velocity
and decides its own timbre with its own LFO and envelope — oblivious to
the harmonic geometry that produced the notes. So the filter sweep, the
pan, the reverb send all move independently of the chord progression,
even though musically they should be the same gesture.

The Tonnetz geometry is the unique thing this plug-in computes. Exposing
it as control voltage — as MIDI CC streams — turns the receiver synth's
timbre into a function of the harmonic path. The cutoff opens as the
progression climbs the lattice; the pan tilts as the triangle's centroid
crosses the center; a brief filter chirp marks each voice-leading move.
The instrument's timbre breathes with its own harmony, instead of being
glazed over by a generic modulation source.

This is a differentiator no generic MIDI generator can offer, because no
generic MIDI generator knows about the lattice. Any MIDI effect can
randomise CC; only Oedipa can ground CC in chord geometry.

### Where the geometry already lives

The engine already computes the quantities this ADR exposes.
[m4l/engine/lattice.ts:176-186](../../m4l/engine/lattice.ts#L176-L186)
computes triangle centroids (row/col space) to disambiguate
`findTriadCell`. [vst/Source/Engine/Lattice.h:47](../../vst/Source/Engine/Lattice.h#L47)
exposes a `centroid` field on lattice cells. Triangle orientation
(`major`/`minor`) is already a first-class type. Voice-leading delta is
not currently computed as a number, but it is implicit in the P / L / R
transform sequence: each transform moves a known set of semitones.

The work this ADR proposes for the feature is not to *generate* new
information — it is to surface what the engine already knows.

### Receiver-side reality

Roland Cloud plug-ins (Juno-106, Jupiter-8, JX-3P), Arturia
V-Collection, U-he, and most modern soft synths support MIDI Learn. The
user side is mostly solved: drop Oedipa upstream, right-click a knob on
the synth, twiddle the relevant CC, mapped. What matters on the Oedipa
side is being able to *pick the CC number* the stream emits on, plus a
sane default for hosts where Learn is fiddly (Logic AU has no plug-in-
level Learn; Live's mappings persist inside the Live set).

### UI motivation (m4l shell realignment)

Two pressures converge.

**First pressure — the strip is full.** The current strip is the
implicit "primary UI" decision distributed across ADR 003 (lattice +
cells), ADR 005 (rhythmic feel widgets), ADR 006 (slots / preset /
randomize). Adding four mod-output streams with per-stream config
(enable + CC# + channel + range + mode + slew/decay + invert) would
need ~20 widgets. The strip cannot absorb that without either dropping
existing functionality or compressing widgets to unreadable sizes.

**Second pressure — vst exists and has a working layout.** The vst
editor ([vst/Source/Editor/PluginEditor.cpp:37](../../vst/Source/Editor/PluginEditor.cpp#L37))
runs at 900×540, lattice center-left, a 280px right rail
([RightRailView.h](../../vst/Source/Editor/RightRailView.h)) stacking
six group views (Slots, Sequence + Drawer, Voicing, Anchors, Output,
Preset). That layout works — the vst ships and runs in Logic + Bitwig +
Reaper. The m4l strip and the vst editor are currently two completely
different UI languages for the same instrument; aligning them is the
correct long-term direction (per the planned standalone suite that
will share visual language with both plug-in targets).

The strip-only constraint was correct for m4l v0.1.x — quickest path to
"plays in Live", no separate window management. With vst shipped and
the suite goal articulated, the constraint is no longer paying for
itself. Modulation outputs gives a concrete reason to retire it.

## Decision

Two-part decision. They are presented in dependency order — the shell
(A) is the substrate the mod-output UI (B) lives inside.

### A. M4L UI shell — strip minimal + floating editor window

**Strip (visible by default in Live).** Reduced to the controls a
musician needs at-a-glance while the floating editor is closed, and to
the surface Live's mapping / Push hardware see by default:

- **Open** button — opens the floating editor window. `live.button`.
- **Chord readout** — current chord name (e.g. "Em7"). Read-only text
  driven by the host.
- **Slot** — slot selector (1 / 2 / 3 / 4). `live.tab`. Same parameter
  as today, just relocated.
- **Level** — output level dial. `live.dial`. Same parameter as today.

The strip retains its full Live parameter table (everything currently
in [m4l/Oedipa.maxpat](../../m4l/Oedipa.maxpat) keeps its
`parameter_longname` and parameter id); the four widgets above are the
*visible* subset. All other `live.*` parameters move to
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
│ │       (larger)           │ │ Voicing ▾ Spread   7th ☐    │ │
│ │                          │ │ ────────────────────────────│ │
│ │                          │ │ Output                      │ │
│ │                          │ │ Rate [4]   Level ◯          │ │
│ │                          │ │ Out Ch [1] In Ch [0] Trig ☐ │ │
│ │                          │ │ ────────────────────────────│ │
│ │                          │ │ Rhythm    ▾ Legato          │ │
│ │                          │ │ Arp       ▾ Off             │ │
│ │                          │ │ Direction ▾ Forward         │ │
│ │                          │ │ ────────────────────────────│ │
│ │                          │ │ ▼ Modulation outputs · 0    │ │
│ └──────────────────────────┘ └─────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

Right-rail group ordering matches vst's
[RightRailView.h:44-50](../../vst/Source/Editor/RightRailView.h#L44-L50)
verbatim except for the new Modulation outputs group, which is
inserted between Rhythm and Preset (after the existing groups,
before the closing "save / load slot state" actions).

**Visual identity alignment.** Same palette, same font scale, same
group block proportions across m4l + vst. m4l draws via `mgraphics`
in `[jsui]`; vst draws via `juce::Graphics` in `LookAndFeel`. The
implementations stay per-platform; the visual spec is shared. The
spec lives in a new shared document (see Implementation Phase 1) and
is the source of truth both targets paint against.

### B. Modulation outputs — 4 CC streams from Tonnetz geometry

Up to four MIDI CC streams emitted on the same MIDI output as the
chord notes. No separate output port; the receiver listens on the
same MIDI cable Oedipa is already wired into.

#### Candidate streams (final selection in Phase 6)

The four-stream cap is deliberate. "All of it" would dilute the
proposition; the plug-in ships with a curated set the user can reason
about. Final four are chosen after a listening pass; the candidates:

1. **Centroid X — horizontal lattice position (bipolar)**
   Triangle's column-space centroid, normalised against the lattice
   center to `[-1, +1]`, then mapped to MIDI `0..127` with centre
   at `64`. Tracks motion along the perfect-fifth axis.

2. **Centroid Y — vertical lattice position (bipolar)**
   Triangle's row-space centroid, same normalisation. Tracks motion
   along the major-third axis.

3. **Voice-leading delta — distance from previous chord (unipolar, decays)**
   Total semitone movement summed across the three voices between
   the previous and current triad. P = 1, L = 1, R = 2; held / rested
   = 0. Emitted as a brief spike at chord-change time, decaying toward
   zero with a configurable falloff.

4. **Triangle orientation — major / minor (bipolar)**
   Major = `+1` (CC `127`), minor = `-1` (CC `0`), held / rested =
   previous value.

The product question Phase 6 answers is "is the voice-leading delta
spike actually musical, or is it just a metronome?" and "does
orientation belong, or is it too on/off to be expressive?" Final
selection happens after one round of listening; non-selected
candidates do not ship in v1 (they can come back in a later ADR).

#### Per-stream user controls

- **Enable** — boolean; default off.
- **CC number** — `0..119` (skipping `120..127`, the channel-mode
  range). Defaults per "Default CC mapping" below.
- **CC channel** — `1..16`, default = Oedipa's note output channel.
- **Range — min / max** — pair of `0..127` integers; normalised
  stream maps into `[min, max]`. Default `0..127`.
- **Mode** — `step` / `smooth` / `spike`. Details in Sampling.
- **Slew / decay time** — used by `smooth` and `spike` modes. Default
  `120ms` for `smooth`, `300ms` for `spike`. Label switches with mode.
- **Invert** — boolean; flips the stream before mapping. Default off.

#### Sampling and smoothing

Per-stream mode:

- **`step`** — one CC value at chord-change time, hold until next
  chord change. Default for centroid X, centroid Y, orientation.
- **`smooth`** — slew between chord-change targets over the per-stream
  slew time.
- **`spike`** — value at chord-change time, decay toward zero over
  the per-stream decay time. Default for voice-leading delta.

Global rate-limiter: **~100 Hz** (one CC update per 10 ms per
stream, max). Cheap synths drop samples above ~200 Hz; DAW automation
lanes handle CC at this rate without thrashing.

#### Default CC mapping

A user who enables one stream and points it at a no-Learn synth
(Logic AU) should hear something musical without further config.
Defaults use MMA-standard controllers:

- Stream 1 (centroid X) → **CC 74** (filter cutoff)
- Stream 2 (centroid Y) → **CC 10** (pan)
- Stream 3 (voice-leading delta) → **CC 91** (reverb send)
- Stream 4 (orientation) → **CC 71** (filter resonance)

#### Behavioural edge cases

- **Plug-in load with notes playing**: first CC emission for an
  enabled stream is at the next chord change. No initial CC dump.
- **Stream enabled mid-playback**: emit one CC immediately using
  current Tonnetz state.
- **Hold / rest cells**: chord-state-derived streams (X, Y,
  orientation) do not re-emit. Voice-leading delta sees the silence
  as a 0-distance event (no emission) and continues decay.
- **CC overlap protection**: if two streams target the same
  CC + channel, surface a UI warning (yellow border on both); do not
  silently merge.

## Persistence

All new state fits into the existing parameter / preset machinery
plus one new hidden parameter for window state.

**Window state (new).** Hidden `live.numbox` `OedipaEditorOpen`
(0 / 1). Persisted by Live like any other parameter; restored on
`hostReady`. vst: corresponding APVTS bool `editorOpen` is *not*
exposed — the vst editor's open/closed state is host-managed via
the standard VST3 / AU / CLAP editor lifecycle, which already works.

**Modulation output state.**

- m4l: per-stream parameters added as `live.numbox` / `live.toggle`
  group. Program string (ADR 006) picks up `|mod=...` segments — one
  per enabled stream, empty when none enabled to avoid bloating the
  default-case string. Slot save / load and randomize-with-motion
  flow through unchanged.
- vst: APVTS parameters under a `modulationOutputs` group; ValueTree
  state inherits. Slot bank presets pick up the additional fields;
  loading an older preset (pre-mod-outputs) defaults every stream to
  disabled, identical to v0.1.x behaviour.

**Backward compatibility.** A v0.1.x Live set that loads under v0.2.0
sees:
- All existing automation lanes intact (parameter ids unchanged).
- All existing slot states load correctly (new mod-output fields
  default to disabled).
- The strip looks different (most widgets now in the floating editor)
  but every previously-visible parameter is still mappable / Push-
  routable; users who built mappings on hidden parameters need to
  re-establish visibility via Live's mapping mode if they want them
  on the strip.

This is a one-way migration. v0.2.0 program strings include
mod-output segments that v0.1.x cannot parse; importing a v0.2.0
preset into v0.1.x silently drops mod-output state. Documented in
release notes.

## UI

### Visual identity (shared spec)

Shared visual spec, painted independently per platform:

- **Palette**: vst's existing [Theme.cpp](../../vst/Source/Editor/Theme.cpp)
  is the source of truth; m4l mgraphics matches. Background,
  foreground, accent, lattice border, lattice highlight, group
  divider — all named, all shared.
- **Font**: monospace data font + proportional label font, same
  scale tiers (`fsLg`, `fsSm` per Theme.h). m4l uses the same family
  names; Max's font fallback picks the nearest system font where the
  exact face is not installed.
- **Group block proportions**: header row + content row + divider,
  with the same internal padding as vst rail groups.
- **Lattice border + cell highlight colours**: identical across both
  paints. Lattice geometry math already shared via test vectors
  (ADR 001).

### Floating editor window (m4l) / editor (vst)

Same layout, mirrored across targets. Right rail group ordering:

1. **Slots** — slot tabs + preset menu + randomize.
2. **Sequence** — cellstrip (8 cells) + jitter + seed.
3. **Voicing** — voicing menu + 7th toggle.
4. **Output** — rate, level, out ch, in ch, trig.
5. **Rhythm** — rhythm menu + arp menu + direction menu (+ Turing
   sub-row when rhythm = turing).
6. **Modulation outputs** — collapsed by default; expanded view is
   a 4-row table (one row per stream).
7. **Preset** — load / save / clear slot operations.

The Modulation outputs group's expanded view:

```
┌─────────────────────────────────────────────────────────┐
│ ▼ Modulation outputs                                    │
├─────────────────────────────────────────────────────────┤
│ En  Stream         CC   Ch  Mode    Time     Inv        │
│ ☑   Centroid X     74   1   step    --       ☐          │
│ ☑   Centroid Y     10   1   smooth  120ms    ☐          │
│ ☐   VL delta       91   1   spike   300ms    ☐          │
│ ☐   Orientation    71   1   step    --       ☐          │
│                                                         │
│ Range: select a stream and edit min/max in popover.     │
└─────────────────────────────────────────────────────────┘
```

The "Time" column shows slew (smooth) or decay (spike); "--" for
step. Range (min / max) lives in a right-click popover per stream
to keep the always-visible columns to seven; range is rarely
re-tuned after initial mapping.

When two streams share CC + channel, both rows get a yellow border
warning until resolved.

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
- Per-stream value computation: centroid normalisation, VL delta
  calculation, spike decay, slew interpolation, range mapping.
- CC overlap detection.
- Window state transitions (open / closed, hostReady restore).
- Chord-name formatting for the strip readout.

**Renderer layer (manual verification in Live + Logic + Bitwig):**
- Lattice drawing (existing).
- Right-rail group rendering (new for m4l; restyled for vst to match
  shared spec).
- Disclosure animation on the mod-output group header.
- Yellow-border warning on CC overlap.
- Popover for range editing.
- Strip layout in Live.

## Scope

**In scope (v0.2.0, both targets):**

- m4l shell rework: minimal strip, floating editor window,
  open/closed persistence, all `live.*` parameters relocated into the
  editor (visible) or hidden on the strip (still mappable).
- vst shared visual identity: palette / font / proportions aligned
  to the new shared spec where they diverge (most should already
  match).
- Engine API for the four candidate streams (pure functions of
  current Tonnetz state + previous-chord state).
- Per-stream mod-output UI in the new shell (m4l + vst).
- Default mappings (CC 74 / 10 / 91 / 71).
- Step / smooth / spike sampling modes.
- Program string + slot persistence including mod-output state.
- Demo deliverable (see "Demo deliverable").

**Out of scope, with musical reasoning:**

- **External CC input → Oedipa parameters.** Different musical
  question (playing Oedipa from a pedal vs. driving a synth's
  timbre from Oedipa). Mixing them in one ADR forces two unrelated
  mental models on the reader. Future ADR.
- **More than four mod-output streams.** The candidates already span
  the meaningful axes of the lattice (X, Y, orientation) plus the
  chord-transition event (delta). A fifth stream would have to add a
  musical axis that does not exist yet. Speculative parking spots
  are not features.
- **Per-voice mod-output streams.** Oedipa's voices are not stable
  identities across chord changes — voice-leading is the whole point.
  A "voice 2" CC stream would jump to a different note at every
  move, producing modulation the user cannot predict.
- **MIDI Learn for Oedipa's own parameters.** Different concern from
  mod outputs; overlaps with VST3 / AU host automation in confusing
  ways. Its own ADR if it lands.
- **Stencil / Pointsman mod-output parity.** Geometry that makes
  Oedipa's streams musical (Tonnetz lattice) is Oedipa-specific.
  Other plug-ins would need different source quantities, not the
  same code.
- **Push parameter banking redesign.** The strip's hidden parameters
  are still Push-mappable via mapping mode, but the default Push
  bank exposes only the four strip-visible widgets. Curating Push
  banks (which parameters appear in which page) is its own design
  question; deferred.
- **Window position persistence across Live sessions.** Live offers
  no stable mechanism; a guessed default is worse than no default
  on multi-monitor setups.

## Demo deliverable

Implementation that ships without a demo is invisible. This feature
sells through hearing what "chord progression drives synth timbre"
sounds like, and that requires a short video that lands the gesture
in <30 seconds.

**Target piece**: `Oedipa → Juno-106 (Roland Cloud)` in Ableton Live,
single MIDI track, one ambient pad patch on the Juno. Held / slow
chord pacing so the timbre changes are audible against a non-busy
backdrop.

**Mapping for the demo**:

- Centroid X → Juno cutoff (CC 74, default)
- Centroid Y → Juno chorus depth (via Juno's MIDI Learn)
- Voice-leading delta → reverb send on a Live return track (CC 91)
- Orientation: not enabled (would be a fourth knob to explain)

**Shot list (~25s)**:

1. ~3s — Oedipa with floating editor open, chord progression playing,
   Juno pad sustained, no mod-output enabled. Audio: clean pad,
   chord changes audible but timbrally flat.
2. ~3s — Enable centroid X → cutoff. The pad starts breathing with
   the progression. Side-by-side visual: lattice playhead moving
   right ↔ filter opening.
3. ~5s — Enable centroid Y → chorus. Width adds a second
   independently-trackable axis.
4. ~5s — Enable voice-leading delta → reverb send. Spikes coincide
   visibly with playhead jumps between non-adjacent triangles.
5. ~3s — Quick cut: same Oedipa-driven progression, no mod outputs
   vs. all three streams on. Without/with contrast in 6 seconds.
6. ~3s — Close-up on the four-row mod-output table, showing how few
   parameters there are.
7. ~3s — Final hold with the floating editor closed, strip showing
   minimal layout — demonstrating the "minimal Live workflow" still
   possible.

**Pre-release checklist additions**:

- Demo video edited and uploaded.
- Maxforlive listing description rewritten to lead with the demo
  (per the maxforlive video-embed limitation: direct YouTube link
  in the description is the standard).
- KVR listing copy mentions modulation outputs in the feature
  bullet list.
- Polar product description updated.
- im9 site product page updated with embed + screenshots of the
  new floating editor.

## Implementation checklist

Per CLAUDE.md TDD gates — tests first, then implementation, then
build/test. m4l + vst targets ship in lockstep; the engine layer
lands once via shared test vectors.

- [ ] **Phase 1 — Shared visual spec.** New document
  `docs/ai/visual-spec.md` defining palette, font scale, group
  block proportions, lattice colours. Both targets paint against
  this. vst's [Theme.cpp](../../vst/Source/Editor/Theme.cpp) becomes
  the implementation reference for the values; m4l mgraphics mirrors.

- [ ] **Phase 2 — m4l editor patcher scaffold.** New file
  `m4l/Oedipa-editor.maxpat`. Floating window opened via
  `[thispatcher] window flags floating 1, front` from a bpatcher
  loaded inside the main `m4l/Oedipa.maxpat`. Hidden `live.numbox`
  `OedipaEditorOpen` records state; hostReady restores. Strip
  retains current widgets temporarily — migration happens in Phase
  3. Manual smoke: device loads, Open button opens window, state
  persists across Live set save/reopen.

- [ ] **Phase 3 — m4l widget migration.** Move lattice (jsui),
  cellstrip (jsui), all `live.*` widgets except the four
  strip-visible ones (Open, chord readout, Slot, Level) into
  `Oedipa-editor.maxpat`. Hidden widgets on the strip stay (still
  exist for the parameter table but `presentation 0`). Verify in
  Live: every parameter still appears in mapping mode; Push still
  routes; existing v0.1.x Live set loads without parameter loss.
  Updates to `m4l/scripts/check-paths.test.ts` (or equivalent) to
  cover the new file's bare-sibling path discipline (per ADR 007).

- [ ] **Phase 4 — vst rail polish.** Apply shared visual spec to
  vst editor where it diverges (most should already match). New
  empty placeholder group for "Modulation outputs" between Rhythm
  and Preset so the layout is in place before Phase 9 fills it.

- [ ] **Phase 5 — Engine API + shared test vectors.** Pure
  functions in `m4l/engine/` (`computeCentroidNormalized`,
  `computeVoiceLeadingDelta`, `computeOrientation`) + C++ mirrors
  in `vst/Source/Engine/`. Extend
  [docs/ai/tonnetz-test-vectors.json](../../docs/ai/tonnetz-test-vectors.json)
  with `modulationOutputs` cases. Both target test suites read the
  vectors per ADR 001.

- [ ] **Phase 6 — Listening pass + final stream selection.** Wire
  the four candidate streams to a temporary dev-only CC output (no
  persistence, no UI), play through a Juno patch, decide which
  candidates ship in v0.2.0. Update this ADR's Decision §B with the
  final list (a design refinement, not a new Phase). Constraint:
  ≤4 streams, set must span chord-position-on-lattice AND chord-
  transition-event.

- [ ] **Phase 7 — Per-stream parameters + persistence.** m4l: program
  string segments, `live.numbox` parameters, slot save/load. vst:
  APVTS group, ValueTree integration, slot bank. Default values per
  "Default CC mapping". Older presets default to all-streams-
  disabled (no migration cliff).

- [ ] **Phase 8 — Sampling modes + rate limiter.** Step / smooth /
  spike per stream; global 100 Hz cap; per-stream slew/decay
  parameter. Logic-layer tests cover slew interpolation at known
  time offsets and spike decay shape.

- [ ] **Phase 9 — Mod outputs UI in both targets.** 4-row table
  placed in the floating editor (m4l) and the right rail (vst).
  Right-click popover for range min/max. CC-overlap yellow border.
  Logic layer covers row-state transitions and overlap detection;
  renderer is manually verified.

- [ ] **Phase 10 — Host smoke verification.** m4l: Ableton Live
  end-to-end (Oedipa → Roland Cloud Juno-106 on the same track,
  every default mapping audibly hooked up; floating window open
  through full edit session; save/reopen). vst: Logic AU and
  Bitwig VST3 / CLAP with a non-Roland soft synth that supports
  Learn. Per CLAUDE.md Quality, this gates the version bump.

- [ ] **Phase 11 — Demo video.** Per "Demo deliverable". Edited and
  uploaded before any listing update.

- [ ] **Phase 12 — Release.** m4l: `make release-m4l VERSION=0.2.0`,
  manual Freeze in Max, GitHub Release with demo video linked. vst:
  `make release-vst` after `CMakeLists.txt` version bump, dmg + pkg
  uploaded to Polar. Listings updated (KVR, maxforlive, Polar, im9
  site).

## Per-target notes

- **m4l**: engine extension in `m4l/engine/`, host parameter surface
  in `m4l/host/`. The editor `.maxpat` is opened from a bpatcher
  inside the main `.amxd`; both files follow ADR 007's bare-sibling
  path discipline. jsui renderers (lattice, cellstrip, mod outputs)
  stay ES5-ASCII per the Max 8.6.5 jsui constraint. After every host
  change run `pnpm -r build && pnpm bake` (per established m4l
  workflow). Existing live.* parameter long-names DO NOT change —
  only their visible/hidden disposition on the strip changes — so
  automation lanes in saved Live sets remain bound.
- **vst**: engine extension in `Source/Engine/` (no JUCE includes
  per ADR 008 iOS reuse target). The `processBlock` realtime path
  reads from a pre-computed snapshot of the stream values per block
  (per CLAUDE.md "Audio plugin discipline" — no allocation /
  blocking / file I/O on the audio thread; snapshot is published
  from the message thread on chord change via std::atomic for the
  scalar cases, or a lock-free SPSC if any future stream needs
  multi-field payloads).
- **app**: not yet created; AUv3 host already plays Oedipa's
  output, so iOS picks up the engine extension free. The shell
  decision applies once iOS implementation begins.

## Supersedes

Partial supersession of the following Implemented ADRs, scoped
narrowly to **visible widget placement on the m4l device strip**.
The parameter surface (long-names, ids, persistence, semantics)
defined in those ADRs is unchanged.

- **ADR 003 — M4L Sequencer (Lattice UI & Cell Sequencer).** The
  "lattice on the device strip" placement is superseded — the
  lattice moves into the floating editor. The lattice's parameter
  bindings, geometry, and interaction model are unchanged.
- **ADR 005 — Rhythmic Feel.** The widget placement for cell
  sequencer / jitter / seed / level / direction / rhythm / arp on
  the device strip is superseded — these widgets move into the
  floating editor's right rail. The parameter surface, defaults,
  and behaviour are unchanged.
- **ADR 006 — Workflow (Slots, Strings, Presets).** The device-
  strip placement of slot tab / preset menu / randomize button is
  superseded — these widgets move into the floating editor. The
  slot model, program string format, factory preset palette, and
  randomize-with-motion semantics are unchanged (program string
  format gains `|mod=...` segments per this ADR's Persistence §,
  which is an extension, not a supersession).

Each of those ADRs stays in `archive/` and stays Implemented —
their code-level decisions (parameter surface, engine API,
persistence shape) remain the source of truth for the parts not
called out above.
