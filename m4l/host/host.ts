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
  type Cell,
  type MidiNote,
  type Triad,
  type Voicing,
  type WalkState,
} from '../engine/tonnetz.ts'

export type NoteEvent =
  | { type: 'noteOn'; pitch: MidiNote; velocity: number; channel: number }
  | { type: 'noteOff'; pitch: MidiNote; channel: number }

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

  setCell(idx: number, op: Cell): void {
    if (idx < 0 || idx >= this.params.cells.length) return
    const cells = this.params.cells.slice()
    cells[idx] = op
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
    }
    const effectivePos = pos - this.startPos
    const { startChord, cells, stepsPerTransform, jitter, seed, voicing, seventh, channel } = this.params
    const walkState: WalkState = { startChord, cells, stepsPerTransform, jitter, seed }
    const triad = walk(walkState, effectivePos)

    if (this.lastTriad !== null && triadsEqual(triad, this.lastTriad)) {
      return []
    }

    const events: NoteEvent[] = []
    for (const pitch of this.held) {
      events.push({ type: 'noteOff', pitch, channel })
    }
    this.held.clear()

    let voiced = applyVoicing(triad, voicing)
    if (seventh) voiced = addSeventh(voiced, triad)
    for (const pitch of voiced) {
      events.push({ type: 'noteOn', pitch, velocity: this.lastInputVelocity, channel })
      this.held.add(pitch)
    }
    this.lastTriad = triad
    return events
  }

  panic(): NoteEvent[] {
    const events: NoteEvent[] = []
    for (const pitch of this.held) {
      events.push({ type: 'noteOff', pitch, channel: this.params.channel })
    }
    this.held.clear()
    this.lastTriad = null
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
