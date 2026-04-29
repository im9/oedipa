---
name: adr-done
description: Mark an ADR as Implemented (or Superseded) and archive it, following docs/ai/adr/INDEX.md conventions.
argument-hint: "<ADR number> [Superseded by NNN]"
allowed-tools: Read, Glob, Bash(ls *), Bash(git mv *), Edit
---

# Mark ADR as Done

Mark ADR $ARGUMENTS as completed and archive it.

## Process

1. **Read `docs/ai/adr/INDEX.md`** to confirm:
   - Status legend: `Proposed`, `Implemented`, `Superseded` (never "Done", "Accepted", "Complete")
   - File organization: Implemented / Superseded ADRs live in `docs/ai/adr/archive/`

2. **Find the ADR file** in `docs/ai/adr/` (top-level) matching the number.

3. **Verify the checklist is actually done** — every Phase / implementation
   checkbox in the ADR body should be `[x]`. If any `[ ]` remain, stop and
   ask the user to confirm before flipping status.

4. **Determine new status**:
   - Default: `Implemented`
   - If the user passed "superseded by NNN": `Superseded` (and add a Supersedes
     line referencing NNN)

5. **Update the ADR file**:
   - Change `## Status: Proposed` → `## Status: Implemented` (or `Superseded`)
   - Add a dated line under the existing `**Created**` / `**Revised**` block:
     `**Implemented**: YYYY-MM-DD (one-line summary of what was verified)`
     — use today's date, mirror the wording style of the most recent archived
     ADR (e.g. `archive/003-m4l-parameters-state.md`).

6. **Move to archive** (use `git mv` so history is preserved):
   - `git mv docs/ai/adr/NNN-...md docs/ai/adr/archive/NNN-...md`

7. **Update `docs/ai/adr/INDEX.md`**:
   - Change the row's link path → `archive/NNN-...md`
   - Change Status column → `Implemented` (or `Superseded`)
   - Trim the Notes column: drop "decisions settled / pending" tails since the
     ADR is no longer pending.

## Rules

- Status values are ONLY: `Proposed`, `Implemented`, `Superseded`. "Accepted",
  "Done", "Complete", "Shipped" are NOT in the legend.
- Implemented and Superseded ADRs MUST be moved to `archive/`.
- Proposed ADRs stay in top-level `docs/ai/adr/`.
- Do NOT update source-code path comments that reference the ADR's old
  `docs/ai/adr/NNN-...md` path — the existing project pattern (see code
  references to ADR 003 after archive) leaves those as-is.
- Do NOT commit. Stop after the file edits and `git mv`. The user routes
  commits through `/commit`.
