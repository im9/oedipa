# Oedipa Engine (m4l)

Pure Tonnetz engine for the Max for Live target. TypeScript source, ESM
output, consumed by Node for tests and by Max's `[node.script]` object at
runtime.

## What's here

| File | Purpose |
|---|---|
| `tonnetz.ts` | Engine source. Pure functions: `identifyTriad`, `buildTriad`, `applyTransform`, `applyVoicing`, `addSeventh`, `walk`. |
| `tonnetz.test.ts` | Test suite. Iterates the shared vectors at [`../../docs/ai/tonnetz-test-vectors.json`](../../docs/ai/tonnetz-test-vectors.json) for cross-target conformance. |
| `tsconfig.json`, `package.json` | ES2022 ESM build config. |
| `dist/` | Generated output. Gitignored — regenerate with `pnpm build`. |

Engine semantics are specified in
[`../../docs/ai/adr/archive/001-tonnetz-engine-interface.md`](../../docs/ai/adr/archive/001-tonnetz-engine-interface.md).
Do not edit `tonnetz.ts` without reading that ADR first.

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

Per the project's [CLAUDE.md](../../CLAUDE.md) Gate 1: update
`tonnetz.test.ts` (and where appropriate `tonnetz-test-vectors.json`)
**before** editing `tonnetz.ts`. New semantic cases go into the shared
vectors file, not into per-target test code.

## How the M4L device consumes it

The engine is **stateless**. The device holds `WalkState` (start chord, cell
sequence, steps-per-transform, jitter, seed) externally and calls
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
[`../../docs/ai/adr/003-m4l-parameters-state.md`](../../docs/ai/adr/003-m4l-parameters-state.md)
for the cell sequencer + jitter design.
