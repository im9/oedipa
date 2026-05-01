# Oedipa Engine (m4l)

Pure Tonnetz engine for the Max for Live target. TypeScript source, ESM
output, consumed by Node for tests and by Max's `[node.script]` object at
runtime.

## What's here

| File | Purpose |
|---|---|
| `tonnetz.ts` | Walk engine. Pure functions: `identifyTriad`, `buildTriad`, `applyTransform`, `applyVoicing`, `addSeventh`, `walk`, `mulberry32`. |
| `tonnetz.test.ts` | Walk-engine tests. Iterates the shared vectors at [`../../docs/ai/tonnetz-test-vectors.json`](../../docs/ai/tonnetz-test-vectors.json) for cross-target conformance. |
| `lattice.ts` | Lattice geometry. Pure functions: `noteAt`, `trianglePcs`, `viewportCells`, `computeLayout`, `pointToCell`, `cellToTriad`, `findTriadCell`. Mirrored as plain ES5 in [`../lattice-renderer.js`](../lattice-renderer.js) for jsui consumption (Max's classic JS engine, not Node). |
| `lattice.test.ts` | Lattice geometry tests. Hit testing, cell↔triad round-trips, P/L/R neighbor consistency, viewport coverage. |
| `tsconfig.json`, `package.json` | ES2022 ESM build config. |
| `dist/` | Generated output. Gitignored — regenerate with `pnpm build`. |

Walk-engine semantics — current walk shape (cells / jitter / seed) is
specified in [`../../docs/ai/concept.md`](../../docs/ai/concept.md) "Traversal"
and [`../../docs/ai/adr/archive/003-m4l-parameters-state.md`](../../docs/ai/adr/archive/003-m4l-parameters-state.md).
The triad math, P/L/R semantics, voicing layer, and shared-test-vectors
contract that the engine still satisfies are documented in
[`../../docs/ai/adr/archive/001-tonnetz-engine-interface.md`](../../docs/ai/adr/archive/001-tonnetz-engine-interface.md)
(read with care — the `WalkState` shape there describes the v1 walker that
ADR 003 superseded). Lattice-UI semantics live in ADR 003's "Lattice UI"
section. Do not edit `tonnetz.ts` or `lattice.ts` without reading the
corresponding ADR first.

## Dev

This package is a member of the `m4l/` pnpm workspace. Run from this
directory for engine-only commands:

```
pnpm test           # run the test suite directly against tonnetz.ts
pnpm build          # emit dist/tonnetz.js (ESM)
pnpm typecheck      # tsc --noEmit
```

Or from `m4l/` to run across the whole workspace: `pnpm -r test`, etc.
First-time setup: `cd m4l && pnpm install`.

Tests run on Node's native `--test` runner with TypeScript type stripping,
so the test command needs no transpile step. `pnpm build` is for
producing the artifact consumed by the M4L device.

## TDD gate

Per the project's [CLAUDE.md](../../CLAUDE.md) Gate 1: update the relevant
test file (`tonnetz.test.ts` or `lattice.test.ts`) **before** editing the
implementation. For walk-engine semantics also update
`tonnetz-test-vectors.json` — new cross-target cases go into the shared
vectors file, not into per-target test code. Lattice geometry stays in
TS-only tests since it's a UI concern not shared across targets the same
way the walk engine is.

## How the M4L device consumes it

The engine is **stateless**. The device holds `WalkState` (start chord, cell
program, steps-per-transform, jitter, seed) externally and calls
`walk(state, pos)` to get the triad at host step `pos`.

```ts
import { walk } from './dist/tonnetz.js'

const state = {
  startChord: [60, 64, 67],           // C major
  cells: ['P', 'L', 'R', 'hold'],     // cyclic op program
  stepsPerTransform: 4,
  jitter: 0,                          // 0..1
  seed: 0,
}
const triad = walk(state, 8)          // triad after 2 transforms
```

The host (running in Max's `[node.script]`) emits MIDI from the triad;
scheduling and note-off discipline live on the Max side. See
[`../../docs/ai/adr/archive/002-m4l-device-architecture.md`](../../docs/ai/adr/archive/002-m4l-device-architecture.md)
for the full device architecture and
[`../../docs/ai/adr/archive/003-m4l-parameters-state.md`](../../docs/ai/adr/archive/003-m4l-parameters-state.md)
for the cell sequencer + jitter design.
