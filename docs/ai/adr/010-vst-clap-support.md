# ADR 010: VST CLAP Support

## Status: Proposed

**Created**: 2026-05-09

## Context

Oedipa's vst/ target shipped `vst-v0.1.0` on 2026-05-08 with VST3 + AU
bundles (ADR 008, ADR 009). The plug-in is labelled `im9 / Free
distribution` and exists to be played by people other than the author;
expanding the set of native hosts where Oedipa loads cleanly is a
direct extension of that goal.

CLAP (CLever Audio Plug-in) is an open plug-in standard hosted by
Bitwig Studio, Reaper, FL Studio, Studio One (6.5+), and others.
Logic Pro, Ableton Live, and Cubase do not host CLAP and are not
affected by this ADR — Logic users keep the AU build, Live users use
the m4l target (ADR 008 §2026-05-05), Cubase remains out of scope
(ADR 009 §2026-05-08).

**Musical motivation.** Oedipa is a chord-traversal MIDI generator;
every host where it loads as a native MIDI effect is a host where a
musician can put it on a track and start playing without workarounds.
Bitwig Studio is one of the project's two declared primary hosts, but
v0.1.0 reaches Bitwig only through the VST3 wrapper. CLAP is Bitwig's
native plug-in format and is the format Bitwig's own development is
oriented around — a CLAP build is the most direct path between the
plug-in and that user. FL Studio's CLAP host is the second motivator:
FL has historically been out of scope (no native MIDI effect track
concept; instrument-disguise rejected in ADR 009) but FL added CLAP
support in 2024, and CLAP's `note-effect` plug-in feature is the only
mechanism by which a MIDI generator can present itself to FL without
the instrument-disguise problem. Whether FL's CLAP host actually
honours `note-effect` for routing is empirically unverified at the
time of writing — this ADR treats it as a research question, not a
guarantee.

**Engine reuse.** ADR 008's JUCE-free `Source/Engine/` discipline is
unaffected. The `clap-juce-extensions` wrapper (Free Audio,
maintained with JUCE-team involvement) wraps the existing
`juce::AudioProcessor` and translates parameter / state / MIDI flow
to CLAP without touching engine code.

## Decision

Add a CLAP build target to `vst/` via the
[`clap-juce-extensions`](https://github.com/free-audio/clap-juce-extensions)
wrapper. Ship it as an additional artefact alongside `.vst3` and
`.component` from a single CMake configure.

**Minimal scope (this ADR).** CLAP format only — the plug-in is
exposed as a CLAP plug-in with `note-effect` feature, full polyphony,
parameter automation, and state save/restore via the existing
APVTS / `ValueTree` path. CLAP-specific extensions (note expressions,
polyphonic modulation) are deferred (see Scope). Minimal-scope CLAP
is functionally at parity with the VST3 / AU builds — same chord
output, same parameter set, same persistence — distinguished only by
the host's native plug-in format.

**Plug-in metadata.**

- CLAP id: `com.im9.oedipa` (reverse-DNS, matches existing
  manufacturer convention).
- `clap_plugin_features`: `note-effect`, `utility`.
- Vendor: `im9` (inherited from the JUCE plugin's `COMPANY_NAME`).
- Manual URL: `https://github.com/im9/oedipa` (repo home; GitHub
  renders the README). Support URL:
  `https://github.com/im9/oedipa/issues`. (The VST3 / AU build does
  not currently set equivalent URL metadata; CLAP exposes them where
  the format supports it.)

**Host scope.**

- **Primary smoke target**: Bitwig Studio (author's declared CLAP
  host per `project_live_no_vst3_midi_fx`).
- **FL Studio**: empirically tested 2026-05-09 and **out of scope**
  (Phase 5). FL's CLAP host does not bridge `note-effect` plug-ins'
  MIDI in/out to FL's internal note bus on any tested surface
  (Patcher green pins, channel-level routing). The VST3 build is
  rejected categorically by FL (no MIDI fx slot in channel or
  mixer). Promotion to primary host is not feasible without
  instrument-disguise, which is rejected per ADR 008/009 identity.
- **Best-effort**: Reaper, Studio One. Loaded once, sanity-checked,
  no ongoing test commitment (mirrors ADR 009 best-effort posture).

**Distribution.** `.clap` bundle joins `.component` and `.vst3` in
`dist/Oedipa.dmg` and as a GitHub Releases asset. KVR submission is
currently in review (memory `project_distribution_channels_status`);
the formats line is updated to add CLAP before the listing goes live.

## Persistence

No new persistence shape. APVTS / `ValueTree` is the source of truth
across all formats; `clap-juce-extensions` translates it to CLAP's
chunk-based plug-in state. State written from a CLAP host loads in
VST3 / AU and vice versa (the wrapper preserves the underlying
ValueTree bytes).

## UI

No UI change. The lattice editor and parameter widgets are
host-agnostic and render identically across formats.

## Scope

**In scope (v0.1.x, target tag `vst-v0.1.1`):**

- `clap-juce-extensions` submodule + CMake integration in
  `vst/CMakeLists.txt`.
- `Oedipa.clap` artefact produced by `make build` / `make release`.
- CLAP plug-in metadata (id, `note-effect` feature, URLs).
- Bitwig smoke verification (load → MIDI fx category → chord output
  → automation → save/restore).
- FL Studio empirical verification (load + routing + outcome
  documented in this ADR's Phase 5 row).
- Reaper / Studio One best-effort load test.
- `dist/Oedipa.dmg` includes `Oedipa.clap`; `INSTALL.txt` covers the
  CLAP install path (`~/Library/Audio/Plug-Ins/CLAP`).
- GitHub Releases asset list, README install table, KVR formats line.

**Out of scope (post-v0.1.x):**

- **CLAP note expressions** (per-note pitch / volume / pan /
  brightness etc.). Oedipa currently emits standard MIDI chord
  events; per-note expression dimensions only become musically
  meaningful if humanisation moves per-note, which is itself
  post-v1. Adding note expressions before that change would expose a
  feature with no audible effect on Oedipa's output — implementation
  surface for nothing musical.
- **Polyphonic modulation source** (CLAP-specific modulation feeding
  downstream synths). Bitwig integration is interesting in principle,
  but Oedipa is a chord generator, not a modulation source — there is
  no internal continuous parameter whose per-note variation a user
  would musically want to route into a downstream synth in this
  release. Re-evaluate when humanisation or per-cell expression
  acquires continuous modulation semantics.
- **Windows / Linux CLAP**. ADR 008 and ADR 009 hold macOS-only for
  v1.x; CLAP inherits that posture. Cross-platform packaging is its
  own ADR when the time comes.

## Implementation checklist

Per CLAUDE.md TDD gates: tests (or empirical-test rigs) first, then
implementation, then build/test.

- [x] **Phase 1 — Build-system test.** `vst/scripts/check-artefacts.sh`
  asserts VST3 / AU / Standalone / CLAP bundles all exist under
  `build/Oedipa_artefacts/<config>/`; wired into `make build` and
  exposed as `make verify-artefacts`. Shipped 50d0338.
- [x] **Phase 2 — Wrapper integration.** `vst/clap-juce-extensions`
  submodule (pinned to `e8de9e8`, with nested `clap` + `clap-helpers`
  recursively initialised) + `add_subdirectory(... EXCLUDE_FROM_ALL)`
  + `clap_juce_extensions_plugin(TARGET Oedipa ...)` after the JUCE
  plugin block. `make build` produces `Oedipa.clap` alongside VST3 /
  AU / Standalone; the Phase 1 check turns green. Shipped 1e02800.
- [x] **Phase 3 — Plug-in metadata.** `CLAP_ID "com.im9.oedipa"`,
  `CLAP_FEATURES note-effect utility`, `CLAP_MANUAL_URL` and
  `CLAP_SUPPORT_URL` pointing to the GitHub repo + issues page.
  Vendor name inherited from JUCE `COMPANY_NAME "im9"`. (The VST3 /
  AU build has no equivalent URL metadata; this is CLAP-specific.)
- [x] **Phase 4 — Bitwig smoke (primary).** Bitwig Studio smoke
  verified by user 2026-05-09.
- [x] **Phase 5 — FL Studio empirical.** Tested 2026-05-09. Result:
  **negative** — FL stays out of scope. The CLAP build loads in
  Patcher (lattice editor renders), but MIDI in does not reach the
  plug-in (lattice unresponsive to keyboard) and MIDI out does not
  flow to downstream synths — tested with both FLEX (FL native) and
  Serum (VST instrument), same result, ruling out a synth-side
  cause. FL's CLAP host does not bridge a `note-effect` plug-in's
  note in/out to FL's internal note bus on any surface tried
  (Patcher green pins, channel-level MIDI port — FL native channels
  do not expose a wrapper Settings page for MIDI port at all). The
  VST3 build, tested for completeness, was rejected categorically
  by FL ("open in mixer instead" → "problem opening": channel slot
  refuses MIDI fx, mixer hosts only audio fx). The
  instrument-disguise workaround remains rejected per ADR 008/009
  identity. Re-evaluate only if FL adds a native MIDI fx track
  concept or CLAP `note-effect` routing in its host bridge.
  `project_oedipa_fl_studio_scope` memory updated to correct the
  "user doesn't use FL" line (user does own FL) and to record this
  empirical.
- [x] **Phase 6 — Reaper / Studio One best-effort.** Reaper: CLAP
  load verified by user 2026-05-09 (initial "not visible" was a UI
  filter — searching with VST3 only hid the CLAP entry; clearing the
  format filter surfaced Oedipa.clap normally). Studio One: not
  exercised — no ongoing test commitment.
- [x] **Phase 7 — Distribution wiring.** Mirrored the AU + VST3
  signing / notarization / dmg pipeline to CLAP:
  `vst/scripts/codesign.sh` and `vst/scripts/notarize.sh` now
  process `Oedipa.clap` alongside the AU / VST3 bundles;
  `vst/scripts/build-dmg.sh` adds it to the dmg staging directory;
  `vst/scripts/INSTALL.txt` adds the `~/Library/Audio/Plug-Ins/CLAP/`
  install row plus host-specific notes (Bitwig CLAP, Reaper CLAP,
  Studio One CLAP not verified, Ableton Live no CLAP, Cubase no
  CLAP, FL Studio host-limit out of scope). Top-level `README.md`:
  install heading "VST3 / AU" → "VST3 / AU / CLAP", install paths
  add the CLAP row, Bitwig host example mentions CLAP, DAW support
  table updated with CLAP info per host, Distribution §
  "AU + VST3" → "AU + VST3 + CLAP". Root and `vst/Makefile`
  unchanged — `make build` already produces CLAP via the wrapper
  integration (Phase 2), and the artefact presence check (Phase 1)
  already covers CLAP. `vst-test.yml` unchanged — it runs
  `make test` only and does not enumerate formats. Status block
  (`vst/` ships ...) and Targets table CLAP row are deferred to
  Phase 9 (flip to "Released" after the v0.1.1 tag is cut,
  mirroring the ADR 009 Phase-9 pattern).
- [ ] **Phase 8 — KVR formats line.** Add CLAP to the formats line
  in the in-review KVR submission (currently pending per
  `project_distribution_channels_status`).
- [ ] **Phase 9 — Release.** Tag `vst-v0.1.1` per the per-target
  tag scheme established in ADR 009. Draft GitHub Release notes
  from the CLAP-related commit log (focus: "what users gain" — CLAP
  build, host coverage outcome).

## Per-target notes

- `m4l/` — unaffected. CLAP is a `vst/` build artefact concern;
  m4l targets Live exclusively.
- `app/` — unaffected. iOS AUv3 does not intersect CLAP.
- Engine: no change. `Source/Engine/` JUCE-free discipline preserved
  (ADR 008); the wrapper operates above the JUCE `AudioProcessor`
  layer.
