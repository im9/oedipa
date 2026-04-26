#!/usr/bin/env node
// Bake Oedipa.maxpat into Oedipa.amxd.
//
// Why: Max's clipboard paste (Open .maxpat → Cmd+A/C → paste into .amxd) only
// transfers boxes, NOT patcher-level attributes (openinpresentation, rect,
// default_fontsize, ...). To get the full .maxpat into the .amxd we splice
// the JSON portion of the existing .amxd, keeping its IFF-style header and
// trailer bytes untouched (whose exact semantics we don't fully understand
// but that Max writes, so we preserve them verbatim).
//
// Observed AMPF layout for this device:
//   bytes 0..3       : "ampf"
//   bytes 4..7       : LE uint32 — format version (= 4)
//   bytes 8..11      : "mmmm" container magic
//   bytes 12..15     : "ptch" patcher chunk magic
//   bytes 16..19     : LE uint32 — patcher chunk size = JSON length + 2 trailer bytes
//   bytes 20..len-3  : UTF-8 JSON patcher (starts with "{", ends with "}")
//   byte  len-2      : 0x0a ("\n")
//   byte  len-1      : 0x00 (null terminator)
//
// Usage:
//   node scripts/maxpat-to-amxd.mjs            # in-place: writes Oedipa.amxd
//   node scripts/maxpat-to-amxd.mjs --check    # exit 1 if .amxd would change

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const maxpatPath = resolve(root, 'Oedipa.maxpat')
const amxdPath = resolve(root, 'Oedipa.amxd')

const HEADER_SIZE = 20
const SIZE_OFFSET = 16   // bytes 16..19 = LE uint32 patcher chunk size
const TRAILER = Buffer.from([0x0a, 0x00]) // "\n\0"

const [maxpat, amxdPrev] = await Promise.all([
  readFile(maxpatPath),
  readFile(amxdPath),
])

if (amxdPrev.length < HEADER_SIZE + TRAILER.length) {
  throw new Error(`existing .amxd is too short to contain the AMPF wrapper (${amxdPrev.length} bytes)`)
}
if (amxdPrev.subarray(0, 4).toString() !== 'ampf') {
  throw new Error(`existing .amxd does not start with "ampf" magic`)
}
if (amxdPrev[amxdPrev.length - 1] !== 0x00) {
  throw new Error(`existing .amxd does not end with the expected NUL terminator`)
}

// Validate JSON before shipping a broken .amxd to Live.
try { JSON.parse(maxpat.toString('utf-8')) } catch (e) {
  console.error(`maxpat is not valid JSON: ${e.message}`)
  process.exit(1)
}

const header = Buffer.from(amxdPrev.subarray(0, HEADER_SIZE))
header.writeUInt32LE(maxpat.length + TRAILER.length, SIZE_OFFSET)
const amxd = Buffer.concat([header, maxpat, TRAILER])

if (process.argv.includes('--check')) {
  if (amxdPrev.equals(amxd)) {
    console.log('Oedipa.amxd is up to date.')
  } else {
    console.log(`Oedipa.amxd differs from baked .maxpat (${amxdPrev.length} → ${amxd.length} bytes).`)
    process.exit(1)
  }
} else {
  await writeFile(amxdPath, amxd)
  console.log(`Wrote ${amxdPath} (${amxd.length} bytes; header ${HEADER_SIZE} + JSON ${maxpat.length} + trailer ${TRAILER.length}).`)
}
