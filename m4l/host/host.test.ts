import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Host, type HostParams, type NoteEvent } from './host.ts'

function baseParams(overrides: Partial<HostParams> = {}): HostParams {
  return {
    startChord: [60, 64, 67],
    cells: ['P', 'L', 'R', 'hold'],
    stepsPerTransform: 1,
    voicing: 'close',
    seventh: false,
    jitter: 0,
    seed: 0,
    velocity: 100,
    channel: 1,
    ...overrides,
  }
}

function pitchesOf(events: NoteEvent[], type: NoteEvent['type']): number[] {
  return events.filter(e => e.type === type).map(e => e.pitch)
}

describe('Host.step', () => {
  test('emits noteOns for the startChord on first step', () => {
    const host = new Host(baseParams())
    const events = host.step(0)

    assert.equal(events.length, 3)
    assert.ok(events.every(e => e.type === 'noteOn'))
    assert.deepEqual(pitchesOf(events, 'noteOn').sort((a, b) => a - b), [60, 64, 67])
    for (const e of events) {
      if (e.type === 'noteOn') {
        assert.equal(e.velocity, 100)
        assert.equal(e.channel, 1)
      }
    }
  })

  test('emits nothing when the chord is unchanged across steps', () => {
    const host = new Host(baseParams({ stepsPerTransform: 4 }))
    host.step(0)
    assert.deepEqual(host.step(1), [])
    assert.deepEqual(host.step(2), [])
    assert.deepEqual(host.step(3), [])
  })

  test('emits noteOffs for the previous chord before noteOns on change', () => {
    const host = new Host(baseParams({ cells: ['P'] }))
    host.step(0)
    const events = host.step(1)

    const lastOffIdx = events.map(e => e.type).lastIndexOf('noteOff')
    const firstOnIdx = events.map(e => e.type).indexOf('noteOn')
    assert.ok(
      lastOffIdx < firstOnIdx,
      `all noteOffs must precede any noteOn (offs end at ${lastOffIdx}, ons start at ${firstOnIdx})`,
    )
    assert.deepEqual(pitchesOf(events, 'noteOff').sort((a, b) => a - b), [60, 64, 67])
    const newPcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(newPcs, [0, 3, 7])
  })

  test('re-calling step with the same pos emits nothing', () => {
    const host = new Host(baseParams({ cells: ['P'] }))
    assert.equal(host.step(0).length, 3)
    assert.deepEqual(host.step(0), [])
  })

  test('supports scrubbing: step(n) without prior calls emits the chord at n', () => {
    const host = new Host(baseParams({ cells: ['P'] }))
    const events = host.step(5)

    assert.equal(pitchesOf(events, 'noteOff').length, 0)
    // cells=['P'] applied 5 times: P is involution → after odd applications we land on minor.
    const pcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 3, 7])
  })

  test('applies spread voicing to emitted notes', () => {
    const host = new Host(baseParams({ voicing: 'spread' }))
    const pitches = pitchesOf(host.step(0), 'noteOn')
    assert.deepEqual(pitches, [60, 76, 67])
  })

  test('emits a fourth note when seventh is enabled', () => {
    const host = new Host(baseParams({ seventh: true }))
    const pitches = pitchesOf(host.step(0), 'noteOn')
    assert.deepEqual(pitches, [60, 64, 67, 71])
  })

  test('cell sequencer cycles through cells in order', () => {
    // cells = [P, L, R, hold] — verify the cycle on a fresh host at each pos.
    const expected: number[][] = [
      [0, 4, 7],   // pos 0: startChord C major
      [0, 3, 7],   // pos 1: cell[0]=P → C minor
      [0, 3, 8],   // pos 2: cell[1]=L → Ab major
      [0, 5, 8],   // pos 3: cell[2]=R → F minor
      [0, 5, 8],   // pos 4: cell[3]=hold → F minor (unchanged)
      [0, 5, 9],   // pos 5: cell[0]=P (cycle) → F major
    ]
    for (let pos = 0; pos < expected.length; pos++) {
      const host = new Host(baseParams())
      const events = host.step(pos)
      const pcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
      assert.deepEqual(pcs, expected[pos], `pos=${pos}`)
    }
  })

  test('hold cell does not change the chord (no events emitted)', () => {
    const host = new Host(baseParams({ cells: ['hold'] }))
    host.step(0)
    // All subsequent steps stay on startChord.
    for (const pos of [1, 2, 5, 17]) {
      assert.deepEqual(host.step(pos), [], `pos=${pos} must emit nothing`)
    }
  })

  test('jitter=0 walk is reproducible regardless of seed', () => {
    // Same params, different seeds — output identical when jitter=0.
    const a = new Host(baseParams({ jitter: 0, seed: 1 }))
    const b = new Host(baseParams({ jitter: 0, seed: 999 }))
    a.step(0); b.step(0)
    assert.deepEqual(a.currentTriad, b.currentTriad)
    a.step(1); b.step(1)
    assert.deepEqual(a.currentTriad, b.currentTriad)
    a.step(5); b.step(5)
    assert.deepEqual(a.currentTriad, b.currentTriad)
  })

  test('jitter > 0 with same seed reproduces between hosts', () => {
    const a = new Host(baseParams({ jitter: 0.5, seed: 42 }))
    const b = new Host(baseParams({ jitter: 0.5, seed: 42 }))
    for (const pos of [0, 1, 2, 3, 5, 13, 50]) {
      a.step(pos); b.step(pos)
      assert.deepEqual(a.currentTriad, b.currentTriad, `pos=${pos}`)
    }
  })

  test('noteOffs at chord change match the previously voiced notes (not the raw triad)', () => {
    const host = new Host(baseParams({ voicing: 'spread', cells: ['P'] }))
    host.step(0)
    const events = host.step(1)
    assert.deepEqual(pitchesOf(events, 'noteOff').sort((a, b) => a - b), [60, 67, 76])
  })
})

describe('Host.panic', () => {
  test('emits noteOff for every held note and clears state', () => {
    const host = new Host(baseParams())
    host.step(0)
    const events = host.panic()
    assert.equal(events.length, 3)
    assert.ok(events.every(e => e.type === 'noteOff'))
    assert.deepEqual(pitchesOf(events, 'noteOff').sort((a, b) => a - b), [60, 64, 67])
    assert.deepEqual(host.panic(), [])
  })

  test('after panic, the next step fires fresh noteOns with no stray noteOffs', () => {
    const host = new Host(baseParams())
    host.step(0)
    host.panic()
    const events = host.step(0)
    assert.equal(pitchesOf(events, 'noteOff').length, 0)
    assert.equal(pitchesOf(events, 'noteOn').length, 3)
  })
})

describe('Host.setParams', () => {
  test('is silent on its own; the next chord change reflects the new params', () => {
    const host = new Host(baseParams({ stepsPerTransform: 2, cells: ['P'] }))
    host.step(0)
    host.setParams({ voicing: 'spread' })
    assert.deepEqual(host.step(1), [])
    const events = host.step(2)
    assert.equal(pitchesOf(events, 'noteOn').length, 3)
    assert.equal(pitchesOf(events, 'noteOff').length, 3)
  })
})

describe('Host.setCell', () => {
  test('mutates only the indexed cell', () => {
    const host = new Host(baseParams({ cells: ['P', 'L', 'R', 'hold'] }))
    host.setCell(2, 'hold')
    host.step(0)
    // pos 3 was R → F minor, now hold → stays Ab major from pos 2.
    host.step(1) // P → C minor
    host.step(2) // L → Ab major
    host.step(3) // hold (was R) → still Ab major, no events
    assert.deepEqual(host.step(3), [])
    const pcs = host.currentTriad!.map(p => ((p % 12) + 12) % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 3, 8])
  })

  test('out-of-range index is a no-op', () => {
    const host = new Host(baseParams({ cells: ['P', 'L', 'R', 'hold'] }))
    host.setCell(-1, 'hold')
    host.setCell(99, 'hold')
    host.step(0)
    host.step(1)
    const pcs = host.currentTriad!.map(p => ((p % 12) + 12) % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 3, 7], 'cells unchanged → P applied normally')
  })
})

describe('Host.currentTriad / centerPc — for lattice rendering', () => {
  // The lattice renderer needs to know which cell to highlight (currentTriad)
  // and which pc to center the lattice on (centerPc). Both are read after
  // step() emits chord-change events.
  test('currentTriad is null before any step', () => {
    const host = new Host(baseParams())
    assert.equal(host.currentTriad, null)
  })

  test('currentTriad reflects the chord emitted by the last step', () => {
    const host = new Host(baseParams())
    host.step(0)
    assert.deepEqual(host.currentTriad, [60, 64, 67])
  })

  test('currentTriad updates after a transform', () => {
    const host = new Host(baseParams({ cells: ['P'] }))
    host.step(0)
    host.step(1)
    // P(C major) = C minor at the same root midi note (60)
    const t = host.currentTriad!
    const pcs = t.map(n => ((n % 12) + 12) % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 3, 7])
  })

  test('currentTriad resets to null after panic', () => {
    const host = new Host(baseParams())
    host.step(0)
    host.panic()
    assert.equal(host.currentTriad, null)
  })

  test('centerPc is the pc of startChord[0]', () => {
    const host = new Host(baseParams({ startChord: [66, 70, 73] })) // F# major
    assert.equal(host.centerPc, 6)
  })

  test('centerPc updates when startChord changes via setParams', () => {
    const host = new Host(baseParams())
    assert.equal(host.centerPc, 0) // C
    host.setParams({ startChord: [65, 69, 72] }) // F major
    assert.equal(host.centerPc, 5)
  })
})
