// Factory presets for Oedipa (ADR 006 Phase 4 — TS half).
//
// Curated programs covering the design space:
//   P-heavy / L-heavy / R-heavy motion, sparse-hold textures,
//   jitter-led variation, dense PLR mixes.
//
// Each entry's program is a slot-format string parsed by `parseSlot`
// (m4l/host/slot.ts). The `live.menu` widget — added in Phase 3 —
// renders `name` and routes the index to `Host.loadFactoryPreset`.

export interface FactoryPreset {
  readonly name: string
  readonly program: string
}

export const FACTORY_PRESETS: readonly FactoryPreset[] = [
  // P-heavy: pure P transforms — alternates major↔minor on the same root.
  { name: 'Steady',     program: 'PPPP|s=0|j=0|c=C' },
  // L-heavy with sparse holds — slower harmonic drift through L's mediant cycle.
  { name: 'Drift',      program: 'L_L_|s=0|j=0|c=Am' },
  // R-heavy — relative-key motion (parallel cycle through R).
  { name: 'Cycle',      program: 'RRRR|s=0|j=0|c=Em' },
  // Dense PLR mix — the canonical 4-cell program (matches default device).
  { name: 'Mixed',      program: 'PLR_|s=0|j=0|c=C' },
  // Motion-rest pulse — sparse rhythmic pattern with audible silences.
  { name: 'Pulse',      program: 'P-L-|s=0|j=0|c=G' },
  // Jitter-led — all holds, but j=0.6 substitutes ~60% of cells with random
  // motion ops. Seed pinned so the preset sounds the same every load.
  { name: 'Jitter Web', program: '____|s=42|j=0.6|c=C' },
] as const
