# Oedipa

Tonnetz-based chord exploration MIDI effect plugin (VST3/AU).
Named after Oedipa Maas from Thomas Pynchon's *The Crying of Lot 49*.

## Origin

Generative engine extracted from [inboil](https://github.com/im9/inboil) (browser-based groove box).
inboil's Tonnetz generator lives in the scene graph as a generative node — Oedipa is a standalone
reimplementation as a DAW-native MIDI effect.

Key references in inboil:
- `src/lib/sceneActions.ts` — `executeGenChain()`, Tonnetz traversal logic
- `src/lib/types.ts` — `SceneNode.generative` field, Tonnetz parameters
- `docs/ai/adr/` — ADR 078 (generative nodes), related ADRs

The inboil implementation is JavaScript/Svelte. Oedipa is a ground-up C++17/JUCE rewrite —
no code is ported directly, but the musical logic and parameter design carry over.

## Setup

```bash
git clone --recursive <repo-url>
make build
```

## Build

```bash
make build     # configure + build (Release)
make debug     # configure + build (Debug)
make clean     # remove build directory
make test      # build + run tests
```

## Architecture

```
Source/              — JUCE plugin source
  PluginProcessor.*  — MIDI processing, Tonnetz engine
  PluginEditor.*     — GUI (Tonnetz lattice visualization)
JUCE/                — JUCE framework (git submodule)
tests/               — Catch2 unit tests
docs/ai/             — design docs
```

## Design

- MIDI effect: receives MIDI input, outputs transformed/generated MIDI
- Tonnetz lattice for chord navigation — visual + interactive
- Parameters normalized in plugin layer
- C++17
- Label: im9. Free distribution

## Mandatory Workflow

**Every implementation task follows these gates in order. Do not skip gates. Do not reorder.**

### Gate 0 — Read before doing

Before writing any code:
1. Read `docs/ai/concept.md` (when created)
2. Read relevant ADR in `docs/ai/adr/` (when created)

### Gate 1 — Tests first (TDD)

**Write or update tests BEFORE editing any file in `Source/`.**

- New feature → write tests that describe the expected behavior
- Bug fix → write a test that reproduces the bug
- Refactor → verify existing tests cover the behavior, add if not

### Gate 2 — Implement

Now edit `Source/` files. Keep changes minimal and focused.

### Gate 3 — Build and test

```bash
make test
```

All tests must pass. Do not proceed with failing tests.

### Gate 4 — Commit (only with explicit approval)

**Never commit or push without explicit user approval.**

## Conventions

- All in English
- Commit messages: imperative mood, concise
