# ADR Index

Quick reference for all Architecture Decision Records. Read individual ADRs
only when relevant to the current task.

## Status Legend

- **Proposed**: Not yet fully implemented. Contains an implementation checklist; flip to Implemented once all boxes are checked.
- **Implemented**: Done. Code is the source of truth. Read only for historical rationale.
- **Superseded**: Replaced by a newer ADR. Generally skip.

## File Organization

- **Top-level** (`docs/ai/adr/`): Proposed ADRs — active design decisions.
- **Archive** (`docs/ai/adr/archive/`): Implemented and Superseded ADRs — historical record.

## Conventions

- File name: `NNN-kebab-case-title.md` (3-digit zero-padded)
- Header: `# ADR NNN: Title`
- Status line: `## Status: Proposed | Implemented | Superseded`
- Created date: `**Created**: YYYY-MM-DD`
- Sections: Context → Decision → (optional) Scope / Implementation notes

## Core

| #   | Title | Status | Notes |
|-----|-------|--------|-------|
| 001 | [Tonnetz Engine Interface](archive/001-tonnetz-engine-interface.md) | Implemented | Pure-function API; P/L/R semantics, voicing, walk state, shared test vectors. Reference impl in m4l |

## M4L

| #   | Title | Status | Notes |
|-----|-------|--------|-------|
| 002 | [M4L Device Architecture](archive/002-m4l-device-architecture.md) | Implemented | Patch / host.js / lattice.js / engine layering; engine loading; MIDI I/O; state ownership |
| 003 | [M4L Sequencer — Lattice UI & Cell Sequencer](archive/003-m4l-parameters-state.md) | Implemented | Short cell sequencer (4× P/L/R/hold) + jitter + seed; lattice click sets startChord; live.* for transport/voice/cells/jitter/seed |
| 004 | [MIDI Input & Note Discipline](archive/004-midi-input.md) | Implemented | Held-chord 3-subset search → startChord; triggerMode (hybrid/hold-to-play); velocity passthrough; inputChannel (omni default); clean note-off transitions; pos reset on every startChord change. |
| 005 | [Rhythmic Feel](archive/005-rhythmic-feel.md) | Implemented | Per-cell expression (op/velocity/gate/probability/timing, incl. `rest`) + global layer (swing, subdivision, stepDirection, humanize × 3, drift, outputLevel). Supersedes ADR 003 cell-schema. |
| 006 | [Workflow — Slots, Strings, Presets](archive/006-workflow.md) | Implemented | 4 slots w/ MIDI-priority load; compact program string `PLR-\|s=42\|j=0.3\|c=Em`; factory presets via live.menu; randomize w/ motion≥1; cell-strip jsui (variable 1–8); RHYTHM/ARP/Turing palette inboil-aligned. |
| 007 | [M4L Distribution — Path Conventions & Freeze Workflow](archive/007-m4l-distribution.md) | Implemented | Bare-sibling `.maxpat` refs (no `/Users/...`); `make release` + bundled `.mjs` host (esbuild) + manual Max Freeze → distributable `dist/Oedipa.amxd`; guard tests for abs-path scrub and bundle externals. |

## VST

| #   | Title | Status | Notes |
|-----|-------|--------|-------|
| 008 | [VST Stack and Scope](archive/008-vst-stack-and-scope.md) | Implemented | VST3+AU+Standalone (macOS, Win deferred); C++17 engine via shared test vectors; APVTS+ValueTree state; interactive Tonnetz lattice as primary UI; `Source/Engine/` JUCE-free for iOS + future standalone-suite reuse. MIDI instrument only (no internal sound, no plugin hosting); vst/ primary hosts = Logic + Bitwig (Cubase scope-out per ADR 009), Live = m4l target only, Standalone is dev convenience. |
| 009 | [VST Distribution — Signing, Notarization, and Release Flow](archive/009-vst-distribution.md) | Implemented | Developer ID signing + hardened runtime; `xcrun notarytool` (app-specific password local; API-key CI workflow deferred for v1); staple bundles + `.dmg`; `dist/Oedipa.dmg` drag-install with `.component` + `.vst3` + `INSTALL.txt` + `README.txt`; per-target tag scheme `<target>-vX.Y.Z` (legacy `v0.1.0` retained); `macos-latest` `vst-test.yml` on `vst/**` push/PR; root Makefile orchestrates `release-vst`. First release `vst-v0.1.0` shipped 2026-05-08. |
| 010 | [VST CLAP Support](archive/010-vst-clap-support.md) | Implemented | `clap-juce-extensions` wrapper → `Oedipa.clap` alongside VST3/AU; `note-effect` feature; minimal scope (no note expressions / poly mod); Bitwig + Reaper CLAP loads verified, FL Studio empirical negative (host-limit, out of scope), Studio One best-effort; `.clap` joins `dist/Oedipa.dmg` + GitHub Releases. Shipped `vst-v0.1.1` 2026-05-09. |

## iOS

| #   | Title | Status | Notes |
|-----|-------|--------|-------|
