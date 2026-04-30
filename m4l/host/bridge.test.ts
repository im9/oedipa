import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge, type BridgeDeps } from './bridge.ts'
import { mulberry32 } from '../engine/tonnetz.ts'
import { FACTORY_PRESETS } from './presets.ts'

interface NoteCall {
  pitch: number
  velocity: number
  channel: number
  // wall-clock time at which emitNote was called (mock-now units).
  at: number
}

interface OutletCall {
  channel: string
  args: Array<number | string>
  at: number
}

interface ScheduleCall {
  ms: number
  cb: () => void
  scheduledAt: number
  // resolves when the cb has been invoked.
  fired: boolean
}

class Harness {
  notes: NoteCall[] = []
  outlets: OutletCall[] = []
  scheduled: ScheduleCall[] = []
  // Flat-rate metro-style clock the test advances explicitly.
  clock = 0

  deps: BridgeDeps = {
    emitNote: (pitch, velocity, channel) => {
      this.notes.push({ pitch, velocity, channel, at: this.clock })
    },
    emitOutlet: (channel, ...args) => {
      this.outlets.push({ channel, args, at: this.clock })
    },
    now: () => this.clock,
    scheduleAfter: (ms, cb) => {
      this.scheduled.push({ ms, cb, scheduledAt: this.clock, fired: false })
    },
  }

  // Advance clock to time `t`, firing any scheduled callbacks whose absolute
  // due time (scheduledAt + ms) is <= t. Mirrors how setTimeout fires when
  // the event loop reaches the timer.
  advanceTo(t: number): void {
    this.clock = t
    for (const s of this.scheduled) {
      if (s.fired) continue
      if (s.scheduledAt + s.ms <= t) {
        s.fired = true
        s.cb()
      }
    }
  }

  noteOnsAt(pitch: number): NoteCall[] {
    return this.notes.filter(n => n.pitch === pitch && n.velocity > 0)
  }

  noteOffsAt(pitch: number): NoteCall[] {
    return this.notes.filter(n => n.pitch === pitch && n.velocity === 0)
  }
}

// Tests below the cellLength block predate the Phase A musical-defaults
// change (gate 0.9 → 1.0, cells P-L-R-hold → R-L-L-R, voicing close →
// spread, stepsPerTransform default decoupled into cellLength). They were
// written against concrete numerical expectations under the old baseline
// (gate=0.9 → audible gate-end offs at delayPos = 0.9 * spt; spt=4 → cells
// fire at pos=4; voicing=close → tight pitch sets). To keep those tests
// grounded in the timing math they were written for — without overwriting
// production defaults — pass this baseline via `initialParams`.
const LEGACY_TEST_BASELINE = {
  stepsPerTransform: 4,
  voicing: 'close' as const,
  cells: [
    { op: 'P' as const, velocity: 1.0, gate: 0.9, probability: 1.0, timing: 0 },
    { op: 'L' as const, velocity: 1.0, gate: 0.9, probability: 1.0, timing: 0 },
    { op: 'R' as const, velocity: 1.0, gate: 0.9, probability: 1.0, timing: 0 },
    { op: 'hold' as const, velocity: 1.0, gate: 0.9, probability: 1.0, timing: 0 },
  ],
}

describe('Bridge — cellLength (cell duration in bars)', () => {
  // Rationale: prior model coupled cell rate to subdivision × stepsPerTransform.
  // That made cell rate change whenever the user shifted subdivision (a feel
  // axis), and forced the user to mentally compute "subdiv * Steps = duration"
  // to predict cycle length. The new contract: cellLength is the single
  // user-facing rate parameter, expressed in BARS (PPQN=24 → 96 ticks/bar at
  // 4/4). Bridge translates to the engine's stepsPerTransform via:
  //   stepsPerTransform = cellLength_bars * 96 / ticksPerStep
  // and recomputes whenever either input changes.
  //
  // Helper to peek at the host's params for assertions.
  function hostParams(b: Bridge): { stepsPerTransform: number; ticksPerStep: number } {
    return (b as unknown as { host: { params: { stepsPerTransform: number; ticksPerStep: number } } })
      .host.params
  }

  test('setParams cellLength=1 with ticksPerStep=6 (16th) → stepsPerTransform=16', () => {
    // 1 bar = 96 raw ticks at PPQN=24. With 16th subdivision (6 ticks/step),
    // 96/6 = 16 subdivision-steps per cell. The engine still consumes one
    // cell per spt subdivisions; only the source of truth shifts.
    const h = new Harness()
    const b = new Bridge(h.deps)
    b.setParams('ticksPerStep', 6)
    b.setParams('cellLength', 1)
    assert.equal(hostParams(b).stepsPerTransform, 16,
      '1 bar / 16th subdivision = 16 spt')
    assert.equal(hostParams(b).ticksPerStep, 6)
  })

  test('setParams cellLength=2 with ticksPerStep=6 → stepsPerTransform=32', () => {
    const h = new Harness()
    const b = new Bridge(h.deps)
    b.setParams('ticksPerStep', 6)
    b.setParams('cellLength', 2)
    assert.equal(hostParams(b).stepsPerTransform, 32, '2 bars / 16th = 32 spt')
  })

  test('changing ticksPerStep recomputes stepsPerTransform from current cellLength', () => {
    // User holds cellLength=1 and changes subdivision. Cell duration in
    // ticks must remain 96 (1 bar) — only the subdivision-step count changes.
    const h = new Harness()
    const b = new Bridge(h.deps)
    b.setParams('cellLength', 1)
    b.setParams('ticksPerStep', 6)  // 16th
    assert.equal(hostParams(b).stepsPerTransform, 16)
    b.setParams('ticksPerStep', 12) // 8th
    assert.equal(hostParams(b).stepsPerTransform, 8, '1 bar / 8th = 8 spt')
    b.setParams('ticksPerStep', 3)  // 32nd
    assert.equal(hostParams(b).stepsPerTransform, 32, '1 bar / 32nd = 32 spt')
    b.setParams('ticksPerStep', 4)  // 16T
    assert.equal(hostParams(b).stepsPerTransform, 24, '1 bar / 16T = 24 spt')
  })

  test('all (cellLength, ticksPerStep) combinations yield integer stepsPerTransform', () => {
    // Sanity: with the live.tab option sets we expose (cellLength ∈
    // {1,2,4,8} bars, ticksPerStep ∈ {12,6,3,8,4} per ADR 005 §Subdivision),
    // every cell duration is an integer number of subdivision-steps. Failing
    // this would mean the engine's cell-boundary modular arithmetic could
    // never line up.
    for (const bars of [1, 2, 4, 8]) {
      for (const tps of [12, 6, 3, 8, 4]) {
        const h = new Harness()
        const b = new Bridge(h.deps)
        b.setParams('ticksPerStep', tps)
        b.setParams('cellLength', bars)
        const spt = hostParams(b).stepsPerTransform
        assert.ok(Number.isInteger(spt) && spt >= 1,
          `cellLength=${bars}, tps=${tps}: spt=${spt} must be positive integer`)
        assert.equal(spt * tps, bars * 96,
          `cellLength=${bars}, tps=${tps}: cell duration must equal ${bars} bars in ticks`)
      }
    }
  })

  test('invalid cellLength (0, negative, NaN) is a no-op', () => {
    const h = new Harness()
    const b = new Bridge(h.deps)
    b.setParams('ticksPerStep', 6)
    b.setParams('cellLength', 1) // baseline
    const baseline = hostParams(b).stepsPerTransform
    b.setParams('cellLength', 0)
    assert.equal(hostParams(b).stepsPerTransform, baseline, '0 ignored')
    b.setParams('cellLength', -1)
    assert.equal(hostParams(b).stepsPerTransform, baseline, 'negative ignored')
    b.setParams('cellLength', NaN)
    assert.equal(hostParams(b).stepsPerTransform, baseline, 'NaN ignored')
  })

  test('cellLength is not auto-saved as a slot field (device-shared)', () => {
    // Until / unless the spec promotes cellLength to a slot field, changing
    // it must not write the slot-store outlet (the Drift/Cycle/etc. presets
    // currently share one global cell duration).
    const h = new Harness()
    const b = new Bridge(h.deps)
    h.outlets.length = 0
    b.setParams('cellLength', 2)
    const slotStore = h.outlets.filter(o => o.channel === 'slot-store')
    assert.equal(slotStore.length, 0, 'cellLength change must not emit slot-store')
  })
})

// ── ADR 006 Phase 7 — RHYTHM/ARP/length params ───────────────────────────
//
// Slice (a) wires the new params through Bridge.setParams. They are
// device-shared per ADR 006 §"Phase 7": rhythm/arp don't reach the slot
// store, length stays out of slot-store too (cell ops are slot-stored, but
// active count is a device-level cap).

describe('Bridge — rhythm / arp / length passthrough (Phase 7)', () => {
  function hostFeel(b: Bridge): { rhythm: string; arp: string; length: number } {
    return (b as unknown as { host: { params: { rhythm: string; arp: string; length: number } } })
      .host.params
  }

  test("setParams('rhythm', 'chord') reaches the host without touching slot-store", () => {
    const h = new Harness()
    const b = new Bridge(h.deps)
    h.outlets.length = 0
    b.setParams('rhythm', 'chord')
    assert.equal(hostFeel(b).rhythm, 'chord')
    const slotStore = h.outlets.filter(o => o.channel === 'slot-store')
    assert.equal(slotStore.length, 0, 'rhythm is device-shared, not slot-stored')
  })

  test("setParams('arp', 'up') reaches the host without touching slot-store", () => {
    const h = new Harness()
    const b = new Bridge(h.deps)
    h.outlets.length = 0
    b.setParams('arp', 'up')
    assert.equal(hostFeel(b).arp, 'up')
    const slotStore = h.outlets.filter(o => o.channel === 'slot-store')
    assert.equal(slotStore.length, 0, 'arp is device-shared, not slot-stored')
  })

  test("setParams('length', 2) reaches the host without touching slot-store", () => {
    const h = new Harness()
    const b = new Bridge(h.deps)
    h.outlets.length = 0
    b.setParams('length', 2)
    assert.equal(hostFeel(b).length, 2)
    const slotStore = h.outlets.filter(o => o.channel === 'slot-store')
    assert.equal(slotStore.length, 0, 'length is device-shared, not slot-stored')
  })
})

describe('Bridge — step timing estimator', () => {
  test('msPerPos starts at 0 and stays 0 until two steps observed', () => {
    const h = new Harness()
    const b = new Bridge(h.deps)
    h.clock = 100
    b.step(0)
    assert.equal(b.getMsPerPos(), 0, 'no estimate from a single step')
  })

  test('two steps separated by dt yield msPerPos = dt / dpos', () => {
    // 16th note @ 120bpm = 125ms per pos. dpos=1 across one metro tick.
    const h = new Harness()
    const b = new Bridge(h.deps)
    h.clock = 1000
    b.step(0)
    h.clock = 1125
    b.step(1)
    assert.equal(b.getMsPerPos(), 125)
  })

  test('msPerPos smooths across uneven intervals (does not snap to outlier)', () => {
    // Smoothing factor: msPerPos = msPerPos*0.7 + inst*0.3 after first sample.
    const h = new Harness()
    const b = new Bridge(h.deps)
    h.clock = 0; b.step(0)
    h.clock = 100; b.step(1) // inst=100 → msPerPos=100 (first sample)
    h.clock = 300; b.step(2) // inst=200 → msPerPos = 100*0.7 + 200*0.3 = 130
    assert.equal(b.getMsPerPos(), 130)
  })

  test('large dt (>= 5000ms) is rejected as a stall, not folded into estimate', () => {
    const h = new Harness()
    const b = new Bridge(h.deps)
    h.clock = 0; b.step(0)
    h.clock = 125; b.step(1)
    assert.equal(b.getMsPerPos(), 125)
    h.clock = 6000; b.step(2) // 5875ms gap: transport likely stalled
    assert.equal(b.getMsPerPos(), 125, 'stall sample ignored')
  })

  test('panic resets timing state without losing msPerPos magnitude', () => {
    // After panic, the next two steps re-establish the estimate; the prior
    // timestamp is gone so a single post-panic step doesn't update.
    const h = new Harness()
    const b = new Bridge(h.deps)
    h.clock = 0; b.step(0)
    h.clock = 125; b.step(1)
    b.panic()
    assert.equal(b.getLastStepPos(), null, 'panic clears lastStepPos')
    h.clock = 200
    b.step(0)
    // Single post-panic step has no prior timestamp → msPerPos unchanged.
    assert.equal(b.getMsPerPos(), 125)
  })
})

describe('Bridge — dispatch (delayPos handling)', () => {
  test('events with no delayPos emit immediately', () => {
    // step(0) emits the startChord with no delayPos → 3 immediate noteOns.
    const h = new Harness()
    const b = new Bridge(h.deps)
    h.clock = 1000
    b.step(0)
    const ons = h.notes.filter(n => n.velocity > 0)
    assert.equal(ons.length, 3)
    for (const ev of ons) assert.equal(ev.at, 1000, 'fires at the step time')
    assert.equal(h.scheduled.length, 0, 'no setTimeout for delayPos<=0 events')
  })

  test('events with delayPos > 0 are scheduled via scheduleAfter when msPerPos is known', () => {
    // After two steps msPerPos=125. Step(4) emits cell-driven events; gate=0.9
    // and spt=4 → scheduled noteOff at delayPos = 0.9*4 = 3.6 → ms=450.
    const h = new Harness()
    const b = new Bridge(h.deps, { initialParams: LEGACY_TEST_BASELINE })
    h.clock = 0; b.step(0)
    h.clock = 125; b.step(1)
    h.clock = 250; b.step(2)
    h.clock = 375; b.step(3)
    // msPerPos has stabilized near 125 by now.
    h.clock = 500; b.step(4)
    // gate-end noteOffs (3 pitches) scheduled at 3.6 * msPerPos.
    const expectedMs = 3.6 * b.getMsPerPos()
    const gateScheduled = h.scheduled.filter(s => Math.abs(s.ms - expectedMs) < 0.001)
    assert.equal(gateScheduled.length, 3, 'three gate-end noteOffs scheduled')
  })

  test('scheduled noteOff fires at the right wall-clock time', () => {
    // gate=0.9, spt=4, msPerPos≈125 → noteOff fires at step time + 450ms.
    const h = new Harness()
    const b = new Bridge(h.deps, { initialParams: LEGACY_TEST_BASELINE })
    h.clock = 0; b.step(0)
    h.clock = 125; b.step(1)
    h.clock = 250; b.step(2)
    h.clock = 375; b.step(3)
    h.clock = 500; b.step(4)
    const ms = b.getMsPerPos() * 3.6
    const dueAt = 500 + ms
    h.advanceTo(dueAt)
    // Three scheduled noteOffs should have fired by now.
    const offs = h.notes.filter(n => n.velocity === 0 && n.at >= dueAt - 1)
    // Cmaj→P→Cmin: voiced = [60, 63, 67]. Gate-end noteOffs target those pitches.
    const offPitches = offs.map(n => n.pitch).sort((a, b) => a - b)
    assert.deepEqual(offPitches, [60, 63, 67])
  })

  test('msPerPos=0 (initial) makes delayed events fall through to immediate emit', () => {
    // Edge case: if for some reason msPerPos is still 0 when a cell-driven
    // step fires (e.g., scrub at pos=spt before any other steps), scheduled
    // noteOffs degrade to immediate emit instead of nonsense ms.
    const h = new Harness()
    const b = new Bridge(h.deps, { initialParams: LEGACY_TEST_BASELINE })
    // Jump directly to pos=4 — no prior steps, msPerPos=0.
    h.clock = 0
    b.step(4)
    assert.equal(b.getMsPerPos(), 0)
    // Voiced noteOns + gate-end noteOffs all at time 0.
    const offs = h.notes.filter(n => n.velocity === 0)
    assert.ok(offs.length > 0, 'gate-end noteOffs emitted immediately')
  })
})

describe('Bridge — full transport cycle (regression for "first note only" bug)', () => {
  // Reproduces the user-reported scenario: transport plays through several
  // metro ticks. Each step's audio must be heard (noteOn is not killed by
  // any racing scheduled noteOff). Asserts on the order of MIDI events as
  // they would arrive at the synth.
  test('Cmaj startChord (step 0) and Cmin (step 4) both produce audible noteOn windows', () => {
    const h = new Harness()
    const b = new Bridge(h.deps, { initialParams: LEGACY_TEST_BASELINE })
    // 16th @ 120bpm = 125ms/pos. spt=4 → cell fires every 500ms.
    for (let pos = 0; pos < 4; pos++) {
      h.advanceTo(pos * 125)
      b.step(pos)
    }
    h.advanceTo(500); b.step(4)

    // After step(0), Cmaj noteOns must be present at clock=0.
    const cmajOns = h.notes.filter(n => n.velocity > 0 && n.at === 0)
    assert.equal(cmajOns.length, 3, 'startChord noteOns at step 0')

    // After step(4), Cmin (60,63,67) noteOns must be present at clock=500
    // and must NOT be killed by a scheduled noteOff at the same instant.
    const cminOns = h.notes.filter(n => n.velocity > 0 && n.at === 500)
    const cminPitches = cminOns.map(n => n.pitch).sort((a, b) => a - b)
    assert.deepEqual(cminPitches, [60, 63, 67])

    // No scheduled noteOff for Cmin should fire at or before clock=500
    // (would zero-length the chord).
    const offsAtFire = h.notes.filter(n => n.velocity === 0 && n.at === 500)
    // The legato handoff offs (Cmaj {60,64,67}) ARE at clock=500. Verify
    // those are the prior-chord pitches, not the new chord's.
    const offPitchesAt500 = offsAtFire.map(n => n.pitch).sort((a, b) => a - b)
    assert.deepEqual(offPitchesAt500, [60, 64, 67], 'only prior-chord legato handoff at clock=500')
  })

  test('audible window for Cmin spans from step(4) to step(4)+gate*spt*ms', () => {
    const h = new Harness()
    const b = new Bridge(h.deps, { initialParams: LEGACY_TEST_BASELINE })
    for (let pos = 0; pos < 4; pos++) {
      h.advanceTo(pos * 125)
      b.step(pos)
    }
    h.advanceTo(500); b.step(4)
    // Advance to just before the gate-end (450ms after step 4). Cmin should
    // still be sounding (no noteOff has fired).
    h.advanceTo(500 + 449)
    const cminOffsBefore = h.notes.filter(n => n.velocity === 0 && n.pitch === 63 && n.at > 500)
    assert.equal(cminOffsBefore.length, 0, 'Cmin still sounding before gate end')
    // Advance past gate end. Now the noteOff for pitch 63 must have fired.
    h.advanceTo(500 + 451)
    const cminOffsAfter = h.notes.filter(n => n.velocity === 0 && n.pitch === 63 && n.at > 500)
    assert.equal(cminOffsAfter.length, 1, 'Cmin noteOff fires at gate end')
  })

  test('three consecutive cell transforms all emit audible noteOns', () => {
    // Cmaj → P→Cmin → L→Ab maj. Verifies that handoffPending=false after
    // gate<1.0 doesn't stop subsequent steps from emitting handoffs (the
    // prior chord's gate-end noteOff handles it via setTimeout, not the
    // host's handoff path).
    const h = new Harness()
    const b = new Bridge(h.deps, { initialParams: LEGACY_TEST_BASELINE })
    for (let pos = 0; pos < 9; pos++) {
      h.advanceTo(pos * 125)
      // Fire any due scheduled callbacks before the next step records
      // its timestamp.
      b.step(pos)
    }
    // Drain remaining scheduled events.
    h.advanceTo(2000)

    // step 0: 3 Cmaj noteOns at clock=0.
    // step 4: 3 Cmaj noteOffs (handoff) + 3 Cmin noteOns at clock=500;
    //         3 Cmin noteOffs scheduled for clock≈950.
    // step 8: 3 Cmin noteOffs scheduled at ~950 already fired; new chord
    //         (cells[1]=L applied to Cmin = Ab maj) noteOns at clock=1000.
    const distinctNoteOnTimes = [...new Set(h.notes.filter(n => n.velocity > 0).map(n => n.at))].sort((a, b) => a - b)
    assert.deepEqual(distinctNoteOnTimes, [0, 500, 1000], 'noteOns at three distinct chord-change times')
  })
})

describe('Bridge slots — ADR 006 Phase 3 (TS half)', () => {
  // The bridge layer wraps the host's slot ops and emits side-channel
  // outlets so the patcher can silently rehydrate its visible widgets
  // (live.tab cells, jitter / seed live.numbox, live.text program string,
  // active-slot tab) after a slot mutation. Tests cover the action surface
  // and outlet protocol; storage rehydrate (patcher → bridge on loadbang)
  // is deferred to commit D once the patcher's storage layout is decided.

  function slotOutlets(h: Harness): OutletCall[] {
    return h.outlets.filter(o => o.channel.startsWith('slot-'))
  }

  function byChannel(outs: OutletCall[], channel: string): OutletCall[] {
    return outs.filter(o => o.channel === channel)
  }

  describe('switchSlot', () => {
    test('updates host activeSlot and emits full slot UI rehydrate', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      // Stage slot 1 with a distinctive program so the rehydrate outlets
      // carry recognizable values.
      assert.equal(b.loadFromProgramString('PPP_|s=42|j=0.3|c=Em'), true)
      // After loadFromProgramString, slot 0 (initial active) is now Em-set.
      // Switch to slot 2 (still default) and back to confirm switching emits.
      h.outlets.length = 0
      b.switchSlot(2)
      const outs = slotOutlets(h)
      // Expected: slot-active, slot-program, slot-cell-op×4, slot-jitter, slot-seed.
      assert.equal(byChannel(outs, 'slot-active').length, 1, 'slot-active emitted once')
      assert.deepEqual(byChannel(outs, 'slot-active')[0]!.args, [2])
      assert.equal(byChannel(outs, 'slot-program').length, 1, 'slot-program emitted once')
      assert.equal(byChannel(outs, 'slot-cell-op').length, 4, 'one slot-cell-op per cell')
      assert.equal(byChannel(outs, 'slot-jitter').length, 1)
      assert.equal(byChannel(outs, 'slot-seed').length, 1)
    })

    test('out-of-range index emits nothing', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      b.switchSlot(-1)
      b.switchSlot(4)
      assert.equal(slotOutlets(h).length, 0)
    })

    // NOTE: bridge.switchSlot is intentionally non-idempotent — it always
    // re-applies the slot's content to params and emits the rehydrate
    // bundle. The loadbang restoration cascade depends on this
    // (initial host.activeSlot=0; if persisted active was also 0 the
    // restored slot data still needs to be applied to params).
    //
    // Loop prevention is handled at the patcher level instead: the
    // slot-active emission is NOT routed back to the slot live.tab.
    // The tab is updated by user clicks and Live's parameter auto-restore
    // — bridge doesn't need to push slot-active to it.

    test('slot-cell-op carries (index, opCode) pairs as ints', () => {
      // Op codes 0=P 1=L 2=R 3=hold 4=rest match host.ts RANDOM_OPS so the
      // patcher can route via [route 0 1 2 3] + [prepend set] directly.
      // The default DEFAULT_PARAMS cells changed in Phase A (2026-04-30) to
      // R-L-L-R; this test stays grounded in the original P-L-R-hold encoding
      // by passing initialParams.cells explicitly.
      const h = new Harness()
      const b = new Bridge(h.deps, { initialParams: LEGACY_TEST_BASELINE })
      h.outlets.length = 0
      b.switchSlot(1) // slot 1 default also "PLR_"
      const cellOps = byChannel(slotOutlets(h), 'slot-cell-op')
      assert.deepEqual(cellOps.map(o => o.args), [
        [0, 0], [1, 1], [2, 2], [3, 3],
      ])
    })
  })

  describe('auto-save (ADR 006 amendment 2026-04-30)', () => {
    // Explicit Bridge.saveCurrent is gone. User-driven setCell / setParams
    // / setStartChord auto-save in the host AND emit slot-store from the
    // bridge so the patcher's hidden numboxes stay in sync.

    test('setCell emits slot-store for the active slot', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      b.setCell(0, 'rest')
      assert.equal(byChannel(slotOutlets(h), 'slot-store').length, 1)
    })

    test('setParams jitter emits slot-store', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      b.setParams('jitter', 0.5)
      assert.equal(byChannel(slotOutlets(h), 'slot-store').length, 1)
    })

    test('setStartChord emits slot-store', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      b.setStartChord(60, 64, 67)
      assert.equal(byChannel(slotOutlets(h), 'slot-store').length, 1)
    })

    test('setParams with non-slot field (voicing) does NOT emit slot-store', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      b.setParams('voicing', 'spread')
      b.setParams('humanizeVelocity', 0.5)
      b.setParams('outputLevel', 0.7)
      assert.equal(byChannel(slotOutlets(h), 'slot-store').length, 0)
    })

    test('setCellField does NOT emit slot-store (per-cell numeric is device-shared)', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      b.setCellField(0, 'velocity', 0.5)
      assert.equal(byChannel(slotOutlets(h), 'slot-store').length, 0)
    })
  })

  describe('loadFactoryPreset', () => {
    test('returns true and emits full rehydrate on valid index', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      const ok = b.loadFactoryPreset(0)
      assert.equal(ok, true)
      const outs = slotOutlets(h)
      assert.equal(byChannel(outs, 'slot-program').length, 1)
      assert.equal(byChannel(outs, 'slot-cell-op').length, 4)
      assert.equal(byChannel(outs, 'slot-jitter').length, 1)
      assert.equal(byChannel(outs, 'slot-seed').length, 1)
      // Program-string outlet carries the preset's program verbatim.
      assert.deepEqual(byChannel(outs, 'slot-program')[0]!.args, [FACTORY_PRESETS[0]!.program])
    })

    test('returns false and emits nothing on out-of-range index', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      assert.equal(b.loadFactoryPreset(-1), false)
      assert.equal(b.loadFactoryPreset(FACTORY_PRESETS.length), false)
      assert.equal(slotOutlets(h).length, 0)
    })
  })

  describe('randomize', () => {
    test('with deterministic RNG, two bridges produce identical program strings', () => {
      const h1 = new Harness(); const b1 = new Bridge(h1.deps); b1.randomize(mulberry32(7))
      const h2 = new Harness(); const b2 = new Bridge(h2.deps); b2.randomize(mulberry32(7))
      const p1 = byChannel(slotOutlets(h1), 'slot-program')[0]!.args[0]
      const p2 = byChannel(slotOutlets(h2), 'slot-program')[0]!.args[0]
      assert.equal(p1, p2)
    })

    test('emits full slot UI rehydrate', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      b.randomize(mulberry32(1))
      const outs = slotOutlets(h)
      assert.equal(byChannel(outs, 'slot-program').length, 1)
      assert.equal(byChannel(outs, 'slot-cell-op').length, 4)
      assert.equal(byChannel(outs, 'slot-jitter').length, 1)
      assert.equal(byChannel(outs, 'slot-seed').length, 1)
    })
  })

  describe('loadFromProgramString', () => {
    test('returns true and emits full rehydrate on valid string', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      const ok = b.loadFromProgramString('PPP_|s=42|j=0.3|c=Em')
      assert.equal(ok, true)
      const outs = slotOutlets(h)
      assert.equal(byChannel(outs, 'slot-program').length, 1)
      assert.deepEqual(byChannel(outs, 'slot-program')[0]!.args, ['PPP_|s=42|j=0.3|c=Em'])
      assert.equal(byChannel(outs, 'slot-cell-op').length, 4)
      assert.deepEqual(byChannel(outs, 'slot-jitter')[0]!.args, [0.3])
      assert.deepEqual(byChannel(outs, 'slot-seed')[0]!.args, [42])
    })

    test('returns false and emits nothing on malformed input', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      assert.equal(b.loadFromProgramString('not-a-program'), false)
      assert.equal(b.loadFromProgramString(''), false)
      assert.equal(slotOutlets(h).length, 0)
    })
  })

  // ADR 006 Phase 3b — slot-store outlet for the patcher's hidden persistence
  // layer. Carries the active slot's full per-field state (4 op codes +
  // jitter + seed + root + quality) so 4 sets of 8 hidden live.numbox can
  // round-trip through Live set save/restore. Emitted on content-mutating
  // ops (save / random / factory / programString); NOT on switchSlot
  // (active idx changed but no slot's content did) or setSlotFields (silent
  // restore from those same hidden numboxes — would loop).
  describe('slot-store outlet (hidden persistence)', () => {
    function storeFor(h: Harness): OutletCall[] {
      return h.outlets.filter(o => o.channel === 'slot-store')
    }

    test('setCell emits slot-store with active idx and 8 fields', () => {
      // Auto-save: the first user-driven setCell on a fresh bridge emits
      // slot-store carrying the (now-mutated) active slot's full state.
      // Uses LEGACY_TEST_BASELINE cells "PLR_" so the assertion remains
      // pinned to the original op-code permutation; verifying the encoding
      // protocol, not the production default cells.
      const h = new Harness()
      const b = new Bridge(h.deps, { initialParams: LEGACY_TEST_BASELINE })
      h.outlets.length = 0
      b.setCell(0, 'rest')
      const stores = storeFor(h)
      assert.equal(stores.length, 1)
      // Default active idx 0; cells "PLR_" → "−LR_" after setCell(0, rest)
      // → opCodes [4,1,2,3]; jitter 0; seed 0; root C (0); quality maj (0).
      assert.deepEqual(stores[0]!.args, [0, 4, 1, 2, 3, 0, 0, 0, 0])
    })

    test('randomize emits slot-store reflecting the new program', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      b.randomize(mulberry32(7))
      const stores = storeFor(h)
      assert.equal(stores.length, 1)
      // First arg is active idx (0 by default). Remaining 8 = the random'd
      // fields. Just assert shape; specific values are RNG-dependent.
      assert.equal(stores[0]!.args.length, 9)
      assert.equal(stores[0]!.args[0], 0)
    })

    test('loadFactoryPreset emits slot-store', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      assert.equal(b.loadFactoryPreset(0), true)
      assert.equal(storeFor(h).length, 1)
    })

    test('loadFromProgramString emits slot-store with parsed fields', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      assert.equal(b.loadFromProgramString('PPP_|s=42|j=0.3|c=Em'), true)
      const stores = storeFor(h)
      assert.equal(stores.length, 1)
      // PPP_ → ops 0,0,0,3; seed 42; jitter 0.3; Em → root 4 quality 1
      assert.deepEqual(stores[0]!.args, [0, 0, 0, 0, 3, 0.3, 42, 4, 1])
    })

    test('switchSlot does NOT emit slot-store', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      b.switchSlot(2)
      assert.equal(storeFor(h).length, 0)
    })

    test('setSlotFields does NOT emit slot-store (silent restore)', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      b.setSlotFields(1, 0, 0, 0, 0, 0.1, 1, 0, 0)
      assert.equal(storeFor(h).length, 0)
    })
  })

  // ADR 006 Phase 3b — slot mutations re-paint the lattice. switchSlot /
  // random / factory / programString may change params.startChord (when no
  // MIDI is held), so the lattice center must follow. Without this, the
  // lattice stays on the previous slot's chord until the next note-on.
  describe('lattice updates on slot mutations', () => {
    test('switchSlot to a slot with a different startChord emits lattice-center', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      // Stage slot 1 with Em (root 4) so switch is a real chord change.
      assert.equal(b.loadFromProgramString('PLR_|s=0|j=0|c=Em'), true)
      // Loading was on slot 0; now go to slot 2 (default Cmaj) and back.
      b.switchSlot(2)
      h.outlets.length = 0
      b.switchSlot(0)
      const center = h.outlets.filter(o => o.channel === 'lattice-center')
      assert.ok(center.length >= 1, 'lattice-center emitted on switchSlot')
    })

    test('randomize emits lattice-center', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      b.randomize(mulberry32(3))
      const center = h.outlets.filter(o => o.channel === 'lattice-center')
      assert.ok(center.length >= 1)
    })
  })

  // ADR 006 Phase 3b — bridge restoration entry point. The patcher's hidden
  // persistence layer (32 per-slot live.numbox + 1 active-slot live.numbox)
  // dumps each slot's stored fields on loadbang and calls setSlotFields to
  // populate the in-memory Slot[]. The call is SILENT — visible widgets are
  // restored independently by Live's own live.* persistence; switchSlot is
  // the one that re-emits the rehydrate bundle once all slots are in place.
  //
  // Wire encoding chosen to match what hidden live.numbox naturally stores:
  //   cell op code  0=P, 1=L, 2=R, 3=hold, 4=rest   (matches host RANDOM_OPS)
  //   quality code  0=maj, 1=min
  //   root          0..11
  describe('setSlotFields', () => {
    test('populates slot silently; switchSlot then surfaces the saved program', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      // P,P,P,hold = "PPP_" | seed 42 | jitter 0.3 | Em (root 4, min)
      b.setSlotFields(2, 0, 0, 0, 3, 0.3, 42, 4, 1)
      assert.equal(slotOutlets(h).length, 0, 'setSlotFields is silent')
      h.outlets.length = 0
      b.switchSlot(2)
      const prog = byChannel(slotOutlets(h), 'slot-program')[0]!.args[0]
      assert.equal(prog, 'PPP_|s=42|j=0.3|c=Em')
    })

    test('all five op codes round-trip through the wire encoding', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      // 4-cell device — populate slot 1 with P,L,R,hold; slot 3 with rest×4
      // would violate cellsToString 0-len semantics elsewhere, so verify the
      // four op codes that occur in a typical 4-cell program.
      b.setSlotFields(1, 0, 1, 2, 3, 0, 0, 0, 0) // PLR_
      h.outlets.length = 0
      b.switchSlot(1)
      const prog = byChannel(slotOutlets(h), 'slot-program')[0]!.args[0]
      assert.equal(prog, 'PLR_|s=0|j=0|c=C')
      // Now populate with rest in one position.
      b.setSlotFields(1, 4, 1, 2, 3, 0, 0, 0, 0) // -LR_
      h.outlets.length = 0
      b.switchSlot(1)
      const prog2 = byChannel(slotOutlets(h), 'slot-program')[0]!.args[0]
      assert.equal(prog2, '-LR_|s=0|j=0|c=C')
    })

    test('out-of-range slot index is a silent no-op', () => {
      const h = new Harness()
      // LEGACY baseline so the assertion can pin "default slot 0 cells = PLR_"
      // without depending on the production default cells (now R-L-L-R).
      const b = new Bridge(h.deps, { initialParams: LEGACY_TEST_BASELINE })
      h.outlets.length = 0
      b.setSlotFields(-1, 0, 0, 0, 0, 0, 0, 0, 0)
      b.setSlotFields(4, 0, 0, 0, 0, 0, 0, 0, 0)
      assert.equal(slotOutlets(h).length, 0)
      // Verify slot 0 (default initial) is untouched: switch and check program
      // string still describes the default cells "PLR_".
      h.outlets.length = 0
      b.switchSlot(0)
      const prog = byChannel(slotOutlets(h), 'slot-program')[0]!.args[0] as string
      assert.ok(prog.startsWith('PLR_'), 'default slot 0 unchanged')
    })

    test('out-of-range cell op / quality / root is a silent no-op', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      // First seed slot 2 with a known program.
      b.setSlotFields(2, 0, 0, 0, 0, 0.1, 1, 0, 0) // PPPP|s=1|j=0.1|c=C
      h.outlets.length = 0
      // Bad cell op (5).
      b.setSlotFields(2, 5, 0, 0, 0, 0.2, 2, 0, 0)
      // Bad quality (2).
      b.setSlotFields(2, 0, 0, 0, 0, 0.2, 2, 0, 2)
      // Bad root (12).
      b.setSlotFields(2, 0, 0, 0, 0, 0.2, 2, 12, 0)
      assert.equal(slotOutlets(h).length, 0, 'no outlets emitted on rejection')
      // Slot 2 should still hold the seeded values, not the rejected ones.
      h.outlets.length = 0
      b.switchSlot(2)
      const prog = byChannel(slotOutlets(h), 'slot-program')[0]!.args[0]
      assert.equal(prog, 'PPPP|s=1|j=0.1|c=C')
    })

    test('NaN field is a silent no-op', () => {
      const h = new Harness()
      const b = new Bridge(h.deps)
      b.setSlotFields(2, 0, 0, 0, 0, 0.1, 1, 0, 0)
      h.outlets.length = 0
      b.setSlotFields(2, 0, 0, 0, 0, NaN, 1, 0, 0)
      b.setSlotFields(2, 0, 0, 0, 0, 0.1, NaN, 0, 0)
      h.outlets.length = 0
      b.switchSlot(2)
      const prog = byChannel(slotOutlets(h), 'slot-program')[0]!.args[0]
      assert.equal(prog, 'PPPP|s=1|j=0.1|c=C', 'unchanged after NaN inputs')
    })

    test('loadbang sequence: 4 setSlotFields + switchSlot rehydrates active slot', () => {
      // Simulate the patcher's restoration cascade: dump per-slot fields for
      // all four slots silently, then switchSlot to the persisted active idx.
      // The final switchSlot emits the rehydrate bundle that re-paints the
      // visible widgets to match the active slot's data.
      const h = new Harness()
      const b = new Bridge(h.deps)
      h.outlets.length = 0
      b.setSlotFields(0, 0, 1, 2, 3, 0.0, 0, 0, 0)   // slot 0: PLR_  | C
      b.setSlotFields(1, 0, 0, 0, 0, 0.5, 7, 4, 1)   // slot 1: PPPP  | Em j=0.5 s=7
      b.setSlotFields(2, 1, 1, 2, 3, 0.2, 99, 9, 0)  // slot 2: LLR_  | A  j=0.2 s=99
      b.setSlotFields(3, 4, 4, 0, 4, 0.0, 0, 5, 0)   // slot 3: --P-  | F
      assert.equal(slotOutlets(h).length, 0, 'all four restorations silent')
      // Active = 1.
      b.switchSlot(1)
      const outs = slotOutlets(h)
      const active = byChannel(outs, 'slot-active')[0]!.args
      assert.deepEqual(active, [1])
      const prog = byChannel(outs, 'slot-program')[0]!.args[0]
      assert.equal(prog, 'PPPP|s=7|j=0.5|c=Em')
    })
  })
})
