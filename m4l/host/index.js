// n4m entry for the Oedipa M4L device.
// Loaded by [node.script host/index.js] in the .amxd. Thin wrapper over the
// TS Host class in dist/host/host.js — this file owns nothing musical, only
// the Max message protocol.
//
// NOTE: `max-api` is provided by Max at runtime when this file is loaded by
// [node.script]. Do NOT add it to package.json dependencies — the npm version
// conflicts with the injected one. Running this file under plain Node will
// fail to resolve 'max-api'; tests live in host.test.ts and don't touch it.
//
// Protocol (see docs/ai/adr/archive/002-m4l-device-architecture.md §3,
// docs/ai/adr/003-m4l-parameters-state.md §"Message protocol",
// docs/ai/adr/004-midi-input.md §"Per-target notes"):
//
//   Max -> here:
//     step <pos>                          advance to host step index
//     panic                               all notes off
//     setParams <key> <value>             scalar param update (jitter, seed,
//                                         stepsPerTransform, voicing, seventh,
//                                         channel, triggerMode, inputChannel)
//     setStartChord <p1> <p2> <p3>        triad as MIDI notes
//     setCell <idx> <op>                  single-cell update; op ∈ {P,L,R,hold}
//     setCells <op0> <op1> <op2> <op3>    bulk-set the whole cell array
//     noteIn <pitch> <velocity> <channel> incoming MIDI note-on (ADR 004)
//     noteOff <pitch> <channel>           incoming MIDI note-off (ADR 004)
//     transportStart                      pre-roll snapshot at transport 0→1 (ADR 004)
//     latticeRefresh                      re-emit lattice state (used on load)
//
//   here -> Max (via Max.outlet):
//     note <pitch> <velocity> <channel>   velocity=0 means note-off
//     lattice-center <pc>                 lattice center pc (0..11)
//     lattice-current <pc1> <pc2> <pc3>   current triad as pitch classes
//     lattice-clear                       no current triad (panic / pre-play)
//     cellIdx <n>                         active-cell LED index (-1 == none)

import Max from 'max-api'
import { Host } from './dist/host/host.js'

Max.post('oedipa host: index.js loaded')

const host = new Host({
  startChord: [60, 64, 67],
  cells: ['P', 'L', 'R', 'hold'],
  stepsPerTransform: 4,
  voicing: 'close',
  seventh: false,
  jitter: 0,
  seed: 0,
  channel: 1,
  triggerMode: 0,
  inputChannel: 0,
})

function emit(ev) {
  const velocity = ev.type === 'noteOn' ? ev.velocity : 0
  Max.outlet('note', ev.pitch, velocity, ev.channel)
}

function emitLatticeCenter() {
  // Send a FIXED viewport pc + startChord pcs. The renderer's viewport center
  // is intentionally decoupled from startChord — clicking a cell moves the
  // marker to that cell instead of rotating the whole lattice around the
  // startChord (the rotating behavior fit inboil's richer visual lattice but
  // makes Oedipa's simpler one feel inert under interaction). host.centerPc
  // remains the musical "tonal center" (= startChord root) for any future
  // consumers; it just isn't the viewport anchor.
  const sc = host.startChord
  const mod12 = (n) => ((n % 12) + 12) % 12
  Max.outlet('lattice-center', 0, mod12(sc[0]), mod12(sc[1]), mod12(sc[2]))
}

function emitLatticeCurrent() {
  const t = host.currentTriad
  if (t === null) {
    Max.outlet('lattice-clear')
    return
  }
  Max.outlet('lattice-current', t[0] % 12, t[1] % 12, t[2] % 12)
}

let lastCellIdx = -1
function emitCellIdx(pos) {
  const idx = host.cellIdx(pos)
  if (idx !== lastCellIdx) {
    Max.outlet('cellIdx', idx)
    lastCellIdx = idx
  }
}
function clearCellIdx() {
  if (lastCellIdx !== -1) {
    Max.outlet('cellIdx', -1)
    lastCellIdx = -1
  }
}

Max.addHandler('step', (pos) => {
  const events = host.step(Number(pos))
  for (const ev of events) emit(ev)
  if (events.length > 0) emitLatticeCurrent()
  emitCellIdx(Number(pos))
})

Max.addHandler('panic', () => {
  for (const ev of host.panic()) emit(ev)
  emitLatticeCurrent()
  clearCellIdx()
})

Max.addHandler('setParams', (key, value) => {
  host.setParams({ [key]: value })
})

Max.addHandler('setStartChord', (p1, p2, p3) => {
  const a = Number(p1), b = Number(p2), c = Number(p3)
  // Guard against corrupt rehydrate (e.g., uninitialized pattrs emitting 0).
  // A real triad never has all three pitches at MIDI 0; treat that pattern
  // as a "no value yet" signal and keep the host's current startChord.
  if (a === 0 && b === 0 && c === 0) return
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c)) return
  host.setParams({ startChord: [a, b, c] })
  emitLatticeCenter()
})

Max.addHandler('setCell', (idx, op) => {
  host.setCell(Number(idx), String(op))
})

Max.addHandler('setCells', (...ops) => {
  host.setParams({ cells: ops.map(String) })
})

Max.addHandler('noteIn', (pitch, velocity, channel) => {
  const events = host.noteIn(Number(pitch), Number(velocity), Number(channel))
  for (const ev of events) emit(ev)
  if (events.length > 0) emitLatticeCurrent()
})

Max.addHandler('noteOff', (pitch, channel) => {
  const events = host.noteOff(Number(pitch), Number(channel))
  for (const ev of events) emit(ev)
  if (events.length > 0) emitLatticeCurrent()
  // hold-to-play release triggers panic; clear LED if walker just paused
  if (host.currentTriad === null) clearCellIdx()
})

Max.addHandler('transportStart', () => {
  const events = host.transportStart()
  for (const ev of events) emit(ev)
  if (events.length > 0) emitLatticeCurrent()
})

Max.addHandler('latticeRefresh', () => {
  emitLatticeCenter()
  emitLatticeCurrent()
})

// Signal the patcher that node.script is up and all handlers are registered.
// The patcher gates its initial param dump cascade (live.* + pattr rehydrate)
// on this so messages don't arrive before this script can handle them —
// see docs/ai/adr/003-m4l-parameters-state.md "Rehydration order".
Max.outlet('hostReady', 1)
