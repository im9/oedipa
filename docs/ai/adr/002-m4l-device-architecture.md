# ADR 002: M4L Device Architecture

## Status: Proposed

**Created**: 2026-04-18

## Context

[ADR 001](001-tonnetz-engine-interface.md) defines a pure, stateless Tonnetz
engine. The engine lives in [`m4l/engine/tonnetz.ts`](../../../m4l/engine/tonnetz.ts)
and is compiled to `dist/tonnetz.js` for use outside Node.

To ship a Max for Live device, the engine must be placed inside an `.amxd`
patch that:

- Receives Live's transport (tempo, position, play state)
- Dispatches per-step triggers to drive the walk
- Calls into the engine for chord generation
- Emits MIDI notes with scheduler-accurate timing
- Exposes parameters to Live for automation, preset save/load, and Push
  integration
- Hosts the Tonnetz lattice UI (deferred to [ADR 004](#))

No `.amxd` exists yet. This ADR decides the **internal layout** of the device
so that parameter design (ADR 003) and UI design (ADR 004) have a fixed
substrate to build on.

## Decision

Three-layer architecture inside a single `.amxd`:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Max patch (.amxd)                                                   │
│                                                                     │
│   Live transport ──► step dispatch ──► [node.script host.js] ──► notes │
│                                                │                    │
│   live.* params ◄──────────────────────────────┤                    │
│                                                │                    │
│   [jsui lattice.js] ◄──────────────────────────┘                    │
│                                                                     │
│   [midiin] ────► passthrough / seed logic ──► [midiout]             │
└─────────────────────────────────────────────────────────────────────┘
```

**Layer responsibilities:**

| Layer           | Responsibility                                                  |
|-----------------|-----------------------------------------------------------------|
| Max patch       | Transport binding, scheduling, MIDI I/O, Live parameter surface |
| `[node.script host.js]` | Walk state, engine calls, step → triad resolution, note events |
| `[jsui lattice.js]` | Lattice rendering and pointer interaction (ADR 004)         |
| `dist/tonnetz.js` | Pure engine from ADR 001 — imported by `host.js` as an ES module |

The patch is the orchestrator; the engine is the oracle; `host.js` is the glue.
`jsui` is a read/write view onto `host.js`'s state, not a second source of truth.

### Why `[node.script]` instead of classic `[js]`

The host runs in Max's `[node.script]` object (full Node.js runtime) rather
than the classic `[js]` object. This gives `host.js` native ES module support,
so it imports the engine directly:

```javascript
// host.js
import { applyTransform, buildTriad, identifyTriad } from './dist/tonnetz.js'
```

Classic `[js]` does not support ESM syntax and would require either a
CommonJS build with a `module`/`exports` shim or an IIFE bundle that writes to
a global. Both are workarounds for a legacy runtime. ESM is this project's
default module format (see user preferences), and `[node.script]` is the
clean path to get it.

Tradeoffs accepted:
- **Device startup**: Node process spawn adds a few hundred ms to device
  instantiation. Occurs only at Live project load, not during playback.
- **Message-boundary latency**: `host.js` ↔ Max messaging is IPC rather than
  in-process. Adds a few ms per message. For chord-rate generation this is
  musically inaudible; if perceptible jitter appears on fast subdivisions,
  precompute the next chord during the current step so Max's scheduler
  handles emission timing.
- **GC jitter**: Node GC may introduce occasional 10–50 ms pauses. For the
  chord-material output Oedipa produces, this is below the perceptual
  threshold for harmonic events. Percussive-feel devices would suffer more;
  Oedipa does not target that aesthetic in v1.

Neither `[js]` nor `[node.script]` provides sample-accurate MIDI — all Max JS
runs in the low-priority scheduler. Sample accuracy, if required later, comes
from emitting precomputed events through Max's scheduler, not from choice of
JS host.

### Why split `host.js` and `lattice.js`

`[node.script]` cannot draw (no sketch/LCD APIs), so the lattice UI must live
in `[jsui]` regardless. This forces the split — and makes it a feature:

- **Testability** — `host.js` is pure logic (walk state, step math, event
  shaping) and runs under `node --test` alongside `tonnetz.ts`. `lattice.js`
  is drawing + input and is manually verified in Live (per CLAUDE.md Gate 1
  GUI policy).
- **Rendering isolation** — jsui redraws should not block note generation.
  Note events originate in `host.js`, which has no drawing obligations.
- **ADR 001 test-vector coverage extends cleanly** — `host.js` exercises
  `walk` cases directly; `lattice.js` stays out of engine conformance tests.

## Engine loading

`dist/tonnetz.js` is emitted as an ES module by `tsc` (see
[`m4l/engine/tsconfig.json`](../../../m4l/engine/tsconfig.json) — `"module":
"ES2022"`, and [`m4l/engine/package.json`](../../../m4l/engine/package.json)
declares `"type": "module"`). `host.js` imports it with standard syntax:

```javascript
// host.js
import * as engine from './dist/tonnetz.js'
// or named imports:
import { applyTransform, buildTriad } from './dist/tonnetz.js'
```

**`host.js` must not duplicate engine logic** — the same `dist/tonnetz.js`
ships with the device and is also consumed by `node --test` via the source
`tonnetz.ts`. Divergence would defeat ADR 001's shared-test-vector promise.

The ts sources and the built `dist/` both live under `m4l/engine/`. A separate
`m4l/host/` directory is introduced for `host.js` so that `host` code is
testable under `node --test` without pulling engine build concerns into the
same package. Exact package layout (one package vs. two) is an implementation
detail, not an ADR-level decision.

### Build artifact placement

`dist/` is `.gitignore`'d. `dist/tonnetz.js` is a generated artifact whose
source of truth is `tonnetz.ts`; committing it would double every engine
diff and risk drift when a contributor edits the source without rebuilding.

Two consumption paths:

- **Development** — a contributor runs `npm install && npm run build` once
  after clone (standard onboarding), and again after any `tonnetz.ts` change.
  The `.amxd` references `dist/tonnetz.js` via a relative path during editing.
- **Distribution** — ship the `.amxd` with Max for Live's *Freeze Device*
  applied. Freezing embeds referenced resources (including `dist/tonnetz.js`)
  into the `.amxd` itself, so end users never see the `dist/` directory.

If it turns out Freeze is not used for distribution (e.g. the device ends up
published via the Max Package format with external resources), this decision
can be revisited — but the default is ignore + rebuild + freeze.

### Engine build follow-up

The existing engine build currently emits CommonJS (`"module": "CommonJS"` in
tsconfig). Accepting this ADR implies updating:

- `m4l/engine/tsconfig.json` → `"module": "ES2022"` (or newer)
- `m4l/engine/package.json` → add `"type": "module"`
- `m4l/engine/tonnetz.ts` header comment referencing CommonJS → update
- Verify `node --test tonnetz.test.ts` still passes (type-strip + ESM)

These are mechanical changes but must go through Gate 1 (run the existing
test suite) before landing.

## MIDI I/O and scheduling

### Transport source

The device binds to Live's transport via `[live.thisdevice]` for lifecycle and
`[transport]` / `[plugsync~]` for position. Step dispatch uses
`[metro] @quantize <rate>` or equivalent, driven off Live's clock — not a
free-running metro.

Rationale: [concept.md](../concept.md) requires deterministic resume from
arbitrary position. Live-synchronized ticks give the host step index `pos`
directly; `host.js` computes the current triad from `pos` + `WalkState`
(ADR 001 walk algorithm).

### Step rate granularity

The walk's host step is a musical subdivision (16th note by default, user-
configurable in ADR 003). `stepsPerTransform` then multiplies this to set
chord duration. Concretely: at default rate = 4 and 16th-note steps, chord
changes land on quarter-note boundaries.

### Note event flow

Per [concept.md](../concept.md) MIDI semantics:

1. On each step, `host.js` computes the triad for the current `pos`.
2. If the triad changed vs. the last emitted triad, `host.js` emits
   **all note-offs for the previous chord**, then **note-ons for the new
   chord**, in the same processing block.
3. If the rhythm pattern for this step is "rest", no new notes are emitted;
   previous notes remain held or not per pattern semantics (ADR 003).

Note events leave `host.js` as `[pitch, velocity, channel]` messages to the
patch, which routes them through `[noteout]` (or `[midiout]` for raw bytes,
TBD in implementation).

### Panic and note-off discipline

Required scenarios for an all-notes-off sweep:

- Transport stop
- Device bypass toggle
- Preset / state restore
- Chord change (implicit — handled by step 2 above)
- Patch free / device removal (via `[live.thisdevice]` close message)

`host.js` maintains a `Set<MidiNote>` of currently-held pitches and emits
note-offs for exactly that set on panic. The patch additionally wires a
"panic" button for manual recovery.

### MIDI input

v1: passthrough only. Input may seed the start chord in a later version
(per concept.md "Input handling is a target-level design choice"). Not
decided in this ADR.

## State ownership

| State                                | Owner         | Persisted by    |
|--------------------------------------|---------------|-----------------|
| Engine (pure, ADR 001)               | `tonnetz.js`  | — (stateless)   |
| `WalkState` (start chord, sequence, rate, anchors) | `host.js` | Live preset (ADR 003) |
| Currently-held MIDI notes            | `host.js`     | not persisted   |
| Last emitted triad (change detection) | `host.js`    | not persisted   |
| UI view state (zoom, pan, hover)     | `lattice.js`  | Live preset if meaningful (ADR 004) |
| Live-exposed parameter values        | Max patch (`live.*`) | Live preset natively |

Authoritative rule: **anything that affects audible output lives in
`host.js` or in `live.*` parameters bound to `host.js`.** The jsui is a view.

Persistence mechanism (`pattr`, `live.*` parameters, `save`/`load` JS hooks,
dict file) is deferred to ADR 003 — it's bound up with the parameter surface.

## Scope

**In scope for this ADR:**
- Patch ↔ `host.js` ↔ `lattice.js` ↔ engine layering
- Engine loading strategy into the `[js]` object
- MIDI I/O direction, transport binding, note-off discipline
- State ownership across layers

**Out of scope (future ADRs):**
- Exact Live-exposed parameters, preset format, automation curves → ADR 003
- Lattice rendering, interaction model, hit testing → ADR 004
- Rhythm pattern representation (beyond "rests emit nothing")
- MIDI input seeding logic
- Performance tuning (jsui redraw throttling, note event batching)

## Open questions

Flagged for resolution during first implementation — may trigger an amendment
to this ADR:

1. Whether `host.js` and `lattice.js` share state via Max messages (loose
   coupling, verifiable) or via a shared Max namespace (tighter, harder to
   test). Default: Max messages. `[node.script]` and `[jsui]` cannot share a
   JS global scope anyway — they are separate runtimes — so this leans
   strongly toward Max messages in practice.
2. Transport-sync object choice (`[transport]` vs `[live.thisdevice]` +
   polling vs `[plugsync~]`). Depends on whether 16th-note granularity is
   sufficient or sub-tick accuracy is needed. Since `[node.script]` cannot
   deliver sample-accurate MIDI regardless, the default is
   `[transport]` + `[metro] @quantize 16n`.
3. Whether `[node.script]`'s startup latency and GC characteristics are
   acceptable in practice. First spike should measure: device load time,
   per-step message roundtrip, worst-case GC pause under sustained playback.

## Per-target notes

This ADR is m4l-specific. The equivalent decisions for `vst/` will be much
thinner — JUCE's `AudioProcessor` already defines the analogous boundaries
(`processBlock` is the step dispatcher, `AudioProcessorValueTreeState` is the
parameter surface, `MidiBuffer` is the note event pipe). No separate ADR is
anticipated for vst/ architecture.
