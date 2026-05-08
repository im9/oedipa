---
name: release
description: Cut a versioned per-target GitHub release of Oedipa (m4l or vst). Verifies repo state (clean / synced / CI green / dist freshness for the chosen target), bumps semver, drafts release notes from the per-target commit log, and runs the tag → push → gh release create flow with explicit user approval at each step.
argument-hint: "<m4l|vst> [major|minor|patch]"
allowed-tools: Read, Write, Edit, Bash(git *), Bash(gh *), Bash(stat *), Bash(ls *), Bash(rm /tmp/oedipa-*)
---

# Release Oedipa

Cut a versioned per-target GitHub release. The first $ARGUMENT
selects the target (`m4l` or `vst`); the second is the bump
(`major` / `minor` / `patch`, default `patch`).

Tags are namespaced per target: `<target>-vX.Y.Z`. Each target
versions independently — m4l hotfixes don't bump vst, and vice
versa.

The legacy `v0.1.0` tag (m4l-only, pre-vst introduction) is retained
as historical and is **not** part of the per-target scheme going
forward. The first per-target release of m4l is `m4l-v0.1.1` (or
later) and the first vst release is `vst-v0.1.0`.

The release asset is target-specific:

- **m4l** → `dist/Oedipa.amxd` — frozen `.amxd`. Manual freeze in
  Max required (snowflake button → *File → Save As*). See
  [ADR 007](../../../docs/ai/adr/archive/007-m4l-distribution.md).
- **vst** → `dist/Oedipa.dmg` — signed / notarized / stapled dmg
  built via `make release-vst`. See
  [ADR 009](../../../docs/ai/adr/009-vst-distribution.md).

## Pre-flight checks (do these BEFORE creating the tag)

Tags are durable. Once pushed, a release with downloads is harder
to undo cleanly. Run all checks; STOP and ask the user if any fail.

### Check 1 — Working tree is clean

`git status --porcelain` must be empty. Uncommitted changes leak
into the release context if you tag now. Halt if dirty.

### Check 2 — main is synced with origin

```bash
git fetch origin --quiet
git rev-list --count main..origin/main   # must be 0 (origin not ahead)
git rev-list --count origin/main..main   # must be 0 (local not ahead)
```

If origin is ahead, `git pull`. If local is ahead, push first
(via `/commit` for any unstaged work, then a normal push). Then
re-run.

### Check 3 — CI is green on HEAD

```bash
gh run list --branch main --limit 5 --json conclusion,headSha,workflowName
```

The most recent completed run for the current HEAD SHA must have
`conclusion: "success"`. If still in progress or failed, halt and
ask. (Memory: `feedback_no_speculative_distribution_fixes` — don't
ship distribution artifacts past a red gate.)

### Check 4 — Asset exists and reflects current target source

The asset is gitignored, so it lives only on the build machine.
Verify per target.

#### m4l target

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

`dist/Oedipa.amxd` mtime must be **>=** the latest m4l-source
commit time. If older, halt and remind:

> Open `m4l/Oedipa.amxd` in Max → click the snowflake (Freeze)
> button in the patcher toolbar → *File → Save As*
> `dist/Oedipa.amxd`.

Even when the mtime check passes, **manual smoke test in a fresh
Live track is recommended before tagging** — drag `dist/Oedipa.amxd`
onto a new MIDI track, confirm it loads, plays, slot rehydrate
works. CI does not (and cannot) cover this.

#### vst target

```bash
ls -la dist/Oedipa.dmg
stat -f '%m' dist/Oedipa.dmg                        # mtime as epoch
git log -1 --format=%ct -- vst/Source/ \
                            vst/CMakeLists.txt \
                            vst/scripts/ \
                            vst/tests/                   # latest vst-source commit time
```

`dist/Oedipa.dmg` mtime must be **>=** the latest vst-source commit
time. If older, halt and remind:

> Run `make release-vst` to rebuild + sign + notarize + dmg.
> Requires `DEVELOPER_TEAM_ID` env var + `oedipa-notary` keychain
> profile. See README §Distribution → §VST3 / AU.

Manual host smoke (Logic AU MIDI FX + Bitwig VST3 MIDI fx) is
recommended before tagging. The dmg's `xcrun stapler validate` is
a cheap final check:

```bash
xcrun stapler validate dist/Oedipa.dmg
```

## Drafting

After pre-flight passes:

### Step 1 — Determine next version

```bash
git tag -l '<target>-v*' | sort -V | tail -1
```

Parse the highest `<target>-vX.Y.Z` tag. Bump per the second
$ARGUMENT (default `patch`). If no prior tag for this target,
propose `<target>-v0.1.0`.

Show the proposed version to the user and **confirm before
proceeding**. The user can override.

### Step 2 — Draft release notes

Generate the draft from the commit log between the previous
**per-target** tag and HEAD:

```bash
PREV=$(git tag -l '<target>-v*' | sort -V | tail -1)
git log "${PREV:-}"..HEAD --pretty=format:'- %s'
```

If `$PREV` is empty (first release for this target), use the
project root or — for vst — the legacy `v0.1.0` tag as the lower
bound for vst's first ship, since vst-relevant work landed after
`v0.1.0`.

Categorize commits by their `type:` prefix into sections:

- **Features** — `feat:`
- **Fixes** — `fix:`
- **Docs / housekeeping** — `docs:` / `chore:` / `style:` / `refactor:`
- **CI / build** — `ci:`

Drop the `Co-Authored-By` lines and trailing housekeeping noise.
Keep the section short — release notes are for users, not
contributors; detailed history is in `git log`.

For the very first release of a target (no prior `<target>-v*`
tag), use a project-intro template instead of a changelog. For
vst, reference the m4l v0.1.0 release (`gh release view v0.1.0`)
for the shape: "What it does" / "Install" / "Requirements".

Write the draft to `/tmp/oedipa-<tag>-notes.md` and show it to
the user. **Wait for explicit "ok" or edit instructions** before
Step 3.

### Step 3 — Tag, push, create release

```bash
TAG=<target>-vX.Y.Z
ASSET=dist/Oedipa.amxd          # or dist/Oedipa.dmg for vst
TITLE="Oedipa <target> vX.Y.Z"

git tag "$TAG"
git push origin "$TAG"
gh release create "$TAG" "$ASSET" \
  --title "$TITLE" \
  --notes-file "/tmp/oedipa-$TAG-notes.md"
```

### Step 4 — Verify

```bash
gh release view "$TAG" --json name,tagName,assets,url
```

Confirm:

- `assets[0].name` matches the per-target asset filename
  (`Oedipa.amxd` or `Oedipa.dmg`).
- `assets[0].size` > 0 and matches the local file's size.
- The release URL is reachable.

Show the release URL to the user.

### Step 5 — Cleanup

```bash
rm "/tmp/oedipa-$TAG-notes.md"
```

## Rules

- **Asset is target-specific.** m4l → `dist/Oedipa.amxd` (frozen);
  vst → `dist/Oedipa.dmg` (signed/notarized/stapled). Never mix.
- **Tag namespace is per-target.** `m4l-vX.Y.Z` and `vst-vX.Y.Z`
  are independent versioning lines. The legacy `v0.1.0` tag is
  retained as historical and not bumped.
- **Manual Freeze required for m4l.** Max has no CLI freeze; this
  skill does not automate it.
- **`make release-vst` required for vst.** The dmg is built + signed
  + notarized + stapled by the script chain; this skill does not
  re-run it.
- **Tag once, never re-tag.** If a tag for the proposed version
  already exists, bump again rather than overwrite. Force-deleting
  a tag that was already pushed is messy and breaks anyone who
  pulled it.
- **Notes via `--notes-file`, not `--notes`.** The temp-file flow
  lets the user edit before publish.
- **Halt on any pre-flight failure.** Don't release past a red
  gate.
- **Halt on any user-confirmation gate.** Steps 1 (version) and 2
  (notes) require explicit "ok" — don't proceed silently.
