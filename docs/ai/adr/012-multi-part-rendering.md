# ADR 012: Multi-part Rendering

## Status: Proposed

**Created**: 2026-06-03

## Context

Oedipa today emits a single triad on a single MIDI output per step.
The walker's Tonnetz position is the harmonic event; everything
downstream (channel, voicing, articulation) is one part's worth of
expression. To play coherent chord + bass + arp + counter-melody the
user must run multiple Oedipa instances on parallel tracks with
matching seeds and pray they stay in sync — which they don't, since
state is per-instance.

This ADR proposes treating the Tonnetz position as a **shared
musical fact** that multiple **parts** render in parallel. Each part
is a small renderer (pad / arp / bass / top-note / programmable) with
its own MIDI channel, octave, voicing, and time subdivision, all
reading the same walker state.

### Terminology note

"Voice" in Oedipa's domain already refers to the individual notes of
a triad (root / third / fifth) — the unit that neo-Riemannian P / L /
R transforms move by minimal voice-leading. `voicing` (close / spread
/ drop2) shares this sense. To avoid collision this ADR uses **part**
for the new "renderer-output stream" concept (pad / arp / bass / …) —
the orchestral sense of part. A part renders the chord; voices are
the notes inside it.

### Strategic motivation

Ableton announced the Extensions SDK 2026-06 (see
CLAUDE.md §Future companion integrations). The SDK makes simple
"context-menu chord generator" tools trivial for anyone to ship. The
defensive position for the im9 plugin trio (Oedipa, Stencil,
Pointsman) is **depth, not breadth** — each plug-in must be a deep
instrument that an Extension cannot easily replicate. Multi-part
rendering pushes Oedipa firmly into "instrument" territory: real-time
multi-track output with per-part routing and live-steerable arp is
structurally impossible inside an Extension's one-shot modal-dialog
model.

This ADR is the first concrete v0.3.x+ direction informed by that
strategic frame. Stencil and Pointsman will need their own
identity-deepening ADRs along the same axis.

### Relationship to ADR 011

ADR 011 (Proposed) ships the m4l shell rework + 16-step gate
sequencer + shared visual identity in v0.2.0. Multi-part rendering
is **out of scope for ADR 011** and lands no earlier than v0.3.0.

However ADR 011's gate sequencer must be designed so that future
multi-part work does not require its redesign. Specifically:

- Treat the gate sequencer as a **chord-articulation envelope** (one
  global rhythmic gate on the walker tick), not as a per-part rhythm
  generator. Per-part rhythmic divisions (arp subdivision, etc.)
  belong to the part renderer in this ADR — not to the gate
  sequencer.
- Walker cursor advance stays globally synchronous across parts. All
  parts observe the same Tonnetz position at the same tick.

If ADR 011 ships with those framings intact, this ADR can layer on
top without breaking it.

## Decision (sketch)

The musical model gains a **part layer** between the walker and MIDI
output:

```
walker (Tonnetz position, tick) ──► part[0] ──► MIDI ch a
                                ──► part[1] ──► MIDI ch b
                                ──► part[N] ──► MIDI ch n
```

Each part has:

- **Renderer** — pad / arp-up / arp-down / arp-random / bass /
  top-note (initial fixed library; programmable renderers deferred,
  see Open questions).
- **MIDI channel** — selectable 1..16.
- **Octave shift** — semitones or octaves offset from walker output.
- **Voicing** — close / spread / drop2, selected per part
  independently of the global voicing.
- **Subdivision** — time division within the walker step (e.g. 1/16,
  1/32 triplet). Meaningful primarily for arp-type renderers; pad /
  bass / top-note may still expose a subdivision control for
  rate-multiplier effects.
- **Gate** — note length / articulation envelope applied by the part
  to its own output, independent of the global ADR 011 gate
  sequencer.
- **Probability / mute / level** — basic per-part gating.

Part count is **user-variable**, target capacity around
**12 parts across 4 MIDI tracks** for "4 tracks × 3 parts average".
Exact maximum and UI layout to be decided in design phase.

User-supplied template patches (Instrument Rack with pre-routed MIDI
ch chains for Live; track templates for Bitwig / Logic) ship with
the device to lower routing setup cost.

## Possible sub-ADR splits

This scope is large enough that it may be split during implementation
design. Candidate axes:

- **012a — Part abstraction + fixed renderer library**: model
  change in `concept.md`, 4–6 built-in renderer types, m4l + vst UI
  for part list.
- **012b — Per-part MIDI routing + host templates**: channel
  routing, Instrument Rack template for Live, multi-bus / multi-out
  configuration for vst (Bitwig / Logic), user-facing routing UI.
- **012c — Programmable renderers**: user-authored renderer scripts
  or graphical step editor for custom part behaviors. Likely
  deferred well beyond v0.3.0 — possibly fits the Ableton Extensions
  SDK companion model for the m4l target only.

Splitting is justified if dependencies are linear (012a → 012b →
012c) and each can ship a usable subset. Defer the split decision
until 012a's design phase has clarified the model.

## Open questions

To resolve before 012a (or its successor) leaves Proposed:

1. **Part count UX** — fixed slots (e.g. 12 always present, mute to
   disable) or dynamic add/remove? Affects state schema and UI.
2. **Renderer programmability surface** — if 012c is in scope, what
   does a "programmable renderer" look like? Lua-style script,
   visual node graph, step list, MPE-aware? Defer until 012a +
   012b ship.
3. **Arp subdivision relationship to walker rate** — does a part's
   subdivision multiply the walker rate, or run on its own free
   clock locked to host tempo? The former keeps everything
   synchronous; the latter allows polymeter at the cost of
   determinism. Implementation-time decision.
4. **Per-part scale / quantization** — does each part quantize to
   the global scale (current behavior) or can a part override
   (e.g. bass to root-only, melody to pentatonic)?
5. **Gate sequencer ↔ part interaction** — the ADR 011 gate
   envelope is global. Should it gate all parts uniformly, or do
   some parts (e.g. bass holding through gate-closed steps) need
   override? Decide once ADR 011 ships and the gate sequencer's
   actual behavior is concrete. Implementation-time decision.
6. **m4l host routing UX cost** — Live's Instrument Rack MIDI-channel
   chain setup is non-obvious. Required to assess whether 012 is
   shippable on m4l or vst-first / m4l-deferred. Template patches
   help but don't eliminate the cost.
7. **vst multi-out vs. multi-channel single-out** — Logic AU MIDI FX
   can emit on multiple channels but routing those to multiple
   instruments requires Track Stack / multi-timbral hosting. Bitwig
   handles this more naturally. Decide whether to target
   "multi-channel on single output" (simplest) or "multi-out bus
   per part" (more host-native but per-host different) — or
   support both.
8. **Identity framing** — Oedipa's positioning evolves from "Tonnetz
   chord explorer" to "Tonnetz-coherent multi-part instrument".
   Confirm with marketing copy + concept.md before shipping; this
   is not just a feature add but a category shift.

## Implementation checklist

*Deferred — to be drafted once 012a leaves Proposed.*
