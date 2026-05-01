---
name: release
description: Cut a versioned GitHub release of Oedipa, attaching the frozen `dist/Oedipa.amxd` as the distribution asset. Verifies repo state (clean / synced / CI green / dist freshness), bumps semver, drafts release notes from the commit log, and runs the tag → push → gh release create flow with explicit user approval at each step.
argument-hint: "[major|minor|patch]"
allowed-tools: Read, Write, Edit, Bash(git *), Bash(gh *), Bash(stat *), Bash(ls *), Bash(rm /tmp/oedipa-*)
---

# Release Oedipa

Cut a versioned GitHub release. Default bump: **patch** unless the user
passes `major` / `minor` as $ARGUMENTS.

The release asset is always the **frozen** `dist/Oedipa.amxd` (NOT the
dev `m4l/Oedipa.amxd`, which only loads on the build machine — it
references sibling JS files that don't exist on a fresh Live install).
Freeze is a manual step in Max; this skill does not attempt to
automate it. See [ADR 007](../../../docs/ai/adr/archive/007-m4l-distribution.md).

## Pre-flight checks (do these BEFORE creating the tag)

Tags are durable. Once pushed, a release with downloads is harder to
undo cleanly. Run all checks; STOP and ask the user if any fail.

### Check 1 — Working tree is clean

`git status --porcelain` must be empty. Uncommitted changes leak into
the release context if you tag now. Halt if dirty.

### Check 2 — main is synced with origin

```bash
git fetch origin --quiet
git rev-list --count main..origin/main   # must be 0 (origin not ahead)
git rev-list --count origin/main..main   # must be 0 (local not ahead)
```

If origin is ahead, `git pull`. If local is ahead, push first
(via `/commit` for any unstaged work, then a normal push). Then re-run.

### Check 3 — CI is green on HEAD

```bash
gh run list --branch main --limit 5 --json conclusion,headSha,workflowName
```

The most recent completed run for the current HEAD SHA must have
`conclusion: "success"`. If still in progress or failed, halt and ask.
(Memory: `feedback_no_speculative_distribution_fixes` — don't ship
distribution artifacts past a red gate.)

### Check 4 — `dist/Oedipa.amxd` exists and reflects current code

The frozen `.amxd` is gitignored, so it lives only on the build
machine. Verify:

```bash
ls -la dist/Oedipa.amxd
stat -f '%m' dist/Oedipa.amxd                       # mtime as epoch
git log -1 --format=%ct -- m4l/Oedipa.maxpat \
                            m4l/cellstrip-renderer.js \
                            m4l/lattice-renderer.js \
                            m4l/separator-renderer.js \
                            m4l/oedipa-host.entry.mjs \
                            m4l/engine m4l/host          # latest m4l-source commit time
```

`dist/Oedipa.amxd` mtime must be **>=** the latest m4l-source commit
time. If older, the user has not re-frozen since the most recent
patcher / engine / host change. Halt and remind:

> Open `m4l/Oedipa.amxd` in Max → click the snowflake (Freeze) button
> in the patcher toolbar → *File → Save As* `dist/Oedipa.amxd`.

Even when the mtime check passes, **manual smoke test in a fresh Live
track is recommended before tagging** — drag `dist/Oedipa.amxd` onto a
new MIDI track, confirm it loads, plays, slot rehydrate works. CI does
not (and cannot) cover this.

## Drafting

After pre-flight passes:

### Step 1 — Determine next version

```bash
git describe --tags --abbrev=0
```

Parse semver `vX.Y.Z`. Bump per $ARGUMENTS (default: patch). If no
prior tag exists, propose `v0.1.0`.

Show the proposed version to the user and **confirm before
proceeding**. The user can override.

### Step 2 — Draft release notes

Generate the draft from the commit log between the previous tag (or
repo root if first release) and HEAD:

```bash
git log <prev-tag>..HEAD --pretty=format:'- %s'
```

Categorize commits by their `type:` prefix into sections:

- **Features** — `feat:`
- **Fixes** — `fix:`
- **Docs / housekeeping** — `docs:` / `chore:` / `style:` / `refactor:`
- **CI / build** — `ci:`

Drop the `Co-Authored-By` lines and trailing housekeeping noise. Keep
the section short — release notes are for users, not contributors;
detailed history is in `git log`.

For the very first release (no prior tag), use a project-intro
template instead of a changelog. Reference v0.1.0 (`gh release view
v0.1.0`) for the shape: "What it does" / "Install" / "Requirements".

Write the draft to `/tmp/oedipa-<version>-notes.md` and show it to the
user. **Wait for explicit "ok" or edit instructions** before Step 3.

### Step 3 — Tag, push, create release

```bash
git tag <version>
git push origin <version>
gh release create <version> dist/Oedipa.amxd \
  --title "Oedipa <version>" \
  --notes-file /tmp/oedipa-<version>-notes.md
```

### Step 4 — Verify

```bash
gh release view <version> --json name,tagName,assets,url
```

Confirm:
- `assets[0].name == "Oedipa.amxd"`
- `assets[0].size` > 0 and matches local `dist/Oedipa.amxd`
- The release URL is reachable

Show the release URL to the user.

### Step 5 — Cleanup

```bash
rm /tmp/oedipa-<version>-notes.md
```

## Rules

- **Asset is always `dist/Oedipa.amxd`.** Never `m4l/Oedipa.amxd`
  (dev only, references sibling JS).
- **Manual Freeze required.** Max has no CLI freeze; this skill does
  not automate it.
- **Tag once, never re-tag.** If a tag for the proposed version
  already exists, bump again rather than overwrite. Force-deleting a
  tag that was already pushed is messy and breaks anyone who pulled
  it.
- **Notes via `--notes-file`, not `--notes`.** The temp-file flow lets
  the user edit before publish.
- **Halt on any pre-flight failure.** Don't release past a red gate.
- **Halt on any user-confirmation gate.** Steps 1 (version) and 2
  (notes) require explicit "ok" — don't proceed silently.
