import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge, type BridgeDeps } from './bridge.ts'

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
    const b = new Bridge(h.deps)
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
    const b = new Bridge(h.deps)
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
    const b = new Bridge(h.deps)
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
    const b = new Bridge(h.deps)
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
    const b = new Bridge(h.deps)
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
    const b = new Bridge(h.deps)
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
