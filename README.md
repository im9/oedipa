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

- a **start chord** — set by clicking a triangle on the lattice or by
  playing notes into the device
- a **cell program** — a short cyclic array (1–8 cells) of ops, each
  `P` / `L` / `R` / `hold` / `rest`, with per-cell expression
  (velocity / gate / probability / timing)
- a **jitter** amount and a **seed** — `jitter` is the per-step probability
  of substituting the op with a uniform-random one; the substitution is
  reproducible from the seed
- a **rate** (cell length in bars) and a **rhythm** mode that frames how
  the cells fire against the grid
- **voicing** (close / spread / drop2) and an optional 7th extension

The Tonnetz handles harmony; the cell program shapes motion; jitter steers
how strict the loop stays. For a fixed configuration the walk is
deterministic, so scrubbing the transport or resuming playback from any
position produces the same output.

Full musical model: [`docs/ai/concept.md`](docs/ai/concept.md).

## Status

`m4l/` is feature-complete for v1 and packaged for distribution. The
frozen `Oedipa.amxd` ships via [GitHub Releases](../../releases) and
runs on any Live 12 install with Max for Live.

`vst/` AU + VST3 are packaged for distribution as a signed and notarized
macOS `.dmg`. Primary hosts: Logic Pro (AU MIDI FX) and Bitwig Studio
(VST3 MIDI fx). See [DAW support](#daw-support) below for the host
compatibility matrix. The first GitHub Release is being prepared.

`app/` (iOS) is planned — see [Targets](#targets).

## Use (Max for Live)

Download `Oedipa.amxd` from the latest [release](../../releases), drag
it onto a MIDI track in Ableton Live, and put an instrument after it.
Click a triangle on the lattice to set the starting chord; press play.

Building from source is only needed if you want to modify the device —
see [Build](#build) below.

## Targets

Oedipa is developed in parallel across multiple platforms that share the
musical concept but differ in UI and integration.

| Target | Status | Notes |
|---|---|---|
| [Max for Live](m4l/) | Released | Max for Live device. Current primary target. |
| [Audio Unit](vst/) | Pre-release | macOS, bundled in the vst/ `.dmg`. C++17 / JUCE. |
| [VST3](vst/) | Pre-release | macOS, bundled in the vst/ `.dmg`. Same codebase as the AU. |
| [iOS](app/) | Planned | AUv3 + standalone, JUCE. Touch-based exploration. |

Musical logic is shared as a specification, not as code. Each target is a
native implementation in its own stack. Cross-target conformance is verified
against [`docs/ai/tonnetz-test-vectors.json`](docs/ai/tonnetz-test-vectors.json).

## DAW support

macOS only for v1 (per ADR 008). Windows / Linux distribution is
deferred. The vst/ `.dmg` ships AU and VST3 bundles together; the table
below covers per-host compatibility on macOS.

| DAW | Format | Status | Notes |
|---|---|---|---|
| Logic Pro | AU | ✅ Primary | AU MIDI FX slot on a software-instrument track. |
| Bitwig Studio | VST3 | ✅ Primary | VST3 MIDI fx slot in front of an instrument. Verified click-free 2026-05-08. |
| Reaper | VST3 | ⚠️ Best-effort | VST3 in any FX chain. Not formally tested for v1. |
| Studio One | VST3 | ⚠️ Best-effort | VST3 in MIDI fx slot. Not formally tested for v1. |
| Ableton Live | — | Use m4l/ | Live does not accept third-party VST3 / AU plug-ins in its MIDI Effect rack (host design, not a format limitation). The [Max for Live device](m4l/) is the supported path. |
| Cubase / Nuendo | — | ❌ Out of scope | The VST3 spec has no "MIDI Effect" sub-category and Cubase rejects third-party VST3 in its MIDI Inserts slot (Steinberg policy). Loading Oedipa as an Instrument with two-track MIDI-out routing works mechanically, but conflicts with the "MIDI fx, not synth" identity Oedipa is built on. The instrument-disguise topology was rejected for v1; revisit only if the Cubase ecosystem opens its MIDI Inserts to third-party VST3. |
| FL Studio | — | ❌ Out of scope | Not targeted for v1; CLAP wrapping deferred (see ADR 008). |

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
| `vst/` (AU + VST3) | `git submodule update --init --recursive` | `make build` | `make test` |

Per-target dev docs:
- [`m4l/engine/README.md`](m4l/engine/README.md)

### Release (m4l)

`make release` from the repo root builds the engine + host packages and
bakes a dev `m4l/Oedipa.amxd`. To produce the distributable file, open
that `.amxd` in Max → click the **snowflake (Freeze)** button in the
patcher toolbar → *File → Save As* `dist/Oedipa.amxd`. The frozen
`.amxd` inlines every referenced JS file and runs on any Live install.

Freeze is a manual step in Max — there is no CLI equivalent. See
[ADR 007](docs/ai/adr/archive/007-m4l-distribution.md) for the full
distribution path conventions and the freeze rationale.

## Design docs

The shared musical model lives at [`docs/ai/concept.md`](docs/ai/concept.md).
Architectural decisions live under [`docs/ai/adr/`](docs/ai/adr/) — start
with [`docs/ai/adr/INDEX.md`](docs/ai/adr/INDEX.md) and read individual ADRs
only when the relevant area is being touched.

## License

[MIT](LICENSE). Free distribution under the `im9` label.
