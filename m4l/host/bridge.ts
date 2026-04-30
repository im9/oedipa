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
import { cellsToString, stringToCells, type Slot, type SlotQuality } from './slot.ts'

// ADR 006 Phase 3b — wire encoding for hidden-persistence dumps. Order
// matches host.ts RANDOM_OPS so the patcher's hidden live.numbox can store
// raw int 0..4 and round-trip through randomize / setSlotFields without a
// translation table on the Max side.
const OP_CODES: readonly Op[] = ['P', 'L', 'R', 'hold', 'rest']

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
  slotsAlreadyRehydrated?: boolean
}

const DEFAULT_PARAMS: HostParams = {
  startChord: [60, 64, 67],
  cells: [
    // Default sequence R-L-L-R produces a cyclical Tonnetz progression that
    // returns to the start every 4 cells (C → Am → F → Am → C). Borrowed
    // from inboil's Tonnetz scene default — a more musically grounded
    // starting point than the prior P-L-R-hold which never returned home.
    { op: 'R', velocity: 1.0, gate: 1.0, probability: 1.0, timing: 0 },
    { op: 'L', velocity: 1.0, gate: 1.0, probability: 1.0, timing: 0 },
    { op: 'L', velocity: 1.0, gate: 1.0, probability: 1.0, timing: 0 },
    { op: 'R', velocity: 1.0, gate: 1.0, probability: 1.0, timing: 0 },
  ],
  stepsPerTransform: 4,
  // Spread voicing octave-distributes the triad — fuller sound that lets
  // chord-rate progressions read as harmony rather than block stabs.
  voicing: 'spread',
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
  humanizeDrift: 0,
  outputLevel: 1.0,
  // ADR 006 Phase 7 — RHYTHM/ARP/length defaults. legato preserves Phase A
  // single-fire-per-cell behavior; off emits the full chord. length=4
  // matches the 4-cell default; engine ignores indices >= length.
  rhythm: 'legato',
  arp: 'off',
  length: 4,
}

// User-facing cell duration is expressed in BARS. Internally the engine
// consumes cells via stepsPerTransform (subdivision-steps per cell); the
// bridge derives spt = cellLength * TICKS_PER_BAR / ticksPerStep so that
// changing the subdivision (a feel axis) does NOT alter the audible cell
// rate. PPQN=24 × 4 quarters = 96 ticks per bar at 4/4 (ADR 005 §Subdivision).
const TICKS_PER_BAR = 96

export class Bridge {
  private host: Host
  private deps: BridgeDeps
  private lastStepTime: number | null = null
  private lastStepPos: number | null = null
  private msPerPos = 0
  private lastCellIdx = -1
  // Cell duration in bars. Default 1 bar = 4-cell pattern of 4 bars (8 sec
  // at 120 BPM), which sits in chord-progression territory rather than the
  // arpeggio-rate quarter-note default the prior model defaulted into.
  private cellLengthBars = 1

  constructor(deps: BridgeDeps, options: BridgeOptions = {}) {
    this.host = new Host({ ...DEFAULT_PARAMS, ...options.initialParams })
    this.deps = deps
    if (options.slotsAlreadyRehydrated) this.slotsRehydrated = true
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

  // ADR 006 §"Axis 1" amendment (2026-04-30) — auto-save model. The
  // host mirrors slot-field edits (cells / jitter / seed / startChord)
  // into slots[active] internally; the bridge needs to push the updated
  // hidden persistence (`slot-store`) so the patcher's 32 hidden numboxes
  // stay in sync with the in-memory slot.
  // ── Init feedback window (load-bearing invariant) ──
  //
  // The patcher persists per-slot state in hidden live.numbox params
  // (cells, length, jitter, seed, startChord). On Live device load, two
  // event streams race for those numboxes, both ultimately driven by
  // hostReady:
  //
  //   (A) Visible-widget dumps. The patcher bangs visible live.* widgets
  //       (jitter, seed, voicing, …) so their saved values feed back into
  //       the bridge as `prepend setParams <key>` messages.
  //   (B) Rehydrate cascade. A deferlow chain bangs the *hidden* slot
  //       numboxes through pack-restore-slotN → `setSlotFields N …`,
  //       silently restoring all four slots' saved data.
  //
  // (A) reaches setParams BEFORE (B) reaches setSlotFields. If
  // emitSlotStore fired during (A), it would read bridge's compile-time
  // initial slot (e.g. length=4 default) and broadcast it back to the
  // patcher — overwriting the user-saved length, c4..c7, etc. in the
  // hidden numboxes with bridge defaults. The cascade then bangs those
  // (now-corrupted) numboxes and replays the corruption back as
  // setSlotFields. User's saved program is silently lost.
  //
  // The gate breaks the loop: emitSlotStore is suppressed until (B)
  // calls setSlotFields at least once, which proves the cascade has
  // injected real saved data. After that flips, user-driven setParams
  // / setCell / etc. emit slot-store as normal.
  //
  // Symptom shape if you ever see this regress: a slot field's saved
  // value round-trips correctly only when it happens to equal bridge's
  // compile-time default. Fields that differ silently revert to default
  // on save+reload. (Found 2026-05-01 against length: bridge default
  // cells [R,L,L,R] matched the user's saved cells, masking c0..c3
  // corruption; length default 4 ≠ saved 5 surfaced the loop first.)
  //
  // Tests pre-flip via the `slotsAlreadyRehydrated` BridgeOption to
  // avoid simulating the cascade in every emitSlotStore test.
  private slotsRehydrated = false

  private isSlotField(key: keyof HostParams): boolean {
    // ADR 006 Phase 7 — `length` joined the slot-field set when variable
    // cell count (1..8) shipped: it's part of the slot identity (slot.cells
    // string length encodes it) and must mirror to the patcher's hidden
    // numbox via emitSlotStore on every change. Without this, [+]/[-]
    // updates the in-memory slot but the patcher's persistence stays
    // stale until the next setCell auto-save fires.
    return key === 'cells' || key === 'jitter' || key === 'seed'
      || key === 'startChord' || key === 'length'
  }

  setParams(key: keyof HostParams | 'cellLength', value: unknown): void {
    if (key === 'cellLength') {
      const bars = Number(value)
      if (!Number.isFinite(bars) || bars < 1) return
      this.cellLengthBars = bars
      this.applyCellLength()
      return
    }
    if (key === 'ticksPerStep') {
      const tps = Number(value)
      if (!Number.isFinite(tps) || tps < 1) return
      this.host.setParams({ ticksPerStep: tps })
      this.applyCellLength()
      return
    }
    this.host.setParams({ [key]: value } as Partial<HostParams>)
    if (this.isSlotField(key)) this.emitSlotStore(this.host.activeSlot)
  }

  // Translate the user-facing (cellLengthBars, ticksPerStep) pair into the
  // engine's stepsPerTransform. Called whenever either input changes.
  private applyCellLength(): void {
    const tps = (this.host as unknown as { params: HostParams }).params.ticksPerStep
    if (tps <= 0) return
    const spt = (this.cellLengthBars * TICKS_PER_BAR) / tps
    if (!Number.isInteger(spt) || spt < 1) return
    this.host.setParams({ stepsPerTransform: spt })
  }

  setStartChord(p1: number, p2: number, p3: number): void {
    if (p1 === 0 && p2 === 0 && p3 === 0) return
    if (Number.isNaN(p1) || Number.isNaN(p2) || Number.isNaN(p3)) return
    this.host.setParams({ startChord: [p1, p2, p3] })
    this.emitLatticeCenter()
    this.emitSlotStore(this.host.activeSlot)
  }

  setCell(idx: number, op: Op): void {
    this.host.setCell(idx, op)
    this.emitSlotStore(this.host.activeSlot)
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
      return prev ? { ...prev, op } : { op, velocity: 1.0, gate: 1.0, probability: 1.0, timing: 0 }
    })
    this.host.setParams({ cells })
    this.emitSlotStore(this.host.activeSlot)
  }

  latticeRefresh(): void {
    this.emitLatticeCenter()
    this.emitLatticeCurrent()
  }

  // -------- ADR 006 Phase 3 — slots --------
  //
  // Each slot-mutating action emits a "slot UI rehydrate" outlet bundle so
  // the patcher can silently re-set its visible widgets (4 cell live.tab,
  // jitter / seed live.numbox, slot-active tab) without echoing back
  // through the user-edit path. User-driven setCell / setParams /
  // setStartChord auto-save into the active slot via the host (ADR 006
  // §"Axis 1" amendment 2026-04-30); the bridge fires `slot-store` after
  // those calls to keep the patcher's hidden persistence in sync.

  switchSlot(idx: number): void {
    if (idx < 0 || idx >= 4) return
    this.host.switchSlot(idx)
    this.emitSlotRehydrate()
  }

  loadFactoryPreset(idx: number): boolean {
    const ok = this.host.loadFactoryPreset(idx)
    if (ok) {
      this.emitSlotRehydrate()
      this.emitSlotStore(this.host.activeSlot)
    }
    return ok
  }

  randomize(rng?: () => number): void {
    this.host.randomizeActiveSlot(rng)
    this.emitSlotRehydrate()
    this.emitSlotStore(this.host.activeSlot)
  }

  loadFromProgramString(s: string): boolean {
    const ok = this.host.loadFromProgramString(s)
    if (ok) {
      this.emitSlotRehydrate()
      this.emitSlotStore(this.host.activeSlot)
    }
    return ok
  }

  // ADR 006 Phase 3b — silent restoration entry. The patcher's hidden
  // persistence layer dumps each slot's fields on loadbang; the bridge
  // reconstructs a Slot and stores it WITHOUT emitting rehydrate outlets.
  // The active slot's data reaches the visible widgets via the subsequent
  // switchSlot call. Out-of-range or NaN inputs are silent no-ops so a
  // stale dump from an old patcher layout can't corrupt slot state.
  setSlotFields(
    idx: number,
    c0: number, c1: number, c2: number, c3: number,
    c4: number, c5: number, c6: number, c7: number,
    length: number,
    jitter: number, seed: number, root: number, quality: number,
  ): void {
    if (!Number.isInteger(idx) || idx < 0 || idx >= 4) return
    if (!Number.isInteger(length) || length < 1 || length > 8) return
    const allCodes = [c0, c1, c2, c3, c4, c5, c6, c7]
    // Validate all 8 codes (even pad slots) so a malformed dump from a
    // stale patcher layout aborts cleanly. Construct the cells string
    // from the first `length` ops only — codes past length are padding.
    for (const code of allCodes) {
      if (!Number.isInteger(code) || code < 0 || code >= OP_CODES.length) return
    }
    const ops: Op[] = []
    for (let i = 0; i < length; i++) ops.push(OP_CODES[allCodes[i]!]!)
    if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) return
    if (!Number.isFinite(seed) || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return
    if (!Number.isInteger(root) || root < 0 || root > 11) return
    if (quality !== 0 && quality !== 1) return
    const slot: Slot = {
      cells: cellsToString(ops),
      startChord: { root, quality: quality === 0 ? 'maj' : 'min' as SlotQuality },
      jitter,
      seed: seed >>> 0,
    }
    this.host.setSlot(idx, slot)
    this.slotsRehydrated = true
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

  // ADR 006 Phase 3 — emit the full slot UI outlet bundle. Called after any
  // slot mutation that may have changed the active slot's contents. Also
  // re-emits lattice-center because switchSlot / random / factory /
  // programString may have updated params.startChord (when no MIDI is held)
  // — without this the jsui lattice would stay on the previous chord until
  // the next note-on.
  private emitSlotRehydrate(): void {
    this.deps.emitOutlet('slot-active', this.host.activeSlot)
    this.emitProgramString()
    const slot = this.host.getSlot(this.host.activeSlot)
    if (slot === null) return
    const ops = stringToCells(slot.cells)
    if (ops !== null) {
      // ADR 006 Phase 7 — emit length BEFORE per-cell ops so the cellstrip
      // renderer grows its visible cell count first; otherwise setCellOp
      // for idx >= renderer's old length would land on a hidden cell. The
      // renderer's setLength handler also auto-closes any open popup whose
      // source cell is now beyond length, keeping the visible state safe.
      this.deps.emitOutlet('slot-length', ops.length)
      // Op codes match host RANDOM_OPS so the patcher can route via
      // [route 0..7] + [prepend setCellOp] without symbol conversion.
      for (let i = 0; i < ops.length; i++) {
        this.deps.emitOutlet('slot-cell-op', i, OP_CODES.indexOf(ops[i]!))
      }
    }
    this.deps.emitOutlet('slot-jitter', slot.jitter)
    this.deps.emitOutlet('slot-seed', slot.seed)
    this.emitLatticeCenter()
  }

  private emitProgramString(): void {
    this.deps.emitOutlet('slot-program', this.host.getActiveProgramString())
  }

  // ADR 006 Phase 3b — single-message dump of the active slot's per-field
  // state to the patcher's hidden persistence layer (52 hidden live.numbox,
  // 13 per slot since Phase 7 widened cells from 4 to 8). Wire format,
  // after the slot index demux:
  //   c0..c7 (8 ints) + length (int) + jitter (float) + seed (int)
  //   + root (int) + quality (int)
  // Op codes match host.ts RANDOM_OPS: 0=P 1=L 2=R 3=hold 4=rest.
  // Quality: 0=maj 1=min. Cells past `length` are padded with 'hold'
  // (code 3) so the wire format is fixed-width regardless of program
  // length; the loader reconstructs cells from the first `length` ops.
  private emitSlotStore(idx: number): void {
    if (!this.slotsRehydrated) return
    const slot = this.host.getSlot(idx)
    if (slot === null) return
    const ops = stringToCells(slot.cells)
    if (ops === null || ops.length < 1 || ops.length > 8) return
    const length = ops.length
    const padded: Op[] = []
    for (let i = 0; i < 8; i++) padded.push(i < length ? ops[i]! : 'hold')
    const opCodes = padded.map(op => OP_CODES.indexOf(op))
    if (opCodes.some(c => c < 0)) return
    const quality = slot.startChord.quality === 'min' ? 1 : 0
    this.deps.emitOutlet(
      'slot-store',
      idx,
      opCodes[0]!, opCodes[1]!, opCodes[2]!, opCodes[3]!,
      opCodes[4]!, opCodes[5]!, opCodes[6]!, opCodes[7]!,
      length,
      slot.jitter,
      slot.seed,
      slot.startChord.root,
      quality,
    )
  }
}

// Re-export Triad for downstream consumers.
export type { Triad }
