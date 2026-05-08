Oedipa — Tonnetz-based chord exploration MIDI effect
im9 / Free distribution


About
-----

On each host step, Oedipa walks a Tonnetz lattice — a 2D triangular
grid where each face is a triad — by applying one of three
neo-Riemannian transforms and emits the resulting chord as MIDI.

  P (Parallel)      flip major <-> minor, same root   (C  <-> Cm)
  L (Leading-tone)  shared third, opposite quality    (C  <-> Em)
  R (Relative)      shared root + fifth               (C  <-> Am)

The walk is driven by a short cyclic "cell program" (4 cells by
default). Each cell carries an op (P / L / R / hold / rest) and
per-cell expression (velocity, gate, probability, timing). A
seeded jitter substitutes a random op with configurable
probability; an opt-in humanize layer takes the edge off the grid.
Both share the same PRNG so the walk is reproducible.

For a fixed configuration the walk is deterministic — scrubbing
the transport or resuming playback from any position produces the
same output.

Full musical model: docs/ai/concept.md in the source repository
(https://github.com/im9/oedipa).


Parameters
----------

Walk core:

  startChord    triad        walker's initial triad
  cells         Cell[]       ordered cell sequence (4 by default)
  jitter        0..1         per-step random-substitute probability
  seed          int          RNG seed for reproducibility
  cellLength    1..64 (16th) cell duration; default 4 = 1 quarter note
  voicing       enum         close | spread | drop2 (default spread)
  seventh       bool         add maj7 / min7 extension

Per-cell record:

  op            enum         P | L | R | hold | rest
  velocity      0..1         source-velocity multiplier
  gate          0..1         step-length fraction; 1.0 = legato handoff
  probability   0..1         per-visit play chance; fail = silent-advance
  timing        -0.5..+0.5   step-length-fraction offset; adds to swing

Global rhythmic layer:

  subdivision        enum    8th | 16th | 32nd | 8T | 16T (default 16th)
  swing              0.5..0.75    off-beat shift; 0.5 = straight
  stepDirection      enum    forward | reverse | pingpong | random
  humanizeVelocity   0..1    signed-noise amplitude on per-cell velocity
  humanizeGate       0..1    signed-noise amplitude on per-cell gate
  humanizeTiming     0..1    signed-noise amplitude on per-cell timing
  humanizeDrift      0..1    EMA smoothing factor across humanize axes
  outputLevel        0..1    global output velocity multiplier (default 1.0)


Voicing
-------

  close     [root, 3rd, 5th] root position
  spread    middle voice up an octave; open sound (default)
  drop2     second voice from top dropped an octave; jazz idiom

Optional 7th extension adds maj7 (for major) or min7 (for minor).


Changelog
---------

v0.1.0     Initial release.
           AU + VST3 macOS bundles, signed and notarized.


License
-------

MIT — https://github.com/im9/oedipa/blob/main/LICENSE
