# ADR 005: Rhythmic Feel

## Status: Proposed

**Created**: 2026-04-29

## Context

ADR 003 limited rhythm to "every step sounds at the transform boundary"
and explicitly listed "Rhythm patterns beyond 'every step sounds'" as out
of scope. ADR 004 covers harmonic input and dynamics via velocity
passthrough. The remaining axis where Oedipa sounds mechanical is rhythm:
output notes are full-length, all even subdivisions, always forward, no
silence within a cycle.

This ADR settles the rhythmic-feel surface for v1.

## Decision

Five design axes. Open at draft time; firm decisions land via revisions
before implementation.

### Axis 1 — Gate length

How long does each output note hold relative to the step?

Options under consideration:

- **Fixed parameter** — `gate` `live.dial` 0.0–1.0 of step length, default
  ~0.9. Simplest.
- **Per-cell gate** — each cell carries its own gate length (heavy; defer
  to a future cell-schema extension).
- **Swing-coupled** — gate auto-shortens on syncopated steps to make swing
  more audible.

Recommended starting point: fixed `gate` parameter.

### Axis 2 — Swing

Even vs. swung subdivision?

Options:

- **None** — current.
- **`swing` parameter** — 50% (straight) to ~75% (heavy swing), `live.dial`.
  Applied to even-numbered transport ticks within a transform window.
- **Live groove-pool follow** — Live ships groove templates; could read
  groove amount from the host. Heavier integration.

Recommended starting point: `swing` parameter, default 50%. Groove-pool
integration is a future extension.

### Axis 3 — Subdivision

The base tick rate that drives `stepsPerTransform`.

Options:

- **Fixed 16th** — current.
- **`subdivision` parameter** — `live.tab` with 8th / 16th / 32nd / 16T
  (triplet). Stored as a tick-multiplier the host applies before
  consulting `stepsPerTransform`.

Recommended starting point: `subdivision` `live.tab`, 4 options, default 16th.

### Axis 4 — Step direction

How does the cell sequencer advance through `cells`?

Options:

- **Forward** — current.
- **`stepDirection` parameter** — `live.tab` with forward / reverse /
  pingpong / random. Random direction *interacts* with `seed`: keep one
  seed driving both jitter substitution and direction randomness, or use
  a separate `directionSeed`?
- **Per-cell skip flag** — too granular; defer.

Recommended starting point: `stepDirection` `live.tab`. Single shared
`seed` for both jitter and direction randomness (simpler; either
randomness on its own is identifiable in the output).

### Axis 5 — Rest vs. hold

Current `hold` op re-emits the same chord. A true `rest` op (silent step)
would give the cell program a real rhythmic primitive.

Options:

- **No change** — `hold` = re-emit (current).
- **Add `rest` op** — cell vocabulary becomes `'P' | 'L' | 'R' | 'hold' |
  'rest'` (5-option `live.tab` instead of 4). Persistence migrates safely
  because indices 0–3 stay stable; existing data reads identically.
- **Velocity-zero hold variant** — keep 4 options, add a separate "silence
  on hold" toggle. Less expressive but no schema touch.

Recommended starting point: add `rest` op. It's a vocabulary extension,
not a schema-shape extension (the latter is deferred per ADR 003 "Future
shape extensions"), and it unlocks the most rhythmic variety per axis
budget.

## Scope

**In scope:**

- Gate length parameter
- Swing parameter
- Subdivision parameter
- Step direction parameter
- Rest op (cell vocabulary extension by one option)

**Out of scope:**

- Per-cell gate / per-cell rhythmic params (would need cell-schema shape
  change → deferred per ADR 003)
- Live groove-pool integration (future)
- Polyrhythm / polymeter (future)

## Implementation checklist

To be filled in once axes settle. Phases will follow ADR 003's tests-first
pattern. Likely shape:

1. Engine: extend cell vocabulary if axis 5 lands on `rest`; rhythm-feel
   params consumed by host (engine stays time-agnostic).
2. Host: tick scheduling with `gate`, `swing`, `subdivision`,
   `stepDirection`. Dedicated tests for each.
3. Patcher wiring: new `live.*` objects + dump paths, layout adjustments.
4. Manual: groove validation across a few tempos and styles.

## Per-target notes

m4l: each rhythmic param maps to a `live.*` object with the standard dump
chain. Tick scheduling lives in `host.ts` (engine stays pure). VST/iOS:
APVTS parameters; tick-level scheduling lives in the JUCE
`AudioProcessor::processBlock` path.
