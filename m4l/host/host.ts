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
  findTriadInHeldNotes,
  walk,
  walkStepEvent,
  type Cell,
  type MidiNote,
  type Op,
  type Triad,
  type Voicing,
  type WalkState,
} from '../engine/tonnetz.ts'

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
}

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

  constructor(params: HostParams) {
    this.params = { ...params }
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

  get currentTriad(): Triad | null {
    return this.lastTriad
  }

  get isWalkerActive(): boolean {
    return this.walkerActive
  }

  cellIdx(pos: number): number {
    if (!this.walkerActive) return -1
    const { stepsPerTransform: spt, cells } = this.params
    const numTransforms = Math.floor((pos - this.startPos) / spt)
    if (numTransforms <= 0 || cells.length === 0) return -1
    return (numTransforms - 1) % cells.length
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
      this.walkerActive = false
      return this.panic()
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

    const { startChord, cells, stepsPerTransform: spt, jitter, seed, voicing, seventh, channel } = this.params

    // pos=0 (or first call after reset): emit startChord once. No cell has
    // fired yet, so vel/gate/timing don't apply.
    if (effectivePos === 0) {
      const events: NoteEvent[] = []
      for (const pitch of this.held) events.push({ type: 'noteOff', pitch, channel })
      this.held.clear()
      let voiced = applyVoicing(startChord, voicing)
      if (seventh) voiced = addSeventh(voiced, startChord)
      for (const pitch of voiced) {
        events.push({ type: 'noteOn', pitch, velocity: this.lastInputVelocity, channel })
        this.held.add(pitch)
      }
      this.lastTriad = startChord
      // startChord has no cell-authored gate; sustain until next noteOn step
      // releases it via the legato handoff.
      this.handoffPending = true
      this.lastEmittedEffectivePos = 0
      return events
    }

    if (effectivePos % spt !== 0) return []

    const walkState: WalkState = { startChord, cells, stepsPerTransform: spt, jitter, seed }
    const stepEvent = walkStepEvent(walkState, effectivePos)
    if (stepEvent === null) {
      // Empty cells[]; fall back to walk() so the cursor is still defined.
      this.lastTriad = walk(walkState, effectivePos)
      return []
    }

    if (!stepEvent.played) {
      // rest or probability fail: silent advance. Cursor still moves; no audio.
      this.lastTriad = stepEvent.chord
      this.lastEmittedEffectivePos = effectivePos
      return []
    }

    const cell = cells[stepEvent.cellIdx]!
    // ADR 005 specifies "subsequent cycles use the unclamped offset" for
    // negative timing, but firing at delayPos<0 needs look-ahead scheduling
    // from the prior step boundary. Phase 2 clamps at every boundary; the
    // look-ahead path is Phase 3+ alongside subdivision/swing.
    const timingOffset = Math.max(0, cell.timing * spt)

    let voiced = applyVoicing(stepEvent.chord, voicing)
    if (seventh) voiced = addSeventh(voiced, stepEvent.chord)
    const velocity = clampVelocity(this.lastInputVelocity * cell.velocity)

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

    if (cell.gate < 1.0) {
      const gateOffset = timingOffset + cell.gate * spt
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

// Attach delayPos only when non-zero so default-cell event shapes (and
// existing unit tests that don't set delayPos) stay clean.
function maybeDelay(event: NoteEvent, delayPos: number): NoteEvent {
  if (delayPos === 0) return event
  return { ...event, delayPos }
}
