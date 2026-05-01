# ADR 007: M4L Distribution — Path Conventions and Freeze Workflow

## Status: Implemented

**Created**: 2026-05-01
**Revised**: 2026-05-01 — node.script entry script moved to `.amxd` sibling level (`m4l/oedipa-host.mjs` after Phase 5; originally `oedipa-host.js`) after observing that subdirectory-relative paths (`host/index.js`) fail to resolve at runtime under Max for Live; only bare-sibling resolution is reliable for `[node.script]`. jsui's bare-sibling resolution was unaffected. Phase 5 also switched the bundle's extension from `.js` to `.mjs` so freeze-extracted scripts parse as ESM in the sandbox tempdir where there is no sibling `package.json` (see Phase 5).
**Implemented**: 2026-05-01 — `make release` → Max Freeze → `dist/Oedipa.amxd` distribution flow verified on a fresh Live track; node.script loads, hostReady cascade rehydrates user-saved program, MIDI plays.

## Context

Oedipa is labelled `im9 / Free distribution` (CLAUDE.md). The product
exists to be played by people other than the author; until that path
works, the musical experience stops at one machine. Right now it does
stop at one machine.

`m4l/Oedipa.maxpat` currently bakes 6 absolute paths to the developer's
local clone into the patcher:

- 1 `node.script` text argument pointing at `host/index.js`.
- 5 `jsui` `filename` attributes pointing at the sibling renderers
  (`cellstrip-renderer.js`, `lattice-renderer.js`, and three uses of
  `separator-renderer.js`).

Anyone receiving the resulting `Oedipa.amxd` cannot load it: the
patcher tries to read paths that don't exist on their disk. The
`pnpm bake` flow has so far just propagated the developer-machine
paths into the produced `.amxd`.

This was deferred during ADR 006 Phase 7 ("separate session, NOT
bundled with Phase 7"). The deferral itself was defensible as scope
hygiene, but allowing a `Free distribution` project to ship six builds
without ever closing the distribution gap was wrong. This ADR closes
it.

## Decision

Two coupled changes — neither works without the other.

### 1. `.maxpat` path conventions

All asset references in `Oedipa.maxpat` resolve via Max-native relative
lookup, never via absolute paths to a developer machine.

- **`jsui` renderers**: `filename` attribute is the bare filename of a
  sibling of `Oedipa.maxpat` (e.g. `cellstrip-renderer.js`). Max's
  jsui resolves the `filename` attribute through the search path; the
  patcher's directory is reachable, so sibling files always resolve.
- **`node.script`**: the text argument is the bare filename of a
  sibling of `Oedipa.maxpat` (currently `oedipa-host.mjs`). The script
  entry lives next to the `.amxd`, not inside a subdirectory. Subdirectory-
  relative forms (e.g. `host/index.js`) are **not reliable** under
  Live's runtime: when the patcher has no Max Project context, Max
  emits `"a project without a name is like a day without sunshine.
  fatal."` and falls back to global search-path lookup, which does not
  treat `host/index.js` as resolvable. jsui's resolution path is more
  forgiving and works for siblings; node.script's is stricter. The
  bare-sibling form matches what jsui already requires.
- **No new path indirection (no env vars, no `pnpm bake`-time
  substitution).** The earlier `OEDIPA_M4L_ROOT` sketch was rejected
  because env-substituted absolute paths still bake into the `.amxd`
  and break on the receiver's machine. The Max-native bare-sibling
  approach is the only one that survives distribution.

Entry source (`m4l/oedipa-host.entry.mjs`) is a thin wrapper around
the host package's compiled output (`./host/dist/host/bridge.js`).
`pnpm bundle:host` (esbuild) inlines that import chain into a single
self-contained `.mjs` bundle, `m4l/oedipa-host.mjs`, which is what
`[node.script]` actually loads. The host TS source / tests / build
artefacts continue to live under `m4l/host/`; only the bundled entry
sits at the .amxd sibling level.

Memory guard: `feedback_jsui_filename` already recorded that jsui's
bare-sibling resolution works. The same constraint applies, more
strictly, to node.script — codified here so it doesn't get
re-litigated.

### 2. Distribution flow = `pnpm bake` → Freeze → ship `.amxd`

`pnpm bake` produces an `Oedipa.amxd` whose JS dependencies still
resolve to sibling files in the `m4l/` directory. To distribute, the
device must be **frozen** in Max, which inlines every referenced JS
file (host, engine `dist/`, all renderers) into the `.amxd` binary.
A frozen `.amxd` is self-contained and runs on any Live install
regardless of where the user drops it on disk.

Distribution flow becomes:

1. Edit `Oedipa.maxpat` (per existing `feedback_m4l_patcher_workflow`).
2. `pnpm -r build` to refresh `engine/dist/` and `host/dist/` (per
   existing `feedback_m4l_pnpm_build`).
3. `pnpm bake` to produce the dev `.amxd`. Use this `.amxd` for local
   smoke testing — it still references siblings, so it only works on
   the dev machine, but it's the fastest iteration loop.
4. **Distribution build**: open the dev `.amxd` in Max → *File →
   Freeze Device* → save as `Oedipa.amxd` to a release directory
   outside `m4l/`. The frozen file is what ships.

Freeze is a manual Max action (Max provides no CLI freeze). The
distribution flow is therefore inherently two-stage: automated bake
for development, manual freeze for release. This is acceptable —
freezes happen per release, not per edit.

### Why not other approaches

- **`OEDIPA_M4L_ROOT` env + `pnpm bake` substitution** — solves dev
  portability between author's machines, but the substituted absolute
  path is still baked into the `.amxd`. Distribution still broken.
  Strictly worse than relative paths.
- **Max search path configuration on the receiver** — requires every
  end user to edit Max preferences, defeats "drag-and-drop" UX of
  M4L.
- **Skip freeze, ship `.amxd` + sidecar JS files** — Max/Live treat
  `.amxd` as a single-file device; sidecar files break the model and
  can't be installed by drag.

## Persistence

No state changes. This is a build / distribution decision.

## UI

No UI changes. The musical experience and device strip layout are
unchanged from ADR 006.

## Scope

**In scope**

- Replacing the 6 absolute paths in `Oedipa.maxpat` with bare /
  relative references.
- Documenting the freeze step in the m4l section of the project's
  contributor instructions (`CLAUDE.md` or a `m4l/README.md` if the
  step list grows).
- A guard test that fails CI/local test runs if any absolute path
  pattern reappears in `Oedipa.maxpat`.

**Out of scope**

- Automating freeze. Max has no CLI freeze command; building a
  custom inliner that mimics freeze is a large, fragile detour for a
  workflow that runs per release. Manual freeze is acceptable.
  *(Reasoning is build-process, not musical — no musical experience is
  affected by automation status.)*
- VST / iOS distribution. Those targets have separate build systems
  and their own distribution stories; this ADR is m4l-only.
- Code signing / notarisation of the `.amxd`. Not required for `.amxd`
  distribution (Live treats devices as data, not executables).
  Revisit only if Live's policy changes.

## Implementation checklist

Phased per CLAUDE.md TDD gates.

### Phase 1 — Path-scrub guard test

- [x] Add a guard test (`m4l/host/maxpat-paths.test.ts`, picked up by
  the host package's `pnpm test` and therefore `pnpm -r test`) that
  reads `Oedipa.maxpat` and asserts no absolute path patterns appear.
  Patterns rejected: `/Users/`, `/home/`, `C:\\`. Test failed the
  pre-Phase-2 `Oedipa.maxpat` with 6 `/Users/` occurrences.

### Phase 2 — Patcher path scrub + entry-script relocation

- [x] Move `m4l/host/index.js` → `m4l/oedipa-host.js`. Internal import
  retargeted from `'./dist/host/bridge.js'` to
  `'./host/dist/host/bridge.js'`.
- [x] Edit `Oedipa.maxpat`:
  - 1 `node.script` text arg → `node.script oedipa-host.js @autostart 1`.
  - 5 `jsui` `filename` attrs → bare filenames (`cellstrip-renderer.js`,
    `lattice-renderer.js`, `separator-renderer.js`).
- [x] `pnpm bake` → fresh dev `.amxd` (119823 bytes).
- [x] Phase 1 guard test passes (264/264 host tests green).

### Phase 3 — Manual smoke (dev machine)

- [x] Open the dev `.amxd` in Live: device loads, lattice renders,
  cell-strip renders, host node.script logs `oedipa host:
  oedipa-host.js loaded` (Max console).
- [x] Slot save / restore round-trip works.
- [x] All ARP / RHYTHM / voicing combinations still audible.

### Phase 4 — Distribution flow + verification

- [x] Document the freeze step in the m4l section of `CLAUDE.md`
  (or a fresh `m4l/README.md` if it doesn't fit cleanly under
  *Build*). Cover: bake → Freeze in Max → ship.
- [x] Manual cross-path test: copy the frozen `Oedipa.amxd` to a
  location outside the repo (e.g. the user's downloads folder on a
  fresh path). Drag into Live; confirm device loads and is fully
  playable. This is the canonical distribution-success criterion.
  Verified 2026-05-01 with the `.mjs` bundle: fresh Live track →
  `from_node: hostReady 1` prints, slot rehydrate cascade emits the
  user's saved program (`slot-program PLR_|s=0|j=0|c=C`), MIDI notes
  flow on transport play, cell-strip + lattice update per step.
- [ ] (Optional, only if a second machine is conveniently available)
  Repeat the cross-path test on a second machine. Not blocking;
  cross-path on the same machine catches the same class of bug
  because the absolute paths in the un-frozen file would be wrong.

### Phase 5 — Bundle host entry to survive freeze

First Phase 4 cross-path attempt revealed that **Max's freeze does not
follow ES module `import` statements**. The patcher's `[node.script
oedipa-host.js]` was inlined, but its import chain
(`./host/dist/host/bridge.js` → `host.js` / `slot.js` / `cellstrip.js` /
`presets.js` and `engine/tonnetz.js`) was lost. Symptom in the Live host:
`node.script: Node script not ready can't handle message step` repeating
forever as the metro fires.

Fix: pre-bundle the host entry into a single self-contained file before
freezing, leaving only `max-api` (Max-injected at runtime) as an external
import. The freeze then captures one entry file that already contains all
host + engine logic. jsui renderers are exempt — they already avoid
imports (Max's classic JS engine does not support ES modules).

This is build-time bundling, not a freeze replacement; ADR 007's
out-of-scope clause on "custom inliner" is unaffected (Max still does the
final freeze).

- [x] Source rename: `m4l/oedipa-host.js` → `m4l/oedipa-host.entry.mjs`.
- [x] Add `esbuild` as devDependency at the m4l workspace root.
- [x] Add `bundle:host` script to `m4l/package.json`:
  `esbuild oedipa-host.entry.mjs --bundle --platform=node --format=esm --external:max-api --outfile=oedipa-host.mjs`.
- [x] Patcher reference: `[node.script oedipa-host.mjs @autostart 1]`
  (bare-sibling form, per the Phase 2 path scrub).
- [x] Update `bake` script to run `bundle:host` first
  (`bake = bundle:host && maxpat-to-amxd`).
- [x] `.gitignore` the bundled `m4l/oedipa-host.mjs` (build artefact).
- [x] Guard test (`m4l/host/oedipa-host-bundle.test.ts`): bundled
  `oedipa-host.mjs` has only `max-api` as a remaining external import.
  Skipped on fresh checkouts where the bundle hasn't been built yet.
- [x] Bundle output extension is `.mjs`, not `.js`. Empirically
  required: a `.js` bundle works in dev because `m4l/package.json` has
  `"type": "module"` next to it, so Node treats the file as ESM. The
  freeze sandbox extracts the inlined script to a tempdir without any
  sibling `package.json`, so a `.js` bundle there is interpreted as
  CommonJS and the entry's `import Max from 'max-api'` throws on parse,
  leaving `[node.script]` permanently in the "Node script not ready"
  state. `.mjs` is unconditionally ESM regardless of any sibling
  `package.json`. Verified 2026-05-01 by Max console log comparison:
  - dev (with `.js` bundle): early init messages drop with "Node
    script not ready" but eventually `oedipa host: oedipa-host.js
    loaded` and `from_node: hostReady 1` print, the cascade re-emits
    state, and the device plays. The early drops are harmless because
    the `hostReady` cascade re-emits everything.
  - dist (with `.js` bundle, after freeze): same drops, but `loaded`
    and `hostReady 1` **never print**. node.script is permanently
    stuck and the device is silent. The bundle is correctly inlined in
    the frozen `.amxd` (`strings dist/Oedipa.amxd | grep -E
    "SYNCOPATED_PATTERN|Max.post"` confirms presence) — Node simply
    cannot run it as ESM.
  This narrows the regression to one cause: ESM resolution requires
  either a sibling `package.json` or a `.mjs` extension; only the
  latter survives the freeze→extract round trip. The earlier
  hypothesis (handoff memo) that the failure was a "loadbang→hostReady
  gating race" was disproven by this comparison: dev shows the same
  early-drop pattern and is fine.
- [x] Re-run Phase 4 cross-path manual test with the `.mjs` bundle:
  `make release` → Live → Edit → snowflake → Save As `dist/Oedipa.amxd`
  → drag into a fresh Live track. Verified 2026-05-01: `oedipa host:
  oedipa-host.mjs loaded` and `from_node: hostReady 1` print, slot
  rehydrate cascade restores user-saved program, MIDI plays.

## Per-target notes

**m4l only.** No engine API changes; the shared
`docs/ai/tonnetz-test-vectors.json` is not touched. ADR 002 (M4L
device architecture) is unaffected — patcher / host.js / engine
layering and state ownership stay as recorded; this ADR records the
distribution-time path resolution that ADR 002 didn't address.

## Notes for future ADRs

- If the host or engine packages start emitting more `dist/` artefacts
  that the patcher references, those references must follow the same
  bare / relative convention, and the Phase 1 guard test must be
  extended to cover their reference patterns.
- A future ADR for VST / iOS distribution should treat its packaging
  story as a separate decision; do not amend this ADR.
