# Oedipa

Tonnetz-based chord exploration MIDI effect.
Named after Oedipa Maas from Thomas Pynchon's *The Crying of Lot 49*.

## Targets

Oedipa is developed in parallel across multiple targets that share the same
musical concept (Tonnetz traversal, chord navigation) but differ in UI and
platform. Each target lives in its own directory and has its own build system.

- `m4l/` — **Max for Live** device (current primary target). Ableton Live MIDI
  effect. Fastest prototyping path, matches the author's own DAW workflow.
- `vst/` — **VST3 / AU / CLAP** plug-in (C++17/JUCE). Primary hosts: Logic Pro
  (AU MIDI FX) and Bitwig Studio (CLAP / VST3 MIDI fx). The `Source/Engine/`
  subdirectory is JUCE-free (iOS reuse target, see ADR 008).
- `app/` — **iOS** app (AUv3 + standalone, JUCE-based). Future target for
  touch-based Tonnetz exploration. Not yet created.

Core logic, parameter design, and ADRs are shared across targets via `docs/ai/`.
Code is not shared — each target is a ground-up implementation in its native
stack.

## Origin

Generative engine extracted from [inboil](https://github.com/im9/inboil)
(browser-based groove box). inboil's Tonnetz generator lives in the scene graph
as a generative node — Oedipa is a standalone reimplementation as a DAW-native
MIDI effect.

Key references in inboil:
- `src/lib/sceneActions.ts` — `executeGenChain()`, Tonnetz traversal logic
- `src/lib/types.ts` — `SceneNode.generative` field, Tonnetz parameters
- `docs/ai/adr/` — ADR 078 (generative nodes), related ADRs

The inboil implementation is JavaScript/Svelte. The `m4l/` target reuses the
Tonnetz logic (JS), while `vst/` and `app/` are C++17/JUCE reimplementations —
no code ported directly, but musical logic and parameter design carry over.

## Layout

```
m4l/                 — Max for Live device
  engine/            — Tonnetz engine (TypeScript)
    tonnetz.ts       — pure logic, ES module
    tonnetz.test.ts  — node:test suite
    dist/tonnetz.js  — compiled ESM output (consumed by the host bundle)
    tsconfig.json, package.json
vst/                 — VST3/AU/CLAP plugin (C++17/JUCE)
  Source/
    Engine/          — pure C++17 engine (no JUCE includes — iOS reuse target)
    Plugin/          — JUCE AudioProcessor, APVTS, MIDI / state I/O
    Editor/          — JUCE AudioProcessorEditor, lattice renderer, widgets
  JUCE/              — JUCE framework (git submodule)
  tests/             — Catch2 unit tests
  CMakeLists.txt, Makefile
app/                 — iOS app (future)
docs/ai/             — shared design docs, ADRs, test vectors
```

## Build

### m4l/

`m4l/` is a pnpm workspace. Packages: `@oedipa/engine`, `@oedipa/host`.

```bash
cd m4l
pnpm install         # first time, installs all workspace packages
pnpm -r test         # run tests across all packages
pnpm -r build        # compile dist/ for all packages
pnpm -r typecheck    # type-check without emit
```

Per-package (e.g. just engine):

```bash
cd m4l/engine
pnpm test            # run tests against TS source
pnpm build           # compile dist/tonnetz.js (consumed by host bundle)
```

Open `.amxd` in Max for Live to use the device. The device loads the bundled
host (`m4l/oedipa-host.mjs`) via `[node.script oedipa-host.mjs]`, so run
`pnpm -r build && pnpm bake` after engine or host changes (bake re-bundles
the entry into `oedipa-host.mjs`).

**Do NOT add `max-api` to dependencies.** It's injected by Max at runtime;
the npm version conflicts with the injected one. See
`m4l/oedipa-host.entry.mjs` header comment.

**Distribution (release builds).** `make release-m4l VERSION=X.Y.Z`
(from repo root) builds + bakes the dev `m4l/Oedipa.amxd` and copies
it to `m4l/Oedipa-vX.Y.Z.amxd` (un-frozen staging file, gitignored).
The baked dev `.amxd` references sibling JS on disk, so it only loads
on the build machine. To ship: open `m4l/Oedipa-vX.Y.Z.amxd` in Max →
click the **snowflake (Freeze)** button in the patcher toolbar
(inlines every referenced JS) → *File → Save As* → navigate to
`dist/` (the default filename `Oedipa-vX.Y.Z.amxd` is already
correct; just confirm the location). `dist/` only ever holds frozen /
shipped artefacts. The frozen file is self-contained and works on any
Live install. See ADR 007.

### vst/

```bash
cd vst
make build     # configure + build (Release)
make debug     # configure + build (Debug)
make clean     # remove build directory
make test      # build + run tests
```

Setup: `git clone --recursive` to fetch the JUCE submodule.

## Design

- MIDI effect: receives MIDI input, outputs transformed/generated MIDI
- Tonnetz lattice for chord navigation — visual + interactive
- Label: im9. m4l free, vst paid (v1.0 in prep)

## Mandatory Workflow

**Every implementation task follows these gates in order. Do not skip gates.
Do not reorder.**

### Gate 0 — Read before doing

Before writing any code:
1. Read `docs/ai/concept.md` (when created)
2. Read relevant ADR in `docs/ai/adr/` (when created)

### Gate 1 — Tests first (TDD)

**Write or update tests BEFORE editing any implementation file.** This applies
per target:

- `vst/` — update `vst/tests/*` before editing `vst/Source/*`
- `m4l/` — update `m4l/engine/*.test.ts` before editing `m4l/engine/*.ts`
- `app/` — same rule once implementation begins

Applicable cases:

- New feature → write tests that describe the expected behavior
- Bug fix → write a test that reproduces the bug
- Refactor → verify existing tests cover the behavior, add if not
- Constant/enum changes that propagate across files → write a consistency test
  that asserts the new count and accesses all indices

#### Shared test vectors

Cross-target Tonnetz engine semantics are captured in
[`docs/ai/tonnetz-test-vectors.json`](docs/ai/tonnetz-test-vectors.json).
Each target's test suite reads this JSON and iterates the cases. When adding a
new semantic case, add it to the JSON — do not duplicate the data in per-target
test code. See ADR 001.

#### GUI / UI components

UI work cannot be unit-tested the way pure logic can — visual quality,
interaction feel, and host loading behavior require human eyes and a real DAW.
Split UI components into a **logic layer** (parameter mapping, state machines,
hit testing, drag-to-value math, lattice position calculations) and a
**renderer** (the actual drawing). Tests target the logic layer; the renderer
reads model state and is not unit-tested.

- **vst/ (JUCE)**: Instantiate the component in the test, simulate input via the
  public JUCE API (`mouseDown` / `mouseDrag` / `mouseUp` / `keyPressed`), and
  assert against parameter values and internal state. Expose minimal
  `getXxxForTest()` inspection methods only when state is otherwise private.
- **m4l/ (jsui)**: Keep pure logic in TypeScript runnable in Node (hit
  testing, coordinate math, state transitions) under `m4l/engine/` or
  `m4l/host/`. The jsui renderers in `m4l/*-renderer.js` are plain ES5
  mirrors of that same math (Max's classic JS engine doesn't support ES
  modules) — drawing and event callbacks live in the renderer and call
  into the mirrored formulas. Keep renderer constants in sync with the TS
  source.
- Do not snapshot-test pixel output. Font rendering and environment differences
  make image hashing brittle.

What stays manual (not covered by Gate 1 tests):

- Visual quality — does the lattice look right, does the animation feel good
- Interaction feel — tap / drag / pinch in the real host
- Host compatibility — load in Ableton (m4l), Logic (vst/app), Bitwig (vst),
  edit, save, reopen, verify no crash

These manual checks are part of pre-release verification, not optional polish.

### Gate 2 — Implement

Now edit implementation files. Keep changes minimal and focused.

### Gate 3 — Build and test

Run the target's test command:

- `vst/` — `cd vst && make test`
- `m4l/` — `cd m4l && pnpm -r test` (runs `node --test` on TS source across workspace)
- `app/` — (TBD when target is added)

For m4l, also run `pnpm -r build` to refresh `dist/` artifacts before loading
the device in Live. `pnpm -r typecheck` checks types without emitting.

All tests must pass. Do not proceed with failing tests.

### Gate 4 — Commit (only with explicit approval)

**Never commit or push without explicit user approval.** Even after `/commit`,
confirm before creating a commit.

## Audio plugin discipline (vst/, future app/)

Realtime audio thread paths (`processBlock`, AU/VST3 callbacks) must be
realtime-safe. The following are **forbidden** in those code paths — including
diagnostic / instrumentation code:

- File I/O of any kind (`juce::FileLogger`, `juce::Logger::writeToLog`,
  `printf`, `std::cout`, `std::ofstream`, raw file handles)
- Mutex / `std::mutex::lock` / blocking synchronization
- Heap allocation (`new`, `delete`, `malloc`, `free`, container resize)
- Direct calls into `juce::MessageManager` (use `MessageManager::callAsync`
  only after confirming it is non-blocking on your JUCE version, or prefer
  the FIFO path below)

To get diagnostic data out of the audio thread, push samples / events into a
**lock-free SPSC FIFO** (`juce::AbstractFifo` + a plain ring buffer) and let
the message thread or a dedicated logger thread read and flush. Probes that
are realtime-unsafe can themselves produce the bug under investigation —
which is exactly how the AU click investigation (2026-05-06 → 05-08) burned
two days before the cause was traced to a `juce::FileLogger` call inside
`processBlock` (recorded in ADR 008 §2026-05-08 revision).

## Distribution (vst paid)

The vst target ships two macOS artifacts in lockstep: a signed pkg
installer (recommended) and a signed dmg (drag-to-install fallback for
users who want a non-standard path). Both produced by `make release-vst`
from the repo root, both signed + notarized + stapled, both uploaded to
the paid platform out of band — see ADR 009.

Both filenames embed the version (parsed by `build-pkg.sh` /
`build-dmg.sh` from `vst/CMakeLists.txt` — single source of truth).
The dmg's mount-time `volname` also carries the version (`Oedipa
vX.Y.Z`) so the Finder shows which build is mounted.

- `dist/Oedipa-vX.Y.Z.pkg` — distribution pkg wrapping per-format
  component pkgs (`fm.im9.oedipa.{vst3,au,clap}`). System-wide install
  only (`<domains enable_localSystem="true"/>`, no per-user choice —
  the two-domain UI shows a confusing "Change Install Location..."
  back-loop button). The customize step lets the user deselect
  individual formats. Welcome / license / conclusion screens are
  localized en + ja under `vst/scripts/pkg-resources/{en,ja}.lproj/`.
- `dist/Oedipa-vX.Y.Z.dmg` — drag-to-install, no UI flow. Power users
  place bundles in custom paths from here.

Signing certs (both under the same Apple Developer Program / TEAMID):
- Bundles signed with **Developer ID Application** by `codesign.sh`
- pkg signed with **Developer ID Installer** by `build-pkg.sh` via
  `productsign` (the dmg outer also uses Developer ID Application in
  `build-dmg.sh`)

**Gotcha (empirical 2026-05-18)**: `productbuild --resources` silently
drops the entire Resources directory from the output pkg if any
`<welcome>` / `<license>` / `<conclusion>` `file=` attribute in
`distribution.xml` omits the file extension. Use `file="welcome.txt"`
etc. — the man page suggests no-extension works for localized resources,
but empirically it doesn't.

**Cross-project mirroring**: sister im9 vst plugins (stencil, pointsman,
future) follow this same pattern. To onboard a new plugin: copy
`build-pkg.sh` + `distribution.xml` + `pkg-resources/` and adjust plugin
name / identifiers (`fm.im9.<plugin>.{vst3,au,clap}`). The
`Makefile`-level `release-<target>` orchestration and the env var
contract (`DEVELOPER_TEAM_ID` + `NOTARY_PROFILE=im9-notary`) are the
same across plugins.

## Future companion integrations

Notes on external integration possibilities that are **out of scope for
current ADRs** but worth retaining design context for. These are not
roadmap commitments — re-evaluate against the active focus before
acting on any of them.

### Ableton Live Extensions SDK (post-v0.2.0)

Ableton announced a JS/TS Extensions SDK 2026-06 (beta, **Live 12.4.5+
Suite only**). It does not replace Oedipa — Extensions are modal-dialog
tools launched from right-click menus, with no real-time MIDI
signal-chain integration and no callback hook from a m4l device back
into an Extension. Oedipa's identity (real-time Tonnetz performance) is
structurally impossible to express as an Extension.

However Extensions can be a useful **compose-time companion**, because
the SDK exposes:
- `track.devices` + `device.parameters` + `param.setValue()` — read and
  write any Live-published parameter, including m4l device params
- `RackDevice.chains` recursion — reach devices nested in racks
- `clip.notes` / `track.createMidiClip()` / `track.arrangementClips` —
  generate or rewrite MIDI clips on any track
- Full WebView UI inside the modal dialog (canvas / SVG / WebGL all
  available — same freedom level as the m4l floating window approach
  in ADR 011, without the Max ES5 constraint)

Candidate Oedipa-companion Extensions (all post-v0.2.0):

- **Bake to clip** — open the Tonnetz UI, navigate, then commit the
  current performance as a 16-bar MIDI clip on the selected track. The
  m4l device can write clips via the Live API but it's hacky; an
  Extension is cleaner.
- **Apply Tonnetz transform to selected clip** — read a clip's notes,
  apply P / L / R operations to each chord, write back. Pure batch
  transformation, well-suited to the Extension one-shot model.
- **Configure Oedipa from song key** — scan song key + tempo, set
  anchor / scale parameters on every Oedipa instance across the set in
  one action.
- **Preset / state distribution** — JSON preset browser that writes to
  one or many Oedipa instances at once; lighter than building a full
  preset manager inside the m4l device.

Constraints to weigh before committing to any of the above:
- Live 12 Suite + 12.4.5+ only — narrower than the m4l device's
  audience (any Live 11+ Suite or Standard with Max).
- Beta SDK — API surface may change; wait for stabilization before
  taking on maintenance load.
- Each Extension is a separate distribution / UX / version-management
  surface.
- Reaching into Oedipa's published parameter schema couples the
  Extension to that schema; renaming a m4l param breaks the Extension.

Reference repo with working examples (2026-06-03):
[`federico-pepe/ableton-live-extensions`](https://github.com/federico-pepe/ableton-live-extensions)
— see `chroma-flux` for `device.parameters` / `param.setValue()` usage,
`snake` for canvas-based real-time UI inside a modal dialog,
`transposer` for `clip.notes` batch read / write.

The same evaluation pattern applies to sister im9 plugins (stencil,
pointsman) with their own use-case lists.

## Conventions

- All in English
- Commit messages: imperative mood, concise
