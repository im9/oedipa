# Oedipa

Tonnetz-based chord exploration MIDI effect.
Named after Oedipa Maas from Thomas Pynchon's *The Crying of Lot 49*.

## Targets

Oedipa is developed in parallel across multiple targets that share the same
musical concept (Tonnetz traversal, chord navigation) but differ in UI and
platform. Each target lives in its own directory and has its own build system.

- `m4l/` — **Max for Live** device (current primary target). Ableton Live MIDI
  effect. Fastest prototyping path, matches the author's own DAW workflow.
- `vst/` — **VST3/AU** plugin (C++17/JUCE). DAW-native, cross-platform. Future
  target once the M4L version validates the concept.
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
m4l/                 — Max for Live device (.amxd, jsui/*.js)
vst/                 — VST3/AU plugin (C++17/JUCE)
  Source/            — Plugin source
    PluginProcessor.*  — MIDI processing, Tonnetz engine
    PluginEditor.*     — GUI (Tonnetz lattice visualization)
  JUCE/              — JUCE framework (git submodule)
  tests/             — Catch2 unit tests
  CMakeLists.txt, Makefile
app/                 — iOS app (future)
docs/ai/             — shared design docs, ADRs
```

## Build

### m4l/

Open `.amxd` in Max for Live. No build step.

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

**Write or update tests BEFORE editing implementation files.**

Applies to all targets where a test harness exists (currently `vst/tests/`).
For `m4l/`, follow the same discipline where practical (e.g. pure JS logic
modules in `m4l/jsui/` should have tests).

- New feature → write tests that describe the expected behavior
- Bug fix → write a test that reproduces the bug
- Refactor → verify existing tests cover the behavior, add if not

### Gate 2 — Implement

Now edit implementation files. Keep changes minimal and focused.

### Gate 3 — Build and test

Run the target's test command (e.g. `make test` in `vst/`).
All tests must pass. Do not proceed with failing tests.

### Gate 4 — Commit (only with explicit approval)

**Never commit or push without explicit user approval.**

## Conventions

- All in English
- Commit messages: imperative mood, concise
