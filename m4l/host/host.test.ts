import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Host, type HostParams, type NoteEvent } from './host.ts'

function baseParams(overrides: Partial<HostParams> = {}): HostParams {
  return {
    startChord: [60, 64, 67],
    sequence: ['P'],
    stepsPerTransform: 1,
    voicing: 'close',
    seventh: false,
    anchors: [],
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
    const host = new Host(baseParams())
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
    const host = new Host(baseParams())
    assert.equal(host.step(0).length, 3)
    assert.deepEqual(host.step(0), [])
  })

  test('supports scrubbing: step(n) without prior calls emits the chord at n', () => {
    const host = new Host(baseParams())
    const events = host.step(5)

    assert.equal(pitchesOf(events, 'noteOff').length, 0)
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

  test('anchor at a step overrides the walked chord', () => {
    const host = new Host(baseParams({
      anchors: [{ step: 2, triad: [65, 69, 72] }],
    }))
    host.step(0)
    host.step(1)
    const events = host.step(2)
    const pcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 5, 9])
  })

  test('noteOffs at chord change match the previously voiced notes (not the raw triad)', () => {
    const host = new Host(baseParams({ voicing: 'spread' }))
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
    const host = new Host(baseParams({ stepsPerTransform: 2 }))
    host.step(0)
    host.setParams({ voicing: 'spread' })
    assert.deepEqual(host.step(1), [])
    const events = host.step(2)
    assert.equal(pitchesOf(events, 'noteOn').length, 3)
    assert.equal(pitchesOf(events, 'noteOff').length, 3)
  })
})
