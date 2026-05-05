# ADR 008: VST Stack and Scope

## Status: Proposed

**Created**: 2026-05-03
**Revised**: 2026-05-03 — Conceptual UI map locked in from inboil
[`TonnetzSheet.svelte`](https://github.com/im9/inboil) reference (lattice
geometry, triangle-state palette, interaction language, right-panel
ordering, per-cell expression placement). Parameter-shape decisions
for `chordQuality`, `hold`/`rest`, and compound ops added.
**Revised**: 2026-05-03 — Confirmed Ableton Live's MIDI Effects rack does
not accept third-party VST3 / VST2 / AU plugins (slot reserved for
Ableton-native + M4L only — Live host design, not a format limitation).
Scope revised: VST3 ships as MIDI generator in the Instrument slot, with
single-track MIDI-effect UX in Logic (AU MIDI FX) / Reaper (FX chain) /
Cubase Pro (VST3 MIDI insert) / Bitwig (Note FX), and **2-track routing
UX in Live** (Track A: Oedipa as Instrument → Track B: target instrument
via "MIDI From"). Built-in synth and plugin hosting (Scaler 2 style)
explicitly out of scope — Oedipa is a pure MIDI generator.
**Revised**: 2026-05-04 — Positioning clarified: Oedipa is a **MIDI
instrument**, not a drop-in MIDI effect. The "Live drop-and-play"
expectation (place plugin on a single track, hear sound) is explicitly
out of scope; users who want that UX use the m4l target. v1 is
"playable where it fits naturally" (single-track MIDI hosts, plus
Live via 2-track or via the Standalone build), and accepts the
narrower addressable market as the cost of preserving the
no-internal-sound identity decision. Plugin hosting (option B) was
re-evaluated 2026-05-04 and remains out of scope (single-developer
scope, VST3 host license uncertainty, Mac App Store sandboxing
incompatibility, plus the first-run "no plugin loaded → no sound"
problem doesn't fully resolve). Two new in-scope items added: a
**Live first-run onboarding overlay** (`PluginHostType().isAbletonLive()`-
gated, dismissible) and the **Standalone build promoted to a documented
user-facing retreat path** (was: dev-convenience only).

## Context

The m4l target validates Oedipa's musical concept (Tonnetz traversal as a
DAW-native MIDI effect) but cannot deliver the **interactive Tonnetz lattice**
that defines Oedipa's identity. Live's device strip — even with `devicewidth`
set — caps usable horizontal space at a few hundred pixels, and `jsui` under
Max 8.6.5 is constrained to ES5 with no module system. The lattice in m4l is
present only as a click-to-set-startChord helper inside a narrow strip; the
real instrument-feeling chord-navigation surface was deferred.

VST3/AU as a free-form plugin window is where that surface can finally exist:
arbitrary canvas size, modern C++ rendering, real input handling. This ADR
defines the v1 stack and scope so implementation can begin without re-litigating
foundational choices mid-build.

A second motivation is **iOS reuse** (future `app/` target, JUCE-AUv3 + native
SwiftUI). Touch UX is a distinct design problem from desktop mouse — same
underlying Tonnetz model, different interaction language. The C++ engine and
lattice geometry MUST be reusable across vst/ (JUCE-rendered) and app/
(SwiftUI-rendered). Drawing this boundary correctly from day 1 is cheaper than
extracting it later.

A third motivation is **long-term reuse in a future standalone instrument
suite** (multi-module MIDI sequencer desktop app — Tonnetz alongside other
sequencer modules). Same `Engine/` boundary serves there too. Oedipa is the
first vehicle for the JUCE / VST3 / AU / standalone build operational
knowledge; the engine code itself is the durable asset that survives across
all three targets (vst/, app/, future suite). This shapes the
no-JUCE-in-Engine rule below from "nice discipline" into a load-bearing
architectural constraint.

## Decision

### Plugin formats

- **VST3** and **AU** on macOS
- **Standalone** build — promoted to a user-facing artefact (was:
  dev-convenience only). See §"Standalone as retreat path" below for the
  positioning. Built from the same JUCE `FORMATS Standalone` line; no
  separate codebase.
- Windows / Linux: deferred (not in v1)

The existing skeleton at [vst/CMakeLists.txt](../../../vst/CMakeLists.txt)
already declares `FORMATS VST3 AU Standalone` with `IS_MIDI_EFFECT TRUE`.
This ADR ratifies that as v1.

### DAW integration (per-host UX)

Oedipa is a **MIDI instrument** (MIDI in → MIDI out, no audio): a chord-
navigation surface that emits MIDI for downstream synths. The "correct"
home for it is the host's pre-instrument MIDI-effect slot — but **that
slot's openness to third-party plugins differs sharply by host**, and
this dictates the per-host UX. Confirmed via empirical testing
2026-05-03 (Live) and JUCE / Ableton / Steinberg / Cockos community
sources for the rest:

| Host | Slot for MIDI generators / processors | Single track? |
|---|---|---|
| **Live 12** | **MIDI Effects rack — closed to third-party VST3/VST2/AU**. Ableton-native + M4L only. Confirmed in 12.3.8. | **No — 2-track routing required (see below)** |
| **Logic Pro** | AU MIDI FX slot accepts `kAudioUnitType_MIDIProcessor` (set by JUCE `IS_MIDI_EFFECT TRUE`) | Yes |
| **Reaper** | FX chain accepts MIDI plugins in any position | Yes |
| **Cubase Pro 13+** | VST3 MIDI insert slot | Yes |
| **Bitwig** | Note FX slot | Yes |

Live is the outlier. **Three options exist within Live, none of which
match the "drop the plugin and play" expectation that VST3 / AU users
typically bring**:

1. **2-track routing** (this ADR's primary documented path) — covered below
2. **Standalone build + virtual MIDI port** — covered in §"Standalone as
   retreat path"
3. **Use the m4l target** — single-track Live UX, ships separately under
   the same name; lattice UI is constrained but the musical engine is
   identical

This ADR locks how each is supported. Before that, one fourth option
worth pre-empting:

#### Why not the Audio Effects rack?

Live's Audio Effects rack **does** accept third-party VST3 / AU (only
the MIDI Effects rack is closed). So a tempting alternative is: ship
Oedipa as a VST3 / AU **audio effect** (`VST3_CATEGORIES "Fx"`,
`kAudioUnitType_Effect`), land it in Live's Audio Effects chain on a
single track. **Evaluated 2026-05-04 and ruled out.** Reasons:

1. **Live's signal flow makes the MIDI useless on the same track.**
   The chain is `[MIDI Effects] → [Instrument] → [Audio Effects] →
   [Audio Out]`. An Audio Effect sits *after* the instrument; even
   if Oedipa-as-Audio-Effect produced MIDI, there's no instrument
   downstream on the same track to receive it. So the user still
   needs a second track with `MIDI From: 1-Oedipa` — the 2-track
   cost is unchanged.
2. **Cross-DAW semantic confusion.** Logic / Reaper / Cubase / Bitwig
   all treat an "audio effect that emits MIDI" as a niche pattern.
   The current `IS_MIDI_EFFECT TRUE` path slots Oedipa cleanly into
   each host's MIDI-FX-equivalent. Switching to Audio-Effect classification
   would break that and create ambiguity in every host.
3. **Discovery is worse.** Users searching for chord / MIDI tools
   look in Instrument or MIDI Effect categories, not Audio Effects.
   Putting Oedipa in Audio Effects buries it in EQs, reverbs, etc.

So the Audio Effects rack does not enable single-track Live UX in any
meaningful sense. The current Instrument-slot + stub-audio-bus + 2-track
routing remains the best available path. **Within Live's architecture,
a third-party plugin that behaves as a single-track MIDI generator is
structurally impossible** — only Ableton-native and M4L devices can
occupy the MIDI Effects rack, and that is by design.

#### Live UX — 2-track routing

```
┌─ Track 1: "Oedipa" (MIDI track) ─────┐
│  Instrument slot: Oedipa (VST3)       │ ← lattice UI lives here
│  • MIDI From: All Ins / keyboard      │
│  • Monitor: In                        │
│  • keyboard → Tonnetz walk → MIDI Out │
└────────────────┬─────────────────────┘
                 │ (MIDI through Live's bus)
                 ▼
┌─ Track 2: "Synth" (MIDI track) ──────┐
│  Instrument slot: Serum / piano / ... │
│  • MIDI From: "1-Oedipa" → "Oedipa"   │ ← explicit routing
│  • Monitor: In                        │
│  • receives Oedipa's MIDI, plays sound│
└──────────────────────────────────────┘
```

To make this work, two implementation accommodations are required:

1. **VST3 subcategory = `Instrument`** (single-element `VST3_CATEGORIES "Instrument"`
   in CMakeLists). Lands Oedipa in Live's Instrument browser bucket so
   it can occupy the Instrument slot. Trade-off: discovery drift —
   users searching MIDI Effects won't find it. Mitigated by docs and
   Track Template (see below).
2. **Stub stereo audio output bus when host is Live**
   (`PluginHostType().isAbletonLive()` query in `getBusesProperties()`).
   Live's VST3 host rejects plugins with zero audio buses regardless
   of subcategory ("plugin has an effect category, but no valid audio
   input bus"). Following the JUCE MidiLogger workaround (commit
   6ed49ff74f, 2020), conditionally add a stereo output. The bus is
   never written to — `processBlock` clears the audio buffer. Other
   hosts get zero buses (per `IS_MIDI_EFFECT TRUE` default), so
   Logic's AU MIDI FX classification stays clean.

User onboarding shipped with the device should include a Live Track
Template ("Oedipa + Synth" pre-wired) so the 2-track setup is one drag
rather than five clicks. This is content, not engineering — flagged here
so it doesn't get forgotten at release.

#### Live first-run onboarding overlay

Without explanation, a new user who drops Oedipa on a Live track and
hears nothing concludes the plugin is broken. To set expectations
correctly, the editor shows a one-time onboarding overlay when the
host is detected as Live:

- Triggered by `juce::PluginHostType().isAbletonLive()` on editor open
- Full-bleed overlay over the lattice with: short explanation of why
  Oedipa needs 2-track routing, a small wiring diagram (Track A:
  Oedipa Instrument + Monitor=In; Track B: synth with MIDI From →
  1-Oedipa), and CTA buttons: [Show me] (links to docs / video) +
  [Don't show again] (dismisses + persists)
- Persistence: `juce::PropertiesFile` in user prefs (per-machine, per-
  user). Choice survives Oedipa updates.
- Same overlay appears as an opt-in help button (`?`) somewhere in
  the UI so users who dismissed it can re-read

The overlay does NOT make the plugin "drop and play" — that expectation
is rejected (see §Out of scope). It makes the friction *intentional and
explained* rather than apparent breakage.

#### Standalone as retreat path

For Live users who don't want the 2-track setup at all (or who use
hosts where Oedipa-as-plugin doesn't fit gracefully), the **Standalone
build is a documented user-facing path**, not just a dev convenience:

- Same JUCE codebase, same lattice, same Tonnetz engine — the
  Standalone wrapper just adds its own audio-device + MIDI-port host
- Output: macOS Core MIDI virtual port (configurable). Live (or any
  DAW) receives via `MIDI From: IAC Driver Bus N → Oedipa`
- Setup cost: one-time IAC bus enable in `Audio MIDI Setup`, then
  per-project MIDI From routing in the DAW. Heavier than plugin
  install but identical to using any other external hardware MIDI
  controller
- Bidirectional benefit: also a reference / dogfood ground for the
  long-term standalone instrument suite (see §Context)

Polish bar for the Standalone build is intentionally minimal in v1
(default IAC bus discovery, basic MIDI port picker, "About" + version,
window remembers size/position). Bitwig / Reason class polish is
explicit non-goal.

#### Live users with MIDI Effects rack expectation

The m4l target ([m4l/](../../../m4l/)) remains the canonical Live UX —
MIDI Effects rack placement, single track, native to Live's instrument
chain. Users who want that UX continue to use the m4l device. The VST3
adds: lattice UI surface + cross-DAW reach. The two targets are
complementary, not redundant — and within Live specifically, m4l is the
recommended path for users who reject both 2-track and Standalone.

### Engine

Pure C++17 reimplementation of the [ADR 001](archive/001-tonnetz-engine-interface.md)
interface contract. **No code is ported** from m4l TS — only musical semantics.
Conformance is verified by reading
[docs/ai/tonnetz-test-vectors.json](../tonnetz-test-vectors.json) from the
Catch2 test binary (per ADR 001).

### Parameter surface

v1 = parity with m4l's shipping `HostParams`
([m4l/host/host.ts](../../../m4l/host/host.ts)):

- `startChord`, `cells[]` (1–8 active), `stepsPerTransform`, `voicing`,
  `chordQuality` (see below), `jitter`, `seed`, `channel`
- `triggerMode`, `inputChannel` (per ADR 004)
- `stepDirection`, `outputLevel` (per ADR 005)
- `rhythm` (RHYTHM preset), `arp` (per ADR 006 §Phase 7)

Per-cell shape (op / velocity / gate / probability / timing including `rest`)
matches ADR 005. RHYTHM preset palette and ARP modes match ADR 006 §Phase 7.

Adding params beyond m4l parity (e.g. lattice-navigation gestures that surface
new state) is out of scope for this ADR — those get their own ADRs once the
lattice UI work surfaces them.

#### Shape divergences from m4l (informed by inboil reference)

| Field | m4l shape | vst/ shape | Reason |
|---|---|---|---|
| 7th extension | `seventh: boolean` | `chordQuality: 'triad' \| '7th'` | Type-symmetric with `voicing` / `rhythm` / `arp` (all named-string enums); extends naturally to 9th/11th later. m4l can migrate in a future ADR — divergence is intentional, not accidental. |
| Per-cell op | `'P'\|'L'\|'R'\|'hold'\|'rest'` | same | Keep `'hold'` as named string (inboil's empty-string convention is a type smell); `'rest'` retained from m4l ADR 005. |
| Compound ops | not present | **not v1**; deferred to a future ADR 001 amendment | inboil supports `'PL'\|'PR'\|'LR'\|'PLR'` as single-step compounds. They have semantic weight (one walk step advances by both transforms) and would let drag-to-sequence capture non-adjacent neighbors directly. v1 keeps the simpler P/L/R surface; drag across non-adjacent triangles silently skips (per inboil's same fallback). Adopting compounds is an ADR 001 contract change that would also require an m4l engine update — out of scope here. |

### State persistence

- Parameters: `juce::AudioProcessorValueTreeState` (APVTS) for everything
  host-automatable (numeric and enum-as-int)
- Non-APVTS state (cells, slot bank, anchors, startChord — structures the
  host's parameter system can't represent natively): serialized as a
  `juce::ValueTree` child written via `getStateInformation` /
  `setStateInformation` alongside APVTS state
- Root ValueTree carries a `version` attribute (start at `1`) so future schema
  migrations have a hook
- m4l divergence: m4l persists everything via hidden `live.numbox` due to
  pattr unreliability in Live. APVTS + ValueTree is JUCE's idiomatic path and
  has no equivalent constraint — different mechanism, same musical state

### UI

The **interactive Tonnetz lattice** is the centerpiece. It is the original
concept from inboil's `TonnetzSheet` ported to a plugin context. Free-form
window, mouse + keyboard for v1 (no touch on desktop). The lattice is the
primary chord-navigation surface — clicking / dragging on it sets `startChord`
and visualizes the current walk position.

Visual identity (palette, typography, animation feel) carries forward from
inboil's TonnetzSheet — same beige/olive/salmon palette, monospace
data-font labels, vector triangle rendering. This is deliberate: continuity
with inboil signals that Oedipa is the same musical idea in a DAW-native
form. Pixel-level details (exact hex values, font choice, animation
timings) ship through implementation iteration; what this ADR locks in is
the conceptual layout and interaction language below.

#### Conceptual layout (locked)

```
┌────────────────────────────────────────┬─────────────┐
│  chord-trail overlay (during playback) │  Slots      │
│  ─────────────────────────────────────  │             │
│                                         │  Sequence   │
│         Tonnetz lattice                 │  (SEQ+RATE) │
│         (7×5 triangle parallelogram)    │             │
│         · walk-trail polyline           │  Voicing    │
│         · anchor markers + step labels  │  (VOICE/    │
│         · current/playing/walk states   │   CHORD/    │
│                                         │   RHYTHM/   │
│                                         │   ARP)      │
│                                         │             │
│                                         │  Anchors    │
│                                         │  (when any) │
│                                         │             │
│                                         │  MIDI in    │
│                                         │  (trigger,  │
│                                         │   channel)  │
│                                         │             │
│                                         │  Output     │
│                                         │  (level)    │
│                                         │             │
│                                         │  Preset+    │
│                                         │  Seed       │
└────────────────────────────────────────┴─────────────┘
   flex (resizable)                          fixed ~280px
```

Two-column body. The lattice fills the left side (`flex:1`, scrollable);
the right rail is fixed-width and scrollable, with grouped sections in
the order shown.

#### Lattice (logic in `Source/Engine/`, render in `Source/Editor/`)

- **Geometry**: 7 cols × 5 rows of vertices forming a parallelogram of 48
  triangles (24 upward = major, 24 downward = minor)
- **Tonnetz axes**: column = +7 semitones (perfect 5th), row = +4 semitones
  (major 3rd). Pitch class at `(r,c)` = `(centerRoot + (c-cc)*7 + (r-cr)*4) mod 12`
- **Vertex layout**: `x = pad + col*W + row*W/2` (parallelogram skew),
  `y = pad + row*H`
- **Triangle root identification**: the same algorithm as ADR 001
  `identifyTriad` (try each rotation against `[0,4,7]` / `[0,3,7]` interval
  stacks) — runs at lattice-build time per triangle
- **Triangle render states** (computed each frame from walk + transport):
  - `major` / `minor` — base color (light/dark divider tint)
  - `current` — solid olive (= `startChord`)
  - `playing` — white + brief pulse (= chord at current playback step)
  - `walk` — light olive-bg tint (= along the visible walk path)
- **Walk trail**: polyline through cell centroids, low-opacity olive,
  drawn beneath triangles
- **Anchors**: salmon circle + `@<step>` label rendered above the anchor
  cell on the lattice; also surfaced in the right rail's Anchors section
  (only when any exist) as inline-editable badges
- **Chord-trail overlay** (top of lattice, only during playback):
  horizontal scrolling list of past + current chord labels (`Em → Am →
  C`), past dimmed, auto-scroll keeps current at right edge

#### Interaction language (locked, ported from inboil)

| Input | Effect |
|---|---|
| Tap on cell | Set `startChord` to that triangle; emit a short MIDI preview note (~300ms) |
| Drag across cells | Define `sequence` from the traversal — for each adjacent pair, find which P/L/R produces the target. Non-adjacent jumps silently skip (compound ops deferred). Live preview = blue dashed polyline |
| Long-press 400ms on cell | Add an anchor at `lastAnchorStep + stepsPerTransform * 4` (or step 0 if no prior anchor) with this triangle's chord |
| Right-click | Suppressed — long-press is the desktop / touch unified path |

Drag and long-press share the same `pointerdown` entry; the state machine
disambiguates by timing and movement (single tap vs drag-with-move vs
hold-without-move).

#### Per-cell expression placement

ADR 005 added per-cell `velocity / gate / probability / timing` (and `rest`
op). inboil's SEQ row has none of this — only the op letter. Decision:
**drawer/popover on SEQ-pill activation** (Option A from the design pass):

- Tapping a SEQ pill in the right rail opens an inline drawer with sliders
  for that cell's velocity / gate / probability / timing
- Dismisses on outside-tap or another pill activation
- Keeps the SEQ row compact, defers detail until requested
- Touch-friendly idiom — extends cleanly to the future iOS UI

Rejected alternative: a permanently-visible cell strip below the lattice
(m4l's approach). Eats vertical space, doesn't transfer well to iOS view
sizes, and clutters the resting-state visual.

#### Logic layer / renderer split

Per CLAUDE.md "GUI / UI components", logic is testable in isolation:

- **Logic** (under `Source/Engine/`): triangle build (geometry + root
  identification), `triangle-at-point` hit test, drag-path state machine
  (idle / dragging / long-press-armed / committed), drag-path-to-sequence
  resolver, anchor placement math, walk-state computation per ADR 001.
  Catch2 tests instantiate these directly.
- **Renderer** (under `Source/Editor/`): JUCE `Graphics` paths for
  triangles + trails, pointer event dispatch, drawer/popover layout,
  right-rail widgets. Manual verification in a real host.

### Shared logic layer (the key architectural decision)

The codebase is split into three directories enforcing dependency direction:

```
vst/Source/
  Engine/        — pure C++17, ZERO JUCE / Cocoa / Foundation includes
                   • Tonnetz engine (ADR 001)
                   • Lattice geometry (cell coords, neighbor lookup, hit-test)
                   • Interaction state machine (selection, drag, animation
                     phase as pure state)
                   • Cell / slot / walk state types
                   • RHYTHM preset gating predicates, ARP picker
  Plugin/        — JUCE-dependent: AudioProcessor, APVTS wiring, MIDI I/O,
                   transport, state save/restore
  Editor/        — JUCE-dependent: AudioProcessorEditor, lattice renderer,
                   widgets, mouse dispatch
```

`Engine/` is the **iOS reuse target**. The future SwiftUI app (separate ADR)
will consume `Engine/` via an Obj-C++ bridge or C ABI, with SwiftUI rendering
the lattice using the same geometry / state machine code.

Enforcement: any header under `Source/Engine/` that includes `<juce_*>` is a
review-blocker. The point of drawing the boundary now is so it doesn't drift.

### Distribution

- macOS only in v1
- Free (no licensing / activation)
- Code signing + notarization required for distribution outside the App Store;
  signing identity and installer format (`.pkg` vs. drag-install) deferred to
  a future distribution ADR (parallel to m4l's ADR 007)
- **Mac App Store: out of scope** for v1. Direct distribution from im9's
  site (with notarization) is the channel. No sandboxing entitlements
  required by current architecture, leaving MAS as a possible future
  channel if desired (revisit if/when the suite ships)

### Test infrastructure

- Catch2 via CMake `FetchContent` (declared in CMakeLists; the existing
  `Catch2::Catch2WithMain` reference at
  [vst/CMakeLists.txt](../../../vst/CMakeLists.txt) needs the FetchContent
  block added)
- JSON parser for `tonnetz-test-vectors.json`: `nlohmann/json` (single-header,
  also via FetchContent) — chosen for header-only simplicity over a heavier
  dep
- `make test` (existing target) runs the test binary

## Scope

**In scope (v1):**
- VST3 + AU + Standalone formats on macOS
- C++17 engine matching ADR 001 contract; conformance via shared test vectors
- Parameter surface at parity with m4l (`HostParams`)
- APVTS + ValueTree state persistence with version attribute
- Interactive Tonnetz lattice as primary UI
- `Engine/` / `Plugin/` / `Editor/` split with the no-JUCE-in-Engine rule
- Catch2 + nlohmann/json wired into CMake
- Single-track MIDI-effect UX in Logic / Reaper / Cubase Pro / Bitwig
- 2-track routing UX in Live (Instrument slot + "MIDI From"); JUCE-style
  Live audio-bus workaround
- **Live first-run onboarding overlay** (`PluginHostType().isAbletonLive()`-
  gated, dismissible, persisted in `juce::PropertiesFile`); explains
  2-track requirement and offers Standalone as alternative
- **Standalone build as user-facing artefact** (was: dev-convenience
  only). Minimal polish bar (IAC bus discovery, MIDI port picker,
  window state persistence)
- **Live Track Template** (`Oedipa + Synth.als`) shipped as a release
  artefact for the 2-track setup

**Out of scope (with reasoning):**

- **iOS UI (`app/`)** — separate ADR. *Reasoning*: touch UX is a distinct
  musical-interaction problem (multi-finger chord stab, Pencil precision,
  AUv3 view-size constraints) that deserves its own design pass, not a
  shared UI codebase that compromises both desktop and iOS feel. The shared
  `Engine/` layer is the bridge.
- **Windows / Linux** — deferred. *Reasoning*: macOS is the primary target
  for both Live (m4l) and the iOS reuse path; cross-platform expansion does
  not constrain v1 design and would dilute Q&A surface.
- **Parameters beyond m4l parity** — deferred. *Reasoning*: the lattice UI's
  full interaction language is unknown until the surface exists. New params
  surface organically during Phase 4–5; each gets its own ADR rather than
  being predicted now.
- **Pixel-level visual details** — deferred to implementation (exact hex
  values, font choice, animation timings, drawer/popover styling).
  *Reasoning*: visual / animation quality cannot be specified in prose;
  it ships through iteration with the device in hand. The conceptual
  layout, palette intent, and interaction language are locked above.
- **Compound transforms** (`PL` / `PR` / `LR` / `PLR`) — deferred to a
  future ADR 001 amendment. *Reasoning*: they are an engine-contract
  change that would need to propagate to m4l, not a vst/-local concern.
  Drag-to-sequence works for adjacent cells without them; non-adjacent
  drags silently skip (same fallback as inboil).
- **Distribution mechanics (signing, installer, hosting)** — deferred to a
  parallel ADR (analog of m4l ADR 007). *Reasoning*: not blocking for
  development; required only at first release.
- **Built-in synth or sample player** — Oedipa is a pure MIDI generator.
  *Reasoning*: identity decision (2026-05-03), reaffirmed 2026-05-04 as
  **non-negotiable**. A bundled sound source would dilute the "instrument
  with a point of view about chord navigation" framing. If a synth-bundled
  product is ever wanted, it ships as a separate application, not under
  the Oedipa name. This decision dominates the Live UX trade-off below
  (Oedipa accepts narrower Live addressability rather than ship sound).
- **Plugin hosting (Scaler 2 style)** — loading a third-party instrument
  inside Oedipa to give Live single-track UX. Re-evaluated 2026-05-04
  and remains out of scope. *Reasoning*:
  1. **Implementation cost beyond single-developer scope** — plugin
     scanner with reliable blacklist, host wrapper for VST3 + AU,
     out-of-process isolation for crash containment, GUI embedding /
     window lifecycle, hosted-plugin state serialization, default-plugin
     onboarding flow. Scaler 2 / Captain Chords ship from paid teams.
  2. **VST3 host license uncertainty** — Steinberg's developer terms
     for hosting third-party VST3 plugins (vs. just shipping a VST3
     plugin) need fresh verification against current 2026 conditions;
     a wrong reading risks GPL contamination of the whole codebase.
  3. **Mac App Store sandboxing incompatibility** — sandboxed apps
     can't load arbitrary plugin bundles. Hosting essentially closes
     the MAS distribution door (kept open under the C path).
  4. **First-run problem doesn't fully resolve** — even with hosting,
     the user must select a plugin before sound exists. "Drop and
     play" still requires an onboarding flow; the failure mode shifts
     from "no sound" to "scan + pick plugin first."
  5. **Support burden grows with hosted plugin matrix** — every
     "Plugin X doesn't work in Oedipa" issue lands on Oedipa
     maintenance.
- **"Drop-and-play" experience in Live** — the expectation that placing
  Oedipa on a single Live track produces sound is **explicitly rejected**.
  Three documented paths exist for Live users (2-track / Standalone /
  m4l); the onboarding overlay redirects users hitting this expectation.
  *Reasoning*: dropping this expectation is the cost of preserving the
  no-internal-sound + no-plugin-hosting decisions above. Market narrowing
  is acceptable because v1 ships free.
- **Live MIDI Effects rack placement** — the VST3 cannot land there.
  *Reasoning*: Live design decision (Ableton-native + M4L only).
  Confirmed 2026-05-03 across community sources for VST3 / VST2 / AU.
  The m4l target covers this UX; the VST3 lives in the Instrument slot
  via 2-track routing (or the user picks Standalone / m4l instead).

## Implementation checklist

Phases gated per CLAUDE.md TDD workflow (tests first, then impl, then build).
Each phase ends with `make test` green.

- [x] **Phase 1 — Bootstrap & engine port** (c9ff5ae, 2026-05-03)
  - Catch2 + nlohmann/json wired into CMakeLists via FetchContent
  - `Source/Engine/` directory created with no-JUCE-in-headers rule documented
  - C++ engine ported (`identifyTriad`, `buildTriad`, `applyTransform`,
    `applyVoicing`, `addSeventh`)
  - Test reads `docs/ai/tonnetz-test-vectors.json` and asserts conformance
  - `make test` green; plugin not yet expected to load anywhere
- [x] **Phase 2 — Plugin scaffold + APVTS + state I/O + Live host workaround** (625ec90, 2026-05-03 — Live load confirmed; save/reopen round-trip covered by Catch2 state test, host-side smoke pending)
  - APVTS param tree mirroring m4l `HostParams` (numeric / enum params)
  - Non-APVTS state (cells, slots, anchors, startChord) serialized into the
    APVTS ValueTree under a child node with `version=1`
  - MIDI passthrough (input → output unchanged, no engine wiring yet)
  - `VST3_CATEGORIES "Instrument"` in CMakeLists so Live places Oedipa in
    the Instrument browser bucket (MIDI Effects rack is closed to
    third-party plugins per §"DAW integration")
  - `getBusesProperties()` returns stub stereo audio output ONLY when
    `PluginHostType().isAbletonLive()`; zero buses on every other host
    (preserves Logic's `kAudioUnitType_MIDIProcessor` classification).
    Stub bus is never written — `processBlock` clears the audio buffer
  - Loads in Live with 2-track routing setup (Track A: Oedipa as
    Instrument with monitor In; Track B: target instrument with
    "MIDI From" → Track A → Oedipa); save/reopen round-trips state
- [x] **Phase 3 — Engine wiring** (2026-05-03 — `Engine/Walker.h/.cpp` ports m4l `walk` / `walkStepEvent` bit-for-bit (mulberry32 + draw order from `walk_step_events` vectors) and adds anchor-reset on top; `processBlock` reads playhead, fires per sub-step boundary, panics on stop / backward scrub; Phase 3 input contract drops MIDI in (ADR 004 wires keyboard later); 21 Catch2 cases / 536 assertions green; in-host audible smoke deferred — needs Phase 5 cells/slot UI to set non-default ops)
  - Walk state held in `Plugin/`, calls into `Engine/` per host step
  - MIDI output reflects walk; transport scrubbing produces correct triads
    (per ADR 001 walk-state determinism)
  - Conformance to ADR 001 anchor-reset semantics
- [x] **Phase 4 — Lattice UI v1** (1ca308c, 2026-05-04 — `Engine/Lattice.{h,cpp}` (`pcAt` / `vertexAt` / `buildTriangles` / `triangleAt` / `labelFor` / `rebuildTriadInOctave` / `resolveDragPath` P/L/R only) + `Engine/PointerInteraction.{h,cpp}` (tap / drag / 400ms long-press state machine, time-injected); `Editor/LatticeView.{h,cpp}` (render: triangles + walk-trail polyline + chord-trail overlay; mouse dispatch + 60Hz Timer for long-press tick); `Plugin/PluginProcessor` adds `requestPreview` (lock-free atomic flag + chord) / `applyDragResolution` / `addAnchorAtNextStep` plus `processBlock` split into `handlePreviewMidi` + `handleWalkerMidi`; 1154 assertions / 53 cases; VST3 + AU + Standalone bundles built; lattice + tap-to-set-startChord verified loading in Live; deeper interaction smoke (drag→sequence / long-press→anchor / chord-trail under playback) lives in Phase 7)
  - Lattice geometry (7×5 vertices, vtx skew, `pcAt(r,c)`) in `Engine/`
    (Catch2-tested against inboil's reference output)
  - Triangle build + root identification in `Engine/`
  - Hit-test (`triangleAt(x,y)`) in `Engine/`
  - Drag-path state machine (idle / dragging / long-press-armed / committed)
    in `Engine/`, Catch2-tested
  - Drag-path-to-sequence resolver in `Engine/` (P/L/R only — compounds
    deferred), Catch2-tested
  - Renderer in `Editor/` draws the lattice with `current/playing/walk`
    states + walk-trail polyline
  - Tap → set `startChord` + MIDI preview note (~300ms)
  - Drag → define `sequence`; long-press 400ms → add anchor
  - Chord-trail overlay during playback
- [ ] **Phase 5 — Right rail + per-cell drawer + slots (inboil-aligned design)**
  - Visual language is inboil's `TonnetzSheet`, not m4l's device strip.
    `Editor/Theme.{h,cpp}` introduces the palette (cream `#EDE8DC` bg,
    navy `#1E2028` fg, olive `#787845` for current/active, salmon
    `#E8A090` for anchors, steel-blue `#4472B4` for drag preview) and
    JetBrains Mono at three sizes — `fs-sm`=9px (group legend),
    `fs-md`=10px (control label), `fs-lg`=11px (value). All colors and
    sizes route through Theme; no literals in views.
  - Layout is 2-column: lattice on the left (flex), right rail
    (`280px` fixed, scroll-y, 1px border-left). Header row holds the
    `TONNETZ` title and a `×` close affordance with a separator below.
    Mirrors inboil's TonnetzSheet 1:1.
  - Right rail groups, top to bottom — ordered by parent→child hierarchy
    (slot is the parent of all other state, so it sits at the top):
    1. **Slots** — 4 pills `[1][2][3][4]`, current pill in olive,
       auto-save (matches m4l ADR 006 §Phase 3b).
    2. **Sequence** — SEQ pills (op dropdowns: ` ` / P / L / R / PL /
       PR / LR / PLR) with `+` / `−` add/remove; `RATE` row =
       stepsPerTransform value + slider.
    3. **Voicing** — VOICE / CHORD / RHYTHM / ARP dropdowns; LEN / LOCK
       slider rows appear only when RHYTHM = `turing` (matches inboil
       rows verbatim).
    4. **Anchors** — conditional (`anchors.length > 0`); inline-editable
       badges with step number input + `×` (matches inboil).
    5. **Output** — OUT level + HUMAN(ize) sliders (ADR 005 carry-over).
    6. **Preset** — PRESET dropdown + SEED row (numeric value or
       `off`, dice icon = randomize, × icon = clear). Matches inboil's
       SEED row.
  - Per-cell drawer — selecting a SEQ pill both commits the op AND
    opens an inline drawer below the Sequence row showing that cell's
    `velocity / gate / probability / timing / rest` sliders (m4l
    ADR 006 §Phase 7 musical scope, rendered in inboil's visual
    language). The drawer state machine — selected cell index,
    toggle-same-pill closes, switch on a different pill, auto-close
    when the sequence shrinks past the selected cell — lives in
    `Engine/SequenceDrawer.{h,cpp}` (Catch2-tested); render in
    `Editor/SequenceDrawerView.{h,cpp}`. Animation (if any) is the
    renderer's concern, not the state machine's.
  - Dropped from the earlier draft: MERGE / TRACK (scene-graph only;
    VST writes to host MIDI out unconditionally) and MIDI in
    (deferred to ADR 004 keyboard-input work).
  - Sub-checklist (each item ends Gate 3 green; Phase 5 closes only
    after the manual host smoke item passes):
    - [x] Engine: `SequenceDrawer` state machine + Catch2 cases
    - [x] Engine: `SlotBank` 4-slot store + auto-save + Catch2 cases
    - [x] Plugin: SlotBank wiring on `OedipaProcessor` —
      `captureSlot()` / `applySlot()`, auto-save hooks on
      cells / startChord / jitter / seed / length, `switchSlot(idx)`
      composing `bank.switchTo` + `applySlot`. Round-trip test in
      `tests/test_Plugin.cpp`
    - [x] Plugin: `setCellField(idx, field, value)` for the drawer's
      vel / gate / prob / timing sliders (mirrors m4l's `setCellField`
      — does NOT auto-save into the slot, since per-cell numeric
      expression is device-shared per ADR 006 §"Axis 1"). NaN /
      out-of-range guards
    - [ ] `Editor/Theme.{h,cpp}` (palette + font sizes via
      `juce::Colour` + `juce::Font`) — single source for all view
      colors and typography. Folded in here rather than a JUCE-free
      `Engine/Theme` because iOS won't share JUCE-typed tokens anyway,
      and `RailLayout` is delegated to JUCE's FlexBox in the rail
      view rather than pre-computed in pure C++ (would duplicate the
      renderer)
    - [ ] Editor: `Theme.{h,cpp}` + 2-column layout shell + header row
      with `TONNETZ` title and `×` close
    - [ ] Editor: `SlotBarView` (4 pills + auto-save indicator)
    - [ ] Editor: `SequenceRowView` + `SequenceDrawerView` (SEQ pills,
      `+` / `−`, RATE row, per-cell sliders)
    - [ ] Editor: `VoicingView` (VOICE / CHORD / RHYTHM / ARP +
      conditional Turing LEN / LOCK)
    - [ ] Editor: `AnchorsView` (conditional)
    - [ ] Editor: `OutputView` (OUT / HUMAN)
    - [ ] Editor: `PresetView` (PRESET dropdown + SEED row)
    - [ ] Manual host smoke: load in Live (2-track routing), switch
      slots audibly, edit a cell via the drawer, save Live set, reopen,
      verify state survives
- [ ] **Phase 6 — Onboarding overlay + Standalone polish + visual identity**
  - Live first-run onboarding overlay (`PluginHostType().isAbletonLive()`-
    gated): full-bleed, dismissible, persisted in `juce::PropertiesFile`.
    Re-openable via `?` button in the UI
  - Live Track Template (`Oedipa + Synth.als`) authored and bundled as a
    release artefact so 2-track setup is one drag (per §"DAW integration")
  - Standalone build minimal polish: IAC bus discovery on macOS, MIDI
    output port picker, window state persistence, "About" with version
  - Visual identity sweep — fix any remaining UTF-8 / glyph fallback
    issues (Theme palette and typography already established in Phase 5)
- [ ] **Phase 7 — Manual host smoke + ship**
  - Load VST3 in Live (macOS) with the documented 2-track routing; save
    Live set; reopen; verify state + Tonnetz output survive. No crash;
    CPU sane. Onboarding overlay appears on first open, dismisses
    correctly, doesn't reappear
  - Load AU in Logic Pro AU MIDI FX slot (or Reaper FX chain as fallback)
    to confirm `IS_MIDI_EFFECT` single-track path is intact; save/reopen
  - Run Standalone build, configure IAC bus, route into Live and into a
    second host (Logic) to confirm the retreat path works as documented
  - Manual lattice interaction feel pass with the device in a real DAW
  - Merge `vst-bootstrap` → `main`

Phase done = playable (per memory): each phase ends with the device usable in
the host for the scope of that phase, not "compiled and tests pass."

## Per-target notes

**Engine semantics**: ADR 001 contract is binding for vst/. Conformance via
[docs/ai/tonnetz-test-vectors.json](../tonnetz-test-vectors.json). Any
musical-semantic change goes through the test vectors, not per-target test
code (per ADR 001 §Test vectors).

**m4l**: unaffected. The C++ engine is a parallel implementation against the
same contract.

**app/ (iOS, future)**: this ADR's `Engine/` directory is the migration
target. iOS UI ADR will assume `Engine/` exists and is JUCE-free. No work
required in this ADR to support that — only the discipline of keeping the
boundary clean.
