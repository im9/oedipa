// M4L host layer for Oedipa.
// Spec: docs/ai/adr/archive/002-m4l-device-architecture.md (architecture),
//       docs/ai/adr/003-m4l-parameters-state.md (cell sequencer params),
//       docs/ai/adr/004-midi-input.md (MIDI input + note discipline)
//
// Bridges Max transport / MIDI input and the Tonnetz engine. Owns WalkState
// and input-side state (held notes, last input velocity, walker gating),
// resolves host step index -> triad (via engine.walk), applies voicing /
// seventh, and emits note-on/off events. Pure logic — no Max, no Node timers,
// no I/O. The Max patch calls step() / noteIn() / noteOff() / transportStart()
// / panic(); returned events go to [noteout].

import {
  addSeventh,
  applyVoicing,
  buildTriad,
  findTriadInHeldNotes,
  identifyTriad,
  walk,
  walkStepEvent,
  type Cell,
  type MidiNote,
  type Op,
  type StepDirection,
  type Triad,
  type Voicing,
  type WalkState,
} from '../engine/tonnetz.ts'
import { cellsToString, parseSlot, stringToCells, type Slot, type SlotQuality } from './slot.ts'
import { FACTORY_PRESETS } from './presets.ts'

// delayPos is in pos-units (the same domain as step(pos)). Undefined or 0
// means "fire at the current pos". The host emits gate-end note-offs and
// pushed/late note-ons via delayPos; the M4L bridge ([pipe] or equivalent)
// is responsible for absolute scheduling.
//
// Negative-timing pull-ahead in subsequent cycles would require look-ahead
// scheduling (emit at the prior step boundary) and is deferred past Phase 2;
// for now negative cell timing is clamped at every boundary.
export type NoteEvent =
  | { type: 'noteOn'; pitch: MidiNote; velocity: number; channel: number; delayPos?: number }
  | { type: 'noteOff'; pitch: MidiNote; channel: number; delayPos?: number }

export type TriggerMode = 0 | 1 // 0 = hybrid (default), 1 = hold-to-play

// The four numeric per-cell fields owned by the 16 hidden live.numbox in the
// patcher (ADR 005 Phase 4). `op` is owned separately by the four live.tab
// and reaches the host via setCell / setCells.
export type CellNumericField = 'velocity' | 'gate' | 'probability' | 'timing'

export interface HostParams {
  startChord: Triad
  cells: Cell[]
  stepsPerTransform: number
  voicing: Voicing
  seventh: boolean
  jitter: number
  seed: number
  channel: number
  // ADR 004 — MIDI input semantics
  triggerMode: TriggerMode
  inputChannel: number // 0 = omni, 1..16 = single-channel filter
  // ADR 005 Phase 3 — global rhythmic layer
  stepDirection: StepDirection
  // PPQN tick → subdivision-step multiplier. Patcher streams ticks at PPQN=24
  // (ADR 005 §Subdivision); the host divides by this to derive engine pos.
  // Default in production = 6 (16th @ PPQN=24); tests pass 1 to keep
  // "1 tick = 1 step" semantics.
  ticksPerStep: number
  swing: number                // 0.5 (none) .. 0.75 (heavy); off-beat tick offset
  humanizeVelocity: number     // 0..1 amount
  humanizeGate: number         // 0..1 amount
  humanizeTiming: number       // 0..1 amount
  humanizeDrift: number        // 0..1 EMA factor for time-correlated humanize (ADR 005 Phase 5)
  // Global output velocity multiplier applied AFTER per-cell velocity and
  // humanize. Single dial for "make everything quieter / louder" without
  // touching per-cell automation. 0..1, default 1.0 (no attenuation).
  outputLevel: number
}

// ADR 006 §"Axis 1" — 4 snapshot slots in the device.
const SLOT_COUNT = 4

export class Host {
  private params: HostParams
  private held: Set<MidiNote> = new Set()      // sustained walker OUTPUT notes
  private lastTriad: Triad | null = null
  // ADR 004 input-side state
  private inputHeld: Set<MidiNote> = new Set() // held INPUT notes (post channel filter)
  private lastInputVelocity = 100              // single source for output velocity
  private walkerActive = true                  // gates step() output (hold-to-play)
  private startPos = 0                         // pos baseline for effective walk position
  private pendingPosReset = false              // queue a pos reset for the next step()
  // ADR 005 Phase 2 scheduling state
  private handoffPending = false               // next noteOn step must legato-off `held`
  private lastEmittedEffectivePos: number | null = null // same-pos idempotency guard
  // ADR 006 Phase 2 — slot state. Slots persist programs; switching applies
  // {cells, jitter, seed} immediately and {startChord} only if no MIDI is
  // currently held (otherwise stash as pending for the next note-off).
  private slots: Slot[]
  private activeSlotIdx = 0
  private pendingSlotStartChord: { root: number; quality: SlotQuality } | null = null

  constructor(params: HostParams) {
    this.params = { ...params }
    const initial = this.captureSlot()
    this.slots = []
    for (let i = 0; i < SLOT_COUNT; i++) this.slots.push(this.cloneSlot(initial))
  }

  setParams(patch: Partial<HostParams>): void {
    if (patch.startChord !== undefined && !triadsEqual(patch.startChord, this.params.startChord)) {
      this.pendingPosReset = true
      this.lastTriad = null
    }
    if (patch.inputChannel !== undefined && patch.inputChannel !== this.params.inputChannel) {
      this.inputHeld.clear()
    }
    if (patch.triggerMode !== undefined && patch.triggerMode === 0) {
      this.walkerActive = true
    }
    this.params = { ...this.params, ...patch }
  }

  setCell(idx: number, op: Op): void {
    if (idx < 0 || idx >= this.params.cells.length) return
    const cells = this.params.cells.slice()
    cells[idx] = { ...cells[idx]!, op }
    this.params = { ...this.params, cells }
  }

  setCellField(idx: number, field: CellNumericField, value: number): void {
    if (idx < 0 || idx >= this.params.cells.length) return
    if (Number.isNaN(value)) return
    const cells = this.params.cells.slice()
    cells[idx] = { ...cells[idx]!, [field]: value }
    this.params = { ...this.params, cells }
  }

  // ADR 006 Phase 2 — slot accessors and switching.
  get activeSlot(): number {
    return this.activeSlotIdx
  }

  getSlot(idx: number): Slot | null {
    if (idx < 0 || idx >= this.slots.length) return null
    return this.cloneSlot(this.slots[idx]!)
  }

  // Bridge calls this on device load to push hidden-param state back into
  // the in-memory Slot[]. This is persistence rehydration only — it does
  // NOT load the slot into params (use switchSlot for that).
  setSlot(idx: number, slot: Slot): void {
    if (idx < 0 || idx >= this.slots.length) return
    this.slots[idx] = this.cloneSlot(slot)
  }

  // Capture current device state into the active slot.
  saveCurrent(): void {
    this.slots[this.activeSlotIdx] = this.captureSlot()
  }

  // ADR 006 Phase 4 — load a curated factory preset into the active slot.
  // Composes parseSlot + setSlot + switchSlot so the result is both
  // persisted (via Slot[]) and audibly applied. Returns false if the
  // index is out of range or the preset's program string is malformed.
  loadFactoryPreset(idx: number): boolean {
    if (idx < 0 || idx >= FACTORY_PRESETS.length) return false
    const slot = parseSlot(FACTORY_PRESETS[idx]!.program)
    if (slot === null) return false
    this.setSlot(this.activeSlotIdx, slot)
    this.switchSlot(this.activeSlotIdx)
    return true
  }

  // Switch to slot `idx` and apply its contents. cells/jitter/seed apply
  // unconditionally; startChord respects MIDI-input priority (deferred
  // when input is held, applied at next note-off).
  switchSlot(idx: number): void {
    if (idx < 0 || idx >= this.slots.length) return
    this.activeSlotIdx = idx
    const slot = this.slots[idx]!
    this.applySlotCells(slot.cells)
    this.params = { ...this.params, jitter: slot.jitter, seed: slot.seed }
    if (this.inputHeld.size === 0) {
      this.applySlotStartChord(slot.startChord)
      this.pendingSlotStartChord = null
    } else {
      this.pendingSlotStartChord = { ...slot.startChord }
    }
  }

  get currentTriad(): Triad | null {
    return this.lastTriad
  }

  get isWalkerActive(): boolean {
    return this.walkerActive
  }

  cellIdx(pos: number): number {
    if (!this.walkerActive) return -1
    const { stepsPerTransform: spt, cells, startChord, jitter, seed, stepDirection, ticksPerStep, humanizeDrift } = this.params
    if (cells.length === 0) return -1
    const effectivePos = pos - this.startPos
    if (effectivePos <= 0) return -1
    // Most recent transform boundary in raw-tick coords, then convert to the
    // engine's subdivision-step coords for walkStepEvent (source of truth for
    // direction-aware cellIdx, including random).
    const transformTicks = spt * ticksPerStep
    const lastBoundaryTicks = Math.floor(effectivePos / transformTicks) * transformTicks
    if (lastBoundaryTicks <= 0) return -1
    const lastBoundarySubdivPos = lastBoundaryTicks / ticksPerStep
    const ev = walkStepEvent(
      { startChord, cells, stepsPerTransform: spt, jitter, seed, stepDirection, humanizeDrift },
      lastBoundarySubdivPos,
    )
    return ev?.cellIdx ?? -1
  }

  get centerPc(): number {
    return ((this.params.startChord[0] % 12) + 12) % 12
  }

  get startChord(): Triad {
    return this.params.startChord
  }

  noteIn(pitch: MidiNote, velocity: number, channel: number): NoteEvent[] {
    if (!this.matchesInputChannel(channel)) return []
    this.lastInputVelocity = velocity
    this.inputHeld.add(pitch)
    const wasInactive = !this.walkerActive
    if (this.params.triggerMode === 1) {
      this.walkerActive = true
    }
    const events = this.recomputeStartChord()
    // Hold-to-play: re-activating after release should restart the cell program
    // even if the new chord matches the previous one (ADR 004 Axis 2 — note-on
    // resets the walker).
    if (wasInactive && this.params.triggerMode === 1 && events.length === 0) {
      this.pendingPosReset = true
      this.lastTriad = null
    }
    return events
  }

  noteOff(pitch: MidiNote, channel: number): NoteEvent[] {
    if (!this.matchesInputChannel(channel)) return []
    this.inputHeld.delete(pitch)
    if (this.params.triggerMode === 1 && this.inputHeld.size === 0) {
      // Hold-to-play last release: panic + walker off. Pending slot
      // startChord becomes moot — next note-on will set the chord from
      // input. Clear so a stale pending can't override later input.
      this.walkerActive = false
      this.pendingSlotStartChord = null
      return this.panic()
    }
    // Hybrid mode: when the player releases the last MIDI note, apply any
    // pending slot startChord BEFORE recomputeStartChord (which will be a
    // no-op with empty inputHeld). Walker continues; the new chord becomes
    // audible at the next step's effective pos 0.
    if (this.inputHeld.size === 0 && this.pendingSlotStartChord !== null) {
      this.applySlotStartChord(this.pendingSlotStartChord)
      this.pendingSlotStartChord = null
    }
    return this.recomputeStartChord()
  }

  transportStart(): NoteEvent[] {
    if (this.params.triggerMode === 1) {
      this.walkerActive = this.inputHeld.size > 0
    }
    return this.recomputeStartChord()
  }

  step(pos: number): NoteEvent[] {
    if (!this.walkerActive) return []
    if (this.pendingPosReset) {
      this.startPos = pos
      this.pendingPosReset = false
      this.lastEmittedEffectivePos = null
    }
    const effectivePos = pos - this.startPos

    // Same-pos idempotency: re-calling step(pos) for an already-emitted pos
    // is a no-op. Keeps scrub / pos-cascade callers safe.
    if (this.lastEmittedEffectivePos !== null && effectivePos === this.lastEmittedEffectivePos) {
      return []
    }

    const { startChord, cells, stepsPerTransform: spt, jitter, seed, voicing, seventh, channel, stepDirection, ticksPerStep, swing, humanizeDrift } = this.params
    // ADR 005 §Subdivision: patcher streams ticks at PPQN=24; ticksPerStep
    // collapses raw ticks into subdivision-steps before stepsPerTransform.
    // One transform period (cell consumption interval) = spt * ticksPerStep
    // raw ticks. timing/gate scale with this transform-period length so
    // gate=1.0 still means "until the next note-on".
    const transformTicks = spt * ticksPerStep

    // pos=0 (or first call after reset): emit startChord once. No cell has
    // fired yet, so vel/gate/timing don't apply — but outputLevel still
    // scales the source velocity so "Level=0" mutes uniformly.
    if (effectivePos === 0) {
      const events: NoteEvent[] = []
      for (const pitch of this.held) events.push({ type: 'noteOff', pitch, channel })
      this.held.clear()
      let voiced = applyVoicing(startChord, voicing)
      if (seventh) voiced = addSeventh(voiced, startChord)
      const startVel = clampVelocity(this.lastInputVelocity * this.params.outputLevel)
      for (const pitch of voiced) {
        events.push({ type: 'noteOn', pitch, velocity: startVel, channel })
        this.held.add(pitch)
      }
      this.lastTriad = startChord
      // startChord has no cell-authored gate; sustain until next noteOn step
      // releases it via the legato handoff.
      this.handoffPending = true
      this.lastEmittedEffectivePos = 0
      return events
    }

    if (effectivePos % transformTicks !== 0) return []

    const subdivStepPos = effectivePos / ticksPerStep
    const walkState: WalkState = { startChord, cells, stepsPerTransform: spt, jitter, seed, stepDirection, humanizeDrift }
    const stepEvent = walkStepEvent(walkState, subdivStepPos)
    if (stepEvent === null) {
      // Empty cells[]; fall back to walk() so the cursor is still defined.
      this.lastTriad = walk(walkState, subdivStepPos)
      return []
    }

    if (!stepEvent.played) {
      // rest or probability fail: silent advance. Cursor still moves; no audio.
      this.lastTriad = stepEvent.chord
      this.lastEmittedEffectivePos = effectivePos
      return []
    }

    const cell = cells[stepEvent.cellIdx]!
    // ADR 005 §"Humanize": apply signed uniform noise to cell vel/gate/timing
    // with the cell-amount knobs. Engine produces raw [0, 1) draws; map to
    // [-1, +1] via (raw*2-1) and scale by amount. Clamp per ADR table.
    const { humanizeVelocity, humanizeGate, humanizeTiming, outputLevel } = this.params
    const cellVel = clamp01(cell.velocity + (stepEvent.humanizeVel * 2 - 1) * humanizeVelocity)
    const cellGate = clamp01(cell.gate + (stepEvent.humanizeGate * 2 - 1) * humanizeGate)
    const cellTiming = clampSigned05(cell.timing + (stepEvent.humanizeTiming * 2 - 1) * humanizeTiming)

    // ADR 005 §Swing: swing offsets odd-indexed subdivision-steps later by
    // (2*swing - 1) * ticksPerStep raw ticks. swing=0.5 → no offset. The
    // offset composes additively with cell.timing.
    const swingOffsetTicks = subdivStepPos % 2 === 1
      ? (2 * swing - 1) * ticksPerStep
      : 0

    // ADR 005 specifies "subsequent cycles use the unclamped offset" for
    // negative timing, but firing at delayPos<0 needs look-ahead scheduling
    // from the prior step boundary. Phase 2 clamps at every boundary; the
    // look-ahead path is deferred.
    const timingOffset = Math.max(0, swingOffsetTicks + cellTiming * transformTicks)

    let voiced = applyVoicing(stepEvent.chord, voicing)
    if (seventh) voiced = addSeventh(voiced, stepEvent.chord)
    // outputLevel scales the entire stack uniformly — applied LAST so it
    // composes cleanly with source velocity, per-cell velocity, and humanize.
    const velocity = clampVelocity(this.lastInputVelocity * cellVel * outputLevel)

    const events: NoteEvent[] = []
    if (this.handoffPending) {
      for (const pitch of this.held) {
        events.push(maybeDelay({ type: 'noteOff', pitch, channel }, timingOffset))
      }
    }
    this.held.clear()

    for (const pitch of voiced) {
      events.push(maybeDelay({ type: 'noteOn', pitch, velocity, channel }, timingOffset))
      this.held.add(pitch)
    }

    if (cellGate < 1.0) {
      const gateOffset = timingOffset + cellGate * transformTicks
      for (const pitch of voiced) {
        events.push(maybeDelay({ type: 'noteOff', pitch, channel }, gateOffset))
      }
      this.handoffPending = false
    } else {
      // gate >= 1.0: leave for next step's legato handoff.
      this.handoffPending = true
    }

    this.lastTriad = stepEvent.chord
    this.lastEmittedEffectivePos = effectivePos
    return events
  }

  panic(): NoteEvent[] {
    const events: NoteEvent[] = []
    for (const pitch of this.held) {
      events.push({ type: 'noteOff', pitch, channel: this.params.channel })
    }
    this.held.clear()
    this.lastTriad = null
    this.handoffPending = false
    this.lastEmittedEffectivePos = null
    return events
  }

  private matchesInputChannel(channel: number): boolean {
    return this.params.inputChannel === 0 || channel === this.params.inputChannel
  }

  private recomputeStartChord(): NoteEvent[] {
    const triad = findTriadInHeldNotes([...this.inputHeld])
    if (triad === null) return []
    if (triadsEqual(triad, this.params.startChord)) return []
    const events: NoteEvent[] = []
    for (const pitch of this.held) {
      events.push({ type: 'noteOff', pitch, channel: this.params.channel })
    }
    this.held.clear()
    this.lastTriad = null
    this.pendingPosReset = true
    this.params = { ...this.params, startChord: triad }
    return events
  }

  // Snapshot current device state into a fresh Slot. Per-cell numeric
  // expression (velocity / gate / probability / timing) is intentionally
  // NOT captured — those are device-shared per ADR 006 §"Axis 1".
  private captureSlot(): Slot {
    const { rootPc, quality } = identifyTriad(this.params.startChord)
    return {
      cells: cellsToString(this.params.cells.map(c => c.op)),
      startChord: { root: rootPc, quality: quality === 'major' ? 'maj' : 'min' },
      jitter: this.params.jitter,
      seed: this.params.seed,
    }
  }

  private cloneSlot(slot: Slot): Slot {
    return {
      cells: slot.cells,
      startChord: { ...slot.startChord },
      jitter: slot.jitter,
      seed: slot.seed,
    }
  }

  // Apply slot.cells (op pattern) onto params.cells, preserving each cell's
  // numeric expression. Mismatched lengths zip over min — slots saved at one
  // cell count don't corrupt a device with a different cell count.
  private applySlotCells(cellsStr: string): void {
    const ops = stringToCells(cellsStr)
    if (ops === null) return
    const next = this.params.cells.slice()
    const n = Math.min(next.length, ops.length)
    for (let i = 0; i < n; i++) {
      next[i] = { ...next[i]!, op: ops[i]! }
    }
    this.params = { ...this.params, cells: next }
  }

  // Apply slot.startChord onto params.startChord, anchored to the current
  // chord's bass-note octave so the player stays in their register. No-op
  // when the resulting triad equals current — keeps walker continuity.
  private applySlotStartChord(sc: { root: number; quality: SlotQuality }): void {
    const reference = this.params.startChord[0]
    const triad = buildTriad(sc.root, sc.quality === 'maj' ? 'major' : 'minor', reference)
    if (triadsEqual(triad, this.params.startChord)) return
    this.params = { ...this.params, startChord: triad }
    this.pendingPosReset = true
    this.lastTriad = null
  }
}

function triadsEqual(a: Triad, b: Triad): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

// Clamp scaled velocity to MIDI 1..127. Velocity 0 is conventionally a
// noteOff, so a fully-attenuated cell still produces a quiet but audible note.
function clampVelocity(v: number): number {
  const rounded = Math.round(v)
  if (rounded < 1) return 1
  if (rounded > 127) return 127
  return rounded
}

function clamp01(v: number): number {
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

function clampSigned05(v: number): number {
  if (v < -0.5) return -0.5
  if (v > 0.5) return 0.5
  return v
}

// Attach delayPos only when non-zero so default-cell event shapes (and
// existing unit tests that don't set delayPos) stay clean.
function maybeDelay(event: NoteEvent, delayPos: number): NoteEvent {
  if (delayPos === 0) return event
  return { ...event, delayPos }
}
