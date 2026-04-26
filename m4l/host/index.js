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
// docs/ai/adr/003-m4l-parameters-state.md §"Message protocol"):
//
//   Max -> here:
//     step <pos>                          advance to host step index
//     panic                               all notes off
//     setParams <key> <value>             scalar param update (jitter, seed,
//                                         stepsPerTransform, voicing, seventh,
//                                         channel)
//     setStartChord <p1> <p2> <p3>        triad as MIDI notes
//     setCell <idx> <op>                  single-cell update; op ∈ {P,L,R,hold}
//     setCells <op0> <op1> <op2> <op3>    bulk-set the whole cell array
//     latticeRefresh                      re-emit lattice state (used on load)
//
//   here -> Max (via Max.outlet):
//     note <pitch> <velocity> <channel>   velocity=0 means note-off
//     lattice-center <pc>                 lattice center pc (0..11)
//     lattice-current <pc1> <pc2> <pc3>   current triad as pitch classes
//     lattice-clear                       no current triad (panic / pre-play)

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
  velocity: 100,
  channel: 1,
})

function emit(ev) {
  const velocity = ev.type === 'noteOn' ? ev.velocity : 0
  Max.outlet('note', ev.pitch, velocity, ev.channel)
}

function emitLatticeCenter() {
  Max.outlet('lattice-center', host.centerPc)
}

function emitLatticeCurrent() {
  const t = host.currentTriad
  if (t === null) {
    Max.outlet('lattice-clear')
    return
  }
  Max.outlet('lattice-current', t[0] % 12, t[1] % 12, t[2] % 12)
}

Max.addHandler('step', (pos) => {
  const events = host.step(Number(pos))
  for (const ev of events) emit(ev)
  if (events.length > 0) emitLatticeCurrent()
})

Max.addHandler('panic', () => {
  for (const ev of host.panic()) emit(ev)
  emitLatticeCurrent()
})

Max.addHandler('setParams', (key, value) => {
  host.setParams({ [key]: value })
})

Max.addHandler('setStartChord', (p1, p2, p3) => {
  host.setParams({ startChord: [Number(p1), Number(p2), Number(p3)] })
  emitLatticeCenter()
})

Max.addHandler('setCell', (idx, op) => {
  host.setCell(Number(idx), String(op))
})

Max.addHandler('setCells', (...ops) => {
  host.setParams({ cells: ops.map(String) })
})

Max.addHandler('latticeRefresh', () => {
  emitLatticeCenter()
  emitLatticeCurrent()
})
