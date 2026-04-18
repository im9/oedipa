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
| `dist/` | Generated output. Gitignored — regenerate with `npm run build`. |

Engine semantics are specified in
[`../../docs/ai/adr/archive/001-tonnetz-engine-interface.md`](../../docs/ai/adr/archive/001-tonnetz-engine-interface.md).
Do not edit `tonnetz.ts` without reading that ADR first.

## Dev

```
npm install        # first time
npm test           # run the test suite directly against tonnetz.ts
npm run build      # emit dist/tonnetz.js (ESM)
npm run typecheck  # tsc --noEmit
```

Tests run on Node's native `--test` runner with TypeScript type stripping,
so the test command needs no transpile step. `npm run build` is for
producing the artifact consumed by the M4L device.

## TDD gate

Per the project's [CLAUDE.md](../../CLAUDE.md) Gate 1: update
`tonnetz.test.ts` (and where appropriate `tonnetz-test-vectors.json`)
**before** editing `tonnetz.ts`. New semantic cases go into the shared
vectors file, not into per-target test code.

## How the M4L device consumes it

The engine is **stateless**. The device holds `WalkState` (start chord,
sequence, steps-per-transform, anchors) externally and calls
`walk(state, pos)` to get the triad at host step `pos`.

```ts
import { walk } from './dist/tonnetz.js'

const state = {
  startChord: [60, 64, 67],           // C major
  sequence: ['P', 'L', 'R'],
  stepsPerTransform: 4,
}
const triad = walk(state, 8)          // triad after 2 transforms
```

The host (running in Max's `[node.script]`) emits MIDI from the triad;
scheduling and note-off discipline live on the Max side. See
[`../../docs/ai/adr/002-m4l-device-architecture.md`](../../docs/ai/adr/002-m4l-device-architecture.md)
for the full device architecture.
