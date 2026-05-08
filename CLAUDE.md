# Oedipa

Tonnetz-based chord exploration MIDI effect.
Named after Oedipa Maas from Thomas Pynchon's *The Crying of Lot 49*.

## Targets

Oedipa is developed in parallel across multiple targets that share the same
musical concept (Tonnetz traversal, chord navigation) but differ in UI and
platform. Each target lives in its own directory and has its own build system.

- `m4l/` — **Max for Live** device (current primary target). Ableton Live MIDI
  effect. Fastest prototyping path, matches the author's own DAW workflow.
- `vst/` — **VST3/AU** plugin (C++17/JUCE). AU in beta on Logic Pro for macOS;
  VST3 verified in Cubase Pro. The `Source/Engine/` subdirectory is JUCE-free
  (iOS reuse target, see ADR 008).
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
vst/                 — VST3/AU plugin (C++17/JUCE)
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

**Distribution (release builds).** `make release` (from repo root) runs
build + bake and prepares `dist/`. The baked dev `.amxd` references
sibling JS on disk, so it only loads on the build machine. To ship: open
`m4l/Oedipa.amxd` in Max → click the **snowflake (Freeze)** button in the
patcher toolbar (inlines every referenced JS) → *File → Save As*
`dist/Oedipa.amxd`. The frozen file is self-contained and works on any
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
- Label: im9. Free distribution

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
- Host compatibility — load in Ableton (m4l, vst), load in Logic (vst/app),
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

## Conventions

- All in English
- Commit messages: imperative mood, concise
