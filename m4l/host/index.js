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
// Protocol (see docs/ai/adr/002-m4l-device-architecture.md §3):
//
//   Max -> here:
//     step <pos>                          advance to host step index
//     panic                               all notes off
//     setParams <key> <value>             scalar param update
//     setStartChord <p1> <p2> <p3>        triad as MIDI notes
//     setSequence <op> [<op> ...]         'P' | 'L' | 'R' list
//     setAnchors <json>                   JSON array of {step, triad}
//
//   here -> Max (via Max.outlet):
//     note <pitch> <velocity> <channel>   velocity=0 means note-off

import Max from 'max-api'
import { Host } from './dist/host/host.js'

Max.post('oedipa host: index.js loaded')

const host = new Host({
  startChord: [60, 64, 67],
  sequence: ['P'],
  stepsPerTransform: 4,
  voicing: 'close',
  seventh: false,
  anchors: [],
  velocity: 100,
  channel: 1,
})

function emit(ev) {
  const velocity = ev.type === 'noteOn' ? ev.velocity : 0
  Max.outlet('note', ev.pitch, velocity, ev.channel)
}

Max.addHandler('step', (pos) => {
  for (const ev of host.step(Number(pos))) emit(ev)
})

Max.addHandler('panic', () => {
  for (const ev of host.panic()) emit(ev)
})

Max.addHandler('setParams', (key, value) => {
  host.setParams({ [key]: value })
})

Max.addHandler('setStartChord', (p1, p2, p3) => {
  host.setParams({ startChord: [Number(p1), Number(p2), Number(p3)] })
})

Max.addHandler('setSequence', (...ops) => {
  host.setParams({ sequence: ops })
})

Max.addHandler('setAnchors', (json) => {
  host.setParams({ anchors: JSON.parse(json) })
})
