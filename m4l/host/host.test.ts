import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCell, type Op } from '../engine/tonnetz.ts'
import { Host, type HostParams, type NoteEvent } from './host.ts'

function cells(...ops: Op[]): HostParams['cells'] {
  return ops.map(op => makeCell(op))
}

function baseParams(overrides: Partial<HostParams> = {}): HostParams {
  return {
    startChord: [60, 64, 67],
    cells: cells('P', 'L', 'R', 'hold'),
    stepsPerTransform: 1,
    voicing: 'close',
    seventh: false,
    jitter: 0,
    seed: 0,
    channel: 1,
    triggerMode: 0,
    inputChannel: 0,
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
    // ADR 005: each step now also schedules a gate-end noteOff at delayPos =
    // gate*spt for the new chord. The legato note-off discipline (prior off
    // before new on) is checked within the delayPos=0 slot only — gate-end
    // offs at delayPos > 0 are unrelated.
    const host = new Host(baseParams({ cells: cells('P') }))
    host.step(0)
    const events = host.step(1)
    const slot0 = events.filter(e => (e.delayPos ?? 0) === 0)
    const lastOffIdx = slot0.map(e => e.type).lastIndexOf('noteOff')
    const firstOnIdx = slot0.map(e => e.type).indexOf('noteOn')
    assert.ok(
      lastOffIdx < firstOnIdx,
      `all noteOffs must precede any noteOn within delayPos=0 (offs end at ${lastOffIdx}, ons start at ${firstOnIdx})`,
    )
    const handoffOffs = slot0.filter(e => e.type === 'noteOff').map(e => e.pitch).sort((a, b) => a - b)
    assert.deepEqual(handoffOffs, [60, 64, 67])
    const newPcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(newPcs, [0, 3, 7])
  })

  test('re-calling step with the same pos emits nothing', () => {
    const host = new Host(baseParams({ cells: cells('P') }))
    assert.equal(host.step(0).length, 3)
    assert.deepEqual(host.step(0), [])
  })

  test('supports scrubbing: step(n) without prior calls emits the chord at n', () => {
    // ADR 005: scrubbing now also schedules a gate-end noteOff at delayPos > 0.
    // No legato handoff (held set empty on first call), so delayPos=0 offs = 0.
    const host = new Host(baseParams({ cells: cells('P') }))
    const events = host.step(5)

    const handoffOffs = events.filter(e => e.type === 'noteOff' && (e.delayPos ?? 0) === 0)
    assert.equal(handoffOffs.length, 0, 'no legato handoff on a fresh scrub')
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

  test('hold cell re-emits the current chord (ADR 005 op effects table)', () => {
    // ADR 005 §"Op effects table": hold = cursor unchanged, audio = re-emit.
    // ADR 003-era "no events on hold" is superseded.
    const host = new Host(baseParams({ cells: cells('hold') }))
    host.step(0)
    for (const pos of [1, 2, 5, 17]) {
      const events = host.step(pos)
      const ons = events.filter(e => e.type === 'noteOn').map(e => e.pitch).sort((a, b) => a - b)
      assert.deepEqual(ons, [60, 64, 67], `pos=${pos} re-emits startChord`)
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
    // ADR 005: legato handoff offs (delayPos=0) target the previously voiced
    // notes; gate-end offs (delayPos > 0) target the new voicing — filter to
    // the handoff slot only for this assertion.
    const host = new Host(baseParams({ voicing: 'spread', cells: cells('P') }))
    host.step(0)
    const events = host.step(1)
    const handoffOffs = events
      .filter(e => e.type === 'noteOff' && (e.delayPos ?? 0) === 0)
      .map(e => e.pitch)
      .sort((a, b) => a - b)
    assert.deepEqual(handoffOffs, [60, 67, 76])
  })
})

describe('Host.step — Phase 2 per-cell scheduling (ADR 005)', () => {
  // ADR 005 §"Layer 1 — Per-cell expression": every emitted note carries
  // velocity scaling, gate-end note-off scheduling, and a timing offset.
  // delayPos is in pos-units (the same domain as step(pos)); step length =
  // stepsPerTransform pos-units.
  describe('NoteEvent.delayPos — gate scheduling', () => {
    test('default cell schedules gate-end noteOff at delayPos = gate * spt', () => {
      // Default cell: gate=0.9, spt=1 → scheduled noteOff at delayPos = 0.9.
      // Slot 0 carries the legato handoff for the prior chord and the new
      // chord's noteOn; the gate slot carries the new chord's note-off.
      const host = new Host(baseParams({ cells: cells('P') }))
      host.step(0)
      const events = host.step(1)
      const offsAtZero = events.filter(e => e.type === 'noteOff' && (e.delayPos ?? 0) === 0)
      const onsAtZero = events.filter(e => e.type === 'noteOn' && (e.delayPos ?? 0) === 0)
      const offsAtGate = events.filter(e => e.type === 'noteOff' && e.delayPos === 0.9)
      assert.equal(offsAtZero.length, 3, 'legato handoff for prior chord')
      assert.equal(onsAtZero.length, 3, 'new chord noteOn at boundary')
      assert.equal(offsAtGate.length, 3, 'gate-end noteOff at delayPos=0.9')
    })

    test('gate offset scales with stepsPerTransform', () => {
      // gate=0.5, spt=4 → scheduled noteOff at delayPos = 0 + 0.5*4 = 2.
      const c = makeCell('P', { gate: 0.5 })
      const host = new Host(baseParams({ cells: [c], stepsPerTransform: 4 }))
      host.step(0)
      const events = host.step(4)
      const offsAtTwo = events.filter(e => e.type === 'noteOff' && e.delayPos === 2)
      assert.equal(offsAtTwo.length, 3, 'noteOff scheduled at gate*spt')
    })

    test('gate=1.0 leaves chord for legato handoff (no scheduled noteOff this step)', () => {
      // gate=1.0 = "note-off coincident with next note-on" — no early off
      // scheduled; the next noteOn step carries the legato handoff.
      const c = makeCell('P', { gate: 1.0 })
      const host = new Host(baseParams({ cells: [c, c] }))
      host.step(0)
      const events1 = host.step(1)
      // Slot 0: 3 handoff offs (prior startChord) + 3 new noteOns. No gate-end offs.
      const offs = events1.filter(e => e.type === 'noteOff')
      const ons = events1.filter(e => e.type === 'noteOn')
      assert.equal(offs.length, 3, 'only legato handoff offs, no gate-end off')
      assert.equal(ons.length, 3)
      // Next step should emit handoff for the previously held (gate=1.0) chord.
      const events2 = host.step(2)
      const handoff2 = events2.filter(e => e.type === 'noteOff' && (e.delayPos ?? 0) === 0)
      assert.equal(handoff2.length, 3, 'next step emits legato handoff for gate=1.0 prior')
    })
  })

  describe('per-cell velocity', () => {
    test('cell.velocity multiplies source velocity (0.5 × 100 = 50)', () => {
      // 100 = default lastInputVelocity (no input wired); 0.5 = half scaling.
      const c = makeCell('P', { velocity: 0.5 })
      const host = new Host(baseParams({ cells: [c] }))
      host.step(0)
      const events = host.step(1)
      const vels = events.filter(e => e.type === 'noteOn').map(e => e.velocity)
      assert.equal(vels.length, 3)
      for (const v of vels) assert.equal(v, 50)
    })

    test('cell.velocity=1.0 default preserves source velocity (no scaling)', () => {
      const host = new Host(baseParams({ cells: cells('P') }))
      host.step(0)
      const events = host.step(1)
      const vels = events.filter(e => e.type === 'noteOn').map(e => e.velocity)
      for (const v of vels) assert.equal(v, 100)
    })

    test('cell.velocity=0 clamps to MIDI minimum 1 (avoid noteOff masquerade)', () => {
      // MIDI velocity 0 in a noteOn message is conventionally interpreted as
      // a noteOff. Clamp the output to >=1 so a fully-attenuated cell still
      // produces audible (if quiet) noteOns.
      const c = makeCell('P', { velocity: 0 })
      const host = new Host(baseParams({ cells: [c] }))
      host.step(0)
      const events = host.step(1)
      const vels = events.filter(e => e.type === 'noteOn').map(e => e.velocity)
      for (const v of vels) assert.equal(v, 1)
    })

    test('source velocity = lastInputVelocity, multiplied by cell.velocity', () => {
      // lastInputVelocity tracks the most recent noteIn (ADR 004).
      // 80 × 0.5 = 40.
      const c = makeCell('P', { velocity: 0.5 })
      const host = new Host(baseParams({ cells: [c] }))
      host.step(0)
      host.noteIn(60, 80, 1)
      const events = host.step(1)
      const vels = events.filter(e => e.type === 'noteOn').map(e => e.velocity)
      for (const v of vels) assert.equal(v, 40)
    })
  })

  describe('per-cell timing', () => {
    test('timing > 0 delays noteOn by timing * spt', () => {
      // timing=+0.25, spt=4 → delayPos = 1.0. Push (late) feel.
      const c = makeCell('P', { timing: 0.25 })
      const host = new Host(baseParams({ cells: [c], stepsPerTransform: 4 }))
      host.step(0)
      const events = host.step(4)
      const ons = events.filter(e => e.type === 'noteOn')
      assert.equal(ons.length, 3)
      for (const e of ons) assert.equal(e.delayPos, 1.0)
    })

    test('timing > 0 also delays the legato handoff so it lands just before the noteOn', () => {
      // ADR 003 note-off discipline: prior chord released before new noteOn.
      // With timing=0.25, both the handoff and the noteOn move to delayPos=1.0.
      const c = makeCell('P', { timing: 0.25 })
      const host = new Host(baseParams({ cells: [c], stepsPerTransform: 4 }))
      host.step(0)
      const events = host.step(4)
      const handoffOffs = events.filter(e => e.type === 'noteOff' && e.delayPos === 1.0)
      assert.equal(handoffOffs.length, 3, 'handoff offs co-located with noteOn at delayPos=1.0')
    })

    test('playback-start clamp: first scheduled cell with timing<0 → delayPos=0', () => {
      // ADR 005 §"Playback start clamp": at transport start, a negative
      // timing offset on the first scheduled cell cannot fire before t=0.
      const c = makeCell('P', { timing: -0.5 })
      const host = new Host(baseParams({ cells: [c, c] }))
      host.step(0)
      const events = host.step(1)
      const ons = events.filter(e => e.type === 'noteOn')
      for (const e of ons) assert.equal(e.delayPos ?? 0, 0)
    })

  })

  describe('probability', () => {
    test('probability=0 emits no events but still advances the chord cursor', () => {
      // ADR 005: P/L/R with prob fail = silent advance (cursor moves, no audio).
      const c = makeCell('P', { probability: 0 })
      const host = new Host(baseParams({ cells: [c] }))
      host.step(0)
      const events = host.step(1)
      assert.deepEqual(events, [])
      // Cursor advanced: P(Cmaj) = Cmin → pcs {0,3,7}.
      const pcs = host.currentTriad!.map(p => ((p % 12) + 12) % 12).sort((a, b) => a - b)
      assert.deepEqual(pcs, [0, 3, 7])
    })

    test('probability=0 with hold op = silent step, cursor unchanged', () => {
      // hold cursor untouched + prob fail = silent → entire step is a no-op
      // visible to the host.
      const c = makeCell('hold', { probability: 0 })
      const host = new Host(baseParams({ cells: [c] }))
      host.step(0)
      const events = host.step(1)
      assert.deepEqual(events, [])
      assert.deepEqual(host.currentTriad, [60, 64, 67])
    })

    test('determinism preserved across probability draws', () => {
      // Two hosts with identical seed must produce identical event streams.
      const c = makeCell('P', { probability: 0.5 })
      const a = new Host(baseParams({ cells: [c], seed: 7 }))
      const b = new Host(baseParams({ cells: [c], seed: 7 }))
      for (const pos of [0, 1, 2, 3, 4, 5, 10, 25]) {
        assert.deepEqual(a.step(pos), b.step(pos), `pos=${pos}`)
      }
    })
  })

  describe('rest op', () => {
    test('rest emits no events and leaves cursor unchanged', () => {
      // ADR 005: rest = silent hold; cursor unchanged.
      const c = makeCell('rest')
      const host = new Host(baseParams({ cells: [c] }))
      host.step(0)
      const events = host.step(1)
      assert.deepEqual(events, [])
      assert.deepEqual(host.currentTriad, [60, 64, 67])
    })

    test('rest does not fire a note-off — prior gate handles it', () => {
      // ADR 005: "Previous step's note dies according to its own gate
      // length — no special note-off at the rest boundary." Verify no events
      // on the rest step itself.
      const cP = makeCell('P', { gate: 0.5 })
      const cRest = makeCell('rest')
      const host = new Host(baseParams({ cells: [cP, cRest] }))
      host.step(0) // startChord
      host.step(1) // P fires; gate 0.5 schedules off at delayPos=0.5
      const events = host.step(2) // rest
      assert.deepEqual(events, [], 'rest step is silent; prior gate already scheduled')
    })
  })

  describe('hold op (re-emit)', () => {
    test('hold re-emits the current chord at every step (ADR 005)', () => {
      // Same as the test above in Host.step, but verifies the gate-end off
      // is also scheduled per re-trigger.
      const host = new Host(baseParams({ cells: cells('hold') }))
      host.step(0)
      const events = host.step(1)
      const ons = events.filter(e => e.type === 'noteOn')
      const offsAtGate = events.filter(e => e.type === 'noteOff' && e.delayPos === 0.9)
      assert.equal(ons.length, 3, 'hold re-emits noteOns')
      assert.equal(offsAtGate.length, 3, 'hold schedules gate-end off like any played step')
    })
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
    // ADR 005: count handoff offs (delayPos=0) only — gate-end offs are
    // scheduled per emission and unrelated to the prior-chord cleanup.
    const host = new Host(baseParams({ stepsPerTransform: 2, cells: cells('P') }))
    host.step(0)
    host.setParams({ voicing: 'spread' })
    assert.deepEqual(host.step(1), [])
    const events = host.step(2)
    assert.equal(pitchesOf(events, 'noteOn').length, 3)
    const handoffOffs = events.filter(e => e.type === 'noteOff' && (e.delayPos ?? 0) === 0)
    assert.equal(handoffOffs.length, 3, 'spread voicing reflected in handoff for prior close startChord')
  })
})

describe('Host.setCell', () => {
  test('mutates only the indexed cell', () => {
    const host = new Host(baseParams({ cells: cells('P', 'L', 'R', 'hold') }))
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
    const host = new Host(baseParams({ cells: cells('P', 'L', 'R', 'hold') }))
    host.setCell(-1, 'hold')
    host.setCell(99, 'hold')
    host.step(0)
    host.step(1)
    const pcs = host.currentTriad!.map(p => ((p % 12) + 12) % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 3, 7], 'cells unchanged → P applied normally')
  })
})

describe('Host.cellIdx — for active-cell LED', () => {
  // cellIdx(pos) returns the index of the cell whose op produced the chord
  // currently sounding. -1 when no transform has fired yet (pos < spt).
  // Derivation: walk() applies a transform at every pos % spt === 0 except
  // pos=0; after numTransforms = floor(pos / spt) transforms, the most-recent
  // cell consumed is index (numTransforms - 1) mod cells.length.
  test('returns -1 before the first transform fires', () => {
    const host = new Host(baseParams({ stepsPerTransform: 4 }))
    // pos < spt → numTransforms = 0 → no cell has fired
    assert.equal(host.cellIdx(0), -1)
    assert.equal(host.cellIdx(3), -1)
  })

  test('returns 0 once the first transform has fired', () => {
    const host = new Host(baseParams({ stepsPerTransform: 4 }))
    // pos in [spt, 2*spt) → numTransforms = 1 → cells[0] is the active cell
    assert.equal(host.cellIdx(4), 0)
    assert.equal(host.cellIdx(7), 0)
  })

  test('advances one cell per stepsPerTransform window', () => {
    const host = new Host(baseParams({ stepsPerTransform: 4 })) // cells length 4
    assert.equal(host.cellIdx(8), 1)  // cells[1] applied
    assert.equal(host.cellIdx(12), 2) // cells[2] applied
    assert.equal(host.cellIdx(16), 3) // cells[3] applied
  })

  test('wraps modulo cells.length', () => {
    const host = new Host(baseParams({ stepsPerTransform: 4 })) // cells length 4
    // numTransforms = 5, 6 → (5-1) % 4 = 0, (6-1) % 4 = 1
    assert.equal(host.cellIdx(20), 0)
    assert.equal(host.cellIdx(24), 1)
  })

  test('honours stepsPerTransform=1 with 2-cell array', () => {
    const host = new Host(baseParams({ stepsPerTransform: 1, cells: cells('P', 'L') }))
    assert.equal(host.cellIdx(0), -1) // no transform yet
    assert.equal(host.cellIdx(1), 0)  // cells[0]=P fired
    assert.equal(host.cellIdx(2), 1)  // cells[1]=L fired
    assert.equal(host.cellIdx(3), 0)  // wraps
  })

  test('reflects stepsPerTransform updates from setParams', () => {
    const host = new Host(baseParams({ stepsPerTransform: 1 }))
    assert.equal(host.cellIdx(2), 1) // 2 transforms with spt=1 → idx 1
    host.setParams({ stepsPerTransform: 4 })
    assert.equal(host.cellIdx(2), -1) // 0 transforms with spt=4
    assert.equal(host.cellIdx(8), 1)  // 2 transforms with spt=4 → idx 1
  })
})

describe('Host.noteIn (ADR 004 — input event model)', () => {
  test('triad input updates startChord and emits note-offs for sustained walker output', () => {
    const host = new Host(baseParams())
    host.step(0) // emit Cmaj noteOns; this.held = {60,64,67}
    // Play Fmaj: F=65, A=69, C=72 — third note completes the triad
    host.noteIn(65, 100, 1)
    host.noteIn(69, 100, 1)
    const events = host.noteIn(72, 100, 1)
    // Subset search picks Fmaj (root 65 < other matches if any), startChord changes.
    // recomputeStartChord emits noteOffs for previously sustained walker output.
    assert.deepEqual(pitchesOf(events, 'noteOff').sort((a, b) => a - b), [60, 64, 67])
    assert.deepEqual(pitchesOf(events, 'noteOn'), [], 'noteOns wait for next step')
    assert.deepEqual(host.startChord, [65, 69, 72])
  })

  test('next step after input-driven chord change emits the new chord at effective pos 0', () => {
    const host = new Host(baseParams({ cells: cells('P', 'L', 'R') }))
    host.step(0); host.step(1); host.step(2) // walker has advanced
    host.noteIn(65, 100, 1); host.noteIn(69, 100, 1); host.noteIn(72, 100, 1) // Fmaj
    // Subsequent step at any pos: walker emits new startChord (Fmaj close) — cells not applied yet.
    const events = host.step(7)
    const pcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 5, 9]) // Fmaj
  })

  test('lastInputVelocity updates on every note-on and is used for walker output', () => {
    const host = new Host(baseParams({ cells: cells('P') }))
    host.step(0) // emit Cmaj at default vel 100
    host.noteIn(60, 80, 1) // single note, no triad — startChord unchanged, lastInputVelocity = 80
    const events = host.step(1) // P → Cmin, emit noteOns at new vel 80
    const onVels = events.filter(e => e.type === 'noteOn').map(e => (e as { velocity: number }).velocity)
    assert.ok(onVels.length > 0, 'expected noteOns')
    for (const v of onVels) assert.equal(v, 80)
  })

  test('default lastInputVelocity is 100 before any input', () => {
    const host = new Host(baseParams())
    const events = host.step(0)
    const onVels = events.filter(e => e.type === 'noteOn').map(e => (e as { velocity: number }).velocity)
    for (const v of onVels) assert.equal(v, 100)
  })

  test('non-triad input does not update startChord', () => {
    const host = new Host(baseParams())
    const initial = host.startChord
    host.noteIn(60, 100, 1) // C
    host.noteIn(62, 100, 1) // C-D
    host.noteIn(67, 100, 1) // C-D-G = Csus2, not a Tonnetz triad
    assert.deepEqual(host.startChord, initial)
  })

  test('partial input (1 or 2 notes) does not update startChord', () => {
    const host = new Host(baseParams())
    const initial = host.startChord
    host.noteIn(60, 100, 1)
    assert.deepEqual(host.startChord, initial)
    host.noteIn(64, 100, 1)
    assert.deepEqual(host.startChord, initial)
  })

  test('inputChannel = 0 (omni) accepts notes on any channel', () => {
    const host = new Host(baseParams({ inputChannel: 0 }))
    host.noteIn(60, 100, 5)
    host.noteIn(64, 100, 7)
    host.noteIn(67, 100, 11)
    assert.deepEqual(host.startChord, [60, 64, 67])
  })

  test('inputChannel = N rejects notes on other channels', () => {
    const host = new Host(baseParams({ inputChannel: 2 }))
    const initial = host.startChord
    host.noteIn(65, 100, 1) // wrong channel
    host.noteIn(69, 100, 1)
    host.noteIn(72, 100, 1)
    assert.deepEqual(host.startChord, initial, 'channel 1 ignored when filter=2')
    host.noteIn(65, 100, 2)
    host.noteIn(69, 100, 2)
    host.noteIn(72, 100, 2)
    assert.deepEqual(host.startChord, [65, 69, 72])
  })
})

describe('Host.noteOff (ADR 004 — trigger model)', () => {
  test('hybrid: walker continues running after all notes released', () => {
    const host = new Host(baseParams({ triggerMode: 0, cells: cells('P') }))
    host.noteIn(60, 100, 1); host.noteIn(64, 100, 1); host.noteIn(67, 100, 1)
    host.step(0) // walker emits Cmaj
    host.noteOff(60, 1); host.noteOff(64, 1); host.noteOff(67, 1)
    const events = host.step(1) // P → Cmin
    const pcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 3, 7], 'walker still emits after release in hybrid mode')
  })

  test('hybrid: removing one note can expose a different triad subset', () => {
    const host = new Host(baseParams({ triggerMode: 0 }))
    // Hold Cmaj7 = C E G B → Cmaj wins (subset match, lowest root)
    host.noteIn(60, 100, 1); host.noteIn(64, 100, 1); host.noteIn(67, 100, 1); host.noteIn(71, 100, 1)
    assert.deepEqual(host.startChord, [60, 64, 67])
    // Release C → E G B remains = Em
    host.noteOff(60, 1)
    assert.deepEqual(host.startChord, [64, 67, 71])
  })

  test('hold-to-play: last note-off triggers panic and pauses the walker', () => {
    const host = new Host(baseParams({ triggerMode: 1, cells: cells('P') }))
    host.noteIn(60, 100, 1); host.noteIn(64, 100, 1); host.noteIn(67, 100, 1)
    host.step(0) // emit Cmaj
    host.noteOff(60, 1); host.noteOff(64, 1)
    const finalRelease = host.noteOff(67, 1)
    assert.deepEqual(pitchesOf(finalRelease, 'noteOff').sort((a, b) => a - b), [60, 64, 67])
    // Walker is paused
    assert.deepEqual(host.step(1), [])
    assert.deepEqual(host.step(2), [])
    assert.equal(host.cellIdx(2), -1)
  })

  test('hold-to-play: note-on after release reactivates the walker and resets cells from cells[0]', () => {
    const host = new Host(baseParams({ triggerMode: 1, cells: cells('P') }))
    host.noteIn(60, 100, 1); host.noteIn(64, 100, 1); host.noteIn(67, 100, 1)
    host.step(0); host.step(1) // walker advances to P(Cmaj) = Cmin
    host.noteOff(60, 1); host.noteOff(64, 1); host.noteOff(67, 1)
    host.step(2) // paused, no events
    // Re-press Cmaj — same chord, but walker should restart from cells[0]
    host.noteIn(60, 100, 1); host.noteIn(64, 100, 1); host.noteIn(67, 100, 1)
    const events = host.step(3) // walker active again, emits Cmaj startChord (cells not applied yet)
    const pcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 4, 7], 'walker resumes at startChord, cells fresh')
  })

  test('hybrid: note-off does not trigger panic even with no notes held', () => {
    const host = new Host(baseParams({ triggerMode: 0, cells: cells('P') }))
    host.noteIn(60, 100, 1); host.noteIn(64, 100, 1); host.noteIn(67, 100, 1)
    host.step(0)
    const events = host.noteOff(60, 1) // not the last release; should also not panic
    assert.deepEqual(events, [], 'no panic in hybrid even when held set thins')
    host.noteOff(64, 1); host.noteOff(67, 1) // all released
    const stepEvents = host.step(1) // walker still alive
    assert.ok(stepEvents.length > 0)
  })
})

describe('Host.transportStart (ADR 004 — pre-roll)', () => {
  test('with no held notes, walker uses the persisted lattice startChord', () => {
    const host = new Host(baseParams({ startChord: [62, 65, 69] })) // Dm
    const events = host.transportStart()
    assert.deepEqual(events, [], 'no events emitted directly')
    assert.deepEqual(host.startChord, [62, 65, 69])
    const stepEvents = host.step(0)
    const pcs = pitchesOf(stepEvents, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [2, 5, 9])
  })

  test('with held notes, derives startChord from the snapshot', () => {
    const host = new Host(baseParams({ startChord: [60, 64, 67] }))
    // User pre-pressed Fmaj before transport — these noteIns may or may not have
    // triggered chord changes already (they did, since 3rd note completes triad);
    // transportStart re-runs the snapshot path idempotently.
    host.noteIn(65, 100, 1); host.noteIn(69, 100, 1); host.noteIn(72, 100, 1)
    host.transportStart()
    const events = host.step(0)
    const pcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 5, 9])
  })

  test('hold-to-play: transportStart with no held notes keeps walker paused', () => {
    const host = new Host(baseParams({ triggerMode: 1 }))
    host.transportStart()
    assert.deepEqual(host.step(0), [], 'no walker emission without held notes')
  })

  test('hold-to-play: transportStart with held notes activates walker', () => {
    const host = new Host(baseParams({ triggerMode: 1, startChord: [60, 64, 67] }))
    host.noteIn(60, 100, 1); host.noteIn(64, 100, 1); host.noteIn(67, 100, 1)
    host.transportStart()
    const events = host.step(0)
    const pcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 4, 7])
  })
})

describe('Host pos reset on startChord change (ADR 004 Axis 5)', () => {
  test('lattice setParams startChord at non-zero pos: walker emits new startChord on next step', () => {
    const host = new Host(baseParams({ cells: cells('P') }))
    host.step(0); host.step(1); host.step(2)
    host.setParams({ startChord: [65, 69, 72] }) // Fmaj
    const events = host.step(3) // pendingPosReset → effectivePos = 0 → walker emits startChord
    const pcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 5, 9], 'Fmaj startChord, no transform applied yet')
  })

  test('input-driven startChord change resets cell program', () => {
    const host = new Host(baseParams({ cells: cells('P', 'L') }))
    host.step(0); host.step(1); host.step(2)
    host.noteIn(65, 100, 1); host.noteIn(69, 100, 1); host.noteIn(72, 100, 1) // Fmaj
    const events = host.step(3)
    const pcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 5, 9], 'cells fresh: walker on Fmaj startChord, cells[0] not yet applied')
    // Next step: cells[0] = P → F minor
    const next = host.step(4)
    const nextPcs = pitchesOf(next, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(nextPcs, [0, 5, 8])
  })

  test('setParams startChord with the same triad does not reset pos', () => {
    const host = new Host(baseParams({ cells: cells('P') }))
    host.step(0); host.step(1) // walker on Cmin (P applied)
    host.setParams({ startChord: [60, 64, 67] }) // same value re-asserted (e.g. dump cascade)
    const events = host.step(2) // walker should continue: P^2(Cmaj) = Cmaj
    const pcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 4, 7])
  })

  test('replay determinism: two fresh hosts driven by the same input event sequence produce identical output', () => {
    const script: Array<['step', number] | ['noteIn', number, number, number] | ['noteOff', number, number] | ['transportStart']> = [
      ['transportStart'],
      ['step', 0],
      ['step', 1],
      ['noteIn', 65, 90, 1], ['noteIn', 69, 90, 1], ['noteIn', 72, 90, 1],
      ['step', 2], ['step', 3],
      ['noteOff', 65, 1], ['noteOff', 69, 1], ['noteOff', 72, 1],
      ['noteIn', 67, 80, 1], ['noteIn', 71, 80, 1], ['noteIn', 74, 80, 1], // Gmaj
      ['step', 4], ['step', 5], ['step', 6],
    ]
    function run(): NoteEvent[] {
      const h = new Host(baseParams({ cells: cells('P', 'L', 'R', 'hold'), jitter: 0.5, seed: 42 }))
      const out: NoteEvent[] = []
      for (const cmd of script) {
        if (cmd[0] === 'step') out.push(...h.step(cmd[1]))
        else if (cmd[0] === 'noteIn') out.push(...h.noteIn(cmd[1], cmd[2], cmd[3]))
        else if (cmd[0] === 'noteOff') out.push(...h.noteOff(cmd[1], cmd[2]))
        else if (cmd[0] === 'transportStart') out.push(...h.transportStart())
      }
      return out
    }
    assert.deepEqual(run(), run(), 'replay must be bit-identical')
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
    const host = new Host(baseParams({ cells: cells('P') }))
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

describe('Host.isWalkerActive — for marker / cellIdx UI gating', () => {
  // The bridge layer needs to distinguish "walker paused via hold-to-play
  // last release" (marker should clear) from "startChord just changed but
  // walker keeps running" (marker should move to the new chord). Both
  // states leave currentTriad === null transiently, so currentTriad alone
  // cannot disambiguate; isWalkerActive is the dedicated signal.
  test('default is true', () => {
    const host = new Host(baseParams())
    assert.equal(host.isWalkerActive, true)
  })

  test('hybrid: stays true across input + release', () => {
    const host = new Host(baseParams({ triggerMode: 0 }))
    host.noteIn(60, 100, 1)
    host.noteIn(64, 100, 1)
    host.noteIn(67, 100, 1)
    assert.equal(host.isWalkerActive, true)
    host.noteOff(60, 1)
    host.noteOff(64, 1)
    host.noteOff(67, 1)
    assert.equal(host.isWalkerActive, true)
  })

  test('hold-to-play: false after last release, true again after next note-on', () => {
    const host = new Host(baseParams({ triggerMode: 1 }))
    host.noteIn(60, 100, 1)
    host.noteIn(64, 100, 1)
    host.noteIn(67, 100, 1)
    assert.equal(host.isWalkerActive, true)
    host.noteOff(60, 1)
    host.noteOff(64, 1)
    host.noteOff(67, 1)
    assert.equal(host.isWalkerActive, false)
    host.noteIn(62, 100, 1)
    assert.equal(host.isWalkerActive, true)
  })

  test('input-driven chord change leaves currentTriad null but isWalkerActive true', () => {
    const host = new Host(baseParams())
    host.step(0) // populates currentTriad
    host.noteIn(65, 100, 1)
    host.noteIn(69, 100, 1)
    host.noteIn(72, 100, 1) // F major triad → startChord change
    assert.equal(host.currentTriad, null)
    assert.equal(host.isWalkerActive, true)
  })
})
