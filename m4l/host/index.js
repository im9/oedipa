// n4m entry for the Oedipa M4L device.
// Loaded by [node.script host/index.js] in the .amxd. Thin wrapper over the
// TS Bridge class in dist/host/bridge.js — this file owns nothing musical,
// only the Max message protocol and dependency injection.
//
// NOTE: `max-api` is provided by Max at runtime when this file is loaded by
// [node.script]. Do NOT add it to package.json dependencies — the npm version
// conflicts with the injected one. Running this file under plain Node will
// fail to resolve 'max-api'; bridge logic is tested in bridge.test.ts and
// doesn't touch it.
//
// Protocol (see docs/ai/adr/archive/002-m4l-device-architecture.md §3,
// docs/ai/adr/003-m4l-parameters-state.md §"Message protocol",
// docs/ai/adr/004-midi-input.md §"Per-target notes",
// docs/ai/adr/005-rhythmic-feel.md §"Layer 1 — Per-cell expression"):
//
//   Max -> here:
//     step <pos>                          advance to host step index
//     panic                               all notes off
//     setParams <key> <value>             scalar param update
//     setStartChord <p1> <p2> <p3>        triad as MIDI notes
//     setCell <idx> <op>                  single-cell op update
//     setCells <op0> <op1> <op2> <op3>    bulk-set the whole cell op array
//     setCellField <idx> <field> <value>  per-cell numeric field update
//                                         (field ∈ velocity|gate|probability|timing)
//     noteIn <pitch> <velocity> <channel> incoming MIDI note-on (ADR 004)
//     noteOff <pitch> <channel>           incoming MIDI note-off (ADR 004)
//     transportStart                      pre-roll snapshot at transport 0→1
//     latticeRefresh                      re-emit lattice state (used on load)
//
//   here -> Max (via Max.outlet):
//     note <pitch> <velocity> <channel>   velocity=0 means note-off
//     lattice-center <pc>                 lattice center pc (0..11)
//     lattice-current <pc1> <pc2> <pc3>   current triad as pitch classes
//     lattice-clear                       no current triad (panic / pre-play)
//     cellIdx <n>                         active-cell LED index (-1 == none)

import Max from 'max-api'
import { Bridge } from './dist/host/bridge.js'

Max.post('oedipa host: index.js loaded')

const bridge = new Bridge({
  emitNote: (pitch, velocity, channel) => Max.outlet('note', pitch, velocity, channel),
  emitOutlet: (channel, ...args) => Max.outlet(channel, ...args),
  now: () => Date.now(),
  scheduleAfter: (ms, cb) => setTimeout(cb, ms),
})

Max.addHandler('step', (pos) => bridge.step(Number(pos)))
Max.addHandler('panic', () => bridge.panic())
Max.addHandler('setParams', (key, value) => bridge.setParams(key, value))
Max.addHandler('setStartChord', (p1, p2, p3) => bridge.setStartChord(Number(p1), Number(p2), Number(p3)))
Max.addHandler('setCell', (idx, op) => bridge.setCell(Number(idx), String(op)))
Max.addHandler('setCells', (...ops) => bridge.setCells(ops.map(String)))
Max.addHandler('setCellField', (idx, field, value) =>
  bridge.setCellField(Number(idx), String(field), Number(value)))
Max.addHandler('noteIn', (pitch, velocity, channel) =>
  bridge.noteIn(Number(pitch), Number(velocity), Number(channel)))
Max.addHandler('noteOff', (pitch, channel) =>
  bridge.noteOff(Number(pitch), Number(channel)))
Max.addHandler('transportStart', () => bridge.transportStart())
Max.addHandler('latticeRefresh', () => bridge.latticeRefresh())

// ADR 006 Phase 3 — slot ops. saveCurrent removed 2026-04-30 (auto-save).
Max.addHandler('switchSlot', (idx) => bridge.switchSlot(Number(idx)))
Max.addHandler('loadFactoryPreset', (idx) => bridge.loadFactoryPreset(Number(idx)))
Max.addHandler('randomize', () => bridge.randomize())
Max.addHandler('loadFromProgramString', (s) => bridge.loadFromProgramString(String(s)))
// ADR 006 Phase 3b — silent slot rehydrate from hidden live.numbox dumps on
// loadbang. Patcher sends one setSlotFields per slot, then `switchSlot
// <activeIdx>` to apply the persisted active slot to host params and emit
// the rehydrate bundle.
Max.addHandler('setSlotFields', (idx, c0, c1, c2, c3, jitter, seed, root, quality) =>
  bridge.setSlotFields(
    Number(idx),
    Number(c0), Number(c1), Number(c2), Number(c3),
    Number(jitter), Number(seed), Number(root), Number(quality),
  ))

// Signal the patcher that node.script is up and all handlers are registered.
// The patcher gates its initial param dump cascade (live.* + pattr rehydrate)
// on this so messages don't arrive before this script can handle them —
// see docs/ai/adr/003-m4l-parameters-state.md "Rehydration order".
Max.outlet('hostReady', 1)
