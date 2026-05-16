---
name: release
description: Cut a versioned per-target release of Oedipa. m4l publishes to GitHub Releases (tag + asset + notes); vst is local-only since the paid pivot (CMakeLists VERSION bump + signed/notarized dmg + drafted listing notes, no tag, no GH release). Verifies repo state, bumps semver, drafts notes from the per-target commit log, and runs the publish flow with explicit user approval at each step.
argument-hint: "<m4l|vst> [major|minor|patch]"
allowed-tools: Read, Write, Edit, Bash(git *), Bash(gh *), Bash(stat *), Bash(ls *), Bash(rm /tmp/oedipa-*)
---

# Release Oedipa

Cut a versioned per-target release. The first $ARGUMENT selects the
target (`m4l` or `vst`); the second is the bump (`major` / `minor` /
`patch`, default `patch`).

m4l publishes to GitHub Releases with tags namespaced as
`m4l-vX.Y.Z`. vst is local-only since the paid pivot — no tag, no GH
release; the in-tree `vst/CMakeLists.txt` `project(... VERSION …)`
is the version source of record, and the dmg is uploaded to the paid
platform out of band.

The legacy `v0.1.0` tag (m4l-only, pre-vst introduction) is retained
as historical. The first per-target release of m4l is `m4l-v0.1.1`
(or later); vst's `vst-v0.1.0` / `v0.1.1` / `v0.1.2` tags remain in
the repo as source history with no GH release entries.

The release asset is target-specific:

- **m4l** → `dist/Oedipa.amxd` — frozen `.amxd`. Manual freeze in
  Max required (snowflake button → *File → Save As*). See
  [ADR 007](../../../docs/ai/adr/archive/007-m4l-distribution.md).
- **vst** → `dist/Oedipa.dmg` — signed / notarized / stapled dmg
  built via `make release-vst`. Distribution is via the paid platform
  (out of band, not GitHub). See
  [ADR 009](../../../docs/ai/adr/archive/009-vst-distribution.md).

> **⚠️ vst paid pivot (2026-05-11).** vst does not publish to GitHub.
> No tag is created, no GH release is created, no asset is uploaded.
> `/release vst` ends locally: a signed/notarized/stapled
> `dist/Oedipa.dmg` + a CMakeLists VERSION bump committed to main + a
> drafted notes file for the paid platform's listing copy. Uploading the
> dmg to the paid platform happens out of band, outside this skill.
>
> Existing `vst-v0.1.0` / `v0.1.1` / `v0.1.2` tags remain in the repo as
> source history; their GH release entries (which previously carried the
> dmg) are already deleted. No new vst tags will be created going forward.
> m4l remains a free GitHub Releases distribution (tag + release + asset).

## Pre-flight checks (do these BEFORE the publish step)

Once a release ships (m4l: tag pushed + GH release; vst: dmg
uploaded to the paid platform), it is harder to undo cleanly. Run
all checks; STOP and ask the user if any fail.

### Check 1 — Working tree is clean

`git status --porcelain` must be empty. Uncommitted changes leak
into the release context. Halt if dirty.

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
ask. Don't ship distribution artifacts past a red gate — chasing
"probably just CI flake" has historically masked real regressions.

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

Also verify `vst/CMakeLists.txt`'s `project(Oedipa VERSION X.Y.Z)`
matches the version about to ship — the plist version the plugin
reports to the host (and the `v…` label drawn in the editor header)
is sourced from this line. If it doesn't match, bump first via the
Drafting Step 1.5 below; the dmg must be rebuilt after the bump so
the binary carries the right version.

Manual host smoke (Logic AU MIDI FX + Bitwig VST3 MIDI fx) is
recommended before handing the dmg off. The dmg's
`xcrun stapler validate` is a cheap final check:

```bash
xcrun stapler validate dist/Oedipa.dmg
```

## Drafting

After pre-flight passes:

### Step 1 — Determine next version

For **m4l**, parse the highest `m4l-v*` tag and bump per the second
$ARGUMENT (default `patch`):

```bash
git tag -l 'm4l-v*' | sort -V | tail -1
```

For **vst**, no tags are created anymore — the in-tree
`project(Oedipa VERSION X.Y.Z)` line in `vst/CMakeLists.txt` is the
authoritative previous version. Bump from there:

```bash
grep '^project(Oedipa VERSION' vst/CMakeLists.txt
```

If no prior version exists for this target, propose `m4l-v0.1.0` /
`0.1.0`.

Show the proposed version to the user and **confirm before
proceeding**. The user can override.

### Step 1.5 — Bump version metadata (vst only)

The plist version reported to the DAW and the `v…` label drawn in
the editor header both come from `project(Oedipa VERSION X.Y.Z)` at
the top of `vst/CMakeLists.txt`. If it doesn't already match the
version confirmed in Step 1, bump it now:

```bash
# In vst/CMakeLists.txt, line 2:
# project(Oedipa VERSION <old>) → project(Oedipa VERSION <new>)
```

Then commit the bump and push to main BEFORE rebuilding the dmg:

```bash
git add vst/CMakeLists.txt
git commit -m "chore(vst): bump version to X.Y.Z"
git push origin main
```

Re-run `make release-vst` so the dmg carries the bumped version,
then re-run Check 4 to confirm the dmg mtime is fresh.

For m4l this step is skipped — m4l version metadata isn't
in-tree (the freeze captures whatever is on disk).

### Step 2 — Draft release notes

Compute the previous-release boundary and generate the changelog
from the commit log between it and HEAD.

For **m4l**, the previous boundary is the highest `m4l-v*` tag:

```bash
PREV=$(git tag -l 'm4l-v*' | sort -V | tail -1)
git log "${PREV:-}"..HEAD --pretty=format:'- %s' -- m4l/
```

For **vst**, no tags exist going forward, so the boundary is the
most recent commit that bumped `vst/CMakeLists.txt`'s
`project(Oedipa VERSION …)` line:

```bash
PREV=$(git log -1 --pretty=format:%H --grep='bump version' -- vst/CMakeLists.txt)
git log "${PREV:-}"..HEAD --pretty=format:'- %s' -- vst/
```

If `$PREV` is empty (first release for this target), use the
project root as the lower bound.

Categorize commits by their `type:` prefix into sections:

- **Features** — `feat:`
- **Fixes** — `fix:`
- **Docs / housekeeping** — `docs:` / `chore:` / `style:` / `refactor:`
- **CI / build** — `ci:`

Drop the `Co-Authored-By` lines and trailing housekeeping noise.
Keep the section short — release notes are for users, not
contributors; detailed history is in `git log`.

For the very first release of a target, use a project-intro template
("What it does" / "Install" / "Requirements") instead of a changelog.

Write the draft to `/tmp/oedipa-<target>-vX.Y.Z-notes.md` and show
it to the user. **Wait for explicit "ok" or edit instructions**
before continuing.

Consumption:

- **m4l** — the file is fed to `gh release create --notes-file` in
  Step 3.
- **vst** — the file is the source copy for the paid-platform
  listing description. Paste it into the platform's release-notes
  field manually; this skill does no further GH-side work for vst.

### Step 3 — Tag, push, create release (m4l only)

For **vst**, skip this step entirely — see the paid-pivot block at
the top. vst's flow ends after Step 2 with the dmg + drafted notes
file in place locally; upload happens out of band.

```bash
TAG=m4l-vX.Y.Z
ASSET=dist/Oedipa.amxd
TITLE="Oedipa m4l vX.Y.Z"

git tag "$TAG"
git push origin "$TAG"
gh release create "$TAG" "$ASSET" \
  --title "$TITLE" \
  --notes-file "/tmp/oedipa-$TAG-notes.md"
```

### Step 4 — Verify (m4l only)

```bash
gh release view "$TAG" --json name,tagName,assets,url
```

Confirm:

- `assets[0].name` is `Oedipa.amxd`.
- `assets[0].size` > 0 and matches the local file's size.
- The release URL is reachable.

Show the release URL to the user.

### Step 5 — Cleanup

```bash
rm "/tmp/oedipa-<target>-vX.Y.Z-notes.md"
```

For vst, do this only after confirming the notes have been pasted
into the paid-platform listing.

## Rules

- **Asset is target-specific.** m4l → `dist/Oedipa.amxd` (frozen);
  vst → `dist/Oedipa.dmg` (signed/notarized/stapled). Never mix.
- **m4l publishes to GitHub; vst does not.** m4l tags `m4l-vX.Y.Z`,
  creates a GH release, attaches the `.amxd`. vst skips Step 3/4
  entirely — no tag, no GH release, no asset upload. vst's dmg is
  handed off to the paid platform out of band.
- **vst version source of record = CMakeLists.** Since vst has no
  tags going forward, `project(Oedipa VERSION X.Y.Z)` in
  `vst/CMakeLists.txt` is the single authoritative version. Bump it
  on every vst release (Step 1.5) and commit before building the
  dmg.
- **Manual Freeze required for m4l.** Max has no CLI freeze; this
  skill does not automate it.
- **`make release-vst` required for vst.** The dmg is built + signed
  + notarized + stapled by the script chain; this skill does not
  re-run it.
- **Tag once, never re-tag (m4l).** If an `m4l-v*` tag for the
  proposed version already exists, bump again rather than
  overwrite. Force-deleting a tag that was already pushed is messy
  and breaks anyone who pulled it.
- **Notes via `--notes-file`, not `--notes`** (m4l). The temp-file
  flow lets the user edit before publish. For vst the same file is
  the source copy for the paid-platform listing.
- **Halt on any pre-flight failure.** Don't release past a red
  gate.
- **Halt on any user-confirmation gate.** Steps 1 (version) and 2
  (notes) require explicit "ok" — don't proceed silently.
