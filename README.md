# Oedipa

Tonnetz-based chord exploration MIDI effect.

Named after Oedipa Maas, the protagonist of Thomas Pynchon's *The Crying of
Lot 49* — a novel about someone trying to read a hidden pattern across a
landscape of signs. The device does something similar, audibly: it walks a
neo-Riemannian lattice and emits the chords it finds.

## What it does

On each host step, Oedipa walks a Tonnetz lattice by applying one of three
neo-Riemannian transforms (P, L, R) to the current triad and emits the
result as MIDI. The user specifies:

- a **start chord** — set by clicking a triangle on the lattice
- a **cell program** — a short cyclic array of 4 ops, each `P` / `L` / `R` /
  `hold`. The walker consumes one op per transform tick.
- a **jitter** amount and a **seed** — `jitter` is the per-step probability
  of substituting the current op with a uniform-random one; the
  substitution is reproducible from the seed.
- a **rate** (steps per transform)
- **voicing** (close / spread / drop2) and an optional 7th extension

The Tonnetz handles harmony; the cell program shapes motion; jitter steers
how strict the loop stays. For a fixed `(startChord, cells, jitter, seed)`
the walk is deterministic, so scrubbing the transport or resuming playback
from any position produces the same output.

Full musical model: [`docs/ai/concept.md`](docs/ai/concept.md).

## Status

In development. The `m4l/` target is musically usable but does not yet
respond to incoming MIDI — `startChord` is currently set by lattice click
only. See [`docs/ai/adr/INDEX.md`](docs/ai/adr/INDEX.md) for the roadmap;
ADR 004 (MIDI input), ADR 005 (rhythmic feel), and ADR 006 (workflow /
presets) are the path to v1 release.

## Use (Max for Live)

Open Ableton Live 12 with Max for Live, drag [`m4l/Oedipa.amxd`](m4l/Oedipa.amxd)
onto a MIDI track, and put an instrument after it. Click a triangle on
the lattice to set the starting chord; press play.

Building from source is only needed if you want to modify the device — see
the `Build` section below.

## Targets

Oedipa is developed in parallel across multiple platforms that share the
musical concept but differ in UI and integration.

| Target | Status | Notes |
|---|---|---|
| [`m4l/`](m4l/) | In progress | Max for Live device. Current primary target. |
| [`vst/`](vst/) | Scaffold | VST3 / AU plugin (C++17 / JUCE). |
| `app/` | Planned | iOS app (AUv3 + standalone, JUCE). Touch-based exploration. |

Musical logic is shared as a specification, not as code. Each target is a
native implementation in its own stack. Cross-target conformance is verified
against [`docs/ai/tonnetz-test-vectors.json`](docs/ai/tonnetz-test-vectors.json).

## Origin

The generative engine is adapted from
[inboil](https://github.com/im9/inboil), a browser-based groove box where a
Tonnetz generator lives inside a scene graph as one generative node among
many. Oedipa lifts that node out into a standalone DAW-native MIDI effect —
the musical model and parameter design carry over; the scene-graph
architecture does not.

## Build

Per-target build commands:

| Target | First time | Build | Test |
|---|---|---|---|
| `m4l/` (workspace) | `cd m4l && pnpm install` | `pnpm -r build` | `pnpm -r test` |
| `vst/` | `git submodule update --init --recursive` | `make build` | `make test` |

Per-target dev docs:
- [`m4l/engine/README.md`](m4l/engine/README.md)

## Design docs

Architectural decisions live under [`docs/ai/adr/`](docs/ai/adr/). Start
with [`docs/ai/adr/INDEX.md`](docs/ai/adr/INDEX.md); read individual ADRs
only when the relevant area is being touched.

Key docs:
- [`docs/ai/concept.md`](docs/ai/concept.md) — shared musical model
- [`docs/ai/adr/archive/001-tonnetz-engine-interface.md`](docs/ai/adr/archive/001-tonnetz-engine-interface.md) — engine contract, cross-target semantics (Implemented)
- [`docs/ai/adr/archive/002-m4l-device-architecture.md`](docs/ai/adr/archive/002-m4l-device-architecture.md) — M4L device layering (Implemented)
- [`docs/ai/adr/archive/003-m4l-parameters-state.md`](docs/ai/adr/archive/003-m4l-parameters-state.md) — lattice UI + cell sequencer (Implemented)

## License

[MIT](LICENSE). Free distribution under the `im9` label.
