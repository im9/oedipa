# npm Supply Chain Hardening

This document captures the supply chain defenses applied to this
repo's npm / pnpm dependency tree, and how to apply the same
pattern to a new vst-family repo.

All three im9 vst-family repos (pointsman, oedipa, stencil) share
this pattern, applied 2026-05-23. When adding a new repo, inherit
the whole pattern up-front — don't re-derive it, and don't omit
parts of it because Dependabot's initial burst feels noisy
(see "What to expect on first enable" below).

## Threat model

Shai-hulud / chalk-debug / event-stream class attacks: an attacker
publishes a malicious version of a real npm package (via
compromised maintainer creds, typosquat, or postinstall hijack)
and the community detects + retracts it within hours-to-days. The
defenses below delay our exposure to fresh versions and limit
blast radius from postinstall execution.

## What's in place

### `.tool-versions` (repo root)

Pins `pnpm 10.33.4` via asdf. pnpm 10 enforces
`pnpm.onlyBuiltDependencies` strictly by default — older pnpm
versions don't, so the pin is load-bearing for the postinstall
allowlist below.

### `m4l/.npmrc`

```
minimum-release-age=10080
```

7 days. During `pnpm install` resolution, pnpm refuses to pick
versions younger than this. Primary defense against fast-detect /
fast-retract attacks — by the time a fresh malicious release
passes 7 days, the community has had time to flag it.

Caveat: `minimum-release-age` only applies during *resolution*
(when pnpm decides which version to pin). Once a version is in
`pnpm-lock.yaml`, `pnpm install --frozen-lockfile` honors the
lockfile regardless of age. **Dependabot bypasses this defense**
by pinning the upgrade target in the lockfile directly; review
fresh Dependabot bumps with that in mind.

### `m4l/package.json`

```json
{
  "packageManager": "pnpm@10.33.4",
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild"]
  }
}
```

`packageManager` is honored by corepack and by
`pnpm/action-setup@v4+`. `onlyBuiltDependencies` is an allowlist
of packages whose postinstall scripts are permitted to execute.
Any package not on the list has its postinstall blocked silently
— this is the main defense, since postinstall is the primary
vehicle for supply chain code execution.

Why exactly `["esbuild"]`: esbuild's postinstall downloads a
platform binary. Without postinstall, the binary isn't fetched
and `pnpm bundle:host` fails. Other deps (typescript,
@types/node) don't have meaningful postinstall.

Platform-specific optional-dep families (`@esbuild/darwin-*`,
`@img/sharp-*`) don't need explicit listing — they ship pre-built
binaries via `optionalDependencies` and don't run postinstall.

When you add a new dep with a postinstall script, pnpm install
prints `Ignored build scripts: <name>`. Decide case-by-case
whether to allowlist; the default is "don't".

### `.github/workflows/test.yml`

```yaml
- uses: pnpm/action-setup@v6
  with:
    package_json_file: m4l/package.json
```

`package_json_file:` is critical. The action reads `packageManager`
from this file to choose which pnpm version to install. Without
the override, the action looks at **repo-root** `package.json`,
which doesn't exist in this layout (the workspace lives in
`m4l/`), and CI fails immediately:

```
Error: No pnpm version is specified.
```

`defaults.run.working-directory: m4l` does NOT fix this — it only
applies to `run:` steps, not `uses:` steps.

### `.github/dependabot.yml`

Weekly version-updates for:

- `package-ecosystem: "npm"` at `/m4l` — covers the pnpm
  workspace. `"npm"` is the correct ecosystem value for pnpm
  projects; Dependabot has no separate `"pnpm"` value
- `package-ecosystem: "github-actions"` at `/` — covers workflow
  action versions

No `groups:` configured. Dep count is small (~3 npm + 3 actions)
and grouping doesn't meaningfully reduce noise at that scale.
Revisit if dep count grows past ~10.

### `.github/SECURITY.md`

Points reporters at GitHub Private Vulnerability Reporting
(`/security/advisories/new`). PVR itself is enabled at the repo
level (see GitHub repo settings below).

### GitHub repo settings

Enabled via `gh api` (one-time, not visible in repo files):

```
gh api -X PUT /repos/im9/oedipa/vulnerability-alerts
gh api -X PUT /repos/im9/oedipa/automated-security-fixes
gh api -X PUT /repos/im9/oedipa/private-vulnerability-reporting
gh api -X PATCH /repos/im9/oedipa \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
```

## What to expect on first enable

The initial Dependabot scan opens ~5–6 PRs at once for major
version bumps of every dep that has a newer release than the
lockfile-pinned version. For this repo's stack, that's typically:

- esbuild major (e.g. 0.24 → 0.28)
- typescript major (e.g. 5 → 6)
- GitHub Actions v4 → v6 across checkout, setup-node,
  pnpm/action-setup

All land green on CI because the npm deps are dev-only and the
shipped artifact (`.amxd`) is bit-identical after bake. After
processing this initial burst, subsequent weeks are quieter —
typically 0–2 PRs per week.

If duplicate PRs appear for the same dep (e.g. two esbuild PRs
to different target versions because new releases shipped during
the burst), close the older one — Dependabot will not auto-rebase
it once another PR supersedes it.

## How to apply to a new repo

1. Add `.tool-versions` at repo root: `pnpm 10.33.4`
2. Add `<workspace>/.npmrc`: `minimum-release-age=10080`
3. Update `<workspace>/package.json`:
   - `"packageManager": "pnpm@10.33.4"`
   - `"pnpm": { "onlyBuiltDependencies": ["esbuild"] }`
     (adjust allowlist after a clean `pnpm install` if other
     postinstall users surface as `Ignored build scripts` warnings)
4. In every CI workflow that uses pnpm, pass
   `with: package_json_file: <workspace>/package.json` to
   `pnpm/action-setup`
5. Add `.github/dependabot.yml` with `npm` (workspace dir) and
   `github-actions` (`/`), both weekly
6. Add `.github/SECURITY.md` pointing to the repo's PVR form
7. Enable repo settings via `gh api` (see above)
8. Push. Expect a ~5–6 PR Dependabot burst; process it in one
   sitting (close duplicates first, then merge the rest)

## Common mistakes (recorded so we don't re-debug)

- Forgetting `package_json_file:` on `pnpm/action-setup` → CI
  fails with "No pnpm version is specified"
- Using `package-ecosystem: "pnpm"` in dependabot.yml → that
  ecosystem name doesn't exist; use `"npm"` for pnpm projects too
- Setting `onlyBuiltDependencies: []` (empty) on pnpm 10 → most
  things still work because esbuild has platform-optional-dep
  fallbacks, but explicit auditability is lost. Always list at
  least `["esbuild"]`
- Treating `minimum-release-age` as protection against Dependabot
  bumps → it isn't. The .npmrc setting gates resolution, not
  lockfile-pinned installs. Review Dependabot bumps manually if
  the target version is fresh
