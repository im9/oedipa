// M4L bridge layer for Oedipa.
//
// Pure JS/TS routing between the Max patch protocol and the Host class.
// All Max-specific I/O (Max.outlet, Max.addHandler) is injected via deps so
// this module can be tested in Node with mocks. The thin index.js wrapper
// supplies real Max API at runtime.
//
// Responsibilities:
// - Convert per-event `delayPos` (pos-units, ADR 005) to ms via a running
//   estimate of step interval, then dispatch immediate vs. scheduled.
// - Track msPerPos across step calls; reset on transport stop / panic.
// - Emit lattice/cellIdx side-channels at the right moments.

import { Host, type CellNumericField, type HostParams, type NoteEvent } from './host.ts'
import type { MidiNote, Op, Triad } from '../engine/tonnetz.ts'

export interface BridgeDeps {
  // Send a MIDI event downstream. velocity=0 means note-off in this protocol.
  emitNote: (pitch: number, velocity: number, channel: number) => void
  // Side-channel outlets keyed by Max outlet name.
  emitOutlet: (channel: string, ...args: Array<number | string>) => void
  // Time provider — Date.now() in production, mock in tests.
  now: () => number
  // Schedule a callback `ms` milliseconds in the future. setTimeout in
  // production; tests pass a synchronous fake that records (ms, cb).
  scheduleAfter: (ms: number, cb: () => void) => void
}

export interface BridgeOptions {
  initialParams?: Partial<HostParams>
}

const DEFAULT_PARAMS: HostParams = {
  startChord: [60, 64, 67],
  cells: [
    { op: 'P', velocity: 1.0, gate: 0.9, probability: 1.0, timing: 0 },
    { op: 'L', velocity: 1.0, gate: 0.9, probability: 1.0, timing: 0 },
    { op: 'R', velocity: 1.0, gate: 0.9, probability: 1.0, timing: 0 },
    { op: 'hold', velocity: 1.0, gate: 0.9, probability: 1.0, timing: 0 },
  ],
  stepsPerTransform: 4,
  voicing: 'close',
  seventh: false,
  jitter: 0,
  seed: 0,
  channel: 1,
  triggerMode: 0,
  inputChannel: 0,
  // ADR 005 Phase 3 defaults: forward direction, "1 pos = 1 step" placeholder
  // (the patcher's setParams cascade overrides ticksPerStep with the
  // subdivision-derived multiplier — see ADR 005 §Subdivision table — before
  // any transport-driven step() arrives), straight feel (no swing), no
  // humanize. The placeholder also keeps "raw" Bridge tests on the Phase 2
  // pos contract.
  stepDirection: 'forward',
  ticksPerStep: 1,
  swing: 0.5,
  humanizeVelocity: 0,
  humanizeGate: 0,
  humanizeTiming: 0,
}

export class Bridge {
  private host: Host
  private deps: BridgeDeps
  private lastStepTime: number | null = null
  private lastStepPos: number | null = null
  private msPerPos = 0
  private lastCellIdx = -1

  constructor(deps: BridgeDeps, options: BridgeOptions = {}) {
    this.host = new Host({ ...DEFAULT_PARAMS, ...options.initialParams })
    this.deps = deps
  }

  // Test inspection only.
  getMsPerPos(): number { return this.msPerPos }
  getLastStepPos(): number | null { return this.lastStepPos }

  step(pos: number): void {
    this.recordStepTiming(pos)
    const events = this.host.step(pos)
    for (const ev of events) this.dispatch(ev)
    if (events.length > 0) this.emitLatticeCurrent()
    this.emitCellIdx(pos)
  }

  panic(): void {
    for (const ev of this.host.panic()) this.dispatch(ev)
    this.emitLatticeCurrent()
    this.clearCellIdx()
    // Reset tempo estimate so a transport restart doesn't carry over a stale
    // interval (the next step looks like a "fresh start" timing-wise).
    this.lastStepTime = null
    this.lastStepPos = null
  }

  noteIn(pitch: MidiNote, velocity: number, channel: number): void {
    const events = this.host.noteIn(pitch, velocity, channel)
    for (const ev of events) this.dispatch(ev)
    if (events.length > 0) {
      this.emitLatticeCenter()
      this.emitMarkerForStartChord()
    }
  }

  noteOff(pitch: MidiNote, channel: number): void {
    const events = this.host.noteOff(pitch, channel)
    for (const ev of events) this.dispatch(ev)
    if (events.length > 0) {
      if (this.host.isWalkerActive) {
        this.emitLatticeCenter()
        this.emitMarkerForStartChord()
      } else {
        this.deps.emitOutlet('lattice-clear')
        this.clearCellIdx()
      }
    }
  }

  transportStart(): void {
    const events = this.host.transportStart()
    for (const ev of events) this.dispatch(ev)
    if (events.length > 0) this.emitLatticeCurrent()
  }

  setParams(key: keyof HostParams, value: unknown): void {
    this.host.setParams({ [key]: value } as Partial<HostParams>)
  }

  setStartChord(p1: number, p2: number, p3: number): void {
    if (p1 === 0 && p2 === 0 && p3 === 0) return
    if (Number.isNaN(p1) || Number.isNaN(p2) || Number.isNaN(p3)) return
    this.host.setParams({ startChord: [p1, p2, p3] })
    this.emitLatticeCenter()
  }

  setCell(idx: number, op: Op): void {
    this.host.setCell(idx, op)
  }

  // Patcher entry point for the per-cell numbox dumps (ADR 005 Phase 4).
  // Validates `field` at the Max boundary so a typo or stale dump path is a
  // silent no-op rather than a typed-cast failure in the host.
  setCellField(idx: number, field: string, value: number): void {
    if (field !== 'velocity' && field !== 'gate' && field !== 'probability' && field !== 'timing') return
    this.host.setCellField(idx, field as CellNumericField, value)
  }

  setCells(ops: Op[]): void {
    // setParams cells expects full Cell records; preserve current vel/gate/
    // timing/probability. Op-only updates come from the four [live.tab]
    // (per-cell op) controls in the patcher.
    const current = (this.host as unknown as { params: HostParams }).params.cells
    const cells = ops.map((op, i) => {
      const prev = current[i]
      return prev ? { ...prev, op } : { op, velocity: 1.0, gate: 0.9, probability: 1.0, timing: 0 }
    })
    this.host.setParams({ cells })
  }

  latticeRefresh(): void {
    this.emitLatticeCenter()
    this.emitLatticeCurrent()
  }

  // -------- internal --------

  private dispatch(ev: NoteEvent): void {
    const dp = ev.delayPos ?? 0
    if (dp <= 0 || this.msPerPos <= 0) {
      this.emitNoteEvent(ev)
      return
    }
    const ms = dp * this.msPerPos
    this.deps.scheduleAfter(ms, () => this.emitNoteEvent(ev))
  }

  private emitNoteEvent(ev: NoteEvent): void {
    const velocity = ev.type === 'noteOn' ? ev.velocity : 0
    this.deps.emitNote(ev.pitch, velocity, ev.channel)
  }

  private recordStepTiming(pos: number): void {
    const now = this.deps.now()
    if (this.lastStepTime !== null && this.lastStepPos !== null) {
      const dt = now - this.lastStepTime
      const dpos = pos - this.lastStepPos
      // dpos<=0 = scrub or wrap; dt>=5000 likely means transport stalled.
      if (dt > 0 && dt < 5000 && dpos > 0) {
        const inst = dt / dpos
        this.msPerPos = this.msPerPos === 0 ? inst : this.msPerPos * 0.7 + inst * 0.3
      }
    }
    this.lastStepTime = now
    this.lastStepPos = pos
  }

  private mod12(n: number): number {
    return ((n % 12) + 12) % 12
  }

  private emitLatticeCenter(): void {
    const sc = this.host.startChord
    this.deps.emitOutlet('lattice-center', 0, this.mod12(sc[0]), this.mod12(sc[1]), this.mod12(sc[2]))
  }

  private emitLatticeCurrent(): void {
    const t = this.host.currentTriad
    if (t === null) {
      this.deps.emitOutlet('lattice-clear')
      return
    }
    this.deps.emitOutlet('lattice-current', this.mod12(t[0]), this.mod12(t[1]), this.mod12(t[2]))
  }

  private emitMarkerForStartChord(): void {
    const sc = this.host.startChord
    this.deps.emitOutlet('lattice-current', this.mod12(sc[0]), this.mod12(sc[1]), this.mod12(sc[2]))
  }

  private emitCellIdx(pos: number): void {
    const idx = this.host.cellIdx(pos)
    if (idx !== this.lastCellIdx) {
      this.deps.emitOutlet('cellIdx', idx)
      this.lastCellIdx = idx
    }
  }

  private clearCellIdx(): void {
    if (this.lastCellIdx !== -1) {
      this.deps.emitOutlet('cellIdx', -1)
      this.lastCellIdx = -1
    }
  }
}

// Re-export Triad for downstream consumers.
export type { Triad }
