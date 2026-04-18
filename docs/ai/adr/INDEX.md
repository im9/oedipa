# ADR Index

Quick reference for all Architecture Decision Records. Read individual ADRs
only when relevant to the current task.

## Status Legend

- **Proposed**: Not yet implemented. Read before working on related features.
- **Accepted**: Design decided, implementation pending or in progress.
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
| 001 | [Tonnetz Engine Interface](001-tonnetz-engine-interface.md) | Proposed | Pure-function API for all targets; P/L/R semantics, voicing, walk state, shared test vectors |

## M4L

| #   | Title | Status | Notes |
|-----|-------|--------|-------|
| 002 | [M4L Device Architecture](002-m4l-device-architecture.md) | Proposed | Patch / host.js / lattice.js / engine layering; engine loading; MIDI I/O; state ownership |

## VST

| #   | Title | Status | Notes |
|-----|-------|--------|-------|

## iOS

| #   | Title | Status | Notes |
|-----|-------|--------|-------|
