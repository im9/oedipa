# ADR 008: VST Stack and Scope

## Status: Proposed

**Created**: 2026-05-03
**Revised**: 2026-05-03 — Conceptual UI map locked in from inboil
[`TonnetzSheet.svelte`](https://github.com/im9/inboil) reference (lattice
geometry, triangle-state palette, interaction language, right-panel
ordering, per-cell expression placement). Parameter-shape decisions
for `chordQuality`, `hold`/`rest`, and compound ops added.

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

## Decision

### Plugin formats

- **VST3** and **AU** on macOS
- **Standalone** build kept for dev convenience (faster iteration than booting
  a host)
- Windows / Linux: deferred (not in v1)

The existing skeleton at [vst/CMakeLists.txt](../../../vst/CMakeLists.txt)
already declares `FORMATS VST3 AU Standalone` with `IS_MIDI_EFFECT TRUE`.
This ADR ratifies that as v1.

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
- [ ] **Phase 2 — Plugin scaffold + APVTS + state I/O**
  - APVTS param tree mirroring m4l `HostParams` (numeric / enum params)
  - Non-APVTS state (cells, slots, anchors, startChord) serialized into the
    APVTS ValueTree under a child node with `version=1`
  - MIDI passthrough (input → output unchanged, no engine wiring yet)
  - Loads in Live + Logic without crash; save/reopen round-trips state
- [ ] **Phase 3 — Engine wiring**
  - Walk state held in `Plugin/`, calls into `Engine/` per host step
  - MIDI output reflects walk; transport scrubbing produces correct triads
    (per ADR 001 walk-state determinism)
  - Conformance to ADR 001 anchor-reset semantics
- [ ] **Phase 4 — Lattice UI v1**
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
- [ ] **Phase 5 — Right rail + per-cell drawer + slots**
  - Right-rail panels in the order Slots / Sequence / Voicing / Anchors
    (conditional) / MIDI in / Output / Preset+Seed
  - SEQ-pill drawer with per-cell sliders (velocity / gate / probability /
    timing / `rest` op) — drawer-state in `Engine/`, drawer-render in
    `Editor/`
  - RHYTHM preset palette + ARP modes matching ADR 006 §Phase 7
  - Slot bank (4) with save/restore matching ADR 006
  - Anchor section (inline-editable badges with step number + remove)
- [ ] **Phase 6 — Polish + manual host smoke**
  - Load in Live (macOS) + Logic; save/reopen; no crash; CPU sane
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
