# ADR 011: Oedipa v1.0

## Status: Proposed

**Created**: 2026-05-21

## Context

v0.1.x has shipped on both targets (m4l-v0.1.1 + vst-v0.1.2). The next bar
is v1.0 — not merely feature accretion, but a coherent "playable
instrument with a point of view" that earns the major-version label.

Four substantive directions emerged during the v1.0 brainstorming on
2026-05-21:

1. **m4l ↔ vst interaction parity** — vst already supports tap / drag-to-
   sequence / long-press-anchor on the lattice (per ADR 008 Phase 4); m4l
   is stuck at tap-only by device-strip width constraint (per ADR 003).
   This is m4l's most visible UI gap.
2. **Harmonic vocabulary expansion** — current engine handles only major /
   minor triads with an optional maj7 / min7 layer (per ADR 001). 9/11/13
   extensions and aug / dim base modes are explicitly deferred.
3. **Rhythm engine generalization** — current rhythm layer ships 5 inboil-
   aligned presets (per ADR 006 §Phase 7). Generalization to a Euclidean
   `(length, beats, rotation)` parameterization opens significantly more
   musical territory at low UI cost.
4. **O&C-inspired chord-navigation vocabulary** — Oedipa already cites
   Automatonnetz as an ancestor. A focused inventory of Hemisphere Suite
   applets (Harrington 1200, Automatonnetz, AnnularFusion) surfaced several
   vocabulary additions that sharpen the Tonnetz POV without diluting it
   into "generic chord generator" territory.

Independent of these four, a cross-plugin prerequisite blocks declaring
v1.0: the visual identity across the im9 vst lineup (Oedipa / stencil /
pointsman) is currently inconsistent and subtly unrefined ("微妙にダサい"
in the source discussion). This must resolve before a major version ships.
m4l plugins are naturally consistent enough via jsui idioms; the
prerequisite is vst-only.

## Decision

### Roadmap — four phases

- **Phase 0 — im9 vst aesthetic direction.** Cross-plugin prerequisite,
  lives outside this repo. Defines the visual direction (palette,
  typography, control geometry, layout idioms) for all im9 vst plugins.
  Form and repo location are open (see Open Questions §1).
- **Phase 1 — Oedipa v1.0 spec.** This ADR. Lock the scope below; resolve
  the Open Questions one by one.
- **Phase 2 — Implementation.** Order:
  1. Engine extensions + ADR 001 amendment (cross-target)
  2. m4l separate-window UI (parity unlock)
  3. UI rebuild on both targets applying Phase 0 direction
  4. Per-cell / steering vocabulary
  5. Euclidean rhythm
  6. Cross-target parity sweep
- **Phase 3 — Release.** Manual host smoke (Logic + Bitwig for vst; Live
  for m4l), demo content, then `vst-v1.0.0` + `m4l-v1.0.0` ship via the
  existing distribution paths (Polar for vst, GitHub Release for the vst
  tag, maxforlive for m4l).

Phase 0 must substantially settle before Phase 2 step 3 (UI rebuild).
Phase 2 step 1 (engine work) can run in parallel with Phase 0.

### Scope — engine and walk vocabulary

Each item is additive. Existing m4l + vst behavior is preserved; new
vocabulary defaults to off / neutral unless noted otherwise.

#### ADR 001 amendment territory

- **N / S / H named compound transforms.** Three additional neo-Riemannian
  operators with distinct musical identity: Nebenverwandt (= RLP), Slide
  (= LPR), Hexatonic pole (= LPL). Each is a single named operator
  occupying one cell slot, **not** generic operator concatenation. Source:
  Hemisphere Suite `tonnetz/tonnetz.h`. Distinct from the generic compound
  ops (PL / PR / LR / PLR) deferred per ADR 008, which remain deferred.
- **Augmented / diminished base triad modes.** Extends the Tonnetz beyond
  the major / minor cycle into hexatonic and octatonic regions. Engine
  `Quality` widens from `major | minor` to
  `major | minor | augmented | diminished`. Existing P / L / R (and the
  new N / S / H) semantics extend accordingly. Source: O&C extended
  firmware wiki.
- **Inversion control.** Global integer `0..2` (root / 1st / 2nd
  inversion). Orthogonal to existing voicing (`close | spread | drop2`):
  voicing = shape, inversion = which chord note is lowest. Source:
  Harrington 1200.
- **9th / 11th / 13th extensions** — see Open Questions §2.

#### Per-cell / steering layer

- **Per-cell offset.** Per-cell signed semitone offset added to all
  emitted notes for that cell. Lives in the existing per-cell expression
  record (`velocity / gate / probability / timing`) without restructuring.
  Source: Automatonnetz `Offs`.
- **Cell-leave mutation.** Opt-in self-modifying cell program: on cell
  exit, with probability `m`, the cell's op (and possibly other fields —
  TBD during Phase 2) is rewritten in place. Distinct from existing
  `jitter`, which substitutes the op at step-time without mutating the
  program. Closer to the live-modulation philosophy Oedipa already cites
  via Automatonnetz. Source: Automatonnetz `Muta`.

#### Rhythm

- **Euclidean rhythm parameterization.** `(length, beats, rotation)`
  generalization for the rhythm gating layer. Generalizes the current 5
  inboil-aligned presets (`all / legato / onbeat / offbeat / syncopated`).
  Coexistence vs. replacement open — see Open Questions §5. Source: HEM
  AnnularFusion.

### Scope — UI and interaction

- **m4l separate-window UI.** m4l currently exposes only
  `tap = set startChord` on the lattice (per ADR 003, by design, given
  device-strip width). vst supports `tap / drag-to-sequence /
  long-press-anchor` (per ADR 008 Phase 4). v1.0 lifts m4l's lattice into
  a separate floating window so the full vst interaction surface (drag,
  long-press, anchors) becomes available on m4l. This is the first time
  m4l ↔ vst will be at interaction parity. Mechanism: `[thispatcher]`
  floating window with explicit open / close affordance; state persistence
  follows the existing hidden `live.numbox` pattern (pattr is unreliable
  in this M4L environment, per ADR 003 Phase 5).
- **UI visual rebuild — both targets.** Apply Phase 0 aesthetic direction
  to both vst (`Source/Editor/Theme.{h,cpp}` + views) and m4l (jsui
  renderers). Pixel-level details (exact hex values, font choice,
  animation timings) deferred to implementation iteration; what this ADR
  locks in is that the direction is applied across both targets, not the
  exact pixels.

### Out of scope (explicit)

- **iOS / `app/` target start.** Separate ADR; deferred until after v1.0
  ships. The engine extensions made now should be JUCE-free (per ADR 008
  `Source/Engine/` discipline) so iOS reuse remains the eventual target.
- **Windows support.** Deferred per `project_vst_windows_support_deferred`
  rationale (signing infra + test cost not justified pre-revenue).
- **Standalone polish as user-facing artefact.** Remains dev-convenience
  only per ADR 008.
- **3D Tonnetz geometry.** Extensions (7/9/11/13) stay 2D + note-append
  semantics, not a lattice-geometry change. Re-evaluate post-v1.0 if
  augmented / diminished modes expose a real need for 3D embedding.
- **Internal synth / sample player.** Identity-forbidden per ADR 008.
- **Plugin hosting.** Identity-forbidden per ADR 008.
- **Cross-plugin (stencil / pointsman) feature work.** The O&C inventory
  was filtered to Oedipa-fit only; non-fit items intentionally not
  tracked. Sister-plugin work happens in each plugin's own next major
  version, independently.
- **Generic compound ops** (PL / PR / LR / PLR concatenation, distinct
  from N / S / H above). Remains deferred per ADR 008.

## Open Questions

1. **Phase 0 repo location and form.** New `im9-design` repo vs.
   subdirectory in an existing repo; minimum form (tokens JSON + docs
   Markdown + mockups PNG) is agreed; whether shared code (`theme.js` /
   `Theme.h`) is generated from tokens or hand-mirrored across stacks is
   open. Stack split (vst-design separate from m4l-design) is agreed.
2. **9 / 11 / 13 extensions in v1.0?** ADR 001 amendment required; both
   targets need engine + voicing changes. Adds genuine musical depth ("jazz
   っぽい" output is reachable) but engine-root, cross-target work.
   Decision sizes Phase 2 step 1 substantially.
3. **Voicing depth.** Euclidean adds fires-per-bar; extensions add notes-
   per-chord. The current voicing logic (`close | spread | drop2` +
   `addSeventh`) is triad-centric and produces dense / muddy output as
   extensions stack up. If "jazz っぽい" is a v1.0 target, jazz-voicing-
   aware expansion is needed (root-omit, third-and-seventh-as-guide-tones,
   tensions-on-top); otherwise extensions ship and sound thick.
4. **Factory preset rebuild scope.** The 6 m4l factory presets
   (Steady / Drift / Cycle / Mixed / Pulse / Jitter Web) predate v1.0
   vocabulary. Refresh scale TBD (how many, what range, what curation
   process).
5. **Euclidean vs preset coexistence.** Does the Euclidean
   parameterization replace the 5 inboil-aligned presets, or augment them
   (preset menu + Euclidean as a separate "custom" mode)? Replacement
   reduces UI clutter; augmentation preserves the inboil-named familiar
   presets as fast paths.

## Per-target notes

- **m4l** — the separate-window mechanism plus lattice-interaction parity
  is the largest single piece of UI work for v1.0. Engine vocabulary
  additions are mechanical (parallel to the vst port).
- **vst** — engine additions (N / S / H, aug / dim, inversion, per-cell
  offset, cell-leave mutation, Euclidean) land in `Source/Engine/`. The
  existing `Editor/` lattice already supports drag and long-press, so the
  Phase 2 step 3 UI rebuild is the primary visual work.
- **app/** (iOS) — out of scope for v1.0; the Engine/ extensions made now
  preserve the JUCE-free discipline so a future AUv3 build can reuse them.

## Sources

This scope rests on grounded reading completed 2026-05-21:

- [concept.md](../concept.md) — musical model
- [ADR 001](archive/001-tonnetz-engine-interface.md) — engine contract
  (extensions deferred; compound ops deferred)
- [ADR 003](archive/003-m4l-parameters-state.md) — m4l lattice click-only
  by design
- [ADR 005](archive/005-rhythmic-feel.md) — per-cell expression + global
  rhythm layer
- [ADR 006](archive/006-workflow.md) §Phase 7 — RHYTHM / ARP inboil-
  aligned palette
- [ADR 008](archive/008-vst-stack-and-scope.md) — vst lattice interactions
  (tap / drag / long-press), `Engine/` / `Plugin/` / `Editor/` split

Plus an O&C / Hemisphere Suite chord-navigation vocabulary inventory
(Harrington 1200, Automatonnetz, AnnularFusion) with dilute candidates
(Carpeggio chord dictionary + X/Y pad selector, ScaleDuet scale mask,
EnigmaJr TM machine bank, Harrington "tune" output mode) explicitly
filtered out.

## Implementation checklist

Deferred until Open Questions §1–5 resolve and Phase 0 substantially
settles. Phases per §Decision. Each phase ends with the device usable in
the host for the scope of that phase ("Phase 完了 = playable").
