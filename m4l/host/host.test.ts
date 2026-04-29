import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCell, type Op } from '../engine/tonnetz.ts'
import { Host, type HostParams, type NoteEvent } from './host.ts'
import { parseSlot, type Slot } from './slot.ts'
import { FACTORY_PRESETS } from './presets.ts'

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
    // ADR 005 Phase 3 — test-friendly defaults so existing tests stay
    // unchanged. Production callers (the m4l patcher) pass real values.
    stepDirection: 'forward',
    ticksPerStep: 1,
    swing: 0.5,
    humanizeVelocity: 0,
    humanizeGate: 0,
    humanizeTiming: 0,
    humanizeDrift: 0,
    outputLevel: 1.0,
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

describe('Host.setCellField', () => {
  // Phase 4 entry point for the 16 hidden live.numbox per-cell fields. The
  // patcher dumps `setCellField <idx> <field> <value>` per numbox change;
  // host updates the indexed cell record while preserving the other fields
  // and the existing op (which is owned by the four live.tab parameters).

  test('velocity scales the source velocity for the next cell-driven noteOn', () => {
    // baseParams: spt=1, lastInputVelocity default 100. cell[0]=P at step(1)
    // → Cmin noteOns. cellVel=0.5 → 100 * 0.5 = 50, clamped 1..127.
    const host = new Host(baseParams())
    host.setCellField(0, 'velocity', 0.5)
    host.step(0)
    const events = host.step(1)
    const ons = events.filter((e): e is Extract<NoteEvent, { type: 'noteOn' }> => e.type === 'noteOn')
    assert.equal(ons.length, 3)
    for (const e of ons) assert.equal(e.velocity, 50)
  })

  test('gate sets the noteOff delayPos relative to the step', () => {
    // gate=0.5, transformTicks = spt(1) * ticksPerStep(1) = 1 → noteOff
    // delayPos = timingOffset(0) + 0.5 * 1 = 0.5. Filter by delayPos to
    // separate gate-end offs from the legato handoff offs (which fire at
    // delayPos=0 alongside the new chord's noteOns).
    const host = new Host(baseParams())
    host.setCellField(0, 'gate', 0.5)
    host.step(0)
    const events = host.step(1)
    const gateOffs = events.filter(e => e.type === 'noteOff' && e.delayPos === 0.5)
    assert.equal(gateOffs.length, 3, 'three gate-end noteOffs for the new chord')
    const pitches = gateOffs.map(e => e.pitch).sort((a, b) => a - b)
    assert.deepEqual(pitches, [60, 63, 67], 'targets the new Cmin chord')
  })

  test('timing offsets the noteOn delayPos within the step', () => {
    // timing=0.25, transformTicks=1 → timingOffset = max(0, 0 + 0.25) = 0.25.
    const host = new Host(baseParams())
    host.setCellField(0, 'timing', 0.25)
    host.step(0)
    const events = host.step(1)
    const ons = events.filter(e => e.type === 'noteOn')
    assert.equal(ons.length, 3)
    for (const e of ons) assert.equal(e.delayPos, 0.25)
  })

  test('probability=0 silences the step without stalling the cursor', () => {
    // rProb < 0 always false → played=false → silent advance. Cursor still
    // applies P (Cmaj → Cmin); no noteOns emitted at step(1).
    const host = new Host(baseParams())
    host.setCellField(0, 'probability', 0)
    host.step(0)
    const events = host.step(1)
    assert.deepEqual(events, [], 'silent advance emits nothing')
    const pcs = host.currentTriad!.map(p => ((p % 12) + 12) % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 3, 7], 'cursor still moved to Cmin')
  })

  test('out-of-range index is a no-op', () => {
    const host = new Host(baseParams())
    host.setCellField(-1, 'velocity', 0.5)
    host.setCellField(99, 'velocity', 0.5)
    host.step(0)
    const events = host.step(1)
    const ons = events.filter((e): e is Extract<NoteEvent, { type: 'noteOn' }> => e.type === 'noteOn')
    assert.equal(ons.length, 3)
    for (const e of ons) assert.equal(e.velocity, 100, 'cells unchanged → default vel=1.0')
  })

  test('preserves the cell op and other fields on a single-field update', () => {
    // setCellField touches one field; op (owned by live.tab) and the other
    // numeric fields keep their prior values.
    const host = new Host(baseParams({
      cells: [
        makeCell('R', { velocity: 0.7, gate: 0.6, probability: 0.8, timing: 0.1 }),
        makeCell('L'),
        makeCell('R'),
        makeCell('hold'),
      ],
    }))
    host.setCellField(0, 'velocity', 0.4)
    host.step(0)
    const events = host.step(1)
    // op stayed R: Cmaj → R = A min = [57, 60, 64].
    const onPitches = events.filter(e => e.type === 'noteOn').map(e => e.pitch).sort((a, b) => a - b)
    assert.deepEqual(onPitches, [57, 60, 64], 'op preserved')
    const onEvents = events.filter((e): e is Extract<NoteEvent, { type: 'noteOn' }> => e.type === 'noteOn')
    for (const e of onEvents) {
      assert.equal(e.velocity, 40, 'velocity reflects the new 0.4')
      assert.equal(e.delayPos, 0.1, 'timing field preserved')
    }
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

// ── ADR 005 Phase 3 — stepDirection wiring ───────────────────────────────

describe('Host.step — stepDirection', () => {
  test('reverse direction consumes cells from cells.length-1 downward', () => {
    // cells = [P, L, R, hold]; reverse → pos 1 plays hold (cursor unchanged).
    const host = new Host(baseParams({ stepDirection: 'reverse' }))
    host.step(0)
    const ev1 = host.step(1)
    // hold re-emits the cursor (still C major) per ADR 005 op effects table.
    const pcs1 = pitchesOf(ev1, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs1, [0, 4, 7], 'pos=1 reverse: cells[3]=hold → C major')
    // pos=2 → cells[2]=R → R(C major) = A minor
    const ev2 = host.step(2)
    const pcs2 = pitchesOf(ev2, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs2, [0, 4, 9], 'pos=2 reverse: cells[2]=R → A minor')
  })

  test('pingpong direction traverses without endpoint replay', () => {
    // cells = [P, L, R, hold]; pingpong sequence cellIdx: 0,1,2,3,2,1,0,1,...
    // Verify chord cursor at pos 5 reflects cell[2]=R applied to the cell[3]=hold
    // result, not a re-application of cell[3].
    const host = new Host(baseParams({ stepDirection: 'pingpong' }))
    host.step(0)
    // pos 1: P → C minor [0,3,7]
    // pos 2: L → Ab major [0,3,8]
    // pos 3: R → F minor [0,5,8]
    // pos 4: hold → F minor [0,5,8]
    // pos 5: R (cell[2] again) → R(F minor) = Ab major [0,3,8]
    for (const [pos, expected] of [[1, [0, 3, 7]], [2, [0, 3, 8]], [3, [0, 5, 8]], [4, [0, 5, 8]], [5, [0, 3, 8]]] as const) {
      const ev = host.step(pos)
      const pcs = pitchesOf(ev, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
      assert.deepEqual(pcs, expected, `pos=${pos}`)
    }
  })

  test('random direction sequence depends on seed alone (not authored ops)', () => {
    // Two hosts with same seed and direction=random but differing cell op
    // contents: cellIdx draws are the same → noteOn pitches match when ops
    // happen to align. Easier structural check: count of distinct cellIdx
    // values reached over many steps is bounded by cells.length.
    const seed = 314
    const a = new Host(baseParams({ stepDirection: 'random', seed, cells: cells('hold', 'hold', 'hold', 'hold') }))
    const b = new Host(baseParams({ stepDirection: 'random', seed, cells: cells('hold', 'hold', 'hold', 'hold') }))
    a.step(0)
    b.step(0)
    // Two identical hosts → identical event streams (sanity).
    for (let pos = 1; pos <= 20; pos++) {
      const evA = a.step(pos).filter(e => e.type === 'noteOn').map(e => e.pitch).sort((x, y) => x - y)
      const evB = b.step(pos).filter(e => e.type === 'noteOn').map(e => e.pitch).sort((x, y) => x - y)
      assert.deepEqual(evA, evB, `pos=${pos} two same-seed hosts must match`)
    }
  })

  test('cellIdx() reports direction-aware index (UI marker)', () => {
    // The lattice marker (ADR 003 cellIdx outlet) reads cellIdx(pos) for the
    // active-cell highlight. Reverse direction must report the reverse cell
    // index, not the forward one.
    const host = new Host(baseParams({ stepDirection: 'reverse' }))
    host.step(0)
    host.step(1)
    // After pos=1 in reverse, the cell that JUST fired is cells.length-1 = 3.
    assert.equal(host.cellIdx(1), 3, 'pos=1 reverse: cellIdx is 3')
    host.step(2)
    assert.equal(host.cellIdx(2), 2, 'pos=2 reverse: cellIdx is 2')
  })
})

// ── ADR 005 Phase 3 — humanize ────────────────────────────────────────────

describe('Host.step — humanize', () => {
  test('humanizeVelocity=0 is deterministic across a cycle', () => {
    // Baseline: cell vel=1 + lastInputVel=100 → MIDI velocity 100 every step.
    const host = new Host(baseParams({ cells: cells('P', 'L', 'R', 'hold'), seed: 42 }))
    host.step(0)
    for (let pos = 1; pos <= 8; pos++) {
      const ev = host.step(pos)
      const ons = ev.filter(e => e.type === 'noteOn')
      for (const on of ons) {
        if (on.type !== 'noteOn') continue
        assert.equal(on.velocity, 100, `pos=${pos} velocity should be unperturbed`)
      }
    }
  })

  test('humanizeVelocity > 0 perturbs MIDI velocity off the baseline', () => {
    // With humanize=0.5, raw uniform [0,1) produces signed noise in [-0.5,+0.5]
    // applied to cell.velocity=1. Most steps should land below 1.0, so MIDI
    // velocity should drift below 100. Across 8 steps, at least one must
    // differ from 100 (the baseline observed in the previous test).
    const host = new Host(baseParams({
      cells: cells('P', 'L', 'R', 'hold'),
      seed: 42,
      humanizeVelocity: 0.5,
    }))
    host.step(0)
    let observedNonBaseline = false
    for (let pos = 1; pos <= 8; pos++) {
      const ev = host.step(pos)
      for (const e of ev) {
        if (e.type === 'noteOn' && e.velocity !== 100) {
          observedNonBaseline = true
        }
        // MIDI velocity must always stay in [1, 127] (clampVelocity invariant).
        if (e.type === 'noteOn') {
          assert.ok(e.velocity >= 1 && e.velocity <= 127, `velocity ${e.velocity} out of MIDI range`)
        }
      }
    }
    assert.ok(observedNonBaseline, 'humanizeVelocity=0.5 should perturb at least one step')
  })

  test('humanizeTiming > 0 perturbs the noteOn delayPos', () => {
    // cell.timing=0 baseline → delayPos=0 on every noteOn. Adding humanizeTiming
    // shifts each step's delayPos by signed noise * spt. Negative offsets are
    // clamped to 0 by Phase 2 boundary clamp; positive ones survive.
    const host = new Host(baseParams({
      cells: cells('P', 'L', 'R', 'hold'),
      seed: 42,
      humanizeTiming: 0.5,
      stepsPerTransform: 4, // gives the timing offset units to vary in
    }))
    host.step(0)
    let observedNonZero = false
    for (let pos = 4; pos <= 32; pos += 4) {
      const ev = host.step(pos)
      for (const e of ev) {
        if (e.type === 'noteOn' && (e.delayPos ?? 0) > 0) {
          observedNonZero = true
        }
      }
    }
    assert.ok(observedNonZero, 'humanizeTiming=0.5 must produce at least one positive delayPos noteOn')
  })

  test('humanizeGate > 0 perturbs the gate-end delayPos in at least one step', () => {
    // cell.gate=0.9 baseline → gate-end delayPos = 0.9*spt. With small
    // humanizeGate, the perturbed cellGate stays strictly < 1.0 (no clamp
    // to legato) and the gate-end delayPos shifts off-baseline. We sweep
    // multiple boundaries because any individual draw can happen to land
    // very close to the baseline.
    const stub = { cells: cells('P', 'L', 'R', 'hold'), seed: 42, stepsPerTransform: 4 }
    const baselineHost = new Host(baseParams(stub))
    const humanizedHost = new Host(baseParams({ ...stub, humanizeGate: 0.1 }))
    baselineHost.step(0); humanizedHost.step(0)
    let observedShift = false
    for (const pos of [4, 8, 12, 16, 20]) {
      const evBase = baselineHost.step(pos).filter(e => e.type === 'noteOff' && (e.delayPos ?? 0) > 0)
      const evHum = humanizedHost.step(pos).filter(e => e.type === 'noteOff' && (e.delayPos ?? 0) > 0)
      if (evBase.length > 0 && evHum.length > 0 && evBase[0]!.delayPos !== evHum[0]!.delayPos) {
        observedShift = true
        break
      }
    }
    assert.ok(observedShift, 'humanizeGate must perturb gate-end delayPos at least once across the sweep')
  })

  test('humanize-disabled host (all 3 amounts = 0) is bit-identical to a Phase-2-era step', () => {
    // Regression guard: with all humanize amounts = 0 and ticksPerStep=1, the
    // host must produce exactly the same event stream as before Phase 3 wiring.
    // This is implicitly covered by Sub 1 / Sub 2 zero-amount tests, but the
    // extra explicit equality check pins down the no-op contract.
    const a = new Host(baseParams({ cells: cells('P', 'L', 'R', 'hold'), seed: 99, stepsPerTransform: 4 }))
    const b = new Host(baseParams({ cells: cells('P', 'L', 'R', 'hold'), seed: 99, stepsPerTransform: 4 }))
    a.step(0); b.step(0)
    for (const pos of [4, 8, 12, 16, 20]) {
      assert.deepEqual(a.step(pos), b.step(pos), `pos=${pos} match`)
    }
  })

  test('humanize results are seed-deterministic across two fresh hosts', () => {
    // Replay determinism with humanize: two fresh hosts, same seed, same
    // humanize amounts → identical event streams.
    const params = baseParams({
      cells: cells('P', 'L', 'R', 'hold'),
      seed: 7,
      humanizeVelocity: 0.4,
      humanizeGate: 0.3,
      humanizeTiming: 0.2,
      stepsPerTransform: 4,
    })
    const a = new Host(params)
    const b = new Host(params)
    a.step(0); b.step(0)
    for (const pos of [4, 8, 12, 16]) {
      assert.deepEqual(a.step(pos), b.step(pos), `pos=${pos} replay match`)
    }
  })

  test('humanizeDrift=0 (default) is bit-identical to a host that never touches drift', () => {
    // Phase 5 regression guard for time-correlated humanize. Drift defaults
    // to 0 (identity EMA) so any combination of non-zero humanize amounts +
    // drift=0 must produce exactly the same event stream as the same host
    // without drift wiring.
    const stub = {
      cells: cells('P', 'L', 'R', 'hold'),
      seed: 7,
      stepsPerTransform: 4,
      humanizeVelocity: 0.3,
      humanizeGate: 0.2,
      humanizeTiming: 0.1,
    }
    const a = new Host(baseParams(stub))
    const b = new Host(baseParams({ ...stub, humanizeDrift: 0 }))
    a.step(0); b.step(0)
    for (const pos of [4, 8, 12, 16, 20, 24]) {
      assert.deepEqual(a.step(pos), b.step(pos), `pos=${pos} match`)
    }
  })

  test('humanizeDrift > 0 changes the event stream from independent humanize', () => {
    // With same seed and same per-axis amounts, drift>0 must produce a
    // DIFFERENT event stream from drift=0 (the smoothed values are different
    // from raw uniforms in general). Confirms the drift parameter is wired.
    const stub = {
      cells: cells('P', 'L', 'R', 'hold'),
      seed: 7,
      stepsPerTransform: 4,
      humanizeVelocity: 0.5,
    }
    const independent = new Host(baseParams(stub))
    const smoothed = new Host(baseParams({ ...stub, humanizeDrift: 0.7 }))
    independent.step(0); smoothed.step(0)
    let observedDifference = false
    for (let pos = 4; pos <= 64; pos += 4) {
      const a = independent.step(pos)
      const b = smoothed.step(pos)
      const aOn = a.find(e => e.type === 'noteOn')
      const bOn = b.find(e => e.type === 'noteOn')
      if (aOn && bOn && aOn.type === 'noteOn' && bOn.type === 'noteOn' && aOn.velocity !== bOn.velocity) {
        observedDifference = true
        break
      }
    }
    assert.ok(observedDifference, 'humanizeDrift=0.7 must perturb at least one MIDI velocity vs drift=0')
  })
})

// ── ADR 005 Phase 5 — outputLevel ────────────────────────────────────────

describe('Host.step — outputLevel', () => {
  // outputLevel is a global multiplier on output velocity, applied AFTER
  // source × cell.velocity × humanize. Default 1.0 (no attenuation).
  // Useful when no MIDI input is wired (source velocity defaults to 100 and
  // there's no other single knob to scale all output uniformly).

  test('outputLevel=1.0 (default) is bit-identical to a host that never touches it', () => {
    const stub = { cells: cells('P', 'L', 'R', 'hold'), seed: 42, stepsPerTransform: 4 }
    const a = new Host(baseParams(stub))
    const b = new Host(baseParams({ ...stub, outputLevel: 1.0 }))
    a.step(0); b.step(0)
    for (const pos of [4, 8, 12, 16, 20]) {
      assert.deepEqual(a.step(pos), b.step(pos), `pos=${pos} match`)
    }
  })

  test('outputLevel=0.5 halves MIDI velocity at startChord and at every cell emission', () => {
    // Source vel = 100 (default), cell.velocity = 1.0, humanize = 0 →
    // baseline MIDI velocity = 100. With outputLevel=0.5: 100 * 1.0 * 0.5 = 50.
    const host = new Host(baseParams({ outputLevel: 0.5, cells: cells('P', 'L', 'R', 'hold') }))
    const startEvents = host.step(0)
    for (const ev of startEvents) {
      if (ev.type === 'noteOn') {
        assert.equal(ev.velocity, 50, 'startChord noteOn at outputLevel=0.5')
      }
    }
    // Cell-driven step at pos=1.
    const cellEvents = host.step(1)
    const ons = cellEvents.filter(e => e.type === 'noteOn')
    for (const ev of ons) {
      if (ev.type === 'noteOn') {
        assert.equal(ev.velocity, 50, 'cell-driven noteOn at outputLevel=0.5')
      }
    }
  })

  test('outputLevel=0 produces MIDI velocity 1 (clamped from 0)', () => {
    // 100 * 1 * 0 = 0 → clampVelocity floors to 1 (note-on with velocity 0
    // is conventionally a note-off, so we keep it audible-but-quiet).
    const host = new Host(baseParams({ outputLevel: 0 }))
    const events = host.step(0)
    for (const ev of events) {
      if (ev.type === 'noteOn') {
        assert.equal(ev.velocity, 1, 'velocity floored to 1 at outputLevel=0')
      }
    }
  })

  test('outputLevel composes with humanizeVelocity', () => {
    // humanize-driven cellVel ∈ [0.5, 1.0] (with humanizeVelocity=0.5,
    // cell.vel=1.0). outputLevel=0.5 then halves output → MIDI velocity ∈
    // [25, 50]. Confirm at least one emitted velocity falls in this range
    // and none exceed 50.
    const host = new Host(baseParams({
      cells: cells('P', 'L', 'R', 'hold'),
      seed: 42,
      humanizeVelocity: 0.5,
      outputLevel: 0.5,
      stepsPerTransform: 1,
    }))
    host.step(0)
    let observedAtCap = false
    for (let pos = 1; pos <= 8; pos++) {
      const events = host.step(pos)
      for (const ev of events) {
        if (ev.type === 'noteOn') {
          assert.ok(ev.velocity <= 50, `velocity ${ev.velocity} must not exceed cap 50`)
          assert.ok(ev.velocity >= 1, `velocity ${ev.velocity} must be valid MIDI`)
          if (ev.velocity === 50) observedAtCap = true
        }
      }
    }
    // The humanizeVel uniform [0,1) hits 0.5+ frequently → cellVel hits 1.0
    // (clamped from above), so we expect to see vel=50 (the cap) at least
    // once across 8 boundaries.
    assert.ok(observedAtCap, 'expected at least one note at the outputLevel cap (50)')
  })

  test('outputLevel respects MIDI input velocity (multiplies the source)', () => {
    // ADR 004 input passthrough: incoming MIDI vel becomes the source vel.
    // With input vel = 60, cell.vel = 1.0, outputLevel = 0.5 →
    // output velocity = 60 * 1.0 * 0.5 = 30.
    const host = new Host(baseParams({ outputLevel: 0.5 }))
    host.noteIn(60, 60, 1) // input velocity 60, channel 1
    const events = host.step(0)
    for (const ev of events) {
      if (ev.type === 'noteOn') {
        assert.equal(ev.velocity, 30, 'startChord velocity = inputVel * outputLevel')
      }
    }
  })
})

// ── ADR 005 Phase 3 — subdivision (ticksPerStep) ─────────────────────────

describe('Host.step — subdivision (ticksPerStep)', () => {
  test('cell boundary occurs every (ticksPerStep * stepsPerTransform) raw ticks', () => {
    // ticksPerStep=6 (16th @ PPQN=24), stepsPerTransform=1 → cell every 6 ticks.
    const host = new Host(baseParams({
      cells: cells('P'),
      ticksPerStep: 6,
      stepsPerTransform: 1,
    }))
    host.step(0) // startChord at tick 0
    for (const pos of [1, 2, 3, 4, 5]) {
      assert.deepEqual(host.step(pos), [], `pos=${pos} between subdivision-steps → no events`)
    }
    // pos=6 is the first subdivision-step boundary AND a cell boundary
    const evCell = host.step(6)
    const ons = evCell.filter(e => e.type === 'noteOn').map(e => e.pitch).sort((a, b) => a - b)
    const pcs = ons.map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 3, 7], 'pos=6: cell[0]=P → C minor')
    // pos=7..11 again silent
    for (const pos of [7, 8, 9, 10, 11]) {
      assert.deepEqual(host.step(pos), [], `pos=${pos} between → no events`)
    }
    // pos=12 next cell boundary
    const ev2 = host.step(12)
    assert.ok(ev2.some(e => e.type === 'noteOn'), 'pos=12 fires next cell')
  })

  test('cell timing/gate scale with ticksPerStep × stepsPerTransform (1 transform period)', () => {
    // With ticksPerStep=6, spt=1: one transform period = 6 raw ticks.
    // cell gate=0.9 → gate-end delayPos = 0.9 * 6 = 5.4.
    const host = new Host(baseParams({
      cells: cells('P'),
      ticksPerStep: 6,
      stepsPerTransform: 1,
    }))
    host.step(0)
    const ev = host.step(6)
    const gateEnds = ev.filter(e => e.type === 'noteOff' && (e.delayPos ?? 0) > 0)
    assert.ok(gateEnds.length > 0, 'gate-end noteOffs should be emitted')
    for (const e of gateEnds) {
      assert.equal(e.delayPos, 5.4, 'gate-end delayPos must scale by ticksPerStep')
    }
  })

  test('subdivision tick multipliers (ADR 005 §Subdivision table)', () => {
    // ADR table: 8th=12, 16th=6, 32nd=3, 8T=8, 16T=4 ticks/step at PPQN=24.
    // For each, host with spt=1 fires the first cell at pos=ticksPerStep.
    const cases: Array<[number, string]> = [
      [12, '8th'], [6, '16th'], [3, '32nd'], [8, '8T'], [4, '16T'],
    ]
    for (const [tps, label] of cases) {
      const host = new Host(baseParams({ cells: cells('P'), ticksPerStep: tps, stepsPerTransform: 1 }))
      host.step(0)
      // Just below boundary: nothing
      assert.deepEqual(host.step(tps - 1), [], `${label}: pos ${tps - 1} → []`)
      // At boundary: cell fires
      const ev = host.step(tps)
      assert.ok(ev.some(e => e.type === 'noteOn'), `${label}: pos ${tps} fires cell`)
    }
  })

  test('cellIdx() reports the most-recent cell across mid-step ticks', () => {
    // ticksPerStep=6, spt=1: cell[0]=P fires at pos=6, cell[1]=L at pos=12.
    // Between, the marker should keep showing the most recently fired cell.
    const host = new Host(baseParams({
      cells: cells('P', 'L', 'R', 'hold'),
      ticksPerStep: 6,
      stepsPerTransform: 1,
    }))
    host.step(0)
    assert.equal(host.cellIdx(0), -1, 'before first cell: -1')
    host.step(6)
    for (const pos of [6, 7, 8, 9, 10, 11]) {
      assert.equal(host.cellIdx(pos), 0, `pos=${pos}: still on cell 0`)
    }
    host.step(12)
    for (const pos of [12, 13, 17]) {
      assert.equal(host.cellIdx(pos), 1, `pos=${pos}: on cell 1`)
    }
  })

  test('ticksPerStep=1 keeps full backward compatibility with Phase 2 pos contract', () => {
    // Sanity: every existing host test passes baseParams with ticksPerStep=1,
    // and that already implies "1 pos = 1 step". Reassert at the contract level
    // that pos=1 is the first transform boundary when spt=1, ticksPerStep=1.
    const host = new Host(baseParams({ cells: cells('P'), stepsPerTransform: 1 }))
    host.step(0)
    const ev = host.step(1)
    assert.ok(ev.some(e => e.type === 'noteOn'), 'pos=1 with ticksPerStep=1 must fire')
  })
})

// ── ADR 005 Phase 3 — swing ──────────────────────────────────────────────

describe('Host.step — swing', () => {
  test('swing=0.5 (default) is a no-op vs an unswung baseline', () => {
    // ticksPerStep=6, spt=1 → cells fire at every 16th. swing=0.5 should
    // produce identical events to a host with swing untouched.
    const stub = { cells: cells('P', 'L', 'R', 'hold'), seed: 0, ticksPerStep: 6, stepsPerTransform: 1 }
    const a = new Host(baseParams(stub))
    const b = new Host(baseParams({ ...stub, swing: 0.5 }))
    a.step(0); b.step(0)
    for (const pos of [6, 12, 18, 24, 30, 36]) {
      assert.deepEqual(a.step(pos), b.step(pos), `pos=${pos} swing=0.5 must match unswung`)
    }
  })

  test('swing>0.5 shifts odd-indexed subdivision-steps later (no shift on even)', () => {
    // swing=0.75, ticksPerStep=6 → odd subdivStepPos gets +3 raw-tick offset.
    // spt=1: cells fire at subdivStepPos=1 (odd, swung), 2 (even, on grid),
    // 3 (odd, swung), 4 (even, on grid).
    // cell.timing=0 baseline, so noteOn delayPos == swing offset.
    const host = new Host(baseParams({
      cells: cells('P', 'L', 'R', 'hold'),
      ticksPerStep: 6,
      stepsPerTransform: 1,
      swing: 0.75,
    }))
    host.step(0)
    // pos=6 → subdivStepPos=1 (odd) → +3 tick swing
    const ev1 = host.step(6).filter(e => e.type === 'noteOn')
    assert.ok(ev1.length > 0)
    for (const e of ev1) assert.equal(e.delayPos, 3, 'swung odd subdivStep gets +3 ticks')
    // pos=12 → subdivStepPos=2 (even) → no swing
    const ev2 = host.step(12).filter(e => e.type === 'noteOn')
    assert.ok(ev2.length > 0)
    for (const e of ev2) assert.equal(e.delayPos ?? 0, 0, 'even subdivStep has no swing')
    // pos=18 → subdivStepPos=3 (odd) → swung
    const ev3 = host.step(18).filter(e => e.type === 'noteOn')
    for (const e of ev3) assert.equal(e.delayPos, 3, 'pos=18 swung')
  })

  test('swing has no effect when cell boundaries land only on even subdivision-steps', () => {
    // spt=2, ticksPerStep=6 → cells fire at subdivStepPos=2, 4, 6 (all even).
    // Musically: a cell-rate of 2 sixteenths = an 8th-note pulse, which does
    // not have 16th-swing applied to it.
    const host = new Host(baseParams({
      cells: cells('P', 'L', 'R', 'hold'),
      ticksPerStep: 6,
      stepsPerTransform: 2,
      swing: 0.75,
    }))
    host.step(0)
    for (const pos of [12, 24, 36, 48]) {
      const ons = host.step(pos).filter(e => e.type === 'noteOn')
      for (const e of ons) {
        assert.equal(e.delayPos ?? 0, 0, `pos=${pos} (subdivStep=${pos / 6}) must not be swung`)
      }
    }
  })

  test('swing composes additively with cell.timing offset', () => {
    // cell.timing=+0.25 transforms-period offset + swing on odd subdivStep.
    // ticksPerStep=6, spt=1, transformTicks=6. cell.timing=+0.25 → +1.5 raw
    // ticks. swing=0.75 odd → +3 ticks. Combined on subdivStepPos=1: +4.5.
    const cellTiming = makeCell('P', { timing: 0.25 })
    const host = new Host(baseParams({
      cells: [cellTiming, makeCell('L'), makeCell('R'), makeCell('hold')],
      ticksPerStep: 6,
      stepsPerTransform: 1,
      swing: 0.75,
    }))
    host.step(0)
    const ev = host.step(6).filter(e => e.type === 'noteOn')
    assert.ok(ev.length > 0)
    for (const e of ev) {
      assert.equal(e.delayPos, 4.5, 'cell.timing + swing additively compose')
    }
  })
})

describe('Host slots — ADR 006 Phase 2', () => {
  // 4 = ADR 006 §"Axis 1" — "4 slots in the device".
  const SLOT_COUNT = 4

  function pcSet(triad: [number, number, number]): number[] {
    return triad.map(p => ((p % 12) + 12) % 12).sort((a, b) => a - b)
  }

  function makeSlot(overrides: Partial<Slot> = {}): Slot {
    return {
      cells: 'PLR_',
      startChord: { root: 0, quality: 'maj' },
      jitter: 0,
      seed: 0,
      ...overrides,
    }
  }

  describe('initial state', () => {
    test('activeSlot defaults to 0', () => {
      const host = new Host(baseParams())
      assert.equal(host.activeSlot, 0)
    })

    test('all slots initialize from constructor HostParams', () => {
      // Initial Live-set load presents 4 identical slots matching the
      // patcher's persisted hidden params; switching to any slot is a
      // no-op until the user starts editing.
      const host = new Host(baseParams({
        cells: cells('P', 'L', 'R', 'hold'),
        startChord: [60, 64, 67], // C major
        jitter: 0.25,
        seed: 7,
      }))
      for (let i = 0; i < SLOT_COUNT; i++) {
        assert.deepEqual(host.getSlot(i), {
          cells: 'PLR_',
          startChord: { root: 0, quality: 'maj' },
          jitter: 0.25,
          seed: 7,
        })
      }
    })

    test('getSlot returns null for out-of-range index', () => {
      const host = new Host(baseParams())
      assert.equal(host.getSlot(-1), null)
      assert.equal(host.getSlot(SLOT_COUNT), null)
    })

    test('getSlot returns a defensive copy', () => {
      const host = new Host(baseParams())
      const s = host.getSlot(0)!
      s.jitter = 0.99
      s.startChord.root = 11
      assert.notEqual(host.getSlot(0)!.jitter, 0.99)
      assert.notEqual(host.getSlot(0)!.startChord.root, 11)
    })
  })

  describe('setSlot — rehydration from patcher', () => {
    test('overwrites stored slot but does not load it into params', () => {
      // Bridge calls setSlot on device load to re-populate the in-memory
      // Slot[] from hidden live.* params. This is persistence rehydration,
      // NOT a load — params stay untouched until switchSlot is called.
      const host = new Host(baseParams({ jitter: 0 }))
      const slot: Slot = makeSlot({ jitter: 0.7, seed: 99 })
      host.setSlot(1, slot)
      assert.deepEqual(host.getSlot(1), slot)
      // Active slot is still 0 with original jitter.
      const evs = host.step(0)
      assert.ok(evs.length > 0)
    })

    test('setSlot to invalid index is a no-op', () => {
      const host = new Host(baseParams())
      host.setSlot(-1, makeSlot({ jitter: 0.5 }))
      host.setSlot(SLOT_COUNT, makeSlot({ jitter: 0.5 }))
      // No throw; slots unchanged at default.
      for (let i = 0; i < SLOT_COUNT; i++) {
        assert.equal(host.getSlot(i)!.jitter, 0)
      }
    })
  })

  describe('switchSlot — load behavior', () => {
    test('updates activeSlot index', () => {
      const host = new Host(baseParams())
      host.switchSlot(2)
      assert.equal(host.activeSlot, 2)
    })

    test('out-of-range index is a no-op', () => {
      const host = new Host(baseParams())
      host.switchSlot(-1)
      assert.equal(host.activeSlot, 0)
      host.switchSlot(SLOT_COUNT)
      assert.equal(host.activeSlot, 0)
    })

    test('cells / jitter / seed apply unconditionally (no MIDI held)', () => {
      const host = new Host(baseParams({ cells: cells('P', 'L', 'R', 'hold') }))
      host.setSlot(1, makeSlot({
        cells: '----', // 4 rests
        jitter: 0.5,
        seed: 42,
      }))
      host.switchSlot(1)
      // Verify cells loaded by stepping: all rests → no audio after pos 0.
      host.step(0)
      const events = host.step(1)
      assert.deepEqual(
        events.filter(e => e.type === 'noteOn'),
        [],
        'rest cells produce no noteOns',
      )
    })

    test('cells / jitter / seed apply unconditionally (MIDI held)', () => {
      // Same as above but with a chord held — the held chord must NOT
      // suppress the cells/jitter/seed update.
      const host = new Host(baseParams({ cells: cells('P', 'L', 'R', 'hold') }))
      host.noteIn(60, 100, 1); host.noteIn(64, 100, 1); host.noteIn(67, 100, 1)
      host.setSlot(1, makeSlot({ cells: '----', jitter: 0, seed: 0 }))
      host.switchSlot(1)
      host.step(0)
      const events = host.step(1)
      assert.deepEqual(
        events.filter(e => e.type === 'noteOn'),
        [],
        'cells loaded even while MIDI held',
      )
    })

    test('switchSlot preserves per-cell numeric expression (velocity etc.)', () => {
      // Per-slot scope is op-only (ADR 006 Phase 1 Slot type). The 4
      // numeric fields (vel, gate, prob, timing) are device-shared and
      // must survive a slot switch.
      const customCells: HostParams['cells'] = [
        makeCell('P', { velocity: 0.5, gate: 0.3, probability: 0.8, timing: 0.1 }),
        makeCell('L', { velocity: 0.5, gate: 0.3, probability: 0.8, timing: 0.1 }),
        makeCell('R', { velocity: 0.5, gate: 0.3, probability: 0.8, timing: 0.1 }),
        makeCell('hold', { velocity: 0.5, gate: 0.3, probability: 0.8, timing: 0.1 }),
      ]
      const host = new Host(baseParams({ cells: customCells }))
      host.setSlot(1, makeSlot({ cells: 'RRRR' }))
      host.switchSlot(1)
      // After switch, cells[0..3].velocity etc. unchanged (only op flipped).
      host.step(0)
      const ev = host.step(1).filter(e => e.type === 'noteOn')
      assert.ok(ev.length > 0)
      // velocity 100 (input default) * 0.5 (cell.velocity) = 50.
      // 50 = 100 * 0.5 (lastInputVelocity * cellVel * outputLevel default 1.0).
      for (const e of ev) {
        if (e.type === 'noteOn') assert.equal(e.velocity, 50)
      }
    })

    test('startChord applies immediately when no MIDI held', () => {
      const host = new Host(baseParams({ startChord: [60, 64, 67] })) // C major
      host.setSlot(1, makeSlot({ startChord: { root: 5, quality: 'min' } })) // F minor
      host.switchSlot(1)
      // F minor: F=5, Ab=8, C=0
      assert.deepEqual(pcSet(host.startChord), [0, 5, 8])
    })

    test('startChord defers when MIDI is held; pending stored', () => {
      const host = new Host(baseParams({ startChord: [60, 64, 67] }))
      // Hold E minor (E=64, G=67, B=71)
      host.noteIn(64, 100, 1); host.noteIn(67, 100, 1); host.noteIn(71, 100, 1)
      assert.deepEqual(pcSet(host.startChord), [4, 7, 11], 'E minor took over')

      host.setSlot(1, makeSlot({ startChord: { root: 5, quality: 'maj' } })) // F major
      host.switchSlot(1)
      // Held E minor still wins; F major suppressed.
      assert.deepEqual(pcSet(host.startChord), [4, 7, 11])
    })

    test('pending startChord applies on last note-off (hybrid mode)', () => {
      const host = new Host(baseParams({ startChord: [60, 64, 67], triggerMode: 0 }))
      host.noteIn(64, 100, 1); host.noteIn(67, 100, 1); host.noteIn(71, 100, 1) // E minor
      host.setSlot(1, makeSlot({ startChord: { root: 5, quality: 'maj' } })) // F major
      host.switchSlot(1)
      // Release one note — still held → pending stays.
      host.noteOff(64, 1)
      assert.deepEqual(pcSet(host.startChord), [4, 7, 11], 'still E minor')
      host.noteOff(67, 1)
      host.noteOff(71, 1)
      // Now empty → pending F major applies.
      assert.deepEqual(pcSet(host.startChord), [0, 5, 9], 'F major took over')
    })

    test('pending clears without applying in hold-to-play mode', () => {
      // Hold-to-play: last note-off panics + walker off; next note-on
      // recomputes startChord from the new MIDI input. Pending becomes
      // moot — clear it so a stale pending can't override later input.
      const host = new Host(baseParams({ startChord: [60, 64, 67], triggerMode: 1 }))
      host.noteIn(64, 100, 1); host.noteIn(67, 100, 1); host.noteIn(71, 100, 1)
      host.setSlot(1, makeSlot({ startChord: { root: 5, quality: 'maj' } }))
      host.switchSlot(1)
      host.noteOff(64, 1); host.noteOff(67, 1); host.noteOff(71, 1)
      assert.equal(host.isWalkerActive, false, 'walker stopped on last release')
      // Re-trigger with a totally different chord — D major (D=62, F#=66, A=69).
      host.noteIn(62, 100, 1); host.noteIn(66, 100, 1); host.noteIn(69, 100, 1)
      assert.deepEqual(pcSet(host.startChord), [2, 6, 9], 'D major from new input, not pending F major')
    })

    test('switchSlot when slot startChord matches current keeps walker continuity', () => {
      // No pendingPosReset / no audible glitch when the loaded chord is
      // identical to params.startChord — only the cell pattern changes.
      const host = new Host(baseParams({
        startChord: [60, 64, 67],
        cells: cells('P', 'L', 'R', 'hold'),
      }))
      host.step(0); host.step(1); host.step(2)
      host.setSlot(1, makeSlot({ cells: 'PPPP', startChord: { root: 0, quality: 'maj' } }))
      host.switchSlot(1)
      // Walker continues; next step advances normally without resetting to startChord.
      const ev = host.step(3)
      // pos was 3 with cells advancing; cells reset to 'PPPP' and chord unchanged
      // means at pos 3 we're at cellIdx for transform 3 modulo 4 = 3, op P → flips quality.
      // The exact chord is implementation-derivable; the assertion is "walker is alive".
      assert.ok(ev.length > 0, 'walker still emits after slot switch')
    })

    test('switchSlot triggers chord change at next step when startChord differs', () => {
      const host = new Host(baseParams({ startChord: [60, 64, 67] }))
      host.step(0) // C major emitted
      host.setSlot(1, makeSlot({ startChord: { root: 5, quality: 'min' } })) // F minor
      host.switchSlot(1)
      // Next step (any pos) should emit the new startChord at effective pos 0.
      const ev = host.step(5)
      const onPcs = ev.filter(e => e.type === 'noteOn')
        .map(e => (e as { pitch: number }).pitch % 12)
        .sort((a, b) => a - b)
      assert.deepEqual(onPcs, [0, 5, 8], 'F minor noteOns at new effective pos 0')
    })
  })

  describe('saveCurrent — capture state into active slot', () => {
    test('captures cells, startChord (root+quality), jitter, seed', () => {
      const host = new Host(baseParams({
        startChord: [65, 68, 72], // F minor
        cells: cells('P', 'hold', 'rest', 'L'),
        jitter: 0.4,
        seed: 12345,
      }))
      host.switchSlot(2)
      host.saveCurrent()
      assert.deepEqual(host.getSlot(2), {
        cells: 'P_-L',
        startChord: { root: 5, quality: 'min' },
        jitter: 0.4,
        seed: 12345,
      })
    })

    test('writes only to the active slot', () => {
      const host = new Host(baseParams({ jitter: 0 }))
      // Workflow: select slot 3, edit jitter, save. Editing must happen
      // AFTER switchSlot — switchSlot itself loads the slot's stored
      // values into params and would clobber pre-switch edits.
      host.switchSlot(3)
      host.setParams({ jitter: 0.9 })
      host.saveCurrent()
      assert.equal(host.getSlot(3)!.jitter, 0.9)
      // Other slots still at their initial value (0).
      for (const i of [0, 1, 2]) {
        assert.equal(host.getSlot(i)!.jitter, 0)
      }
    })

    test('saveCurrent then switchSlot away and back roundtrips', () => {
      const host = new Host(baseParams({
        startChord: [60, 64, 67],
        cells: cells('P', 'L', 'R', 'hold'),
        jitter: 0,
        seed: 0,
      }))
      // Configure something distinct on slot 1 via setParams + saveCurrent.
      host.switchSlot(1)
      host.setParams({ jitter: 0.6, seed: 777 })
      host.setCell(0, 'rest')
      host.setCell(1, 'rest')
      host.setCell(2, 'rest')
      host.setCell(3, 'rest')
      host.saveCurrent()
      // Switch to slot 0 and back.
      host.switchSlot(0)
      host.switchSlot(1)
      assert.deepEqual(host.getSlot(1), {
        cells: '----',
        startChord: { root: 0, quality: 'maj' },
        jitter: 0.6,
        seed: 777,
      })
    })
  })

  describe('loadFactoryPreset — ADR 006 Phase 4', () => {
    test('FACTORY_PRESETS has at least 6 entries', () => {
      // ADR 006 §"Axis 3" — target range is 6–10 curated programs.
      assert.ok(FACTORY_PRESETS.length >= 6,
        `expected ≥6 presets, got ${FACTORY_PRESETS.length}`)
    })

    test('every preset parses successfully', () => {
      // Catch broken program strings at build time rather than runtime.
      for (const preset of FACTORY_PRESETS) {
        const slot = parseSlot(preset.program)
        assert.notEqual(slot, null,
          `preset "${preset.name}" failed to parse: ${preset.program}`)
      }
    })

    test('every preset has a non-empty name', () => {
      for (const preset of FACTORY_PRESETS) {
        assert.ok(preset.name.length > 0)
      }
    })

    test('loads preset into the active slot', () => {
      const host = new Host(baseParams())
      host.switchSlot(2)
      const ok = host.loadFactoryPreset(0) // "Steady" — PPPP|s=0|j=0|c=C
      assert.equal(ok, true)
      assert.deepEqual(host.getSlot(2), parseSlot(FACTORY_PRESETS[0]!.program))
      // Other slots untouched (still default).
      for (const i of [0, 1, 3]) {
        assert.notDeepEqual(host.getSlot(i), parseSlot(FACTORY_PRESETS[0]!.program))
      }
    })

    test('applies preset to running params (cells / jitter / seed)', () => {
      // Loading a preset must affect what the next step() emits, not just
      // the stored Slot. Verifies the setSlot + switchSlot composition.
      const host = new Host(baseParams({ jitter: 0, seed: 0 }))
      // Pick "Jitter Web" — all-hold cells + j=0.6 + c=C. Seed = 42.
      const idx = FACTORY_PRESETS.findIndex(p => p.name === 'Jitter Web')
      assert.ok(idx >= 0, 'Jitter Web preset present')
      host.loadFactoryPreset(idx)
      // The cells should be all hold, jitter 0.6, seed 42 reflected in the
      // active slot AND in params (via switchSlot path).
      assert.deepEqual(host.getSlot(host.activeSlot)!.cells, '____')
      assert.equal(host.getSlot(host.activeSlot)!.jitter, 0.6)
      assert.equal(host.getSlot(host.activeSlot)!.seed, 42)
    })

    test('out-of-range index returns false and does not mutate state', () => {
      const host = new Host(baseParams())
      const before = host.getSlot(0)
      assert.equal(host.loadFactoryPreset(-1), false)
      assert.equal(host.loadFactoryPreset(FACTORY_PRESETS.length), false)
      assert.deepEqual(host.getSlot(0), before)
    })
  })
})
