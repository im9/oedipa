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
frozen `Oedipa.amxd` ships via [GitHub Releases](../../releases?q=m4l)
and runs on any Live 12 install with Max for Live.

`vst/` AU + VST3 + CLAP — v1 paid release in preparation; distribution
platform will be announced. Source is public and self-build is supported
(see [Build](#build)). Primary hosts: Logic Pro (AU MIDI FX) and Bitwig
Studio (CLAP / VST3 MIDI fx). See [DAW support](#daw-support) below
for the host compatibility matrix.

`app/` (iOS) is planned — see [Targets](#targets).

## Install

### Max for Live (m4l)

Download `Oedipa.amxd` from the latest [release](../../releases?q=m4l), drag
it onto a MIDI track in Ableton Live, and put an instrument after it.
Click a triangle on the lattice to set the starting chord; press play.

### VST3 / AU / CLAP (vst)

The v1 paid release is in preparation; distribution platform will be
announced. Until then, build from source (see [Build](#build)) and
install the resulting bundles into:

- `Oedipa.component` → `~/Library/Audio/Plug-Ins/Components/`
- `Oedipa.vst3` → `~/Library/Audio/Plug-Ins/VST3/`
- `Oedipa.clap` → `~/Library/Audio/Plug-Ins/CLAP/`

Any of these folders may need to be created if you have no other
plug-ins of that format installed there.

**Logic Pro** — load on a software-instrument track in the *AU MIDI
FX* slot, then route the track through a synth or sampler.

**Bitwig Studio** — load as a *CLAP* or *VST3* note effect in front
of an instrument. CLAP is Bitwig's native plug-in format.

See [DAW support](#daw-support) for per-host compatibility. Reaper /
Studio One are best-effort; Ableton Live uses the [Max for Live
target](m4l/) instead.

## Targets

Oedipa is developed in parallel across multiple platforms that share the
musical concept but differ in UI and integration.

| Target | Status | Notes |
|---|---|---|
| [Max for Live](m4l/) | Released | Max for Live device. Current primary target. |
| [Audio Unit](vst/) | v1 in prep | macOS, C++17 / JUCE. Self-build via `make build`; paid release TBA. |
| [VST3](vst/) | v1 in prep | macOS. Same codebase as the AU. Self-build via `make build`; paid release TBA. |
| [iOS](app/) | Planned | AUv3 + standalone, JUCE. Touch-based exploration. |

Musical logic is shared as a specification, not as code. Each target is a
native implementation in its own stack. Cross-target conformance is verified
against [`docs/ai/tonnetz-test-vectors.json`](docs/ai/tonnetz-test-vectors.json).

## DAW support

macOS only for v1 (per ADR 008). Windows / Linux distribution is
deferred. The vst/ build produces AU, VST3, and CLAP bundles together;
the table below covers per-host compatibility on macOS.

| DAW | Format | Status | Notes |
|---|---|---|---|
| Logic Pro | AU | ✅ Primary | AU MIDI FX slot on a software-instrument track. (Logic does not host CLAP.) |
| Bitwig Studio | VST3 / CLAP | ✅ Primary | Note FX slot in front of an instrument. CLAP is Bitwig's native plug-in format. VST3 verified click-free 2026-05-08; CLAP load verified 2026-05-09. |
| Reaper | VST3 / CLAP | ⚠️ Best-effort | VST3 in any FX chain; CLAP load verified 2026-05-09. Not formally tested for v1. |
| Studio One | VST3 | ⚠️ Best-effort | VST3 in MIDI fx slot. Not formally tested for v1. CLAP build is also produced but has not been verified in Studio One. |
| Ableton Live | — | Use m4l/ | Live does not accept third-party VST3 / AU plug-ins in its MIDI Effect rack (host design, not a format limitation) and does not host CLAP. The [Max for Live device](m4l/) is the supported path. |
| Cubase / Nuendo | — | ❌ Out of scope | The VST3 spec has no "MIDI Effect" sub-category and Cubase rejects third-party VST3 in its MIDI Inserts slot (Steinberg policy). Loading Oedipa as an Instrument with two-track MIDI-out routing works mechanically, but conflicts with the "MIDI fx, not synth" identity Oedipa is built on. The instrument-disguise topology was rejected for v1; revisit only if the Cubase ecosystem opens its MIDI Inserts to third-party VST3. |
| FL Studio | — | ❌ Out of scope | FL has no MIDI fx routing on any plug-in surface: VST3 is rejected categorically (channel slot accepts only instruments, mixer hosts only audio fx, no MIDI fx slot exists), and the CLAP build loads but FL's CLAP host does not bridge `note-effect` plug-ins to FL's internal note bus (verified empirically 2026-05-09, ADR 010 Phase 5). Reconsider only if FL adds a native MIDI fx track concept or CLAP `note-effect` routing in its host bridge. |

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
| `vst/` (AU + VST3 + CLAP) | `git submodule update --init --recursive` | `make build` | `make test` |

Per-target dev docs:
- [`m4l/engine/README.md`](m4l/engine/README.md)

## Distribution

Developer-facing — only needed when cutting a new release. `make
release` from the repo root chains `make release-m4l` and `make
release-vst`; the per-target subsections below cover each in detail.

### Max for Live (m4l)

`make release-m4l` builds the engine + host packages and bakes a dev
`m4l/Oedipa.amxd`. To produce the distributable file, open that
`.amxd` in Max → click the **snowflake (Freeze)** button in the
patcher toolbar → *File → Save As* `dist/Oedipa.amxd`. The frozen
`.amxd` inlines every referenced JS file and runs on any Live
install.

Freeze is a manual step in Max — there is no CLI equivalent. See
[ADR 007](docs/ai/adr/archive/007-m4l-distribution.md) for the full
distribution path conventions and the freeze rationale.

### VST3 / AU (vst)

`make release-vst` builds the AU + VST3 + CLAP bundles in Release
mode, signs them with the Developer ID, submits to Apple
notarization, staples the tickets, packages all three bundles +
a `README.txt` + an `INSTALL.txt` into `dist/Oedipa.dmg`, and signs
+ notarizes + staples the dmg itself.

Required environment:

- `DEVELOPER_TEAM_ID` — Apple Developer Team ID
- `NOTARY_PROFILE` — keychain profile name (default `oedipa-notary`)

One-time setup: run `xcrun notarytool store-credentials oedipa-notary
--apple-id <id> --team-id <team> --password <app-specific>` to register
the notarization credentials in the keychain.

See [ADR 009](docs/ai/adr/archive/009-vst-distribution.md) for the
full distribution path.

## Design docs

The shared musical model lives at [`docs/ai/concept.md`](docs/ai/concept.md).
Architectural decisions live under [`docs/ai/adr/`](docs/ai/adr/) — start
with [`docs/ai/adr/INDEX.md`](docs/ai/adr/INDEX.md) and read individual ADRs
only when the relevant area is being touched.

## License

[MIT](LICENSE). Free distribution under the `im9` label.
