# ADR 005: Rhythmic Feel

## Status: Proposed

**Created**: 2026-04-29
**Revised**: 2026-04-29 — initial 5-axis draft was a thin global-knob layer
on top of ADR 003's flat-string cells. Reshaped after design review:
per-cell musical expression became the foundation, global layer sits on
top. Cell schema portion of ADR 003 is superseded here.
**Revised**: 2026-04-29 — semantics tightened across walk-state,
probability, PRNG order, humanize math, scheduling edges, migration
strategy, and subdivision options per second design-review pass.
**Revised**: 2026-04-29 — Phase 3 design pass: subdivision tick contract
pinned (PPQN=24 patcher → host `ticksPerStep` multiplier → engine pos =
subdivision-step). See §Subdivision for rationale and the future-feature
implications (ratchet, polyrhythm, groove pool).

## Context

ADR 003 limited rhythm to "every step sounds at the transform boundary"
and defined `Cell = 'P' | 'L' | 'R' | 'hold'` — a flat string. The
"short program" justification (4 cells, no manual chord authoring) was
sound for *program length*, but conflating that with *per-cell
expressiveness* was a misjudgment.

A musical event in a step sequencer canonically carries: what to play,
how loud, how long, whether to play, when to play. Eurorack step
sequencers, Live's Arpeggiator, hardware step sequencers from the TR-808
onwards all expose at least {op, velocity, gate} per step. With Oedipa's
flat cells:

- All 4 cells in a cycle play at identical articulation.
- All 4 cells play at identical loudness — input passthrough (ADR 004) is
  uniform when input is held still, so output is mechanically flat.
- Density is binary (note vs. hold) with no probabilistic shaping.
- Groove is restricted to global swing — no authored push/pull per cell.

Treating cells as bare strings stripped Oedipa of the baseline phrasing
vocabulary that 40+ years of step-based music gear has converged on. This
ADR makes per-cell expression the foundation of rhythmic feel, with a
small global layer for parameters that genuinely belong to the whole
walk (swing, subdivision, direction) plus an opt-in humanize layer for
organic variation on top of authored expression.

## Decision

Two layers: **per-cell expression** (the program) and **global rhythmic
layer** (the grid the program fires against).

### Layer 1 — Per-cell expression

```ts
export type Op = 'P' | 'L' | 'R' | 'hold' | 'rest'

export interface Cell {
  op: Op
  velocity: number     // 0–1, multiplier on source velocity (input passthrough or default 100)
  gate: number         // 0–1, fraction of step length; 1.0 = note-off coincident with next note-on
  probability: number  // 0–1, chance the step plays this visit
  timing: number       // -0.5 to +0.5, step-length fraction; -0.5 = pulled half a step, +0.5 = pushed
}
```

Default cell values (preserve current ADR 003 audible behavior):

- `op` per position: cell0=`P`, cell1=`L`, cell2=`R`, cell3=`hold`
- `velocity` = 1.0 (full source velocity)
- `gate` = 0.9 (slightly detached, harmonic motion stays audible)
- `probability` = 1.0 (always plays)
- `timing` = 0.0 (on the grid)

#### Walk-state model: cell pointer vs. Tonnetz chord cursor

Two distinct pieces of state advance per step. They have different rules
and the rest of this section depends on the distinction:

- **Cell pointer** — index into `cells[]`. Always advances exactly one
  position per step (modulated by `stepDirection`, Layer 2). Never
  affected by op, probability, or rest.
- **Tonnetz chord cursor** — the current triad. Whether it changes
  depends on the op resolved at this step (after jitter, after
  probability skip).

#### Op effects table

For each resolved op, the effect on the chord cursor and audio output:

| Op    | Chord cursor    | Audio output                   |
|-------|-----------------|--------------------------------|
| P     | apply P         | emit new chord                 |
| L     | apply L         | emit new chord                 |
| R     | apply R         | emit new chord                 |
| hold  | unchanged       | re-emit current chord          |
| rest  | unchanged       | silent (no note-on)            |

The cell pointer always advances regardless of op.

#### `rest` op

Vocabulary addition. Pure silent hold: cursor unchanged, no audio.
Previous step's note dies according to its own gate length — no special
note-off at the rest boundary. `rest` is **NOT** a candidate for jitter
substitution; only explicitly authored rests produce silence.

`Op` has 5 values total. The jitter substitution pool `CELL_OPS` is the
4-element subset `['P', 'L', 'R', 'hold']` — `rest` is excluded so that
random op replacement never injects unintended silence.

#### Probability semantics

Per-step independent draw, sampled from the seeded PRNG. If the roll
fails, the step is treated as a "silent advance":

| Op resolved | Probability fail effect                              |
|-------------|------------------------------------------------------|
| P / L / R   | chord cursor still applies the transform, no audio   |
| hold        | chord cursor unchanged, no audio                     |
| rest        | identical to non-fail (already silent, no-op)        |

The cell pointer advances unchanged in all cases. This keeps rhythmic
position deterministic across playback restarts (ADR 003 transport
guarantee). Skipped audio behaves like `rest`: prior note dies via its
own gate; no new note-on.

`jitter` (op substitution) and `probability` (whether to fire) are
independent draws within the same step. See [PRNG draw
order](#prng-draw-order) for the resolution sequence.

#### Timing semantics

Offset within the step, expressed as a fraction of step length:

- `-0.5` = note fires half a step before the nominal grid position
- `+0.5` = half a step after

Composes with global `swing` (Layer 2): swing offsets the grid;
per-cell `timing` offsets from the (already-swung) grid position.

**Playback start clamp**: at transport start, any negative timing offset
on the first scheduled cell is clamped to 0 (cannot fire before t=0).
Subsequent cycles use the unclamped offset.

**Adjacent overlap**: aggressive offsets can cause adjacent cells'
absolute scheduled times to cross. Each cell fires at its own absolute
time — no re-ordering. If the prior step's gate would extend past the
next note-on, ADR 003's note-off discipline applies (legato note-off:
prior note released *before* new note-on, in the same processing block).

#### Velocity passthrough source

When input is wired (ADR 004 hybrid / hold-to-play), the "source
velocity" multiplied by per-cell `velocity` is the **most recent
note-on velocity** within the held set. As the user re-articulates, the
source updates and per-cell scaling tracks the new dynamic. When no
input is wired, source = 100 (ADR 003 default).

### Layer 2 — Global rhythmic layer

#### Swing

`swing` `live.dial` 50–75%, default 50% (straight). Applied to **off-beat
ticks** (odd indices when 0-indexed: ticks 1, 3, 5, …) within the step
grid. 50% = even subdivision, 75% = heavy swing.

#### Subdivision

`subdivision` `live.tab` with 5 options: 8th / 16th / 32nd / 8T / 16T
(eighth- and sixteenth-note triplets). Default 16th. Stored as a
tick-multiplier the host applies before consulting `stepsPerTransform`
(ADR 003 group A).

**Tick contract (Phase 3 decision).** The patcher streams transport
ticks at a fixed **PPQN = 24** (LCM of {8, 16, 32, 12, 24} per quarter
note — covers all five subdivisions with integer multipliers). The host
maintains a `ticksPerStep` multiplier (a function of `subdivision`):

| subdivision | ticks per subdivision-step (PPQN=24) |
|-------------|---------------------------------------|
| 8th         | 12                                    |
| 16th        | 6 (default)                           |
| 32nd        | 3                                     |
| 8T          | 8                                     |
| 16T         | 4                                     |

The host accumulates raw PPQN ticks, divides by `ticksPerStep` to derive
the engine's `pos`, and feeds that to `walk(state, pos)`. The engine's
pos contract (`1 pos = 1 subdivision-step`) is therefore unchanged from
ADR 003 — only the host's tick→pos mapping gains the subdivision lever.

This high-PPQN feed is what unlocks the "Out of scope" musical extensions
later: ratchet (sub-step retriggers — host already has tick granularity
within a step), polyrhythm/polymeter (multiple cell programs sharing the
same PPQN stream at different multipliers), and Live groove-pool
integration (groove templates apply per-tick micro-shifts). Choosing the
narrower contract (patcher emits step-rate ticks directly) would have
collapsed all three extensions into per-feature transport reworks.

For cross-target consistency: the VST/AU port maps the host's PPQN feed
from JUCE's `AudioPlayHead::CurrentPositionInfo::ppqPosition` (which is
already PPQN-based — JUCE just hands the engine its native unit). The
iOS AUv3 port follows the same shape.

#### Step direction

`stepDirection` `live.tab` with 4 options: forward / reverse / pingpong
/ random. Default forward. Random direction shares the existing `seed`
(ADR 003 group C) — one seed drives jitter substitution, probability
rolls, direction randomness, and humanize draws.

- **Forward**: 0→1→2→3→0→…
- **Reverse**: 3→2→1→0→3→…
- **Pingpong**: traverse without replaying endpoints. For 4 cells:
  `0→1→2→3→2→1→0→1→…` (period 6).
- **Random**: each step picks the next cell uniformly from
  `{0..cells.length-1}`, independent draws (consecutive same-cell
  selections are possible).

#### Humanize

Opt-in layer that adds non-authored variation on top of per-cell values:

- `humanizeVelocity` `live.dial` (0–1, default 0)
- `humanizeGate` `live.dial` (0–1, default 0)
- `humanizeTiming` `live.dial` (0–1, default 0)

Per output event, each axis applies an independent uniform noise:

| Axis     | Formula                          | Clamp           |
|----------|----------------------------------|-----------------|
| velocity | `velocity + uniform(-h, +h)`     | `[0, 1]`        |
| gate     | `gate + uniform(-h, +h)`         | `[0, 1]`        |
| timing   | `timing + uniform(-h, +h)`       | `[-0.5, +0.5]`  |

Noise is in absolute parameter units, so at peak base values clamping
naturally produces "downward-only" jitter (e.g. `vel = 1.0`, `h = 0.3`
→ output range `[0.7, 1.0]`). This matches standard arpeggiator humanize
behavior — peaks fall away, troughs lift up.

Random source is the shared seeded PRNG → reproducible. Default 0 means
humanize is opt-in; authored phrasing is the primary expression source.

### PRNG draw order

For deterministic reproducibility across playback restarts and across
targets (m4l / vst / app), per-step PRNG draws happen in this fixed
order from the same seeded stream:

1. **stepDirection** (only when set to `random`) — picks next cell
   index
2. **jitter** — substitutes op (skipped when `jitter == 0` or when the
   resolved op would be `rest`)
3. **probability** — rolls play vs. silent-advance
4. **humanizeVelocity**
5. **humanizeGate**
6. **humanizeTiming**

Cross-target test vectors must reflect this order.

## Persistence

Cells persist as 20 hidden parameters per cell field:

- 4 × `live.tab` for `op` — IDs preserved from ADR 003 (option count
  extended 4 → 5; new index 4 = `rest`)
- 4 × `live.numbox` for `velocity`
- 4 × `live.numbox` for `gate`
- 4 × `live.numbox` for `probability`
- 4 × `live.numbox` for `timing`

Global layer parameters: `swing`, `subdivision`, `stepDirection`,
`humanizeVelocity`, `humanizeGate`, `humanizeTiming` — each its own
`live.*` object.

This continues ADR 003's pattern (live.* over pattr; per the project
memory entry on pattr unreliability) and gives each field its own
host-automation lane.

`op` is stored as integer index 0..4 (P=0, L=1, R=2, hold=3, rest=4).

### Migration from ADR 003 state

Existing devices have 4 × `live.tab` for op (cell0..cell3, indices
0..3). **The 4 op `live.tab` parameters are kept** — same parameter IDs,
just option count extended 4 → 5. Existing presets and Live sets load
op values unchanged. The 16 new `live.numbox` (velocity / gate /
probability / timing) and the 6 new global `live.*` are added on top
with default values; old saves load with defaults (vel=1.0, gate=0.9,
prob=1.0, timing=0.0, swing=50, subdivision=16th, stepDirection=forward,
humanize-*=0), sounding identical to before.

The vocabulary extension `rest` (op index 4) is unreachable from old
saves until the user edits a cell.

## UI

A custom **cell strip** is added to the jsui lattice surface, below the
lattice. Each cell renders as a box where:

- height ∝ `velocity`
- width ∝ `gate`
- horizontal offset ∝ `timing`
- opacity ∝ `probability`
- color = `op`

The model layer (hit testing, drag-to-value math, op cycling, value
clamping) is pure TypeScript runnable in Node — testable per CLAUDE.md
"GUI / UI components". The renderer reads model state.

The 5-axis-per-box density is intentionally rich (one box conveys five
musical dimensions). Phase 5 implementation will likely iterate on
specific affordances — which drag axis maps to which field, modifier-key
discovery, etc. The data contract (5 fields per cell) is fixed by this
ADR; the affordances are not.

The 4 op `live.tab`, 16 `live.numbox` cell expression params, and 6
global `live.*` are addressable for host automation. Continues ADR 003's
"lattice = primary UI, `live.*` = automation surface" pattern.

## Scope

**In scope:**

- 5-field cell record (op, velocity, gate, probability, timing)
- 5-option `op` vocabulary including `rest`
- Global rhythmic layer: swing, subdivision (5 opts), stepDirection
- Humanize layer: 3 axes (velocity, gate, timing)
- jsui cell strip UI (logic + render)
- Migration from ADR 003 op `live.tab` (ID-preserving)

**Out of scope:**

- **Ratchet** (1-step retriggers) — separate musical primitive, future ADR
- **Tie** (cross-cell legato without retrigger) — `gate` = 1.0 covers
  detached legato; explicit tie semantics deferred
- **Slide / portamento** — instrument-specific, not Tonnetz-relevant
- **Live groove-pool integration** — future
- **Polyrhythm / polymeter** — future

## Implementation checklist

Phases follow ADR 003's TDD pattern.

- [x] **Phase 1 — Engine: cell shape + walk semantics**
  - Extend `Cell` to record shape; add `Op` type with `rest`.
  - Op effects table semantics in `nextChord` / walk logic.
  - Probability roll with silent-advance behavior on P/L/R; seeded.
  - PRNG draw order fixed (direction-random → jitter → probability →
    humanize × 3).
  - `CELL_OPS` (jitter pool) explicitly excludes `rest`.
  - Update shared test vectors
    ([docs/ai/tonnetz-test-vectors.json](../tonnetz-test-vectors.json))
    for new cell shape, ops, and probability semantics.
- [x] **Phase 2 — Host: per-cell scheduling**
  - Per-cell velocity / gate / timing offset applied per output event.
  - Source velocity = most-recent note-on within held set (ADR 004
    integration).
  - Skipped-step (probability) and rest paths share note-off via
    prior-step gate (legato note-off per ADR 003).
  - Playback-start clamp: first scheduled cell's negative timing → 0.
  - Negative-timing pull-ahead in subsequent cycles deferred to Phase 3+
    (requires look-ahead from prior step boundary, easier alongside
    subdivision/swing scheduling). Phase 2 clamps at every boundary.
- [x] **Phase 3 — Host: global layer**
  - [x] Engine: `StepDirection`, `WalkState.stepDirection`, expose
    humanize draws on `StepEvent`, refactor cellIdx via `resolveCellIdx`.
    (commit `0dc7a0f`; engine 206 tests pass)
  - [x] Host: PPQN=24 tick feed → `ticksPerStep` multiplier (5
    subdivisions) → engine pos. Existing host tests opt into
    `ticksPerStep: 1` to keep "1 pos = 1 step" semantics; new
    subdivision tests use the real multipliers.
  - [x] Host: swing offset on off-beat subdivision-steps
    (`subdivStepPos % 2 === 1` → `(2*swing - 1) * ticksPerStep` raw-tick
    offset, additively composed with cell timing).
  - [x] Host: step-direction wiring through `HostParams` (forward /
    reverse / pingpong / random); `cellIdx()` UI reporter now defers to
    `walkStepEvent` so the lattice marker is direction-aware.
  - [x] Host: humanize amounts (3 dials) applied to per-event
    vel/gate/timing via `(raw * 2 - 1) * amount`, clamped per ADR table
    (`clamp01` for vel/gate, `clampSigned05` for timing).
  - Defaults sanity: with `stepDirection='forward'`, `ticksPerStep=1`,
    `swing=0.5`, all `humanize*=0`, the host is bit-identical to the
    Phase 2 contract (regression-pinned by an explicit deepEqual test).
    Patcher / Live UI surfacing of these params is deferred to Phase 4.
- [x] **Phase 4 — Patcher: parameters**
  - [x] Bridge: `setCellField <idx> <field> <value>` entry point for
    the per-cell numeric numbox dumps; `Host.setCellField` mirrors
    `setCell`'s idx-bounds + NaN guard and preserves op + untouched
    fields. (commit `242e759`; 6 host tests)
  - [x] Patcher: 4 × `live.tab` op extended 4 → 5 (added `·` = rest).
    Same parameter IDs (`OedipaCell{0..3}`) preserved; old saves load
    unchanged with values 0..3. New `setCell N rest` messages wired
    via the existing `sel` cascade (now 5 outlets).
  - [x] Patcher: 16 × `live.numbox` (vel/gate/prob/timing per cell)
    added on the patching canvas. **Hidden from the device strip
    until Phase 5** — Phase 5 cell-strip jsui is the proper UI for
    these (per ADR §UI). Default `parameter_visible: 1` keeps them
    surfaced in Live's automation list as a fallback. Each dumps via
    `prepend setCellField <idx> <field>` → `[node.script]`. Defaults
    match Phase 1: vel=1.0, gate=0.9, prob=1.0, timing=0.0; ranges
    0..1 except timing -0.5..+0.5. All 16 also wired into the
    `obj-trig-hostready` cascade for rehydrate.
  - [x] Patcher: 6 × `live.*` globals (swing, subdivision,
    stepDirection, 3 × humanize) added with **device-strip UI** in a
    dedicated FEEL section right of the existing strip
    (`devicewidth: 880 → 1040`, separator at x=849). Layout
    prioritizes musical use: Swing as a primary dial, Subdivision
    and StepDirection as compact tabs (5 / 4 segments respectively),
    Humanize ×3 grouped as small dials with a shared section header.
    Numeric dials (swing 0.5..0.75, humanize 0..1) → `prepend
    setParams <key>`. Subdivision `live.tab` 5 opts (`8 / 16 / 32 /
    8T / 16T`, default 16th) → `sel` → 5 `setParams ticksPerStep N`
    messages (12, 6, 3, 8, 4 per ADR §Subdivision table).
    Step-direction `live.tab` 4 opts (`Fwd / Rev / PPng / Rnd`) →
    `sel` → 4 `setParams stepDirection {forward,reverse,pingpong,
    random}` messages. All 6 wired into `obj-trig-hostready` for
    rehydrate.
  - [x] Patcher: `metro 16n @quantize 16n` → `metro 96n @quantize
    96n`. Phase 3 §Subdivision specified the patcher would stream
    raw transport ticks at PPQN=24, but the engine/host commits
    (`0dc7a0f` / `9a08b40`) didn't update the metro — a Phase 3
    patcher gap. With Phase 4's subdivision rehydrate setting
    `ticksPerStep=6` (default 16th) on `hostReady`, the legacy
    16n-rate metro made every cell run 6 × longer than intended
    (one transform period stretched from 1 quarter to 6 quarters).
    96n = 24 ticks/quarter = PPQN=24, so 6 raw ticks per
    16th-note subdivision-step lines up with `ticksPerStep=6`,
    restoring 1 transform period = 1 quarter at the default
    subdivision.
- [ ] **Phase 5 — jsui cell strip**
  - Pure model layer (hit testing, drag math, op cycling, clamping)
    tested in Node.
  - Renderer in jsui, integrated below the existing lattice.
  - UI affordance iteration permitted within Phase 5.
- [ ] **Phase 6 — Migration, doc sync, manual smoke**
  - Update [docs/ai/concept.md](../concept.md) velocity section —
    remove "single static velocity parameter intentionally not exposed"
    framing; replace with per-cell velocity × source-velocity ×
    humanize stack.
  - Load an ADR 003-era device; verify op live.tab IDs preserved,
    defaults apply, audible behavior unchanged.
  - Manual groove validation across tempos and styles; humanize amounts
    feel organic, not random-noisy.

## Per-target notes

**m4l**: as above.

**VST/iOS**: APVTS parameters per cell field and per global. Custom UI
component for the cell strip. Engine `Cell` shape and walk semantics
are shared logic — cross-target test vectors enforce semantic parity,
including PRNG draw order.

## Supersedes

This ADR supersedes the cell-schema portions of ADR 003:

- §"Group C — Walk generation" `cells` row (4-option enum → 5-field
  record)
- `CELL_OPS` definition (4 ops → still 4 ops for jitter pool, but `Op`
  type expands to 5 with `rest` excluded from substitution)
- §"Future shape extensions" `(op, count)` and `(dx, dy, flip)` items
  remain deferred, but the rationale ("flat schema") is now historical.

ADR 003's other decisions (transport, voicing/MIDI output, lattice as
primary UI, jitter, seed, startChord, persistence via live.*) stand.
