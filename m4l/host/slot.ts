// Slot serialization for Oedipa workflow (ADR 006 Phase 1).
//
// A Slot captures the four per-slot fields — cells, startChord, jitter, seed —
// in a compact single-line program string. The same format covers in-device
// snapshot persistence and copy/paste sharing between Live sets.
//
// Encoding (ADR 006 §"Program string format"):
//   cells       positional first token; one char per cell:
//                 P = P, L = L, R = R, _ = hold, - = rest
//   |s=<uint>   PRNG seed
//   |j=<float>  jitter, 0..1, 3-decimal precision
//   |c=<chord>  startChord, e.g. C, C#, Db, Em, Bbm. Parser accepts both
//               sharps and flats; serializer emits canonical sharps.
//   |x=...      unknown keys ignored for forward compatibility.
//
// Pure TS, no Max / no Node-specific imports. Safe under node:test and
// in [node.script] runtime.

import type { Op } from '../engine/tonnetz.ts'

export type SlotQuality = 'maj' | 'min'

export interface Slot {
  cells: string
  startChord: { root: number; quality: SlotQuality }
  jitter: number
  seed: number
}

const OP_TO_CHAR: Record<Op, string> = {
  P: 'P',
  L: 'L',
  R: 'R',
  hold: '_',
  rest: '-',
}

const CHAR_TO_OP: Readonly<Record<string, Op>> = {
  P: 'P',
  L: 'L',
  R: 'R',
  _: 'hold',
  '-': 'rest',
}

// Canonical pitch-class names (sharps). Index = MIDI pitch class 0..11.
const ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

// Parse table — accepts both sharps and flats. Cb / Fb / E# / B# are
// intentionally absent: the canonical form for those pitch classes is B / E
// / F / C, so an explicit Cb (= B) would be a notation oddity, not a useful
// alias for clipboard sharing.
const ROOT_PARSE: Readonly<Record<string, number>> = {
  C: 0,
  'C#': 1, Db: 1,
  D: 2,
  'D#': 3, Eb: 3,
  E: 4,
  F: 5,
  'F#': 6, Gb: 6,
  G: 7,
  'G#': 8, Ab: 8,
  A: 9,
  'A#': 10, Bb: 10,
  B: 11,
}

export function cellsToString(ops: readonly Op[]): string {
  let out = ''
  for (const op of ops) out += OP_TO_CHAR[op]
  return out
}

export function stringToCells(s: string): Op[] | null {
  const out: Op[] = []
  for (const ch of s) {
    const op = CHAR_TO_OP[ch]
    if (op === undefined) return null
    out.push(op)
  }
  return out
}

export function chordToString(root: number, quality: SlotQuality): string {
  if (!Number.isInteger(root) || root < 0 || root > 11) return ''
  const name = ROOT_NAMES[root]!
  return quality === 'min' ? name + 'm' : name
}

export function parseChord(s: string): { root: number; quality: SlotQuality } | null {
  if (typeof s !== 'string' || s.length === 0) return null
  let quality: SlotQuality = 'maj'
  let rootName = s
  if (s.endsWith('m')) {
    quality = 'min'
    rootName = s.slice(0, -1)
  }
  const root = ROOT_PARSE[rootName]
  if (root === undefined) return null
  return { root, quality }
}

export function serializeSlot(slot: Slot): string {
  const j = formatJitter(slot.jitter)
  const c = chordToString(slot.startChord.root, slot.startChord.quality)
  return `${slot.cells}|s=${slot.seed >>> 0}|j=${j}|c=${c}`
}

export function parseSlot(s: string): Slot | null {
  if (typeof s !== 'string' || s.length === 0) return null
  const parts = s.split('|')
  const cellsStr = parts[0]!
  // Reject zero-length cells (audit High #7, 2026-05-10). A pasted
  // program string with `|s=0|j=0|c=C` (cells token elided) parses
  // syntactically but loads as a slot with no active cells; the
  // engine's activeCells() returns [] and the device goes silent
  // with no diagnostic. stringToCells happens to return [] (truthy
  // null check below), so this guard is the sole rejection point.
  if (cellsStr.length === 0) return null
  if (stringToCells(cellsStr) === null) return null

  const fields: Record<string, string> = {}
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!
    if (part.length === 0) continue // tolerate stray | separators
    const eq = part.indexOf('=')
    if (eq < 0) return null
    const key = part.slice(0, eq)
    const value = part.slice(eq + 1)
    fields[key] = value
  }

  const sStr = fields['s']
  const jStr = fields['j']
  const cStr = fields['c']
  if (sStr === undefined || jStr === undefined || cStr === undefined) return null

  const seed = parseUint(sStr)
  if (seed === null) return null
  const jitter = parseUnit(jStr)
  if (jitter === null) return null
  const chord = parseChord(cStr)
  if (chord === null) return null

  return { cells: cellsStr, startChord: chord, jitter, seed }
}

// Trim trailing zeros from a 3-decimal jitter so common values like 0.5 or 0
// serialize compactly. Range-clamped at the parse boundary, not here.
function formatJitter(v: number): string {
  const rounded = Math.round(v * 1000) / 1000
  // toString already trims trailing zeros (0.5 → "0.5", 0 → "0"). Avoid
  // exponential notation by keeping the value in [0, 1].
  return rounded.toString()
}

function parseUint(s: string): number | null {
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 0xffffffff) return null
  return n
}

function parseUnit(s: string): number | null {
  // Accept signless or +-prefixed decimals; reject NaN / Infinity / hex /
  // exponent notation by requiring a strict decimal pattern. Range 0..1
  // per ADR 005 jitter spec.
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0 || n > 1) return null
  return n
}
