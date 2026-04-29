import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cellsToString,
  chordToString,
  parseChord,
  parseSlot,
  serializeSlot,
  stringToCells,
  type Slot,
} from './slot.ts'

describe('cellsToString / stringToCells', () => {
  test('canonical encoding: P L R _ -', () => {
    // Spec: ADR 006 §"Program string format" — each char is one cell op.
    // `_` = hold (continuation), `-` = rest (silence). P/L/R unchanged.
    assert.equal(cellsToString(['P', 'L', 'R', 'hold', 'rest']), 'PLR_-')
    assert.deepEqual(stringToCells('PLR_-'), ['P', 'L', 'R', 'hold', 'rest'])
  })

  test('every op roundtrips', () => {
    const ops = ['P', 'L', 'R', 'hold', 'rest'] as const
    for (const op of ops) {
      const s = cellsToString([op])
      assert.deepEqual(stringToCells(s), [op])
    }
  })

  test('empty string ↔ empty array', () => {
    assert.equal(cellsToString([]), '')
    assert.deepEqual(stringToCells(''), [])
  })

  test('invalid char returns null', () => {
    // Malformed ops must not throw and must not silently coerce. ADR 006
    // §"Implementation checklist" Phase 1 — malformed input → null.
    assert.equal(stringToCells('PXR-'), null)
    assert.equal(stringToCells('plr'), null) // lowercase rejected
    assert.equal(stringToCells('P L R'), null) // whitespace rejected
  })
})

describe('chordToString / parseChord', () => {
  test('every (root, quality) roundtrips through canonical form', () => {
    // 12 roots × 2 qualities = 24 chords. Canonical roots use sharps.
    // ADR 006 §"Axis 2" — serializer emits canonical form per pitch class.
    const sharps = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    for (let root = 0; root < 12; root++) {
      for (const quality of ['maj', 'min'] as const) {
        const s = chordToString(root, quality)
        const expectedName = sharps[root] + (quality === 'min' ? 'm' : '')
        assert.equal(s, expectedName)
        assert.deepEqual(parseChord(s), { root, quality })
      }
    }
  })

  test('flat names are accepted on input', () => {
    // ADR 006 §"Axis 2" — chord parsing accepts both sharps and flats.
    // 5 enharmonic pairs cover all flatted accidentals: Db, Eb, Gb, Ab, Bb.
    assert.deepEqual(parseChord('Db'), { root: 1, quality: 'maj' })
    assert.deepEqual(parseChord('Eb'), { root: 3, quality: 'maj' })
    assert.deepEqual(parseChord('Gb'), { root: 6, quality: 'maj' })
    assert.deepEqual(parseChord('Ab'), { root: 8, quality: 'maj' })
    assert.deepEqual(parseChord('Bb'), { root: 10, quality: 'maj' })
    assert.deepEqual(parseChord('Bbm'), { root: 10, quality: 'min' })
  })

  test('serializer emits sharps even when input was a flat', () => {
    // Round-trip through the slot must canonicalize Db → C# etc.
    const slot: Slot = {
      cells: 'P',
      startChord: { root: 1, quality: 'maj' }, // C#/Db
      jitter: 0,
      seed: 0,
    }
    const s = serializeSlot(slot)
    assert.match(s, /c=C#/) // canonical form
    assert.doesNotMatch(s, /c=Db/)
  })

  test('invalid chord names return null', () => {
    // Names outside {C, C#/Db, ..., B} or with bad quality suffix → null.
    assert.equal(parseChord(''), null)
    assert.equal(parseChord('H'), null) // H is not a valid pitch class name
    assert.equal(parseChord('Cb'), null) // Cb / Fb / E# / B# rejected
    assert.equal(parseChord('Fb'), null)
    assert.equal(parseChord('E#'), null)
    assert.equal(parseChord('B#'), null)
    assert.equal(parseChord('cm'), null) // lowercase root rejected
    assert.equal(parseChord('CM'), null) // uppercase M not accepted (only lowercase m for minor)
    assert.equal(parseChord('Cmaj'), null) // long-form quality rejected
    assert.equal(parseChord('C##'), null)
  })
})

describe('serializeSlot / parseSlot', () => {
  test('canonical roundtrip identity', () => {
    // Spec example from ADR 006 §"Axis 2": "PLR-|s=42|j=0.3|c=Em"
    // (rewritten with our canonical hold/rest chars: PLR-)
    const slot: Slot = {
      cells: 'PLR-',
      startChord: { root: 4, quality: 'min' }, // Em
      jitter: 0.3,
      seed: 42,
    }
    const s = serializeSlot(slot)
    assert.equal(s, 'PLR-|s=42|j=0.3|c=Em')
    assert.deepEqual(parseSlot(s), slot)
  })

  test('round-trip for a grid of valid slots', () => {
    // Sample across each axis: cells variety, both qualities, jitter
    // boundaries, seed boundaries (uint32 max — mulberry32 reads via >>>0).
    const slots: Slot[] = [
      { cells: '', startChord: { root: 0, quality: 'maj' }, jitter: 0, seed: 0 },
      { cells: 'P', startChord: { root: 0, quality: 'maj' }, jitter: 0, seed: 0 },
      { cells: 'PLR_-', startChord: { root: 11, quality: 'min' }, jitter: 1, seed: 4294967295 },
      { cells: '____', startChord: { root: 7, quality: 'maj' }, jitter: 0.5, seed: 12345 },
      { cells: '----', startChord: { root: 5, quality: 'min' }, jitter: 0.001, seed: 1 },
    ]
    for (const slot of slots) {
      const s = serializeSlot(slot)
      assert.deepEqual(parseSlot(s), slot, `roundtrip failed for: ${s}`)
    }
  })

  test('jitter precision: 3 decimals, trailing zeros trimmed', () => {
    // ADR 006 lacks an explicit precision spec; we round to 3 decimals.
    // Justification: jitter knob granularity at 0.001 is below human
    // perceptual threshold for stochastic substitution rate, and keeps the
    // serialized form short for clipboard sharing.
    const slot: Slot = {
      cells: 'P',
      startChord: { root: 0, quality: 'maj' },
      jitter: 0.5,
      seed: 0,
    }
    assert.match(serializeSlot(slot), /j=0\.5\b/)
  })

  test('unknown |key=value pairs are ignored', () => {
    // ADR 006 §"Axis 2" — forward compatibility for future global params.
    const s = 'PL|s=7|j=0|c=C|future=42|x=hello'
    const slot = parseSlot(s)
    assert.notEqual(slot, null)
    assert.deepEqual(slot, {
      cells: 'PL',
      startChord: { root: 0, quality: 'maj' },
      jitter: 0,
      seed: 7,
    })
  })

  test('field order in input is flexible', () => {
    // The cells token is positional (always first), but s/j/c may appear
    // in any order. Forward-compat parsers must not assume a fixed order.
    assert.deepEqual(parseSlot('PL|c=C|j=0|s=7'), {
      cells: 'PL',
      startChord: { root: 0, quality: 'maj' },
      jitter: 0,
      seed: 7,
    })
  })

  test('malformed input returns null without throwing', () => {
    // Phase 1 contract: parseSlot is exception-safe; never crashes on
    // arbitrary user-supplied strings (clipboard paste).
    const malformed: string[] = [
      '', // empty
      'PLR-', // no fields
      'PLR-|s=0|j=0', // missing c
      'PLR-|s=0|c=C', // missing j
      'PLR-|j=0|c=C', // missing s
      'PLR-|s=foo|j=0|c=C', // non-numeric seed
      'PLR-|s=0|j=foo|c=C', // non-numeric jitter
      'PLR-|s=0|j=0|c=Q', // invalid chord
      'PLR-|s=-1|j=0|c=C', // negative seed
      'PLR-|s=0|j=-0.1|c=C', // jitter below 0
      'PLR-|s=0|j=1.5|c=C', // jitter above 1
      'XYZ|s=0|j=0|c=C', // invalid cell chars
      'PLR-|sj=0|c=C', // malformed pair (no =)
    ]
    for (const s of malformed) {
      assert.doesNotThrow(() => parseSlot(s))
      assert.equal(parseSlot(s), null, `expected null for: ${JSON.stringify(s)}`)
    }
  })

  test('non-string input returns null safely', () => {
    // Defensive: callers may pass through Max payloads of unknown shape.
    assert.equal(parseSlot(null as unknown as string), null)
    assert.equal(parseSlot(undefined as unknown as string), null)
    assert.equal(parseSlot(42 as unknown as string), null)
  })
})
