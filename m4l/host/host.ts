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
  arpIndex,
  buildTriad,
  findTriadInHeldNotes,
  gatingFires,
  identifyTriad,
  makeCell,
  makeTuringState,
  mulberry32,
  turingFires,
  walk,
  walkStepEvent,
  type ArpMode,
  type Cell,
  type MidiNote,
  type Op,
  type RhythmPreset,
  type StepDirection,
  type StepEvent,
  type Triad,
  type TuringRhythmState,
  type Voicing,
  type WalkState,
} from '../engine/tonnetz.ts'
import { cellsToString, parseSlot, serializeSlot, stringToCells, type Slot, type SlotQuality } from './slot.ts'
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
  // Global output velocity multiplier applied AFTER per-cell velocity and
  // humanize. Single dial for "make everything quieter / louder" without
  // touching per-cell automation. 0..1, default 1.0 (no attenuation).
  outputLevel: number
  // ADR 006 Phase 7 Step 4 (rev 2026-05-01) — RHYTHM preset, ported from
  // inboil's TonnetzRhythm subset (see engine.RhythmPreset). Drives the
  // within-cell gating predicate only; swing / humanize were removed
  // entirely (no inboil basis — inboil keeps swing project-global, no
  // humanize). ticksPerStep is hardcoded internally to 6 (16th @ PPQN=24).
  rhythm: RhythmPreset
  // ADR 006 Phase 7 — ARP picker. 'off' emits the full voiced chord per
  // fire (legacy behavior); other modes pick a single voiced index per
  // fire, advancing fireIdx within the cell and resetting at cell boundary.
  arp: ArpMode
  // ADR 006 Phase 7 — active cell count (1..8). Engine ignores cells at
  // indices >= length so the patcher can pre-allocate up to 8 hidden
  // numbox per slot without forcing them to play.
  length: number
  // ADR 006 Phase 7 Step 4 rev 2026-05-01 — Turing-machine rhythm params
  // (inboil generative.ts:498-513 + types.ts:204). Apply only when
  // rhythm='turing'; on other presets they sit dormant. Defaults match
  // inboil's TonnetzSheet UI initial values (length=8, lock=0.7, seed=0).
  // Range: length ∈ [2, 32], lock ∈ [0, 1], seed ∈ [0, 0xffffffff].
  turingLength: number
  turingLock: number
  turingSeed: number
}

// ADR 006 §"Axis 1" — 4 snapshot slots in the device.
const SLOT_COUNT = 4

// ADR 006 §"Axis 4" — random-generate alphabet. Uniform draw per cell with
// re-roll until ≥1 motion op (P/L/R) is present in the cell string.
const RANDOM_OPS: readonly Op[] = ['P', 'L', 'R', 'hold', 'rest']

// ADR 006 Phase 7 Step 4 rev 2 (2026-05-01) — patcher metro is `16n`
// (Max standard syntax, transport-synced; previously `96n` which is
// non-standard and BPM-unreliable). Each metro tick = 1 sixteenth-note,
// so 1 raw tick = 1 sub-step → ticksPerStep = 1. Tests can still pass
// a higher value via HostOptions for unit tests that want to simulate
// the old PPQN=24 stream, but production now matches the test default.
const DEFAULT_TICKS_PER_STEP = 1

export interface HostOptions {
  ticksPerStep?: number
}

export class Host {
  private params: HostParams
  private readonly ticksPerStep: number
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
  // ADR 006 Phase 7 — RHYTHM/ARP tick-loop state. `currentCellEvent` is
  // recomputed at every cell boundary and reused for sub-step refires
  // within the cell so probability/humanize draws aren't repeated. The init
  // period (effectivePos < transformTicks) uses a synthetic event with
  // cellIdx=-1 carrying startChord. `fireIdxThisCell` resets to 0 at every
  // cell boundary; `arpRng` is reseeded from `seed` on transport restart so
  // the random-ARP stream is reproducible per play.
  private currentCellEvent: StepEvent | null = null
  private fireIdxThisCell = 0
  private arpRng: () => number
  // ADR 006 Phase 7 Step 4 rev 2 — Turing-rhythm register state. Owned by
  // the host (not engine) because it evolves per sub-step boundary across
  // cells. Reseeded from (turingLength, turingSeed) on construct, on
  // transport restart, and on any of the 3 turing params changing.
  private turingState: TuringRhythmState

  constructor(params: HostParams, opts: HostOptions = {}) {
    this.params = { ...params }
    this.ticksPerStep = opts.ticksPerStep ?? DEFAULT_TICKS_PER_STEP
    this.arpRng = mulberry32(this.params.seed >>> 0)
    this.turingState = makeTuringState(this.params.turingLength, this.params.turingSeed)
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
    if (patch.seed !== undefined && patch.seed !== this.params.seed) {
      this.arpRng = mulberry32(patch.seed >>> 0)
    }
    // Reseed turing register when any of its 3 params change. Length and
    // seed control register init; lock is read live by turingFires (no
    // reseed needed for lock, but reseeding on lock change is harmless
    // and keeps the rule simple).
    const turingLengthChanged = patch.turingLength !== undefined && patch.turingLength !== this.params.turingLength
    const turingSeedChanged = patch.turingSeed !== undefined && patch.turingSeed !== this.params.turingSeed
    this.params = { ...this.params, ...patch }
    if (turingLengthChanged || turingSeedChanged) {
      this.turingState = makeTuringState(this.params.turingLength, this.params.turingSeed)
    }
    // ADR 006 Phase 7 — when length grows past cells.length, pad cells
    // with 'hold' so the engine sees N entries. Without this, [+] would
    // silently fail to add a playable cell (activeCells clamps at
    // min(cells.length, length)). Only triggers on an explicit length
    // patch — pre-existing cells.length < length mismatches from the
    // constructor are left alone (defended by activeCells's own clamp).
    if (
      patch.length !== undefined
      && patch.length > this.params.cells.length
    ) {
      const padded = this.params.cells.slice()
      while (padded.length < this.params.length) padded.push(makeCell('hold'))
      this.params = { ...this.params, cells: padded }
    }
    // ADR 006 §"Axis 1" — auto-save: user-driven slot-field edits mirror
    // into the active slot. recomputeStartChord (MIDI-driven) bypasses
    // setParams via direct mutation, so MIDI input does not trigger this.
    if (
      patch.cells !== undefined ||
      patch.jitter !== undefined ||
      patch.seed !== undefined ||
      patch.startChord !== undefined ||
      patch.length !== undefined
    ) {
      this.syncActiveSlot()
    }
  }

  setCell(idx: number, op: Op): void {
    if (idx < 0 || idx >= this.params.cells.length) return
    const cells = this.params.cells.slice()
    cells[idx] = { ...cells[idx]!, op }
    this.params = { ...this.params, cells }
    this.syncActiveSlot()
  }

  setCellField(idx: number, field: CellNumericField, value: number): void {
    if (idx < 0 || idx >= this.params.cells.length) return
    if (!Number.isFinite(value)) return
    // Clamp each field to its documented range. Without this, a patcher
    // numbox accidentally exposed beyond [0, 1] (or a stale dump path)
    // could land e.g. gate=2.0 — which the dispatcher then translates
    // into a gate-end note-off scheduled past the next note-on for the
    // same pitch, producing a stuck note. Negative gate is even worse:
    // the dispatcher's `dp <= 0` short-circuit emits the off immediately,
    // so the cell's note-on arrives with no matching off.
    let clamped: number
    switch (field) {
      case 'velocity':    clamped = Math.max(0, Math.min(1, value)); break
      case 'gate':        clamped = Math.max(0, Math.min(1, value)); break
      case 'probability': clamped = Math.max(0, Math.min(1, value)); break
      // Concept §Traversal: timing is the per-cell forward offset as a
      // fraction of cell duration. Inboil pins it to 0..+0.5 (ADR 005);
      // negative timing would push the fire EARLIER than the cell head
      // which has no defined semantics under the current scheduler.
      case 'timing':      clamped = Math.max(0, Math.min(0.5, value)); break
    }
    const cells = this.params.cells.slice()
    cells[idx] = { ...cells[idx]!, [field]: clamped }
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

  // ADR 006 §"Axis 1" amendment (2026-04-30) — auto-save replaces
  // explicit saveCurrent. Called from setCell / setParams when a slot
  // field changes. setSlot / switchSlot / load* paths bypass this
  // (they're internal slot mutations, not user-driven edits).
  private syncActiveSlot(): void {
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

  // ADR 006 Phase 6 — program string for the active slot. Reflects the
  // SAVED slot, not live params: un-saved per-param edits do not change
  // the displayed string until the user calls saveCurrent. Updates on
  // switchSlot / saveCurrent / randomizeActiveSlot / loadFactoryPreset
  // (all paths that mutate the slot).
  getActiveProgramString(): string {
    return serializeSlot(this.slots[this.activeSlotIdx]!)
  }

  // ADR 006 Phase 6 — paste handler. Parses a program string and loads it
  // into the active slot via the same setSlot + switchSlot composition as
  // loadFactoryPreset. Returns false on malformed input (no state change).
  loadFromProgramString(s: string): boolean {
    const slot = parseSlot(s)
    if (slot === null) return false
    this.setSlot(this.activeSlotIdx, slot)
    this.switchSlot(this.activeSlotIdx)
    return true
  }

  // ADR 006 Phase 5 — randomize the active slot. Generates fresh cells (with
  // ≥1 motion op constraint), jitter (0..0.6, 3-decimal), seed (uint), and
  // startChord (uniform root × quality), then setSlot + switchSlot so the
  // new program is persisted to the slot AND audibly applied via the same
  // path as loadFactoryPreset. RNG is injected for testability; production
  // callers (the m4l bridge) pass Math.random.
  randomizeActiveSlot(rng: () => number = Math.random): void {
    // Phase 7 slice (b): randomize the active region only. Cells beyond
    // params.length live in the pool but don't belong to the slot's
    // identity — regenerating must not silently extend the pattern length.
    const cellCount = Math.max(0, Math.min(this.params.cells.length, this.params.length))
    let cellsStr = ''
    if (cellCount > 0) {
      while (true) {
        const ops: Op[] = []
        for (let i = 0; i < cellCount; i++) {
          ops.push(RANDOM_OPS[Math.floor(rng() * RANDOM_OPS.length)]!)
        }
        if (ops.some(op => op === 'P' || op === 'L' || op === 'R')) {
          cellsStr = cellsToString(ops)
          break
        }
      }
    }
    // jitter quantized to 3 decimals so the in-memory slot round-trips
    // through serializeSlot's 3-decimal format identically.
    const jitter = Math.round(rng() * 600) / 1000
    const seed = Math.floor(rng() * 0x100000000) >>> 0
    const root = Math.floor(rng() * 12)
    const quality: SlotQuality = rng() < 0.5 ? 'maj' : 'min'
    const slot: Slot = { cells: cellsStr, startChord: { root, quality }, jitter, seed }
    this.setSlot(this.activeSlotIdx, slot)
    this.switchSlot(this.activeSlotIdx)
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
    const { stepsPerTransform: spt } = this.params
    const activeCells = this.activeCells()
    if (activeCells.length === 0) return -1
    const effectivePos = pos - this.startPos
    if (effectivePos <= 0) return -1
    // Most recent transform boundary in raw-tick coords, then convert to the
    // engine's subdivision-step coords for walkStepEvent (source of truth for
    // direction-aware cellIdx, including random).
    const transformTicks = spt * this.ticksPerStep
    const lastBoundaryTicks = Math.floor(effectivePos / transformTicks) * transformTicks
    if (lastBoundaryTicks <= 0) return -1
    const lastBoundarySubdivPos = lastBoundaryTicks / this.ticksPerStep
    const ev = walkStepEvent(this.makeWalkState(activeCells), lastBoundarySubdivPos)
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
    // Reseed BOTH stochastic streams so a cold-start replay (no MIDI
    // input held → recomputeStartChord doesn't set pendingPosReset, so
    // step()'s reset path doesn't fire) still reproduces. Without the
    // arpRng reseed here, transportStart preserves the prior run's
    // arp='random' stream position — violating the documented "transport
    // restart reproduces the exact ARP-random stream" contract that the
    // pendingPosReset path was added for (audit Medium, 2026-05-10).
    this.arpRng = mulberry32(this.params.seed >>> 0)
    this.turingState = makeTuringState(this.params.turingLength, this.params.turingSeed)
    return this.recomputeStartChord()
  }

  step(pos: number): NoteEvent[] {
    if (!this.walkerActive) return []
    if (this.pendingPosReset) {
      this.startPos = pos
      this.pendingPosReset = false
      this.lastEmittedEffectivePos = null
      // ADR 006 Phase 7 — reseed the ARP rng so a transport restart
      // reproduces the exact ARP-random stream. Same for the turing
      // register so the stochastic rhythm pattern restarts cleanly.
      this.arpRng = mulberry32(this.params.seed >>> 0)
      this.turingState = makeTuringState(this.params.turingLength, this.params.turingSeed)
      this.currentCellEvent = null
      this.fireIdxThisCell = 0
    }
    const effectivePos = pos - this.startPos

    // Same-pos idempotency: re-calling step(pos) for an already-emitted pos
    // is a no-op. Keeps scrub / pos-cascade callers safe.
    if (this.lastEmittedEffectivePos !== null && effectivePos === this.lastEmittedEffectivePos) {
      return []
    }

    if (effectivePos < 0) return []

    const { stepsPerTransform: spt, startChord, channel } = this.params

    // ADR 006 Phase 7 — fire only at sub-step boundaries (every ticksPerStep
    // raw ticks). Non-boundary ticks are silent.
    if (effectivePos % this.ticksPerStep !== 0) return []

    const subdivStepPos = effectivePos / this.ticksPerStep
    const subStepIdxInCell = spt > 0 ? subdivStepPos % spt : 0

    // pos=0 init: panic prior held output, synthesize an init StepEvent so
    // sub-step refires within the init period (subStepIdxInCell > 0) reuse
    // startChord. Treat pos=0 as cell-head fire (subStepIdxInCell === 0)
    // gated by the rhythm preset.
    let preEvents: NoteEvent[] = []
    if (effectivePos === 0) {
      for (const pitch of this.held) preEvents.push({ type: 'noteOff', pitch, channel })
      this.held.clear()
      this.handoffPending = false
      this.currentCellEvent = {
        cellIdx: -1,
        resolvedOp: 'hold',
        chord: [startChord[0], startChord[1], startChord[2]],
        played: true,
        humanizeVel: 0.5,
        humanizeGate: 0.5,
        humanizeTiming: 0.5,
      }
      this.fireIdxThisCell = 0
    } else if (subStepIdxInCell === 0) {
      // Cell boundary at effectivePos = K * transformTicks where K >= 1.
      const activeCells = this.activeCells()
      if (activeCells.length === 0) {
        this.lastTriad = walk(this.makeWalkState(activeCells), subdivStepPos)
        this.lastEmittedEffectivePos = effectivePos
        return []
      }
      this.currentCellEvent = walkStepEvent(this.makeWalkState(activeCells), subdivStepPos)
      this.fireIdxThisCell = 0
    }

    // Mid-cell sub-step with no cached event (first call was non-boundary):
    // skip — only legato (head-only) would fire at idx=0 anyway, and that
    // path went through the boundary branch above.
    if (this.currentCellEvent === null) {
      this.lastEmittedEffectivePos = effectivePos
      return []
    }

    const fireEvents = this.maybeFire(subStepIdxInCell, subdivStepPos)
    this.lastEmittedEffectivePos = effectivePos
    return preEvents.concat(fireEvents)
  }

  // ADR 006 Phase 7 Step 4 — single-fire emission. Decides via gatingFires
  // whether this sub-step fires; on fire, applies cell expression
  // (vel/gate/timing), picks an ARP index (or full chord), and schedules
  // legato handoff + gate-end note-offs. Returns [] on silent steps.
  // Step 4 rev 2026-05-01 dropped swing + humanize entirely — no inboil
  // basis; humanize, if reintroduced, ships as a separate parameter axis.
  private maybeFire(subStepIdxInCell: number, _subdivStepPos: number): NoteEvent[] {
    const { rhythm, arp, voicing, seventh, channel, outputLevel, stepsPerTransform: spt } = this.params

    // Gating decision:
    //   - rhythm='turing': stateful register advances every sub-step
    //     (matches inboil's turingRhythm loop, generative.ts:503-510).
    //   - rhythm='legato' + arp != 'off': override the head-only gating
    //     to fire every sub-step. Legato by itself = 1 fire per cell
    //     (held chord). With arp on, the user wants the held chord
    //     audibly arpeggiated — the standard synth-ARP behavior. So we
    //     fire at every sub-step, the arp picker walks voiced notes,
    //     fireIdxThisCell resets at each cell boundary so each new
    //     chord restarts the arp at index 0.
    //   - all other cases: the static gatingFires predicate.
    let fires: boolean
    if (rhythm === 'turing') {
      fires = turingFires(this.turingState, this.params.turingLock)
    } else if (rhythm === 'legato' && arp !== 'off') {
      fires = true
    } else {
      fires = gatingFires(rhythm, subStepIdxInCell)
    }

    if (!fires) {
      if (this.currentCellEvent) this.lastTriad = this.currentCellEvent.chord
      return []
    }

    const ev = this.currentCellEvent
    if (ev === null || !ev.played) {
      if (ev) this.lastTriad = ev.chord
      return []
    }

    // For init synthetic events (cellIdx === -1) there is no per-cell record;
    // fall back to default expression so startChord behaves as a gate=1.0
    // legato fire — same as Phase A's pos=0 emission.
    const isInit = ev.cellIdx < 0
    const cell = isInit ? null : this.params.cells[ev.cellIdx] ?? null
    const cellVel = cell?.velocity ?? 1.0
    const cellGateBase = cell?.gate ?? 1.0
    const cellTimingBase = cell?.timing ?? 0.0

    // Sub-steps between fires for this preset. Drives gate-end scheduling
    // so gate=1.0 always means "until the next fire" regardless of preset.
    // Under legato + arp the gating is overridden to fire every sub-step,
    // so the interval is 1 (matches the 'all' preset).
    const intervalRhythm: RhythmPreset = (rhythm === 'legato' && arp !== 'off') ? 'all' : rhythm
    const fireIntervalTicks = fireIntervalSubsteps(intervalRhythm, spt) * this.ticksPerStep

    // cell.timing offset applies only at the cell head — subsequent fires
    // within the cell sit on the sub-step grid.
    const transformTicks = spt * this.ticksPerStep
    const isCellHead = subStepIdxInCell === 0
    const cellTimingTicks = isCellHead ? cellTimingBase * transformTicks : 0
    const timingOffset = Math.max(0, cellTimingTicks)

    let voiced = applyVoicing(ev.chord, voicing)
    if (seventh) voiced = addSeventh(voiced, ev.chord)

    // ARP picking.
    //   - arp='off': full voiced chord (every rhythm).
    //   - arp != 'off': one voiced index per fire, picked via fireIdxThisCell.
    //     Under multi-fire rhythms the cycle happens within a cell (reset at
    //     cell boundary in step()); under legato (1 fire/cell) the cycle
    //     spans cells (step() does NOT reset fireIdxThisCell when legato +
    //     arp, so consecutive cells see fireIdxThisCell = 0, 1, 2, ...).
    //     This makes arp audibly progress under legato as well — required
    //     for UX consistency (the arp dropdown should always have effect
    //     when not 'off').
    const arpIdx = arpIndex(arp, voiced.length, this.fireIdxThisCell, this.arpRng)
    const playPitches = arpIdx === null ? voiced : [voiced[arpIdx]!]

    const velocity = clampVelocity(this.lastInputVelocity * cellVel * outputLevel)

    const events: NoteEvent[] = []
    if (this.handoffPending) {
      for (const pitch of this.held) {
        events.push(maybeDelay({ type: 'noteOff', pitch, channel }, timingOffset))
      }
    }
    this.held.clear()

    for (const pitch of playPitches) {
      events.push(maybeDelay({ type: 'noteOn', pitch, velocity, channel }, timingOffset))
      this.held.add(pitch)
    }

    if (cellGateBase < 1.0) {
      const gateOffset = timingOffset + cellGateBase * fireIntervalTicks
      for (const pitch of playPitches) {
        events.push(maybeDelay({ type: 'noteOff', pitch, channel }, gateOffset))
      }
      this.handoffPending = false
    } else {
      this.handoffPending = true
    }

    this.lastTriad = ev.chord
    this.fireIdxThisCell++
    return events
  }

  // Cells active under the current `length` cap. Engine consumes only this
  // slice, so cells at indices >= length are ignored without dropping them
  // from the persisted record.
  private activeCells(): Cell[] {
    const { cells, length } = this.params
    const n = Math.max(0, Math.min(cells.length, length))
    return cells.slice(0, n)
  }

  private makeWalkState(activeCells: Cell[]): WalkState {
    const { startChord, stepsPerTransform: spt, jitter, seed, stepDirection } = this.params
    return { startChord, cells: activeCells, stepsPerTransform: spt, jitter, seed, stepDirection }
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
    this.currentCellEvent = null
    this.fireIdxThisCell = 0
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
  // NOT captured — those are device-shared per ADR 006 §"Axis 1". Cells
  // are sliced to the active region (length); cells beyond live in the
  // pool but don't belong to the slot's identity (Phase 7 slice b).
  private captureSlot(): Slot {
    const { rootPc, quality } = identifyTriad(this.params.startChord)
    const activeOps = this.activeCells().map(c => c.op)
    return {
      cells: cellsToString(activeOps),
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

  // Apply slot.cells (op pattern) onto params.cells. Cells beyond the
  // loaded program retain their per-cell numeric expression in the pool
  // but go inert via the length cap (Phase 7 slice b). When the loaded
  // program is longer than the current pool, extends with default-cell
  // entries so cells 4..7 (or however far) become available for editing.
  // Empty programs leave length unchanged — same as the pre-Phase-7
  // contract for malformed/empty slot loads.
  private applySlotCells(cellsStr: string): void {
    const ops = stringToCells(cellsStr)
    if (ops === null) return
    const next = this.params.cells.slice()
    while (next.length < ops.length) next.push(makeCell('hold'))
    for (let i = 0; i < ops.length; i++) {
      next[i] = { ...next[i]!, op: ops[i]! }
    }
    if (ops.length === 0) {
      this.params = { ...this.params, cells: next }
      return
    }
    const newLength = Math.max(1, Math.min(8, ops.length))
    this.params = { ...this.params, cells: next, length: newLength }
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

// Attach delayPos only when non-zero so default-cell event shapes (and
// existing unit tests that don't set delayPos) stay clean.
function maybeDelay(event: NoteEvent, delayPos: number): NoteEvent {
  if (delayPos === 0) return event
  return { ...event, delayPos }
}

// ADR 006 Phase 7 Step 4 — fires-per-preset interval, in sub-steps. Drives
// gate-end scheduling so gate=1.0 always means "until the next fire"
// regardless of preset. legato spans the whole cell; all spans 1 sub-step;
// onbeat spans the quarter (4); offbeat spans every-other-16th (2);
// syncopated's pattern (`[T,F,T,F,F,T,F,T]`) has variable gaps — fall back
// to 1 (the pattern's minimum interval) so gate<1.0 always releases by the
// next 16th boundary, never overlapping a denser fire downstream.
function fireIntervalSubsteps(mode: RhythmPreset, spt: number): number {
  switch (mode) {
    case 'legato':     return spt
    case 'all':        return 1
    case 'onbeat':     return 4
    // offbeat fires on quarter-offs (idx % 4 === 2), so the next fire is
    // always 4 sub-steps later — same gate-end scaling as onbeat.
    case 'offbeat':    return 4
    case 'syncopated': return 1
    // Turing's interval is stochastic — minimum is 1 (consecutive bits
    // can both fire). Use 1 as a safe gate-end scaler so gate < 1.0
    // releases by the next 16th boundary, never overlapping the next
    // (potentially adjacent) fire.
    case 'turing':     return 1
  }
}
