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

Four design axes. Open at draft time.

### Axis 1 — Snapshot slots

A small number of in-device slots holding alternative cell programs the
user can switch between live.

Each slot stores: `cells`, optionally `jitter`, `seed`, `startChord`.
Voicing / transport / rhythmic params stay at the device level (shared
across slots).

Options:

- **No slots** — rely on Live's automation lanes / clip envelopes only.
- **2 slots (A / B)** — minimal performance affordance.
- **4 slots (A / B / C / D)** — common pattern for live-loopers / sketch
  pads.
- **8 slots** — heavy in device-strip real estate.

Open question: what exactly does a slot capture? `cells` only is the
lightest; including `startChord` makes slots feel like full sections.

Recommended starting point: 4 slots, capturing `cells` only.
`startChord` / `jitter` / `seed` evolve via input + automation.

### Axis 2 — Program string format

How is a cell program represented for copy/paste / save / share?

Options:

- **Compact string** — e.g. `"PLR-|j=0.3|s=42"` (cells, jitter, seed).
  Human-readable, paste-anywhere, copies cleanly between Live sets.
- **JSON** — verbose, structured, easier to evolve later but overkill for
  the scope.
- **No string format** — only Live's native preset save.

Open question: include `startChord` in the string, or treat startChord
as session state outside the program?

Recommended starting point: compact string covering `cells`, `jitter`,
`seed`. Exclude `startChord` (it is session-bound and typically
input-driven).

### Axis 3 — Factory presets

A small curated set built into the device, available from a dropdown.

Options:

- **None** — every device starts at default; users build everything.
- **~6–10 curated programs** — e.g. "Walk in fourths", "Pachelbel-ish",
  "Sparse holds", "All-P shuffle", "Random init". Picks expose the design
  range without overwhelming.
- **Larger library (~30+)** — risk of cluttered UX; better as an external
  pack.

Open question: factory presets ship as inlined data in the device, or as
a sidecar JSON file users can edit?

Recommended starting point: 6–10 curated programs inlined. External pack
is a future extension.

### Axis 4 — Random generate

A "give me random cells" button as an ideation aid.

Options:

- **No** — manual authoring only.
- **Random cells (uniform)** — every cell rolls a uniform random op
  (including `hold` / `rest`).
- **Random with constraints** — guarantee at least one motion op (not all
  hold/rest), avoid all-same.

Recommended starting point: yes, random with one constraint (≥1 motion op
per program). Single button on the device strip.

## Scope

**In scope:**

- 4 snapshot slots within the device, capturing `cells`
- Compact program-string format for copy/paste
- 6–10 inlined factory presets accessible via a `live.menu`
- Random-generate button

**Out of scope:**

- External JSON library / cross-project pack management (future ADR if
  user demand emerges)
- MIDI program change to switch slots (future)
- Slot crossfade / morph (defer)
- Importing programs from other Tonnetz tools (future, unlikely)

## Implementation checklist

To be filled in once axes settle. Likely shape:

1. Host: program-string serialization (pure TS, well-tested), slot state
   machine.
2. Engine: no changes expected; engine stays stateless.
3. Patcher: snapshot slot UI (4 buttons or `live.tab`), preset dropdown
   (`live.menu`), random button (`live.button`), copy/paste affordance
   (likely a `live.text` field with `dumpout` to clipboard via a
   `[node.script]` helper, since Max has no first-class clipboard
   write API).
4. Manual: save with non-default slots / verify recall, paste a string
   from another project.

## Per-target notes

m4l: snapshot slot state lives as additional `live.numbox` / `live.menu`
parameters (one set per slot for the captured fields). Switching slot
re-fires `setCells` to host. Program string serialization is a pure
function in `host.ts` reused later by vst/app.

vst/app: APVTS for slots; preset and program-string surfaces are JUCE
components that reuse the host's serialization functions ported to C++.
