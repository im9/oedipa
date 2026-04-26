// M4L host layer for Oedipa.
// Spec: docs/ai/adr/archive/002-m4l-device-architecture.md (architecture),
//       docs/ai/adr/003-m4l-parameters-state.md (cell sequencer params)
//
// Bridges Max transport and the Tonnetz engine. Owns WalkState, resolves
// host step index -> triad (via engine.walk), applies voicing/seventh, and
// emits note-on/off events. Pure logic — no Max, no Node timers, no I/O.
// The Max patch calls step() on each transport tick and delivers the returned
// events to [noteout]. panic() is invoked on transport stop, device bypass,
// and preset restore (see concept.md "note-off discipline").

import {
  addSeventh,
  applyVoicing,
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

export interface HostParams {
  startChord: Triad
  cells: Cell[]
  stepsPerTransform: number
  voicing: Voicing
  seventh: boolean
  jitter: number
  seed: number
  velocity: number
  channel: number
}

export class Host {
  private params: HostParams
  private held: Set<MidiNote> = new Set()
  private lastTriad: Triad | null = null

  constructor(params: HostParams) {
    this.params = { ...params }
  }

  setParams(patch: Partial<HostParams>): void {
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

  get centerPc(): number {
    return ((this.params.startChord[0] % 12) + 12) % 12
  }

  step(pos: number): NoteEvent[] {
    const { startChord, cells, stepsPerTransform, jitter, seed, voicing, seventh, velocity, channel } = this.params
    const walkState: WalkState = { startChord, cells, stepsPerTransform, jitter, seed }
    const triad = walk(walkState, pos)

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
      events.push({ type: 'noteOn', pitch, velocity, channel })
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
}

function triadsEqual(a: Triad, b: Triad): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}
