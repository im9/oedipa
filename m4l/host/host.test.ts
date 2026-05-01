import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCell, mulberry32, type Op } from '../engine/tonnetz.ts'
import { Host, type HostParams, type NoteEvent } from './host.ts'
import { parseSlot, serializeSlot, type Slot } from './slot.ts'
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
    stepDirection: 'forward',
    outputLevel: 1.0,
    rhythm: 'legato',
    arp: 'off',
    length: 4,
    turingLength: 8,
    turingLock: 0.7,
    turingSeed: 0,
    ...overrides,
  }
}

// Test-only constructor wrapper. Production hosts run at ticksPerStep=6 (16th
// @ PPQN=24); tests default to 1 so every step(pos) increments to the next
// subdivision boundary, keeping the historical "1 pos = 1 step" pos arithmetic
// terse. Tests that need to exercise the production multiplier pass a second
// arg explicitly.
function makeHost(params: HostParams, opts: { ticksPerStep?: number } = {}): Host {
  return new Host(params, { ticksPerStep: opts.ticksPerStep ?? 1 })
}

function pitchesOf(events: NoteEvent[], type: NoteEvent['type']): number[] {
  return events.filter(e => e.type === type).map(e => e.pitch)
}

describe('Host.step', () => {
  test('emits noteOns for the startChord on first step', () => {
    const host = makeHost(baseParams())
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
    const host = makeHost(baseParams({ stepsPerTransform: 4 }))
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
    const host = makeHost(baseParams({ cells: cells('P') }))
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
    const host = makeHost(baseParams({ cells: cells('P') }))
    assert.equal(host.step(0).length, 3)
    assert.deepEqual(host.step(0), [])
  })

  test('supports scrubbing: step(n) without prior calls emits the chord at n', () => {
    // ADR 005: scrubbing now also schedules a gate-end noteOff at delayPos > 0.
    // No legato handoff (held set empty on first call), so delayPos=0 offs = 0.
    const host = makeHost(baseParams({ cells: cells('P') }))
    const events = host.step(5)

    const handoffOffs = events.filter(e => e.type === 'noteOff' && (e.delayPos ?? 0) === 0)
    assert.equal(handoffOffs.length, 0, 'no legato handoff on a fresh scrub')
    // cells=['P'] applied 5 times: P is involution → after odd applications we land on minor.
    const pcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 3, 7])
  })

  test('applies spread voicing to emitted notes', () => {
    const host = makeHost(baseParams({ voicing: 'spread' }))
    const pitches = pitchesOf(host.step(0), 'noteOn')
    assert.deepEqual(pitches, [60, 76, 67])
  })

  test('emits a fourth note when seventh is enabled', () => {
    const host = makeHost(baseParams({ seventh: true }))
    const pitches = pitchesOf(host.step(0), 'noteOn')
    assert.deepEqual(pitches, [60, 64, 67, 71])
  })

  test('cell sequencer cycles through cells in order', () => {
    // cells = [P, L, R, hold]. P/L/R fire noteOns at chord changes; hold is
    // silent-advance (sustain prev chord, no new attack) per the post-2026-04
    // hold-as-sustain semantic.
    type Expected = { ons: number[][] | null }
    const cases: Expected[] = [
      { ons: [[0, 4, 7]] },             // pos 0: startChord C major
      { ons: [[0, 3, 7]] },             // pos 1: cell[0]=P → C minor
      { ons: [[0, 3, 8]] },             // pos 2: cell[1]=L → Ab major
      { ons: [[0, 5, 8]] },             // pos 3: cell[2]=R → F minor
      { ons: null },                    // pos 4: cell[3]=hold → silent (Fm sustains)
      { ons: [[0, 5, 9]] },             // pos 5: cell[0]=P (cycle) → F major
    ]
    for (let pos = 0; pos < cases.length; pos++) {
      const host = makeHost(baseParams())
      const events = host.step(pos)
      const ons = pitchesOf(events, 'noteOn')
      if (cases[pos]!.ons === null) {
        assert.equal(ons.length, 0, `pos=${pos} hold must not emit noteOns`)
      } else {
        const pcs = ons.map(p => p % 12).sort((a, b) => a - b)
        assert.deepEqual(pcs, cases[pos]!.ons![0], `pos=${pos}`)
      }
    }
  })

  test('hold cell is silent-advance (sustain prev chord, no re-attack)', () => {
    // Post-2026-04 hold semantic: hold = silent-advance, equivalent to rest
    // for audio output, but the chord cursor stays put (rest also leaves the
    // cursor untouched, but the conceptual difference is "stay on this chord
    // intentionally" vs "skip a beat"). With a hold-only program there is no
    // chord-changing event after pos=0, so steps 1..N emit nothing.
    const host = makeHost(baseParams({ cells: cells('hold') }))
    host.step(0)
    for (const pos of [1, 2, 5, 17]) {
      const events = host.step(pos)
      const ons = events.filter(e => e.type === 'noteOn')
      assert.equal(ons.length, 0, `pos=${pos} hold must not emit noteOns`)
    }
  })

  test('jitter=0 walk is reproducible regardless of seed', () => {
    // Same params, different seeds — output identical when jitter=0.
    const a = makeHost(baseParams({ jitter: 0, seed: 1 }))
    const b = makeHost(baseParams({ jitter: 0, seed: 999 }))
    a.step(0); b.step(0)
    assert.deepEqual(a.currentTriad, b.currentTriad)
    a.step(1); b.step(1)
    assert.deepEqual(a.currentTriad, b.currentTriad)
    a.step(5); b.step(5)
    assert.deepEqual(a.currentTriad, b.currentTriad)
  })

  test('jitter > 0 with same seed reproduces between hosts', () => {
    const a = makeHost(baseParams({ jitter: 0.5, seed: 42 }))
    const b = makeHost(baseParams({ jitter: 0.5, seed: 42 }))
    for (const pos of [0, 1, 2, 3, 5, 13, 50]) {
      a.step(pos); b.step(pos)
      assert.deepEqual(a.currentTriad, b.currentTriad, `pos=${pos}`)
    }
  })

  test('noteOffs at chord change match the previously voiced notes (not the raw triad)', () => {
    // ADR 005: legato handoff offs (delayPos=0) target the previously voiced
    // notes; gate-end offs (delayPos > 0) target the new voicing — filter to
    // the handoff slot only for this assertion.
    const host = makeHost(baseParams({ voicing: 'spread', cells: cells('P') }))
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
    test('cell with gate < 1.0 schedules gate-end noteOff at delayPos = gate * spt', () => {
      // gate=0.9, spt=1 → scheduled noteOff at delayPos = 0.9. Slot 0 carries
      // the legato handoff for the prior chord and the new chord's noteOn;
      // the gate slot carries the new chord's note-off. The post-2026-04
      // default is gate=1.0 (legato handoff, no scheduled gate-end), so this
      // test pins the gate < 1.0 path with an explicit per-cell override.
      const host = makeHost(baseParams({ cells: [makeCell('P', { gate: 0.9 })] }))
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
      const host = makeHost(baseParams({ cells: [c], stepsPerTransform: 4 }))
      host.step(0)
      const events = host.step(4)
      const offsAtTwo = events.filter(e => e.type === 'noteOff' && e.delayPos === 2)
      assert.equal(offsAtTwo.length, 3, 'noteOff scheduled at gate*spt')
    })

    test('gate=1.0 leaves chord for legato handoff (no scheduled noteOff this step)', () => {
      // gate=1.0 = "note-off coincident with next note-on" — no early off
      // scheduled; the next noteOn step carries the legato handoff.
      const c = makeCell('P', { gate: 1.0 })
      const host = makeHost(baseParams({ cells: [c, c] }))
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
      const host = makeHost(baseParams({ cells: [c] }))
      host.step(0)
      const events = host.step(1)
      const vels = events.filter(e => e.type === 'noteOn').map(e => e.velocity)
      assert.equal(vels.length, 3)
      for (const v of vels) assert.equal(v, 50)
    })

    test('cell.velocity=1.0 default preserves source velocity (no scaling)', () => {
      const host = makeHost(baseParams({ cells: cells('P') }))
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
      const host = makeHost(baseParams({ cells: [c] }))
      host.step(0)
      const events = host.step(1)
      const vels = events.filter(e => e.type === 'noteOn').map(e => e.velocity)
      for (const v of vels) assert.equal(v, 1)
    })

    test('source velocity = lastInputVelocity, multiplied by cell.velocity', () => {
      // lastInputVelocity tracks the most recent noteIn (ADR 004).
      // 80 × 0.5 = 40.
      const c = makeCell('P', { velocity: 0.5 })
      const host = makeHost(baseParams({ cells: [c] }))
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
      const host = makeHost(baseParams({ cells: [c], stepsPerTransform: 4 }))
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
      const host = makeHost(baseParams({ cells: [c], stepsPerTransform: 4 }))
      host.step(0)
      const events = host.step(4)
      const handoffOffs = events.filter(e => e.type === 'noteOff' && e.delayPos === 1.0)
      assert.equal(handoffOffs.length, 3, 'handoff offs co-located with noteOn at delayPos=1.0')
    })

    test('playback-start clamp: first scheduled cell with timing<0 → delayPos=0', () => {
      // ADR 005 §"Playback start clamp": at transport start, a negative
      // timing offset on the first scheduled cell cannot fire before t=0.
      const c = makeCell('P', { timing: -0.5 })
      const host = makeHost(baseParams({ cells: [c, c] }))
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
      const host = makeHost(baseParams({ cells: [c] }))
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
      const host = makeHost(baseParams({ cells: [c] }))
      host.step(0)
      const events = host.step(1)
      assert.deepEqual(events, [])
      assert.deepEqual(host.currentTriad, [60, 64, 67])
    })

    test('determinism preserved across probability draws', () => {
      // Two hosts with identical seed must produce identical event streams.
      const c = makeCell('P', { probability: 0.5 })
      const a = makeHost(baseParams({ cells: [c], seed: 7 }))
      const b = makeHost(baseParams({ cells: [c], seed: 7 }))
      for (const pos of [0, 1, 2, 3, 4, 5, 10, 25]) {
        assert.deepEqual(a.step(pos), b.step(pos), `pos=${pos}`)
      }
    })
  })

  describe('rest op', () => {
    test('rest emits no events and leaves cursor unchanged', () => {
      // ADR 005: rest = silent hold; cursor unchanged.
      const c = makeCell('rest')
      const host = makeHost(baseParams({ cells: [c] }))
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
      const host = makeHost(baseParams({ cells: [cP, cRest] }))
      host.step(0) // startChord
      host.step(1) // P fires; gate 0.5 schedules off at delayPos=0.5
      const events = host.step(2) // rest
      assert.deepEqual(events, [], 'rest step is silent; prior gate already scheduled')
    })
  })

  describe('hold op (silent-advance)', () => {
    test('hold cell emits no noteOns and no scheduled gate-end offs (post-2026-04 sustain semantic)', () => {
      // Hold is silent-advance: the chord cursor stays, but no new attack and
      // no new gate-end is scheduled. The previous chord's sustain (or its
      // already-scheduled gate-end) governs whether the listener still hears
      // the chord during the hold cell.
      const host = makeHost(baseParams({ cells: cells('hold') }))
      host.step(0)
      const events = host.step(1)
      const ons = events.filter(e => e.type === 'noteOn')
      const offs = events.filter(e => e.type === 'noteOff')
      assert.equal(ons.length, 0, 'hold must not re-attack')
      assert.equal(offs.length, 0, 'hold must not schedule new gate-end offs')
    })
  })
})

describe('Host.panic', () => {
  test('emits noteOff for every held note and clears state', () => {
    const host = makeHost(baseParams())
    host.step(0)
    const events = host.panic()
    assert.equal(events.length, 3)
    assert.ok(events.every(e => e.type === 'noteOff'))
    assert.deepEqual(pitchesOf(events, 'noteOff').sort((a, b) => a - b), [60, 64, 67])
    assert.deepEqual(host.panic(), [])
  })

  test('after panic, the next step fires fresh noteOns with no stray noteOffs', () => {
    const host = makeHost(baseParams())
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
    const host = makeHost(baseParams({ stepsPerTransform: 2, cells: cells('P') }))
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
    const host = makeHost(baseParams({ cells: cells('P', 'L', 'R', 'hold') }))
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
    const host = makeHost(baseParams({ cells: cells('P', 'L', 'R', 'hold') }))
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
    const host = makeHost(baseParams())
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
    const host = makeHost(baseParams())
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
    const host = makeHost(baseParams())
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
    const host = makeHost(baseParams())
    host.setCellField(0, 'probability', 0)
    host.step(0)
    const events = host.step(1)
    assert.deepEqual(events, [], 'silent advance emits nothing')
    const pcs = host.currentTriad!.map(p => ((p % 12) + 12) % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 3, 7], 'cursor still moved to Cmin')
  })

  test('out-of-range index is a no-op', () => {
    const host = makeHost(baseParams())
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
    const host = makeHost(baseParams({
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
    const host = makeHost(baseParams({ stepsPerTransform: 4 }))
    // pos < spt → numTransforms = 0 → no cell has fired
    assert.equal(host.cellIdx(0), -1)
    assert.equal(host.cellIdx(3), -1)
  })

  test('returns 0 once the first transform has fired', () => {
    const host = makeHost(baseParams({ stepsPerTransform: 4 }))
    // pos in [spt, 2*spt) → numTransforms = 1 → cells[0] is the active cell
    assert.equal(host.cellIdx(4), 0)
    assert.equal(host.cellIdx(7), 0)
  })

  test('advances one cell per stepsPerTransform window', () => {
    const host = makeHost(baseParams({ stepsPerTransform: 4 })) // cells length 4
    assert.equal(host.cellIdx(8), 1)  // cells[1] applied
    assert.equal(host.cellIdx(12), 2) // cells[2] applied
    assert.equal(host.cellIdx(16), 3) // cells[3] applied
  })

  test('wraps modulo cells.length', () => {
    const host = makeHost(baseParams({ stepsPerTransform: 4 })) // cells length 4
    // numTransforms = 5, 6 → (5-1) % 4 = 0, (6-1) % 4 = 1
    assert.equal(host.cellIdx(20), 0)
    assert.equal(host.cellIdx(24), 1)
  })

  test('honours stepsPerTransform=1 with 2-cell array', () => {
    const host = makeHost(baseParams({ stepsPerTransform: 1, cells: cells('P', 'L') }))
    assert.equal(host.cellIdx(0), -1) // no transform yet
    assert.equal(host.cellIdx(1), 0)  // cells[0]=P fired
    assert.equal(host.cellIdx(2), 1)  // cells[1]=L fired
    assert.equal(host.cellIdx(3), 0)  // wraps
  })

  test('reflects stepsPerTransform updates from setParams', () => {
    const host = makeHost(baseParams({ stepsPerTransform: 1 }))
    assert.equal(host.cellIdx(2), 1) // 2 transforms with spt=1 → idx 1
    host.setParams({ stepsPerTransform: 4 })
    assert.equal(host.cellIdx(2), -1) // 0 transforms with spt=4
    assert.equal(host.cellIdx(8), 1)  // 2 transforms with spt=4 → idx 1
  })
})

describe('Host.noteIn (ADR 004 — input event model)', () => {
  test('triad input updates startChord and emits note-offs for sustained walker output', () => {
    const host = makeHost(baseParams())
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
    const host = makeHost(baseParams({ cells: cells('P', 'L', 'R') }))
    host.step(0); host.step(1); host.step(2) // walker has advanced
    host.noteIn(65, 100, 1); host.noteIn(69, 100, 1); host.noteIn(72, 100, 1) // Fmaj
    // Subsequent step at any pos: walker emits new startChord (Fmaj close) — cells not applied yet.
    const events = host.step(7)
    const pcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 5, 9]) // Fmaj
  })

  test('lastInputVelocity updates on every note-on and is used for walker output', () => {
    const host = makeHost(baseParams({ cells: cells('P') }))
    host.step(0) // emit Cmaj at default vel 100
    host.noteIn(60, 80, 1) // single note, no triad — startChord unchanged, lastInputVelocity = 80
    const events = host.step(1) // P → Cmin, emit noteOns at new vel 80
    const onVels = events.filter(e => e.type === 'noteOn').map(e => (e as { velocity: number }).velocity)
    assert.ok(onVels.length > 0, 'expected noteOns')
    for (const v of onVels) assert.equal(v, 80)
  })

  test('default lastInputVelocity is 100 before any input', () => {
    const host = makeHost(baseParams())
    const events = host.step(0)
    const onVels = events.filter(e => e.type === 'noteOn').map(e => (e as { velocity: number }).velocity)
    for (const v of onVels) assert.equal(v, 100)
  })

  test('non-triad input does not update startChord', () => {
    const host = makeHost(baseParams())
    const initial = host.startChord
    host.noteIn(60, 100, 1) // C
    host.noteIn(62, 100, 1) // C-D
    host.noteIn(67, 100, 1) // C-D-G = Csus2, not a Tonnetz triad
    assert.deepEqual(host.startChord, initial)
  })

  test('partial input (1 or 2 notes) does not update startChord', () => {
    const host = makeHost(baseParams())
    const initial = host.startChord
    host.noteIn(60, 100, 1)
    assert.deepEqual(host.startChord, initial)
    host.noteIn(64, 100, 1)
    assert.deepEqual(host.startChord, initial)
  })

  test('inputChannel = 0 (omni) accepts notes on any channel', () => {
    const host = makeHost(baseParams({ inputChannel: 0 }))
    host.noteIn(60, 100, 5)
    host.noteIn(64, 100, 7)
    host.noteIn(67, 100, 11)
    assert.deepEqual(host.startChord, [60, 64, 67])
  })

  test('inputChannel = N rejects notes on other channels', () => {
    const host = makeHost(baseParams({ inputChannel: 2 }))
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
    const host = makeHost(baseParams({ triggerMode: 0, cells: cells('P') }))
    host.noteIn(60, 100, 1); host.noteIn(64, 100, 1); host.noteIn(67, 100, 1)
    host.step(0) // walker emits Cmaj
    host.noteOff(60, 1); host.noteOff(64, 1); host.noteOff(67, 1)
    const events = host.step(1) // P → Cmin
    const pcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 3, 7], 'walker still emits after release in hybrid mode')
  })

  test('hybrid: removing one note can expose a different triad subset', () => {
    const host = makeHost(baseParams({ triggerMode: 0 }))
    // Hold Cmaj7 = C E G B → Cmaj wins (subset match, lowest root)
    host.noteIn(60, 100, 1); host.noteIn(64, 100, 1); host.noteIn(67, 100, 1); host.noteIn(71, 100, 1)
    assert.deepEqual(host.startChord, [60, 64, 67])
    // Release C → E G B remains = Em
    host.noteOff(60, 1)
    assert.deepEqual(host.startChord, [64, 67, 71])
  })

  test('hold-to-play: last note-off triggers panic and pauses the walker', () => {
    const host = makeHost(baseParams({ triggerMode: 1, cells: cells('P') }))
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
    const host = makeHost(baseParams({ triggerMode: 1, cells: cells('P') }))
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
    const host = makeHost(baseParams({ triggerMode: 0, cells: cells('P') }))
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
    const host = makeHost(baseParams({ startChord: [62, 65, 69] })) // Dm
    const events = host.transportStart()
    assert.deepEqual(events, [], 'no events emitted directly')
    assert.deepEqual(host.startChord, [62, 65, 69])
    const stepEvents = host.step(0)
    const pcs = pitchesOf(stepEvents, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [2, 5, 9])
  })

  test('with held notes, derives startChord from the snapshot', () => {
    const host = makeHost(baseParams({ startChord: [60, 64, 67] }))
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
    const host = makeHost(baseParams({ triggerMode: 1 }))
    host.transportStart()
    assert.deepEqual(host.step(0), [], 'no walker emission without held notes')
  })

  test('hold-to-play: transportStart with held notes activates walker', () => {
    const host = makeHost(baseParams({ triggerMode: 1, startChord: [60, 64, 67] }))
    host.noteIn(60, 100, 1); host.noteIn(64, 100, 1); host.noteIn(67, 100, 1)
    host.transportStart()
    const events = host.step(0)
    const pcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 4, 7])
  })
})

describe('Host pos reset on startChord change (ADR 004 Axis 5)', () => {
  test('lattice setParams startChord at non-zero pos: walker emits new startChord on next step', () => {
    const host = makeHost(baseParams({ cells: cells('P') }))
    host.step(0); host.step(1); host.step(2)
    host.setParams({ startChord: [65, 69, 72] }) // Fmaj
    const events = host.step(3) // pendingPosReset → effectivePos = 0 → walker emits startChord
    const pcs = pitchesOf(events, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 5, 9], 'Fmaj startChord, no transform applied yet')
  })

  test('input-driven startChord change resets cell program', () => {
    const host = makeHost(baseParams({ cells: cells('P', 'L') }))
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
    const host = makeHost(baseParams({ cells: cells('P') }))
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
      const h = makeHost(baseParams({ cells: cells('P', 'L', 'R', 'hold'), jitter: 0.5, seed: 42 }))
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
    const host = makeHost(baseParams())
    assert.equal(host.currentTriad, null)
  })

  test('currentTriad reflects the chord emitted by the last step', () => {
    const host = makeHost(baseParams())
    host.step(0)
    assert.deepEqual(host.currentTriad, [60, 64, 67])
  })

  test('currentTriad updates after a transform', () => {
    const host = makeHost(baseParams({ cells: cells('P') }))
    host.step(0)
    host.step(1)
    // P(C major) = C minor at the same root midi note (60)
    const t = host.currentTriad!
    const pcs = t.map(n => ((n % 12) + 12) % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 3, 7])
  })

  test('currentTriad resets to null after panic', () => {
    const host = makeHost(baseParams())
    host.step(0)
    host.panic()
    assert.equal(host.currentTriad, null)
  })

  test('centerPc is the pc of startChord[0]', () => {
    const host = makeHost(baseParams({ startChord: [66, 70, 73] })) // F# major
    assert.equal(host.centerPc, 6)
  })

  test('centerPc updates when startChord changes via setParams', () => {
    const host = makeHost(baseParams())
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
    const host = makeHost(baseParams())
    assert.equal(host.isWalkerActive, true)
  })

  test('hybrid: stays true across input + release', () => {
    const host = makeHost(baseParams({ triggerMode: 0 }))
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
    const host = makeHost(baseParams({ triggerMode: 1 }))
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
    const host = makeHost(baseParams())
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
    // cells = [P, L, R, hold]; reverse → pos 1 hits cells[3]=hold (silent-
    // advance, no noteOn). pos 2 plays cells[2]=R applied to current cursor.
    const host = makeHost(baseParams({ stepDirection: 'reverse' }))
    host.step(0)
    const ev1 = host.step(1)
    const ons1 = pitchesOf(ev1, 'noteOn')
    assert.equal(ons1.length, 0, 'pos=1 reverse: cells[3]=hold → no noteOn (sustain)')
    // pos=2 → cells[2]=R → R(C major) = A minor
    const ev2 = host.step(2)
    const pcs2 = pitchesOf(ev2, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs2, [0, 4, 9], 'pos=2 reverse: cells[2]=R → A minor')
  })

  test('pingpong direction traverses without endpoint replay', () => {
    // cells = [P, L, R, hold]; pingpong sequence cellIdx: 0,1,2,3,2,1,0,1,...
    // Verify chord cursor at pos 5 reflects cell[2]=R applied to the cell[3]=hold
    // result, not a re-application of cell[3]. Hold cell at pos=4 is silent-
    // advance (cursor unchanged, no noteOn).
    const host = makeHost(baseParams({ stepDirection: 'pingpong' }))
    host.step(0)
    // pos 1: P → C minor [0,3,7]
    // pos 2: L → Ab major [0,3,8]
    // pos 3: R → F minor [0,5,8]
    // pos 4: hold → silent (Fm sustains, no noteOn)
    // pos 5: R (cell[2] again) → R(F minor) = Ab major [0,3,8]
    type Case = readonly [number, readonly number[] | null]
    const cases: readonly Case[] = [
      [1, [0, 3, 7]],
      [2, [0, 3, 8]],
      [3, [0, 5, 8]],
      [4, null],
      [5, [0, 3, 8]],
    ]
    for (const [pos, expected] of cases) {
      const ev = host.step(pos)
      const ons = pitchesOf(ev, 'noteOn')
      if (expected === null) {
        assert.equal(ons.length, 0, `pos=${pos} hold → no noteOn`)
      } else {
        const pcs = ons.map(p => p % 12).sort((a, b) => a - b)
        assert.deepEqual(pcs, [...expected], `pos=${pos}`)
      }
    }
  })

  test('random direction sequence depends on seed alone (not authored ops)', () => {
    // Two hosts with same seed and direction=random but differing cell op
    // contents: cellIdx draws are the same → noteOn pitches match when ops
    // happen to align. Easier structural check: count of distinct cellIdx
    // values reached over many steps is bounded by cells.length.
    const seed = 314
    const a = makeHost(baseParams({ stepDirection: 'random', seed, cells: cells('hold', 'hold', 'hold', 'hold') }))
    const b = makeHost(baseParams({ stepDirection: 'random', seed, cells: cells('hold', 'hold', 'hold', 'hold') }))
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
    const host = makeHost(baseParams({ stepDirection: 'reverse' }))
    host.step(0)
    host.step(1)
    // After pos=1 in reverse, the cell that JUST fired is cells.length-1 = 3.
    assert.equal(host.cellIdx(1), 3, 'pos=1 reverse: cellIdx is 3')
    host.step(2)
    assert.equal(host.cellIdx(2), 2, 'pos=2 reverse: cellIdx is 2')
  })
})

// ── ADR 006 Phase 7 Step 4 — RHYTHM determinism (no humanize) ────────────
// Step 4 rev 2026-05-01 dropped per-rhythm humanize/swing entirely (no
// inboil basis). Every preset now produces a fully deterministic event
// stream — no PRNG draws inside maybeFire. If a humanize axis ships later
// it lands as a separate parameter, not folded into preset.

describe('Host.step — RHYTHM presets are deterministic (no humanize)', () => {
  test("rhythm='legato' (default) emits constant velocity 100 across a cycle", () => {
    // cell vel=1 × lastInputVel=100 × outputLevel=1 = 100, every cell head.
    const host = makeHost(baseParams({ cells: cells('P', 'L', 'R', 'hold'), seed: 42 }))
    host.step(0)
    for (let pos = 1; pos <= 8; pos++) {
      const ev = host.step(pos)
      for (const e of ev) {
        if (e.type === 'noteOn') {
          assert.equal(e.velocity, 100, `pos=${pos} velocity must be deterministic 100`)
        }
      }
    }
  })

  test('every preset produces an identical event stream across two fresh hosts (seed-deterministic)', () => {
    const presets = ['all', 'legato', 'onbeat', 'offbeat', 'syncopated'] as const
    for (const rhythm of presets) {
      const params = baseParams({ cells: cells('P', 'L', 'R', 'hold'), seed: 7, rhythm, stepsPerTransform: 4 })
      const a = makeHost(params)
      const b = makeHost(params)
      a.step(0); b.step(0)
      for (const pos of [4, 8, 12, 16]) {
        assert.deepEqual(a.step(pos), b.step(pos), `${rhythm} pos=${pos} must replay`)
      }
    }
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
    const a = makeHost(baseParams(stub))
    const b = makeHost(baseParams({ ...stub, outputLevel: 1.0 }))
    a.step(0); b.step(0)
    for (const pos of [4, 8, 12, 16, 20]) {
      assert.deepEqual(a.step(pos), b.step(pos), `pos=${pos} match`)
    }
  })

  test('outputLevel=0.5 halves MIDI velocity at startChord and at every cell emission', () => {
    // Source vel = 100 (default), cell.velocity = 1.0, humanize = 0 →
    // baseline MIDI velocity = 100. With outputLevel=0.5: 100 * 1.0 * 0.5 = 50.
    const host = makeHost(baseParams({ outputLevel: 0.5, cells: cells('P', 'L', 'R', 'hold') }))
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
    const host = makeHost(baseParams({ outputLevel: 0 }))
    const events = host.step(0)
    for (const ev of events) {
      if (ev.type === 'noteOn') {
        assert.equal(ev.velocity, 1, 'velocity floored to 1 at outputLevel=0')
      }
    }
  })

  test("outputLevel composes with rhythm='all' (deterministic 50 every fire)", () => {
    // After Phase 7 Step 4 rev: no humanize. cell.vel=1.0 × inputVel=100
    // × outputLevel=0.5 = 50, deterministic on every fire. 'all' fires
    // every 16th sub-step, so each cell head sees 50.
    const host = makeHost(baseParams({
      cells: cells('P', 'L', 'R', 'hold'),
      seed: 42,
      rhythm: 'all',
      outputLevel: 0.5,
      stepsPerTransform: 1,
    }))
    host.step(0)
    for (let pos = 1; pos <= 8; pos++) {
      for (const ev of host.step(pos)) {
        if (ev.type !== 'noteOn') continue
        assert.equal(ev.velocity, 50, `pos=${pos} must be deterministic 50`)
      }
    }
  })

  test('outputLevel respects MIDI input velocity (multiplies the source)', () => {
    // ADR 004 input passthrough: incoming MIDI vel becomes the source vel.
    // With input vel = 60, cell.vel = 1.0, outputLevel = 0.5 →
    // output velocity = 60 * 1.0 * 0.5 = 30.
    const host = makeHost(baseParams({ outputLevel: 0.5 }))
    host.noteIn(60, 60, 1) // input velocity 60, channel 1
    const events = host.step(0)
    for (const ev of events) {
      if (ev.type === 'noteOn') {
        assert.equal(ev.velocity, 30, 'startChord velocity = inputVel * outputLevel')
      }
    }
  })
})

// ── ADR 006 Phase 7 Step 4 rev 2 — ticksPerStep > 1 multiplier ──────────
// Step 4 rev 2 (2026-05-01) switched the patcher metro to standard `16n`,
// so production ticksPerStep is now 1 (1 metro tick = 1 sub-step). These
// tests pin the engine's higher-tps math (e.g., PPQN=24 streams from a
// hypothetical VST/AU port) — at tps=6 the engine fires at every 6th
// raw tick, scaling timing offsets by the multiplier. With production =
// tps=1 these are cross-target conformance tests, not "production"
// scenarios, but kept for coverage of the multiplier math.

describe('Host.step — ticksPerStep=6 multiplier (cross-target)', () => {
  test('cell boundary occurs every (6 * stepsPerTransform) raw ticks', () => {
    // ticksPerStep=6, stepsPerTransform=1 → cell every 6 ticks. Sub-step ticks
    // (1..5, 7..11) are silent; pos=6 fires cell[0]; pos=12 fires cell[1].
    const host = makeHost(baseParams({ cells: cells('P'), stepsPerTransform: 1 }), { ticksPerStep: 6 })
    host.step(0)
    for (const pos of [1, 2, 3, 4, 5]) {
      assert.deepEqual(host.step(pos), [], `pos=${pos} between subdivision-steps → no events`)
    }
    const evCell = host.step(6)
    const pcs = evCell.filter(e => e.type === 'noteOn').map(e => e.pitch % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs, [0, 3, 7], 'pos=6: cell[0]=P → C minor')
    for (const pos of [7, 8, 9, 10, 11]) {
      assert.deepEqual(host.step(pos), [], `pos=${pos} between → no events`)
    }
    const ev2 = host.step(12)
    assert.ok(ev2.some(e => e.type === 'noteOn'), 'pos=12 fires next cell')
  })

  test('cell gate-end delayPos scales by ticksPerStep (transformTicks = 6 * spt)', () => {
    // With ticksPerStep=6, spt=1: one transform period = 6 raw ticks. cell
    // gate=0.9 → gate-end delayPos = 0.9 * 6 = 5.4. Explicit gate=0.9 because
    // the default 1.0 emits no gate-end (legato handoff to next cell).
    const host = makeHost(
      baseParams({ cells: [makeCell('P', { gate: 0.9 })], stepsPerTransform: 1 }),
      { ticksPerStep: 6 },
    )
    host.step(0)
    const ev = host.step(6)
    const gateEnds = ev.filter(e => e.type === 'noteOff' && (e.delayPos ?? 0) > 0)
    assert.ok(gateEnds.length > 0, 'gate-end noteOffs should be emitted')
    for (const e of gateEnds) assert.equal(e.delayPos, 5.4, 'gate-end delayPos = 0.9 * 6')
  })

  test('cellIdx() reports the most-recent cell across mid-step ticks', () => {
    // ticksPerStep=6, spt=1: cell[0]=P fires at pos=6, cell[1]=L at pos=12.
    // Between, the marker should keep showing the most recently fired cell.
    const host = makeHost(
      baseParams({ cells: cells('P', 'L', 'R', 'hold'), stepsPerTransform: 1 }),
      { ticksPerStep: 6 },
    )
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
})

// ── ADR 006 Phase 7 Step 4 — RHYTHM gating, inboil-aligned ──────────────
// 5 presets ported from inboil's TonnetzRhythm (resolveRhythm @
// generative.ts:478): all / legato / onbeat / offbeat / syncopated.
// Tests pin the host's gatingFires integration at production tps=6,
// spt=4 (cell = 4 sub-steps within a quarter).

describe("Host.step — rhythm='legato' fires only at cell head", () => {
  test('only subStepIdx=0 fires (every spt sub-steps)', () => {
    const host = makeHost(
      baseParams({ cells: cells('P', 'L', 'R', 'hold'), stepsPerTransform: 4, rhythm: 'legato' }),
      { ticksPerStep: 6 },
    )
    host.step(0)
    assert.ok(host.step(6).every(e => e.type !== 'noteOn'), 'mid-cell idx=1 silent')
    assert.ok(host.step(12).every(e => e.type !== 'noteOn'), 'mid-cell idx=2 silent')
    assert.ok(host.step(18).every(e => e.type !== 'noteOn'), 'mid-cell idx=3 silent')
    assert.ok(host.step(24).some(e => e.type === 'noteOn'), 'next cell head idx=0 fires')
  })
})

describe("Host.step — rhythm='onbeat' fires every 4 sub-steps", () => {
  test('quarter-note pulse (idx % 4 === 0)', () => {
    const host = makeHost(
      baseParams({ cells: cells('P', 'L', 'R', 'hold'), stepsPerTransform: 4, rhythm: 'onbeat' }),
      { ticksPerStep: 6 },
    )
    host.step(0)
    assert.ok(host.step(6).every(e => e.type !== 'noteOn'), 'idx=1 silent')
    assert.ok(host.step(12).every(e => e.type !== 'noteOn'), 'idx=2 silent')
    assert.ok(host.step(18).every(e => e.type !== 'noteOn'), 'idx=3 silent')
    assert.ok(host.step(24).some(e => e.type === 'noteOn'), 'idx=0 (next cell head) fires')
  })
})

describe("Host.step — rhythm='offbeat' fires on the &-of-each-quarter", () => {
  test('only subStepIdx % 4 === 2 fires (4 fires/bar, complementary to onbeat)', () => {
    // spt=4: subStepIdx 0,1,2,3 → fire only at idx=2 (= the &-of-quarter).
    // Standard musical off-beat semantic.
    const host = makeHost(
      baseParams({ cells: cells('P', 'L', 'R', 'hold'), stepsPerTransform: 4, rhythm: 'offbeat' }),
      { ticksPerStep: 6 },
    )
    host.step(0)
    assert.ok(host.step(6).every(e => e.type !== 'noteOn'), 'idx=1 silent')
    assert.ok(host.step(12).some(e => e.type === 'noteOn'), 'idx=2 (&) fires')
    assert.ok(host.step(18).every(e => e.type !== 'noteOn'), 'idx=3 silent')
    assert.ok(host.step(24).every(e => e.type !== 'noteOn'), 'idx=0 (next cell head) silent')
  })
})

describe("Host.step — rhythm='all' fires at every sub-step", () => {
  test('every 16th fires (no humanize / no swing per Step 4 rev)', () => {
    const host = makeHost(
      baseParams({ cells: cells('P', 'L', 'R', 'hold'), stepsPerTransform: 4, rhythm: 'all' }),
      { ticksPerStep: 6 },
    )
    host.step(0)
    for (const pos of [6, 12, 18, 24]) {
      assert.ok(host.step(pos).some(e => e.type === 'noteOn'), `pos=${pos} fires`)
    }
  })
})

describe("Host.step — rhythm='syncopated' uses inboil 8-step pattern", () => {
  test('pattern [T,F,T,F,F,T,F,T] over subStepIdx % 8', () => {
    // spt=8 covers one full period of the 8-step pattern.
    const host = makeHost(
      baseParams({ cells: cells('P', 'L'), stepsPerTransform: 8, rhythm: 'syncopated' }),
      { ticksPerStep: 6 },
    )
    host.step(0)
    // pattern fires on subStepIdx 0 (handled by init), 2, 5, 7.
    // pos=6 → idx=1 silent
    assert.ok(host.step(6).every(e => e.type !== 'noteOn'), 'idx=1 silent')
    assert.ok(host.step(12).some(e => e.type === 'noteOn'), 'idx=2 fires')
    assert.ok(host.step(18).every(e => e.type !== 'noteOn'), 'idx=3 silent')
    assert.ok(host.step(24).every(e => e.type !== 'noteOn'), 'idx=4 silent')
    assert.ok(host.step(30).some(e => e.type === 'noteOn'), 'idx=5 fires')
    assert.ok(host.step(36).every(e => e.type !== 'noteOn'), 'idx=6 silent')
    assert.ok(host.step(42).some(e => e.type === 'noteOn'), 'idx=7 fires')
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
      const host = makeHost(baseParams())
      assert.equal(host.activeSlot, 0)
    })

    test('all slots initialize from constructor HostParams', () => {
      // Initial Live-set load presents 4 identical slots matching the
      // patcher's persisted hidden params; switching to any slot is a
      // no-op until the user starts editing.
      const host = makeHost(baseParams({
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
      const host = makeHost(baseParams())
      assert.equal(host.getSlot(-1), null)
      assert.equal(host.getSlot(SLOT_COUNT), null)
    })

    test('getSlot returns a defensive copy', () => {
      const host = makeHost(baseParams())
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
      const host = makeHost(baseParams({ jitter: 0 }))
      const slot: Slot = makeSlot({ jitter: 0.7, seed: 99 })
      host.setSlot(1, slot)
      assert.deepEqual(host.getSlot(1), slot)
      // Active slot is still 0 with original jitter.
      const evs = host.step(0)
      assert.ok(evs.length > 0)
    })

    test('setSlot to invalid index is a no-op', () => {
      const host = makeHost(baseParams())
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
      const host = makeHost(baseParams())
      host.switchSlot(2)
      assert.equal(host.activeSlot, 2)
    })

    test('out-of-range index is a no-op', () => {
      const host = makeHost(baseParams())
      host.switchSlot(-1)
      assert.equal(host.activeSlot, 0)
      host.switchSlot(SLOT_COUNT)
      assert.equal(host.activeSlot, 0)
    })

    test('cells / jitter / seed apply unconditionally (no MIDI held)', () => {
      const host = makeHost(baseParams({ cells: cells('P', 'L', 'R', 'hold') }))
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
      const host = makeHost(baseParams({ cells: cells('P', 'L', 'R', 'hold') }))
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
      const host = makeHost(baseParams({ cells: customCells }))
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
      const host = makeHost(baseParams({ startChord: [60, 64, 67] })) // C major
      host.setSlot(1, makeSlot({ startChord: { root: 5, quality: 'min' } })) // F minor
      host.switchSlot(1)
      // F minor: F=5, Ab=8, C=0
      assert.deepEqual(pcSet(host.startChord), [0, 5, 8])
    })

    test('startChord defers when MIDI is held; pending stored', () => {
      const host = makeHost(baseParams({ startChord: [60, 64, 67] }))
      // Hold E minor (E=64, G=67, B=71)
      host.noteIn(64, 100, 1); host.noteIn(67, 100, 1); host.noteIn(71, 100, 1)
      assert.deepEqual(pcSet(host.startChord), [4, 7, 11], 'E minor took over')

      host.setSlot(1, makeSlot({ startChord: { root: 5, quality: 'maj' } })) // F major
      host.switchSlot(1)
      // Held E minor still wins; F major suppressed.
      assert.deepEqual(pcSet(host.startChord), [4, 7, 11])
    })

    test('pending startChord applies on last note-off (hybrid mode)', () => {
      const host = makeHost(baseParams({ startChord: [60, 64, 67], triggerMode: 0 }))
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
      const host = makeHost(baseParams({ startChord: [60, 64, 67], triggerMode: 1 }))
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
      const host = makeHost(baseParams({
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
      const host = makeHost(baseParams({ startChord: [60, 64, 67] }))
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

  describe('auto-save — user edits sync to active slot', () => {
    // ADR 006 §"Axis 1" amendment (2026-04-30) — explicit saveCurrent is
    // gone; user-driven setCell / setParams (cells / jitter / seed /
    // startChord) mirror their changes into slots[active] immediately.
    // MIDI-input-driven recomputeStartChord stays a live override and
    // does NOT auto-save (the slot keeps its anchor across performance).

    test('setParams({jitter}) syncs jitter to active slot', () => {
      const host = makeHost(baseParams({ jitter: 0 }))
      host.switchSlot(3)
      host.setParams({ jitter: 0.9 })
      assert.equal(host.getSlot(3)!.jitter, 0.9, 'active slot updated')
      // Other slots still at their initial value.
      for (const i of [0, 1, 2]) {
        assert.equal(host.getSlot(i)!.jitter, 0)
      }
    })

    test('setParams({seed}) syncs seed', () => {
      const host = makeHost(baseParams({ seed: 0 }))
      host.switchSlot(2)
      host.setParams({ seed: 12345 })
      assert.equal(host.getSlot(2)!.seed, 12345)
    })

    test('setParams({startChord}) syncs startChord (lattice click path)', () => {
      const host = makeHost(baseParams({ startChord: [60, 64, 67] }))
      host.switchSlot(1)
      host.setParams({ startChord: [65, 68, 72] }) // F minor
      assert.deepEqual(host.getSlot(1)!.startChord, { root: 5, quality: 'min' })
    })

    test('setCell syncs cells to active slot', () => {
      const host = makeHost(baseParams({ cells: cells('P', 'L', 'R', 'hold') }))
      host.switchSlot(2)
      host.setCell(0, 'rest')
      host.setCell(1, 'rest')
      host.setCell(2, 'rest')
      host.setCell(3, 'rest')
      assert.equal(host.getSlot(2)!.cells, '----')
    })

    test('setCellField does NOT auto-save (per-cell numeric fields are device-shared)', () => {
      const host = makeHost(baseParams())
      host.switchSlot(2)
      const before = host.getSlot(2)
      host.setCellField(0, 'velocity', 0.5)
      host.setCellField(1, 'gate', 0.7)
      host.setCellField(2, 'probability', 0.3)
      host.setCellField(3, 'timing', 0.1)
      // Slot is unaffected — vel/gate/probability/timing are device-shared
      // (ADR 006 §"Axis 1" — only cells/jitter/seed/startChord are slot-stored).
      assert.deepEqual(host.getSlot(2), before)
    })

    test('MIDI-input note-on does NOT auto-save startChord (live override)', () => {
      // recomputeStartChord (MIDI-driven) updates params.startChord but
      // intentionally bypasses auto-save: the slot keeps its anchor chord;
      // MIDI input is what the player is playing right now, not what they
      // want to commit to the slot.
      const host = makeHost(baseParams({ startChord: [60, 64, 67] })) // C maj
      host.switchSlot(2)
      const before = host.getSlot(2)
      // Player presses an F major triad: should update params but NOT slot.
      host.noteIn(65, 100, 1)
      host.noteIn(69, 100, 1)
      host.noteIn(72, 100, 1)
      assert.deepEqual(host.getSlot(2), before, 'slot unchanged by MIDI input')
    })

    test('roundtrip: switch / edit / switch away / switch back preserves edits', () => {
      const host = makeHost(baseParams({
        startChord: [60, 64, 67],
        cells: cells('P', 'L', 'R', 'hold'),
        jitter: 0,
        seed: 0,
      }))
      // Edits on slot 1 via the user-driven paths (no explicit save).
      host.switchSlot(1)
      host.setParams({ jitter: 0.6, seed: 777 })
      host.setCell(0, 'rest')
      host.setCell(1, 'rest')
      host.setCell(2, 'rest')
      host.setCell(3, 'rest')
      // Switch away and back.
      host.switchSlot(0)
      host.switchSlot(1)
      assert.deepEqual(host.getSlot(1), {
        cells: '----',
        startChord: { root: 0, quality: 'maj' },
        jitter: 0.6,
        seed: 777,
      })
    })

    test('setParams with non-slot fields (voicing, etc.) does NOT auto-save', () => {
      const host = makeHost(baseParams())
      host.switchSlot(1)
      const before = host.getSlot(1)
      host.setParams({ voicing: 'spread' })
      host.setParams({ rhythm: 'syncopated' })
      host.setParams({ arp: 'up' })
      host.setParams({ outputLevel: 0.5 })
      // None of these are slot-stored fields — slot stays untouched.
      assert.deepEqual(host.getSlot(1), before)
    })

    test('auto-save does NOT touch stepsPerTransform', () => {
      // Regression guard: the user reported step interval became "abnormally
      // fast" after the auto-save changes. Verify that setCell / setParams
      // for slot fields (cells / jitter / seed / startChord) do not
      // accidentally mutate or reset stepsPerTransform. (ticksPerStep was
      // revoked in Phase 7 Step 4 and is now an internal Host constant.)
      const host = makeHost(baseParams({ stepsPerTransform: 4 }))
      host.setCell(0, 'L')
      host.setParams({ jitter: 0.5 })
      host.setParams({ seed: 99 })
      host.setParams({ startChord: [62, 65, 69] }) // D minor
      assert.equal((host as any).params.stepsPerTransform, 4,
        'stepsPerTransform preserved through slot-field auto-save')
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
      const host = makeHost(baseParams())
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
      const host = makeHost(baseParams({ jitter: 0, seed: 0 }))
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
      const host = makeHost(baseParams())
      const before = host.getSlot(0)
      assert.equal(host.loadFactoryPreset(-1), false)
      assert.equal(host.loadFactoryPreset(FACTORY_PRESETS.length), false)
      assert.deepEqual(host.getSlot(0), before)
    })
  })

  describe('randomizeActiveSlot — ADR 006 Phase 5', () => {
    test('writes to the active slot', () => {
      const host = makeHost(baseParams())
      host.switchSlot(2)
      const before = host.getSlot(2)
      host.randomizeActiveSlot(mulberry32(1))
      assert.notDeepEqual(host.getSlot(2), before)
    })

    test('writes only to the active slot', () => {
      const host = makeHost(baseParams())
      const before = [0, 1, 2, 3].map(i => host.getSlot(i)!)
      host.switchSlot(2)
      host.randomizeActiveSlot(mulberry32(99))
      assert.notDeepEqual(host.getSlot(2), before[2])
      for (const i of [0, 1, 3]) {
        assert.deepEqual(host.getSlot(i), before[i])
      }
    })

    test('cells string length matches the host cells.length', () => {
      const host = makeHost(baseParams()) // 4 cells
      host.randomizeActiveSlot(mulberry32(0))
      assert.equal(host.getSlot(0)!.cells.length, 4)
    })

    test('cells always contains ≥1 motion op (re-roll constraint)', () => {
      // ADR 006 §"Axis 4" — All-hold / all-rest programs have no harmonic
      // motion and aren't useful output; re-roll until ≥1 of P/L/R appears.
      // Sweep many seeds — each result must contain at least one motion op.
      for (let s = 0; s < 200; s++) {
        const host = makeHost(baseParams())
        host.randomizeActiveSlot(mulberry32(s))
        const cells = host.getSlot(0)!.cells
        assert.match(cells, /[PLR]/, `seed ${s} produced cells "${cells}" without motion op`)
      }
    })

    test('re-roll triggers when first batch is all-hold/all-rest', () => {
      // RANDOM_OPS = ['P', 'L', 'R', 'hold', 'rest']. floor(rng()*5):
      //   0.6 → 3 (hold), 0.0 → 0 (P).
      // First 4 draws = all hold (no motion op) → re-roll. Next 4 draws =
      // P, P, P, hold → valid. Trailing draws feed jitter/seed/root/quality.
      const draws = [
        0.6, 0.6, 0.6, 0.6, // first batch — all hold (rejected)
        0.0, 0.0, 0.0, 0.6, // second batch — PPP_ (accepted)
        0.5, 0.5, 0.5, 0.5, // jitter, seed, root, quality
      ]
      let i = 0
      const rng = () => draws[i++]!
      const host = makeHost(baseParams())
      host.randomizeActiveSlot(rng)
      assert.equal(host.getSlot(0)!.cells, 'PPP_')
    })

    test('field ranges hold across many seeds', () => {
      // ADR 006 §"Axis 4": jitter 0..0.6; seed uint; root 0..11; quality
      // maj|min. Sweep 200 seeds — every generated slot must satisfy these.
      for (let s = 0; s < 200; s++) {
        const host = makeHost(baseParams())
        host.randomizeActiveSlot(mulberry32(s))
        const slot = host.getSlot(0)!
        assert.ok(slot.jitter >= 0 && slot.jitter <= 0.6,
          `seed ${s} jitter=${slot.jitter} out of [0, 0.6]`)
        assert.ok(Number.isInteger(slot.seed) && slot.seed >= 0 && slot.seed <= 0xffffffff,
          `seed ${s} produced invalid uint seed=${slot.seed}`)
        assert.ok(Number.isInteger(slot.startChord.root)
          && slot.startChord.root >= 0 && slot.startChord.root <= 11,
          `seed ${s} root=${slot.startChord.root}`)
        assert.ok(slot.startChord.quality === 'maj' || slot.startChord.quality === 'min')
      }
    })

    test('same RNG sequence is deterministic across two fresh hosts', () => {
      const host1 = makeHost(baseParams())
      const host2 = makeHost(baseParams())
      host1.randomizeActiveSlot(mulberry32(42))
      host2.randomizeActiveSlot(mulberry32(42))
      assert.deepEqual(host1.getSlot(0), host2.getSlot(0))
    })

    test('randomized slot startChord is loaded into running params (no MIDI held)', () => {
      // Verifies the setSlot + switchSlot composition — same contract as
      // loadFactoryPreset. With no MIDI held, the slot's startChord must
      // become params.startChord (subject to the bass-note octave anchor).
      const host = makeHost(baseParams({ startChord: [60, 64, 67] }))
      host.randomizeActiveSlot(mulberry32(7))
      const slot = host.getSlot(host.activeSlot)!
      const r = slot.startChord.root
      const third = slot.startChord.quality === 'maj' ? 4 : 3
      const expected = [r, (r + third) % 12, (r + 7) % 12].sort((a, b) => a - b)
      assert.deepEqual(pcSet(host.startChord), expected)
    })

    test('startChord defers when MIDI is held (same priority rule as switchSlot)', () => {
      const host = makeHost(baseParams({ startChord: [60, 64, 67] }))
      host.noteIn(64, 100, 1); host.noteIn(67, 100, 1); host.noteIn(71, 100, 1) // E minor
      assert.deepEqual(pcSet(host.startChord), [4, 7, 11])
      host.randomizeActiveSlot(mulberry32(13))
      // Held E minor still wins regardless of what the random produced.
      assert.deepEqual(pcSet(host.startChord), [4, 7, 11])
    })
  })

  describe('program string copy/paste — ADR 006 Phase 6', () => {
    describe('getActiveProgramString', () => {
      test('returns the serialized form of the active slot', () => {
        const host = makeHost(baseParams({
          startChord: [60, 64, 67],
          cells: cells('P', 'L', 'R', 'hold'),
          jitter: 0.25,
          seed: 7,
        }))
        const expected = serializeSlot(host.getSlot(0)!)
        assert.equal(host.getActiveProgramString(), expected)
      })

      test('reflects active-slot change on switchSlot', () => {
        const host = makeHost(baseParams())
        const slot1 = makeSlot({ cells: 'PPP_', jitter: 0.4, seed: 99 })
        host.setSlot(1, slot1)
        host.switchSlot(1)
        assert.equal(host.getActiveProgramString(), serializeSlot(slot1))
      })

      test('reflects auto-saved edits in the active slot', () => {
        const host = makeHost(baseParams({ jitter: 0 }))
        host.switchSlot(2)
        host.setParams({ jitter: 0.5 })
        const parsed = parseSlot(host.getActiveProgramString())!
        assert.equal(parsed.jitter, 0.5)
      })

      test('reflects randomizeActiveSlot output', () => {
        const host = makeHost(baseParams())
        host.randomizeActiveSlot(mulberry32(3))
        const generated = host.getSlot(host.activeSlot)!
        assert.equal(host.getActiveProgramString(), serializeSlot(generated))
      })

      test('reflects loadFactoryPreset', () => {
        const host = makeHost(baseParams())
        host.loadFactoryPreset(0)
        assert.equal(host.getActiveProgramString(), FACTORY_PRESETS[0]!.program)
      })

      test('reflects auto-saved per-param edits', () => {
        // Per ADR 006 §"Axis 1" amendment (2026-04-30): user-driven
        // setParams(jitter) auto-saves into the active slot, so the
        // program string updates immediately.
        const host = makeHost(baseParams({ jitter: 0 }))
        host.setParams({ jitter: 0.7 })
        assert.ok(host.getActiveProgramString().includes('|j=0.7|'),
          `expected updated jitter in program string, got ${host.getActiveProgramString()}`)
      })
    })

    describe('loadFromProgramString', () => {
      test('parses + loads valid program into the active slot', () => {
        const host = makeHost(baseParams())
        host.switchSlot(2)
        const ok = host.loadFromProgramString('PPP_|s=42|j=0.3|c=Em')
        assert.equal(ok, true)
        const slot = host.getSlot(2)!
        assert.equal(slot.cells, 'PPP_')
        assert.equal(slot.seed, 42)
        assert.equal(slot.jitter, 0.3)
        assert.deepEqual(slot.startChord, { root: 4, quality: 'min' })
      })

      test('applies loaded slot to running params (no MIDI held)', () => {
        // Same setSlot + switchSlot composition as loadFactoryPreset —
        // the loaded program must drive the next step output, not just
        // sit in the slot.
        const host = makeHost(baseParams({ startChord: [60, 64, 67] }))
        host.loadFromProgramString('PLR_|s=0|j=0|c=F#m')
        // F# minor: F#=6, A=9, C#=1
        assert.deepEqual(pcSet(host.startChord), [1, 6, 9])
      })

      test('malformed string returns false and does not mutate state', () => {
        const host = makeHost(baseParams())
        const before = host.getSlot(0)
        assert.equal(host.loadFromProgramString('not-a-program'), false)
        assert.equal(host.loadFromProgramString(''), false)
        assert.equal(host.loadFromProgramString('PLR_|s=abc|j=0|c=C'), false)
        assert.equal(host.loadFromProgramString('PLR_|j=0|c=C'), false) // missing seed
        assert.deepEqual(host.getSlot(0), before)
      })

      test('round-trip: getActiveProgramString → loadFromProgramString restores slot', () => {
        // Auto-save model: constructor seeds slot 0 from initial params
        // (no explicit saveCurrent needed). Reading the program string
        // and loading it into a fresh host should reproduce slot 0.
        const host1 = makeHost(baseParams({
          startChord: [65, 68, 72], // F minor
          cells: cells('P', 'hold', 'rest', 'L'),
          jitter: 0.4,
          seed: 12345,
        }))
        const program = host1.getActiveProgramString()

        const host2 = makeHost(baseParams())
        host2.loadFromProgramString(program)
        assert.deepEqual(host2.getSlot(0), host1.getSlot(0))
      })

      test('writes only to the active slot', () => {
        const host = makeHost(baseParams())
        const before = [0, 1, 2, 3].map(i => host.getSlot(i)!)
        host.switchSlot(2)
        host.loadFromProgramString('PPP_|s=1|j=0.1|c=A')
        assert.notDeepEqual(host.getSlot(2), before[2])
        for (const i of [0, 1, 3]) {
          assert.deepEqual(host.getSlot(i), before[i])
        }
      })

      test('startChord defers when MIDI is held (same priority rule as switchSlot)', () => {
        const host = makeHost(baseParams({ startChord: [60, 64, 67] }))
        host.noteIn(64, 100, 1); host.noteIn(67, 100, 1); host.noteIn(71, 100, 1) // E minor
        assert.deepEqual(pcSet(host.startChord), [4, 7, 11])
        host.loadFromProgramString('PLR_|s=0|j=0|c=F') // F major
        // Held E minor still wins; loaded F major suppressed until release.
        assert.deepEqual(pcSet(host.startChord), [4, 7, 11])
      })
    })
  })
})

// ── ADR 006 Phase 7 — RHYTHM gating ──────────────────────────────────────
//
// rhythm='legato' (default) preserves Phase A single-fire-per-cell behavior
// — verified implicitly by the existing Host.step suite which doesn't set
// rhythm. New presets fire multiple times per cell per gating mode.

describe('Host.step — RHYTHM gating (Phase 7)', () => {
  test("rhythm='chord' fires the held chord at every sub-step within a cell", () => {
    // spt=4, ticksPerStep=1 → cell = 4 sub-steps. cells=[hold] keeps chord
    // at startChord across the cell so each refire is the same triad.
    const host = makeHost(baseParams({
      cells: cells('hold'),
      stepsPerTransform: 4,
      rhythm: 'all',
    }))
    assert.equal(pitchesOf(host.step(0), 'noteOn').length, 3, 'pos=0 init fires startChord')
    for (const p of [1, 2, 3]) {
      assert.equal(pitchesOf(host.step(p), 'noteOn').length, 3, `pos=${p} every-tick refire`)
    }
  })

  test("rhythm='straight' fires only on the quarter (idx % 4 === 0)", () => {
    // spt=8, ticksPerStep=1 → 8 sub-steps per cell. onbeat fires at idx=0,4.
    const host = makeHost(baseParams({
      cells: cells('hold'),
      stepsPerTransform: 8,
      rhythm: 'onbeat',
    }))
    assert.equal(pitchesOf(host.step(0), 'noteOn').length, 3, 'pos=0 onbeat fires')
    for (const p of [1, 2, 3]) {
      assert.equal(pitchesOf(host.step(p), 'noteOn').length, 0, `pos=${p} silent`)
    }
    assert.equal(pitchesOf(host.step(4), 'noteOn').length, 3, 'pos=4 onbeat fires')
    for (const p of [5, 6, 7]) {
      assert.equal(pitchesOf(host.step(p), 'noteOn').length, 0, `pos=${p} silent`)
    }
  })

  test("rhythm='offbeat' fires on `&-of-each-quarter` (idx % 4 === 2)", () => {
    // Standard musical off-beat: 4 fires/bar at &-positions, complementary
    // to onbeat. spt=8 covers 2 quarters → fires at idx 2 and 6 only.
    const host = makeHost(baseParams({
      cells: cells('hold'),
      stepsPerTransform: 8,
      rhythm: 'offbeat',
    }))
    assert.equal(pitchesOf(host.step(0), 'noteOn').length, 0, 'pos=0 (idx=0, on-beat) silent')
    assert.equal(pitchesOf(host.step(1), 'noteOn').length, 0, 'pos=1 (e) silent')
    assert.equal(pitchesOf(host.step(2), 'noteOn').length, 3, 'pos=2 (&) fires')
    assert.equal(pitchesOf(host.step(3), 'noteOn').length, 0, 'pos=3 (a) silent')
    assert.equal(pitchesOf(host.step(4), 'noteOn').length, 0, 'pos=4 (next on-beat) silent')
    assert.equal(pitchesOf(host.step(5), 'noteOn').length, 0, 'pos=5 (e) silent')
    assert.equal(pitchesOf(host.step(6), 'noteOn').length, 3, 'pos=6 (&) fires')
    assert.equal(pitchesOf(host.step(7), 'noteOn').length, 0, 'pos=7 (a) silent')
  })

  test("rhythm='legato' (default) preserves single-fire-per-cell behavior", () => {
    // Regression check: head-only gating fires only at the cell head.
    const host = makeHost(baseParams({
      cells: cells('hold'),
      stepsPerTransform: 4,
    }))
    assert.equal(pitchesOf(host.step(0), 'noteOn').length, 3, 'pos=0 cell head fires')
    for (const p of [1, 2, 3]) {
      assert.equal(pitchesOf(host.step(p), 'noteOn').length, 0, `pos=${p} silent (head-only)`)
    }
  })

  test('within-cell refires use the same cell chord across sub-steps', () => {
    // cells=[P], spt=4: cell 0 boundary at pos=4 applies P → C major flips
    // to C minor. Sub-steps 5..7 should refire the SAME minor chord.
    const host = makeHost(baseParams({
      cells: cells('P'),
      stepsPerTransform: 4,
      rhythm: 'all',
    }))
    host.step(0); host.step(1); host.step(2); host.step(3)
    const ev4 = host.step(4)
    const pcs4 = pitchesOf(ev4, 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    // Reason: P inverts major↔minor with shared root → C minor pcs.
    assert.deepEqual(pcs4, [0, 3, 7], 'pos=4 cell 0 P → C minor')
    for (const p of [5, 6, 7]) {
      const ev = host.step(p)
      const pcs = pitchesOf(ev, 'noteOn').map(x => x % 12).sort((a, b) => a - b)
      assert.deepEqual(pcs, [0, 3, 7], `pos=${p} refires C minor`)
    }
  })
})

// ── ADR 006 Phase 7 — ARP picker ─────────────────────────────────────────

describe('Host.step — ARP (Phase 7)', () => {
  test("arp='up' rotates voiced notes within a cell, resets at cell boundary", () => {
    // cells=[P] with length=1, spt=4: init period (pos 0..3) holds startChord
    // (C major); cell 0 boundary at pos=4 applies P → C minor [60,63,67].
    // arp='up' with chord size 3 cycles voiced indices 0,1,2,0 within each
    // cell; fireIdx resets to 0 at the boundary. The fact that pos=4 lands
    // on ARP[0]=60 distinguishes reset (would yield 60) from no-reset (would
    // yield ARP[4%3]=ARP[1]=63).
    const host = makeHost(baseParams({
      cells: cells('P'),
      stepsPerTransform: 4,
      length: 1,
      voicing: 'close',
      rhythm: 'all',
      arp: 'up',
    }))
    // C major voiced = [60, 64, 67]
    assert.deepEqual(pitchesOf(host.step(0), 'noteOn'), [60], 'pos=0 ARP[0]')
    assert.deepEqual(pitchesOf(host.step(1), 'noteOn'), [64], 'pos=1 ARP[1]')
    assert.deepEqual(pitchesOf(host.step(2), 'noteOn'), [67], 'pos=2 ARP[2]')
    assert.deepEqual(pitchesOf(host.step(3), 'noteOn'), [60], 'pos=3 ARP wraps within cell')
    // pos=4: cell 0 boundary, P → C minor [60,63,67]. fireIdx resets → ARP[0]=60.
    assert.deepEqual(pitchesOf(host.step(4), 'noteOn'), [60], 'pos=4 boundary resets fireIdx')
    assert.deepEqual(pitchesOf(host.step(5), 'noteOn'), [63], 'pos=5 ARP[1] of C minor')
  })

  test("arp='down' rotates from highest voiced index to lowest", () => {
    // Init period (pos 0..7) holds C major; arpIndex(down, 3, fireIdx) =
    // 2,1,0,2,...
    const host = makeHost(baseParams({
      cells: cells('P'),
      stepsPerTransform: 8,
      length: 1,
      voicing: 'close',
      rhythm: 'all',
      arp: 'down',
    }))
    assert.deepEqual(pitchesOf(host.step(0), 'noteOn'), [67], 'down[0]=2')
    assert.deepEqual(pitchesOf(host.step(1), 'noteOn'), [64], 'down[1]=1')
    assert.deepEqual(pitchesOf(host.step(2), 'noteOn'), [60], 'down[2]=0')
    assert.deepEqual(pitchesOf(host.step(3), 'noteOn'), [67], 'down[3]=2 (wraps)')
  })

  test("arp='off' (default) emits the full voiced chord", () => {
    // Regression check: with arp='off', a multi-fire RHYTHM still emits the
    // full voiced chord on each fire.
    const host = makeHost(baseParams({
      cells: cells('P'),
      stepsPerTransform: 4,
      length: 1,
      voicing: 'close',
      rhythm: 'all',
    }))
    assert.deepEqual(pitchesOf(host.step(0), 'noteOn').sort((a, b) => a - b), [60, 64, 67])
    assert.deepEqual(pitchesOf(host.step(1), 'noteOn').sort((a, b) => a - b), [60, 64, 67])
  })

  test("arp='updown' bounces through voiced indices without replaying endpoints", () => {
    // chord size 3 → period = 2*(3-1) = 4 → indices 0,1,2,1,0,1,2,1,...
    const host = makeHost(baseParams({
      cells: cells('P'),
      stepsPerTransform: 8,
      length: 1,
      voicing: 'close',
      rhythm: 'all',
      arp: 'updown',
    }))
    assert.deepEqual(pitchesOf(host.step(0), 'noteOn'), [60], 'updown[0]=0')
    assert.deepEqual(pitchesOf(host.step(1), 'noteOn'), [64], 'updown[1]=1')
    assert.deepEqual(pitchesOf(host.step(2), 'noteOn'), [67], 'updown[2]=2')
    assert.deepEqual(pitchesOf(host.step(3), 'noteOn'), [64], 'updown[3]=1 (descending)')
    assert.deepEqual(pitchesOf(host.step(4), 'noteOn'), [60], 'updown[4]=0 (period wraps)')
  })

  test("arp='random' is seed-deterministic across two fresh hosts", () => {
    // All sub-steps fire within the init period; arp='random' draws one
    // index per fire from the host's reseeded mulberry32 stream. Two fresh
    // hosts with matching seed must produce identical ARP picks.
    const params = baseParams({
      cells: cells('P'),
      stepsPerTransform: 8,
      length: 1,
      voicing: 'close',
      rhythm: 'all',
      arp: 'random',
      seed: 12345,
    })
    const a = makeHost(params)
    const b = makeHost(params)
    for (let p = 0; p < 8; p++) {
      const evA = pitchesOf(a.step(p), 'noteOn')
      const evB = pitchesOf(b.step(p), 'noteOn')
      assert.deepEqual(evA, evB, `pos=${p} ARP random matches`)
      assert.equal(evA.length, 1, `pos=${p} fires exactly one ARP note`)
    }
  })
})

// ── ADR 006 Phase 7 — variable cell length ───────────────────────────────

describe('Host.params — length (Phase 7)', () => {
  test('length < cells.length restricts active cells', () => {
    // cells=[P,hold,hold,hold]: with length=4 the engine cycles through all
    // four cells (P, then three silent holds, then wraps back to P at pos=5).
    // With length=1 only cell 0 is active → P fires at every boundary.
    const longParams = baseParams({
      cells: cells('P', 'hold', 'hold', 'hold'),
      stepsPerTransform: 1,
      length: 4,
    })
    const shortParams = baseParams({
      cells: cells('P', 'hold', 'hold', 'hold'),
      stepsPerTransform: 1,
      length: 1,
    })
    const host4 = makeHost(longParams)
    const host1 = makeHost(shortParams)
    host4.step(0); host1.step(0)
    // pos=1: both fire cell 0 (P) → C minor
    assert.equal(pitchesOf(host4.step(1), 'noteOn').length, 3, 'length=4 pos=1 fires P')
    assert.equal(pitchesOf(host1.step(1), 'noteOn').length, 3, 'length=1 pos=1 fires P')
    // pos=2: length=4 visits cell 1 (hold, silent); length=1 wraps to cell 0 (P)
    assert.equal(pitchesOf(host4.step(2), 'noteOn').length, 0, 'length=4 pos=2 hold cell silent')
    assert.equal(pitchesOf(host1.step(2), 'noteOn').length, 3, 'length=1 pos=2 P wraps')
    // pos=5: length=4 wraps back to cell 0 (P fires again); length=1 fires P
    assert.equal(pitchesOf(host4.step(5), 'noteOn').length, 3, 'length=4 pos=5 wraps to P')
    assert.equal(pitchesOf(host1.step(5), 'noteOn').length, 3, 'length=1 pos=5 P wraps')
  })

  test('setParams({ length: N }) auto-extends cells when N > cells.length', () => {
    // [+] button user flow: user grows length from 4 to 5. Without
    // auto-extension activeCells caps at min(cells.length, length)=4 and
    // the new cell silently never plays — observed bug 2026-05-01. Pad
    // new cells with 'hold' (musically inert) so the user can grow the
    // program audibly; they then set the new cell's op via the popup.
    const host = makeHost(baseParams({
      cells: cells('P', 'L', 'R', 'hold'),
      length: 4,
    }))
    host.setParams({ length: 5 })
    const params = (host as unknown as { params: HostParams }).params
    assert.equal(params.cells.length, 5, 'cells extended to match new length')
    assert.equal(params.cells[4]!.op, 'hold', 'new cell defaults to hold')
  })

  test('setParams({ length: N }) does not shrink cells when N < cells.length', () => {
    // Shrinking via [-] keeps cells past the new length so growing back
    // does not lose user edits. Engine clamps via activeCells().
    const host = makeHost(baseParams({
      cells: cells('P', 'L', 'R', 'hold'),
      length: 4,
    }))
    host.setParams({ length: 2 })
    const params = (host as unknown as { params: HostParams }).params
    assert.equal(params.cells.length, 4, 'cells preserved on shrink')
    assert.equal(params.cells[2]!.op, 'R')
    assert.equal(params.cells[3]!.op, 'hold')
  })

  test('length is clamped at cells.length (no out-of-bounds reads)', () => {
    // cells.length=2, length=8 → effective active = 2; engine sees cells[0..1].
    const host = makeHost(baseParams({
      cells: cells('P', 'L'),
      stepsPerTransform: 1,
      length: 8,
    }))
    host.step(0)
    // pos=1: cell 0 P → minor
    const pcs1 = pitchesOf(host.step(1), 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.deepEqual(pcs1, [0, 3, 7], 'pos=1 fires C minor (P from C major)')
    // pos=3: cells [P,L] wraps (length clamped to 2) → cell 0 P again.
    // Sequence after init: P → minor, L → ?, P → ?, L → ?
    // At minimum, verify pos=3 produces SOME chord change (no out-of-range crash).
    const pcs3 = pitchesOf(host.step(3), 'noteOn').map(p => p % 12).sort((a, b) => a - b)
    assert.equal(pcs3.length, 3, 'pos=3 fires a triad (no out-of-range)')
  })
})

// ── ADR 006 Phase 7 — variable-length slot persistence (slice b) ─────────
//
// captureSlot must serialize only the active region (cells[0..length-1]) so
// switching back to the slot reproduces the same active count. applySlot
// must update length to match the loaded program string and extend the
// cells pool when loading a longer program. Round-trips at lengths 1, 4,
// and 8 must be lossless.

describe('Host slots — variable cell length (Phase 7 slice b)', () => {
  test('captureSlot serializes only the active region (length < cells.length)', () => {
    // cells=[P,L,L,R] but length=2 → slot.cells should be "PL", not "PLLR".
    const host = makeHost(baseParams({
      cells: cells('P', 'L', 'L', 'R'),
      length: 2,
    }))
    const slot = host.getSlot(host.activeSlot)!
    assert.equal(slot.cells, 'PL', 'slot persists only the active 2 cells')
  })

  test('captureSlot at length=cells.length matches pre-Phase-7 behavior', () => {
    // Regression: when length === cells.length, slot serialization is
    // identical to the legacy form. Guards against breaking saved Live sets.
    const host = makeHost(baseParams({
      cells: cells('P', 'L', 'R', 'hold'),
      length: 4,
    }))
    assert.equal(host.getSlot(host.activeSlot)!.cells, 'PLR_')
  })

  test('switchSlot to an 8-cell program extends cells pool and sets length=8', () => {
    // Default device starts with 4-cell pool. Loading an 8-char cells string
    // must extend the pool (so cells 4..7 receive the new ops) and update
    // length so the engine fires through all 8. Force a fresh captureSlot
    // by changing seed (auto-saves into slots[1]) so the round-trip reflects
    // the active params, not the stored input.
    const host = makeHost(baseParams())
    host.setSlot(1, {
      cells: 'PLRPLR_-',
      startChord: { root: 0, quality: 'maj' },
      jitter: 0,
      seed: 0,
    })
    host.switchSlot(1)
    host.setParams({ seed: 42 })
    const captured = host.getSlot(1)!
    assert.equal(captured.cells, 'PLRPLR_-', 'active params round-trip an 8-cell program')
    assert.equal(captured.seed, 42)
  })

  test('switchSlot to a shorter program shrinks the active length', () => {
    // Start with an 8-cell slot, switch to a 4-cell slot, then auto-save.
    // captureSlot reflects only the new 4-cell active region; cells beyond
    // remain in the pool (untouched) but are inert per the length cap.
    const host = makeHost(baseParams())
    host.setSlot(1, {
      cells: 'PLRPLR_-',
      startChord: { root: 0, quality: 'maj' },
      jitter: 0,
      seed: 0,
    })
    host.switchSlot(1)
    host.setSlot(2, {
      cells: 'PLLR',
      startChord: { root: 0, quality: 'maj' },
      jitter: 0,
      seed: 0,
    })
    host.switchSlot(2)
    host.setParams({ seed: 99 })
    assert.equal(host.getSlot(2)!.cells, 'PLLR', 'active region shrinks to 4 chars')
  })

  test('captureSlot round-trip preserves cells across switchSlot at lengths 1, 4, 8', () => {
    // For each length, set a slot, switch into it, force a fresh capture
    // (auto-save via seed change), then verify the cells string matches
    // the input. Tests the full applySlotCells → captureSlot path against
    // the active params (not just the stored slot reference).
    for (const cellsStr of ['P', 'PLLR', 'PLRPLR_-']) {
      const host = makeHost(baseParams())
      host.setSlot(1, {
        cells: cellsStr,
        startChord: { root: 0, quality: 'maj' },
        jitter: 0.25,
        seed: 7,
      })
      host.switchSlot(1)
      host.setParams({ seed: 8 }) // force syncActiveSlot
      assert.equal(host.getSlot(1)!.cells, cellsStr, `length=${cellsStr.length} round-trip`)
    }
  })

  test('randomizeActiveSlot generates cells matching the active length', () => {
    // length=2 → randomized slot has exactly 2 cells. length=8 → 8 cells.
    // Reason: randomize must respect the user's chosen pattern length so
    // cycling pattern length isn't accidentally extended on regenerate.
    let counter = 0
    const fakeRng = () => {
      const seq = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.05, 0.15]
      const v = seq[counter % seq.length]!
      counter++
      return v
    }
    const host2 = makeHost(baseParams({ length: 2 }))
    host2.randomizeActiveSlot(fakeRng)
    assert.equal(host2.getSlot(host2.activeSlot)!.cells.length, 2, 'length=2 → 2 cells generated')

    counter = 0
    const host8 = makeHost(baseParams({
      cells: [...cells('P', 'L', 'L', 'R', 'hold', 'hold', 'hold', 'hold')],
      length: 8,
    }))
    host8.randomizeActiveSlot(fakeRng)
    assert.equal(host8.getSlot(host8.activeSlot)!.cells.length, 8, 'length=8 → 8 cells generated')
  })

  test('setParams with new length triggers auto-save into the active slot', () => {
    // Reason: length is part of the slot's persistent identity (via cells
    // string length). Changing it must mirror into slots[active] like other
    // slot fields, so the patcher's slot-store stays in sync.
    const host = makeHost(baseParams({
      cells: cells('P', 'L', 'L', 'R'),
      length: 4,
    }))
    assert.equal(host.getSlot(0)!.cells, 'PLLR')
    host.setParams({ length: 2 })
    assert.equal(host.getSlot(0)!.cells, 'PL', 'length change auto-saves shorter cells string')
  })
})
