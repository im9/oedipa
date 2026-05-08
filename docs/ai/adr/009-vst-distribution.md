# ADR 009: VST Distribution — Signing, Notarization, and Release Flow

## Status: Proposed

**Created**: 2026-05-08
**Revised**: 2026-05-08 — Phase 5 scope expanded to cover broader
Makefile reorganization (root + `vst/Makefile` target-name overlap
and per-file responsibility), beyond just adding `release-vst`.

## Context

Oedipa is labelled `im9 / Free distribution` (CLAUDE.md). The product
exists to be played by people other than the author; until that path
works, the musical experience stops at one machine. ADR 007 closed
that gap for the m4l target on 2026-05-01. The vst/ subsystem shipped
to `main` on 2026-05-08 (PR #1, `8c00803`) but currently has no
distribution story: AU and VST3 bundles exist only in
`vst/build/Oedipa_artefacts/Release/` on the author's laptop and in
`~/Library/Audio/Plug-Ins/{Components,VST3}` (where JUCE's
`COPY_PLUGIN_AFTER_BUILD TRUE` deposits them on every build).

A macOS user cannot today download Oedipa, drag two files into their
plug-ins folders, and have Logic Pro or Cubase Pro load them. The
musical experience for vst/ is therefore single-machine, exactly the
condition ADR 007 was written to remove for m4l.

ADR 008 §Distribution explicitly deferred this work: "Distribution
path (signing / notarization / `dist/` artefacts) deferred to a parallel
ADR." This ADR is that parallel.

The shape of macOS plug-in distribution is also non-trivial. macOS
Catalina (10.15) and later add the `com.apple.quarantine` extended
attribute to anything downloaded via a browser. Gatekeeper then refuses
to load unsigned, un-notarized binaries from quarantined locations, and
the failure mode in Logic / Cubase is silent — the host scans, drops
the bundle, and the user sees a missing plug-in with no diagnostic.
Free indie plug-ins routinely ship with a "right-click → Open" or
`xattr -d com.apple.quarantine` workaround, but this surfaces friction
to musicians who are not also command-line users. The author holds
an Apple Developer Program membership; using it is the lowest-friction
path.

## Decision

Six coupled changes that together produce a downloadable, drag-installable
`.dmg` for AU + VST3 on macOS, plus the CI and documentation surface to
keep that artefact reproducible.

### 1. Code signing with Developer ID Application

AU (`Oedipa.component`) and VST3 (`Oedipa.vst3`) bundles are signed
with the author's `Developer ID Application` certificate. Hardened
runtime is enabled — required for notarization. Plug-in bundles need
the `com.apple.security.cs.disable-library-validation` entitlement so
arbitrary hosts (Logic / Cubase / Bitwig) can load the bundle without
their own signature satisfying library validation. No JIT or
`allow-unsigned-executable-memory` entitlement is needed; Oedipa has
no runtime code generation.

Mechanism: post-build `codesign` invocation rather than JUCE's
`juce_add_plugin` signing parameters. Post-build keeps the cert and
entitlements out of `CMakeLists.txt` (no per-machine config in source)
and matches how indie JUCE plug-ins typically handle signing in CI-
adjacent contexts. The exact `codesign` command line is fixed in
Phase 2 — `--options runtime --entitlements entitlements.plist
--sign "Developer ID Application: <name> (<team-id>)"` — but the cert
selector and team ID stay outside the repo (Phase 2 reads them from
environment variables or `make` overrides; release-tag CI reads them
from GitHub Actions secrets).

### 2. Notarization with `xcrun notarytool`

After signing, each bundle is submitted to Apple's notarization
service. The submission produces a notarization ticket if Apple's
malware scan and signing checks pass. Submission uses **app-specific
password** authentication (Apple ID + a password generated at
appleid.apple.com, scoped to notarization). Local use stores the
credential in the macOS Keychain via
`xcrun notarytool store-credentials`; the named profile is then read
non-interactively on every release.

API-key authentication (App Store Connect `.p8` private key + key ID +
issuer ID) is the alternative path. It is the right choice when CI
needs to notarize without 2FA prompts. v1 ships with the local
manual flow only; the GitHub Actions release-tag workflow uses
secrets-driven API-key auth (Phase 8). Both paths use `notarytool`;
`altool` is deprecated and not used.

### 3. Stapling

`xcrun stapler staple` writes the notarization ticket into each
bundle. Stapled bundles validate offline — Gatekeeper does not need
network access to confirm notarization status, which matters for
musicians installing on machines that are routinely offline (live
rigs, studio machines on isolated networks). The `.dmg` itself is
also stapled so that mounting and running the installer works
offline as well.

### 4. `.dmg` drag-install packaging

The distributable artefact is a single `.dmg` file. Its contents:

- `Oedipa.component` — AU bundle
- `Oedipa.vst3` — VST3 bundle
- `INSTALL.txt` — short, plain text. Drag instructions, `~/Library`
  path locations, one note about Gatekeeper / quarantine for users
  who download via something other than a browser-aware tool.

Optional cosmetic elements (background image, layout positions, custom
icon) are deferred to a follow-up — they are visual polish, not
distribution mechanics, and the `.dmg` is functional without them.

The `.dmg` is built with `create-dmg` (Homebrew, scripted, reproducible)
or `hdiutil` directly (no extra dependency). Phase 4 picks one based
on actual layout requirements; the simpler tool wins.

The `.dmg` is signed and notarized as a unit. Stapling the `.dmg`
plus the bundles inside it is intentional belt-and-braces: end users
who unzip the `.dmg` and copy the bundles never end up with
unstapled plug-ins, regardless of how they extracted them.

### 5. `dist/` placement and Makefile orchestration

Output layout — both targets coexist under the existing root `dist/`
(already gitignored):

```
dist/
├── Oedipa.amxd       # m4l, frozen Max device (ADR 007)
├── Oedipa.dmg        # vst/, signed + notarized + stapled .dmg
└── (intermediate artefacts not committed)
```

Root `Makefile` is positioned as a **cross-target distribution
orchestrator**, not an m4l-specific entry point. New targets:

- `make release-vst` — build + sign + notarize + staple + dmg, output
  to `dist/Oedipa.dmg`. Reads `DEVELOPER_ID`, `TEAM_ID`, and
  `NOTARYTOOL_PROFILE` from the environment (or `make` overrides);
  fails fast with a readable error if any are missing.
- `make release` (existing) — depends on both `release-m4l` and
  `release-vst`. m4l still requires the manual freeze step; vst/ is
  fully automated. Running `make release` produces both artefacts
  where automation allows and prints the m4l freeze instructions
  unchanged.

The vst/ release flow is fully automatable end-to-end (no Max-style
manual freeze); the m4l freeze instruction echo from ADR 007 stays
the only manual step in the combined `release` target.

### 6. CI on macOS GitHub-hosted runners

The repo is public (`im9/oedipa`); GitHub Actions runners — including
`macos-latest` — are billed at zero cost for public repositories. The
10× macOS multiplier applies only to private repos, and "free tier" /
"included minutes" caps are not enforced on public repos at all.

Two workflows:

- **`vst-test.yml`** — runs on push and pull-request events that
  modify `vst/**` paths. Runner: `macos-latest`. Steps: checkout
  with `submodules: recursive` (JUCE is a submodule),
  `cd vst && make test`. This catches breakage in the C++ engine,
  plugin core, and editor logic that the existing m4l ubuntu workflow
  cannot exercise.
- **`vst-release.yml`** — runs on `release: published` (or tag
  push matching `v*`). Runner: `macos-latest`. Steps: checkout, full
  build, sign with cert from `MACOS_CERT` / `MACOS_CERT_PASSWORD`
  secrets imported into a temporary keychain, notarize with API-key
  auth (`APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER_ID`
  secrets), staple, build `.dmg`, attach to the GitHub Release.
  v1 may run this manually rather than wiring secrets — see Phase 8.

The existing `test.yml` m4l job stays unchanged. Splitting into two
files (rather than adding a `vst` job inside `test.yml`) keeps the
release-tag workflow's trigger condition isolated from per-push runs.

### 7. README en/ja split

`README.md` becomes the English entry point and is restructured so
that **Install** comes before **Build** — most visitors are users,
not contributors. New `Install` section covers:

- Download `Oedipa.dmg` from the latest GitHub Release
- Mount, drag `Oedipa.component` to `~/Library/Audio/Plug-Ins/Components/`,
  drag `Oedipa.vst3` to `~/Library/Audio/Plug-Ins/VST3/`
- First-run Gatekeeper note (no warning expected for signed +
  notarized + stapled bundles, but a fallback `xattr -d` line for
  edge cases like AirDrop transfers that strip notarization)
- Per-host load location: Logic AU MIDI FX slot, Cubase Instrument
  track with MIDI-out routing (per ADR 008)

`README.ja.md` mirrors the structure in Japanese. Both files cross-link
at the top (`English | 日本語`). All other docs (`docs/ai/`) remain
English-only per the global CLAUDE.md convention; only the entry-point
README is bilingual because it is the user-facing document.

The current README's m4l-released / vst-beta status table is updated
to reflect vst/ Released alongside m4l/.

### Why not other approaches

- **Skip signing, ship unsigned `.dmg` + Gatekeeper bypass README**.
  Would work — many indie plug-ins do this — but pushes friction onto
  musicians who didn't sign up to learn `xattr`. The author already
  holds the Developer ID, so the cost of doing this properly is one
  weekend of CMake / shell wiring; not doing it would be a deliberate
  downgrade of user experience for no upside.
- **Mac App Store distribution**. MAS sandboxing forbids writing to
  `~/Library/Audio/Plug-Ins/`, which is the entire mechanism by which
  AU and VST3 plug-ins install. Plug-ins are categorically not
  distributable through MAS. Direct distribution is the only path.
- **`.pkg` installer instead of `.dmg`**. `.pkg` requires admin
  authentication for system-location installs and is opaque to the
  user (no visible "I dragged this here" mental model). Free / indie
  plug-ins overwhelmingly use `.dmg`; matching that convention reduces
  cognitive load for musicians familiar with the format. `.pkg`
  remains a future option if user-side `~/Library` install proves
  fragile.
- **Plain `.zip`**. Quarantine handling for `.zip` is more fragile
  than `.dmg` (Safari un-quarantines `.dmg` after Gatekeeper check
  but propagates quarantine into individual files extracted from
  `.zip`). `.dmg` is the macOS-native format for software distribution.
- **Auto-update mechanism (Sparkle, EddyVR-style)**. Adds an upstream
  surface for the plug-in to phone home and a maintenance burden.
  Releases are infrequent (per-feature, not per-bug); manual
  re-download is acceptable for v1. Revisit if release cadence
  increases.

## Security

This ADR signs binaries that ship to musicians under the `im9` name.
The signing surface includes secrets that, if leaked, would let
attackers sign their own binaries as `im9` (cert leak) or submit
notarization requests as the author (notarytool credential leak). The
repo is public, so secret-leak prevention is a first-class concern of
the design — not an afterthought.

### Public by design (visible in any signed bundle)

These values are intentionally exposed and hiding them would defeat
the verification step Gatekeeper performs:

- Team ID (10-character Apple developer team identifier)
- Developer Name (cert's Common Name, e.g. `Developer ID Application:
  <name> (<team-id>)`)
- Bundle ID (`com.im9.oedipa`, already in `vst/CMakeLists.txt`)

`codesign -dvv Oedipa.component` on any released artefact prints
these. Recording them in the repo or in release notes adds nothing
to the public surface.

### Private — never enter the repo

| Credential | Use | Storage |
|------------|-----|---------|
| `Developer ID Application` `.p12` + password | Code signing | macOS Keychain (local); GitHub Secrets `MACOS_CERT` (base64 `.p12`) + `MACOS_CERT_PASSWORD` (CI) |
| App-specific password | Local `notarytool` auth | macOS Keychain via `xcrun notarytool store-credentials <profile>` |
| App Store Connect API key (`.p8`) + Key ID + Issuer ID | CI `notarytool` auth | GitHub Secrets `APPLE_API_KEY` (base64 `.p8`) + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER_ID` |

Scripts and workflow files reference these by **name only** (Keychain
profile name, GitHub secret name) — values never appear in the repo
or in workflow logs.

### GitHub Actions secret protection on a public repo

Three guarantees from GitHub Actions matter here:

1. **Encrypted at rest** with libsodium sealed boxes; decrypted only
   on the runner at workflow start.
2. **Auto-redacted from logs**: any string matching a secret value is
   replaced with `***` in workflow output, including stderr.
3. **Withheld from fork PRs**: workflows triggered by pull requests
   from forks receive empty values for `secrets.*`. A third party who
   forks the repo, modifies a workflow, and opens a PR cannot
   exfiltrate secrets — the workflow run never receives them.

Guarantee 3 is the load-bearing one for public repos. Without it,
public-repo signing would be infeasible; with it, the standard
indie-plugin pattern (Surge, Vital, U-he free, etc.) is safe.

### Workflow split as defence in depth

Two workflow files (per §Decision 6) isolate the signing surface:

- `vst-test.yml` — push + PR triggers (including forks). Runs only
  `make test`. **No secret access, no signing path.** A malicious PR
  modifying this file can only break tests.
- `vst-release.yml` — `release: published` trigger only. Forks
  cannot publish releases on the upstream repo, so this workflow
  cannot be triggered by a third party. Has secret access; signs
  and notarizes.

The split means workflow-injection via PR has no path to release-time
secrets even before fork-PR isolation kicks in.

### Script discipline

Signing scripts under `vst/scripts/` (Phases 2–4) follow basic hygiene:

- No `set -x`. Errors print short messages, not env-var dumps. Failure
  to find `DEVELOPER_ID` prints `error: DEVELOPER_ID env var not set`,
  not the contents of `env`.
- No interactive prompts that read secrets into shell variables.
  `notarytool store-credentials` writes directly to the Keychain;
  scripts read via the profile name (`xcrun notarytool submit
  --keychain-profile <name>`).

### `.gitignore` additions

Cert and key extensions are added to `.gitignore` so an accidental
`git add .` cannot stage them, and so `git status` flags any stray
file with these extensions:

```
*.p12       # Developer ID cert export
*.p8        # App Store Connect API key
*.cer       # certificate
*.mobileprovision
*.keychain
```

GitHub's secret scanning catches a committed `.p12` post-push and
emails the maintainer, but the `.gitignore` entry prevents it from
ever entering the staging area in the first place.

### Rotation if a credential is suspected leaked

- `.p12` cert: revoke in the Apple Developer portal; re-issue a
  fresh cert; re-sign any artefact that needs to remain trusted.
  Apple invalidates the old signature globally within propagation
  time, so all previously-signed releases will start failing
  Gatekeeper.
- App-specific password: revoke at appleid.apple.com; generate a
  fresh one; re-run `xcrun notarytool store-credentials`.
- API key (`.p8`): revoke in App Store Connect; generate a fresh
  key; update GitHub Actions secrets.

Notarization tickets stapled to historical releases remain valid
unless the underlying cert is rotated; cert rotation invalidates
them globally.

## Persistence

No state changes. This is a build / distribution / CI decision.

## UI

No editor UI changes. The user-visible artefacts of this ADR are the
`Oedipa.dmg` filesystem layout (Phase 4), `INSTALL.txt` content
(Phase 4), and the README install instructions (Phase 6). The
`INSTALL.txt` is short enough (~15 lines target) that it is reviewed
manually; no automated layout test.

## Scope

**In scope**

- Developer ID Application code signing for `Oedipa.component` and
  `Oedipa.vst3` with hardened runtime + plug-in entitlement
- Notarization via `xcrun notarytool` (app-specific password local,
  API key for CI release workflow)
- Stapling of bundles and `.dmg`
- `Oedipa.dmg` drag-install artefact under `dist/`
- Root `Makefile` `release-vst` target and `release` reorganization
- `vst-test.yml` macOS CI workflow on push / PR touching `vst/**`
- `vst-release.yml` macOS CI workflow on release tag (build + sign +
  notarize + dmg)
- `README.md` restructured + `README.ja.md` Japanese mirror
- First GitHub Release tag (v0.1.0 or similar) attaching the `.dmg`

**Out of scope**

- iOS distribution. The `app/` target has its own packaging story
  (App Store / TestFlight / sideload), which is a fundamentally
  different surface from a macOS plug-in `.dmg`. Separate ADR when
  `app/` exists.
- Windows / Linux distribution. ADR 008 deferred non-macOS targets;
  the primary plug-in hosts in scope (Logic, Cubase, Bitwig, Reaper,
  Studio One) all have macOS counterparts that already host Oedipa.
  Reach onto Windows is a future scope expansion, not a v1 omission.
- Mac App Store distribution. Sandbox model is incompatible with
  audio plug-in install paths (see §"Why not other approaches").
- Standalone `.app` distribution. ADR 008 maintains "Standalone is
  dev convenience only"; not packaged in `.dmg`. Users who want a
  standalone Tonnetz exploration tool are the iOS or future
  standalone-suite audience, not the v1 plug-in audience.
- Auto-update mechanism. Manual re-download for v1.
- Cosmetic `.dmg` styling (background image, custom icon, layout
  coordinates). Functional `.dmg` ships first; styling is a follow-up.
- Code signing identity / cert / API-key management as a documented
  process. Out-of-band (Keychain on author's machine, GitHub Actions
  secrets for CI). The ADR records *which* credentials are used, not
  how to provision or rotate them.

## Implementation checklist

Phased per CLAUDE.md TDD gates (tests / verification first, then
implementation, then build / verify). Most phases here ship shell
glue, not Catch2 unit tests; the "test" gate is a CLI verification
command (`codesign --verify`, `spctl --assess`, `xcrun stapler
validate`, `hdiutil verify`) baked into the release script so the
pipeline fails loudly when any step regresses.

### Phase 1 — macOS-runner CI for vst/ test

- [ ] Add `.github/workflows/vst-test.yml` with `runs-on:
  macos-latest`, `submodules: recursive` checkout, `paths:` filter
  on `vst/**` and the workflow file itself, run `cd vst && make
  test`.
- [ ] First push of the workflow file is itself the verification:
  workflow runs green on `macos-latest`, all 1682 Catch2 assertions
  pass on the runner (matches local `make test`).
- [ ] No change to `test.yml` (m4l ubuntu job stays as-is).

### Phase 2 — Local sign + hardened runtime

- [ ] Add cert / key extensions to `.gitignore`: `*.p12`, `*.p8`,
  `*.cer`, `*.mobileprovision`, `*.keychain` (per §Security). Done
  before any cert handling so the patterns are in place from the
  first signing experiment.
- [ ] Author `vst/scripts/codesign.sh` (or inline in root `Makefile`,
  whichever is shorter for two bundles). Reads `DEVELOPER_ID` env
  var; signs `vst/build/Oedipa_artefacts/Release/AU/Oedipa.component`
  and `.../VST3/Oedipa.vst3` with `--options runtime --entitlements
  vst/scripts/entitlements.plist`. No `set -x`, no env-var dumps on
  error (per §Security script discipline).
- [ ] Author `vst/scripts/entitlements.plist` containing only
  `com.apple.security.cs.disable-library-validation` (true).
- [ ] Verification gate: `codesign --verify --deep --strict
  --verbose=2` on each bundle returns 0; `spctl --assess --type
  install` returns 0 (Gatekeeper accepts the locally-signed bundle
  before notarization — pre-flight only, not the final state).
- [ ] Document the env var contract in a header comment in the
  script and in `README.md` §Building from source.

### Phase 3 — Notarize + staple

- [ ] Author `vst/scripts/notarize.sh`. For each bundle: zip into a
  notarization-friendly archive (notarytool requires `.zip`,
  `.pkg`, or `.dmg`); submit with `xcrun notarytool submit --wait
  --keychain-profile <profile>`; on success run `xcrun stapler
  staple` against the original bundle (not the zip).
- [ ] Author one-time setup instructions for `xcrun notarytool
  store-credentials <profile> --apple-id <id> --team-id <team>
  --password <app-specific>`. Lives in `README.md` §Building from
  source (developer-only section).
- [ ] Verification gate: `xcrun stapler validate` returns 0 on each
  bundle; `spctl --assess --type install` returns 0 with
  `--verbose=4` reporting `accepted, source=Notarized Developer
  ID`.

### Phase 4 — `.dmg` assembly

- [ ] Pick `create-dmg` (Homebrew) or `hdiutil` based on whether a
  custom layout is wanted in v1. Default expectation: `hdiutil`
  produces a functional `.dmg` with no extra dependency; pick that
  unless layout proves too clunky.
- [ ] Author `vst/scripts/build-dmg.sh`: stage `Oedipa.component`,
  `Oedipa.vst3`, `INSTALL.txt` into a temp dir; build a read-only
  compressed `.dmg`; sign and notarize the `.dmg` itself; staple
  the `.dmg`.
- [ ] Author `vst/scripts/INSTALL.txt` content (~15 lines): drag
  instructions for `~/Library/Audio/Plug-Ins/{Components,VST3}`,
  Logic / Cubase host notes, license line.
- [ ] Verification gate: `hdiutil verify dist/Oedipa.dmg` returns
  0; `spctl --assess --type open --context context:primary-signature`
  returns 0; mounting the `.dmg`, copying both bundles to
  `~/Library/Audio/Plug-Ins/...`, and launching Logic confirms the
  AU loads without a Gatekeeper dialog.

### Phase 5 — Root Makefile `release-vst` + reorganize `release`

- [ ] Add `release-vst` target chaining `cd vst && make build` →
  Phase 2 codesign script → Phase 3 notarize script → Phase 4
  build-dmg script. Output: `dist/Oedipa.dmg`. Reads required env
  vars, errors with a one-line "missing DEVELOPER_ID" message if
  unset.
- [ ] Modify `release` to depend on `release-m4l release-vst`. m4l
  freeze instructions still echo at the end (unchanged from ADR
  007); vst/ build runs fully automated.
- [ ] Resolve Makefile naming overlap and per-file responsibility:
  root `Makefile` and `vst/Makefile` both define `release` with
  different semantics today (root chains across targets,
  `vst/Makefile`'s is a cmake-build internal step). Rename /
  consolidate so root is unambiguous as cross-target orchestrator
  and `vst/Makefile` covers vst-only build commands only. Specific
  target renames settled during the reorg work, not pre-locked here.
- [ ] Verification gate: `make release-vst` on a clean working
  tree produces `dist/Oedipa.dmg` whose `xcrun stapler validate`
  passes and whose mounted contents open in Logic Pro and Cubase
  Pro without any Gatekeeper dialog. Also: `make test` and
  `cd vst && make test` both still work after the Makefile reorg
  (no broken target chains).

### Phase 6 — README en/ja split + restructure

- [ ] Restructure `README.md` so `## Install` precedes `## Build`.
  Add §Install with download / drag-install / Logic / Cubase setup.
  Add §Distribution covering the `make release-vst` flow (developer-
  facing, references this ADR).
- [ ] Update §Status and §Targets table: vst/ AU and VST3 → Released.
- [ ] Author `README.ja.md` mirroring the structure in Japanese.
  Both files cross-link at the top.
- [ ] Verification gate: link checker (manual or `markdown-link-check`)
  confirms all internal links resolve in both files, including the
  ADR cross-reference path conventions (this ADR moves to
  `archive/009-...` once Implemented; READMEs reference both forms
  acceptably or update at archive time).

### Phase 7 — Manual cross-machine smoke

- [ ] Mount `dist/Oedipa.dmg` on the author's machine; copy
  `.component` and `.vst3` to `~/Library/Audio/Plug-Ins/...`. Verify
  Logic Pro loads the AU MIDI FX, Cubase Pro loads the VST3
  Instrument, Bitwig loads either format. No Gatekeeper warning, no
  AU validation failure.
- [ ] If a second machine is available (clean macOS user account or
  fresh user partition), repeat the install. Confirms the "Free
  distribution" mandate end-to-end: an arbitrary macOS user
  receiving the `.dmg` from a download URL successfully installs
  and plays.
- [ ] Document any host-specific issues observed (e.g., AU
  validation cache requiring a clear) in §Install troubleshooting.

### Phase 8 — First GitHub Release

- [ ] `gh release create v0.1.0` (or appropriate version) with
  `dist/Oedipa.dmg` and `dist/Oedipa.amxd` attached. Release notes
  describe v1 vst/ AU + VST3 alongside the existing m4l device.
- [ ] Wire `vst-release.yml` GitHub Actions workflow for future
  releases:
  - Trigger on `release: published` events.
  - Import `MACOS_CERT` (base64'd `.p12`) + `MACOS_CERT_PASSWORD`
    secrets into a temporary keychain on the runner.
  - Use API-key auth (`APPLE_API_KEY` / `APPLE_API_KEY_ID` /
    `APPLE_API_ISSUER_ID` secrets) for notarization — no 2FA in CI.
  - Build, sign, notarize, staple, dmg, attach to the in-flight
    Release via `gh release upload`.
- [ ] Verification: a subsequent tag push triggers the workflow and
  produces an attachment matching the manual artefact's hash modulo
  notarization timestamp differences. (v1 may skip CI wiring if
  manual release is acceptable; the secrets configuration is
  in-scope but its activation is at the author's discretion.)

## Per-target notes

**vst/ only.** No engine API changes; the shared
[docs/ai/tonnetz-test-vectors.json](../tonnetz-test-vectors.json) is
not touched. ADR 008 (vst/ stack and scope) is unaffected — its
build-output, plug-in metadata, and host-disguise decisions stay as
recorded; this ADR records the post-build distribution flow that
ADR 008 deferred.

**m4l unaffected.** ADR 007's `make release-m4l` flow is reused
verbatim. Root `release` target gains a vst/ leg but does not change
the m4l leg.

**app/ (iOS, future).** When the iOS target exists, its
distribution story (App Store / TestFlight / AUv3 host integration)
is a separate ADR. None of the macOS-specific decisions here
(Developer ID Application, hardened runtime entitlements, `.dmg`,
Gatekeeper) carry over.

## Notes for future ADRs

- If vst/ later targets Windows or Linux, a separate ADR captures
  the per-OS signing / packaging story (Windows: Authenticode +
  `.exe` or `.msi`; Linux: tarball + per-distro packaging).
- Auto-update is deliberately deferred. If release cadence
  accelerates beyond a couple of releases per year, revisit with
  Sparkle or a comparable framework.
- `.dmg` cosmetic styling (background, layout) is a follow-up
  improvement, not a separate ADR — it amends Phase 4 of this ADR
  in place.
