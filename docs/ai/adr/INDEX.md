# ADR Index

Quick reference for all Architecture Decision Records. Read individual ADRs
only when relevant to the current task.

## Status Legend

- **Proposed**: Not yet fully implemented. Contains an implementation checklist; flip to Implemented once all boxes are checked.
- **Implemented**: Done. Code is the source of truth. Read only for historical rationale.
- **Superseded**: Replaced by a newer ADR. Generally skip.

## File Organization

- **Top-level** (`docs/ai/adr/`): Proposed and Accepted ADRs — active design decisions.
- **Archive** (`docs/ai/adr/archive/`): Implemented and Superseded ADRs — historical record.

## Conventions

- File name: `NNN-kebab-case-title.md` (3-digit zero-padded)
- Header: `# ADR NNN: Title`
- Status line: `## Status: Proposed | Accepted | Implemented | Superseded`
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
| 006 | [Workflow — Slots, Strings, Presets](006-workflow.md) | Proposed | 4 slots (cells/startChord/jitter/seed) w/ MIDI-priority load; compact program string `PLR-\|s=42\|j=0.3\|c=Em`; 6–10 inlined factory presets via live.menu; random gen w/ motion≥1 constraint. Spec finalized, 7-phase impl pending. |

## VST

| #   | Title | Status | Notes |
|-----|-------|--------|-------|

## iOS

| #   | Title | Status | Notes |
|-----|-------|--------|-------|
