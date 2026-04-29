---
name: adr
description: Create a new Architecture Decision Record (ADR) for a proposed feature or design change. Runs pre-flight checks (amend? supersede? merge?) before drafting, to prevent casual fragmentation of decisions across multiple files.
argument-hint: "<title>"
allowed-tools: Read, Glob, Grep, Bash(ls *), Write, Edit
---

# Create ADR

Create a new ADR for: $ARGUMENTS

## Pre-flight checks (do these BEFORE writing anything)

These guardrails exist because ADRs split casually become hard to read
and impossible to implement in isolation. Run all four checks before
deciding to create a new ADR file.

### Check 1 — Should this be an amendment instead?

1. Read [docs/ai/adr/INDEX.md](../../../docs/ai/adr/INDEX.md).
2. Read every Proposed ADR (those still in `docs/ai/adr/`, not
   `archive/`).
3. For each: does the proposed decision belong **inside an existing
   Proposed ADR's scope**? If yes → amend that ADR via `Edit`,
   add or update a `**Revised**: YYYY-MM-DD — <one-line>` line under
   the existing `**Created**` block, and STOP. Do not create a new
   file.

### Check 2 — Is this a supersession of an Implemented ADR?

If the decision overrides part of an Implemented ADR (in
`docs/ai/adr/archive/`):

- A new ADR is appropriate, but it MUST include a `## Supersedes`
  section naming the superseded ADR and the specific sections it
  replaces.
- The ADR being superseded stays in `archive/` and stays
  `Implemented` — the code is still its source of truth for the parts
  not superseded.

### Check 3 — Single-ADR default

If you find yourself wanting to create more than one ADR for what is
essentially one design discussion, STOP and merge into one file.

Tests for split-worthiness (must pass ALL to justify a split):

- Can each ADR be implemented and read independently?
- Does draft B avoid saying "see ADR A" repeatedly? Cross-references
  every other paragraph mean it's one decision.
- Are the two decisions actually independent (e.g., MIDI input vs.
  sequencer model — independent), or does one exist *because of* the
  other (cell schema vs. rhythmic feel — coupled)?

"Different concerns" alone is NOT sufficient. ADRs can carry multiple
concerns when they serve one decision (schema + scheduling + UI in
one ADR is fine).

### Check 4 — Read relevant feedback memory

Read the project memory index
(`/Users/tn/.claude/projects/-Users-tn-src-vst-oedipa/memory/MEMORY.md`)
and any feedback memories that apply (especially
`feedback_musical_first.md`, `feedback_dont_split_adrs.md`). Apply
their guidance during design, not after.

## Drafting the ADR

After all four pre-flight checks pass:

### Step 1 — Determine number

List `docs/ai/adr/` and `docs/ai/adr/archive/` to find the highest
existing number across both, then increment by 1.

### Step 2 — Research

Read related code paths and ADRs. Identify what currently exists vs.
what is missing or wrong. Reference specific files as `path:line`.

### Step 3 — Write at `docs/ai/adr/NNN-kebab-slug.md`

Default structure (omit sections that don't apply):

```markdown
# ADR NNN: Title

## Status: Proposed

**Created**: YYYY-MM-DD

## Context

Why is this needed? What is the current situation? What problems exist?
For Oedipa specifically: state the **musical motivation first**, before
implementation concerns. The product exists to deliver musical
experience; design rationale starts there.

## Decision

The proposed design.

- Data shape / types (TypeScript signatures where relevant)
- UI / interaction (ASCII diagrams or prose)
- Behavioral semantics (edge cases, defaults, composition with other
  params)

## Persistence (if state changes)

m4l: how this persists (`live.*` objects per the project pattern; pattr
is unreliable in this Live env). VST: APVTS. Migration from prior
shape if applicable.

## UI (if user-facing)

Both **logic layer** (testable in Node) and **renderer** (manual). See
CLAUDE.md "GUI / UI components".

## Scope

In scope / Out of scope. **Out-of-scope items must include musical
reasoning for deferral**, not "YAGNI" and not "implementation cost".
YAGNI does not apply to v1 features under design.

## Implementation checklist

Phased per CLAUDE.md TDD gates (tests first, then impl, then build/test):

- [ ] **Phase 1 — …**
- [ ] **Phase 2 — …**

## Per-target notes

m4l / vst / app considerations. Engine-level decisions update the
shared test vectors at
[docs/ai/tonnetz-test-vectors.json](../../../docs/ai/tonnetz-test-vectors.json)
(per ADR 001).

## Supersedes (if applicable)

Which prior ADR sections this replaces.
```

### Step 4 — Update INDEX.md

Add a row under the appropriate section (Core / M4L / VST / iOS) of
[docs/ai/adr/INDEX.md](../../../docs/ai/adr/INDEX.md):

- Status `Proposed`
- Notes column: name the **concrete deliverable**, not the topic. Bad:
  "rhythm stuff". Good: "Per-cell expression + global swing/subdivision
  /direction/humanize".

### Step 5 — Stop

Do not commit. Do not start implementation. The ADR is a proposal — the
user reviews it before Phase 1 work begins. Commits route through the
`/commit` skill once the user approves.

## Rules

- Write the ADR in English. Discussion in Japanese is fine; the document
  is English (per CLAUDE.md).
- Status values are ONLY: `Proposed`, `Implemented`, `Superseded`. The
  legend in INDEX.md is the source of truth — `Accepted`, `Done`,
  `Complete`, `Shipped` are NOT real statuses.
- File name: `NNN-kebab-case-title.md`, 3-digit zero-padded.
- Header: `# ADR NNN: Title` (matches file number).
- For Oedipa: musical/perceptual experience comes first. Defer features
  only with musical reasoning, never with YAGNI or implementation cost
  as the primary justification.
- Do NOT create the ADR if any pre-flight check failed and was not
  resolved (amend, merge, or supersede instead).
