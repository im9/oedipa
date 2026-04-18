import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as path from 'node:path'
import { readFileSync } from 'node:fs'
import {
  identifyTriad,
  applyTransform,
  applyVoicing,
  addSeventh,
  walk,
  type Triad,
  type Transform,
  type Voicing,
  type WalkState,
} from './tonnetz.ts'

interface IdentifyCase {
  name: string
  input: Triad
  expected: { root_pc: number; quality: 'major' | 'minor' }
}

interface TransformCase {
  name: string
  input: Triad
  op: Transform
  expected_pcs: number[]
}

interface RoundtripCase {
  name: string
  input: Triad
  ops: Transform[]
  expected_pcs: number[]
}

interface VoicingCase {
  name: string
  input: Triad
  mode: Voicing
  expected: number[]
}

interface SeventhCase {
  name: string
  voiced: number[]
  triad: Triad
  expected: number[]
}

interface WalkSample {
  pos: number
  expected_pcs: number[]
  note?: string
}

interface WalkCase {
  name: string
  state: WalkState
  samples: WalkSample[]
}

interface Vectors {
  identify_triad: IdentifyCase[]
  apply_transform: TransformCase[]
  roundtrip: RoundtripCase[]
  voicing: VoicingCase[]
  seventh: SeventhCase[]
  walk: WalkCase[]
}

const vectorsPath = path.join(import.meta.dirname, '..', '..', 'docs', 'ai', 'tonnetz-test-vectors.json')
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as Vectors

function pcSet(notes: number[]): number[] {
  const pcs = notes.map(n => ((n % 12) + 12) % 12)
  return [...new Set(pcs)].sort((a, b) => a - b)
}

test('identifyTriad', async (t) => {
  for (const tc of vectors.identify_triad) {
    await t.test(tc.name, () => {
      const result = identifyTriad(tc.input)
      assert.equal(result.rootPc, tc.expected.root_pc, 'rootPc')
      assert.equal(result.quality, tc.expected.quality, 'quality')
    })
  }
})

test('applyTransform', async (t) => {
  for (const tc of vectors.apply_transform) {
    await t.test(tc.name, () => {
      const result = applyTransform(tc.input, tc.op)
      assert.deepEqual(pcSet(result), tc.expected_pcs)
    })
  }
})

test('roundtrip (involution)', async (t) => {
  for (const tc of vectors.roundtrip) {
    await t.test(tc.name, () => {
      let result: Triad = tc.input
      for (const op of tc.ops) {
        result = applyTransform(result, op)
      }
      assert.deepEqual(pcSet(result), tc.expected_pcs)
    })
  }
})

test('applyVoicing', async (t) => {
  for (const tc of vectors.voicing) {
    await t.test(tc.name, () => {
      const result = applyVoicing(tc.input, tc.mode)
      assert.deepEqual(result, tc.expected)
    })
  }
})

test('addSeventh', async (t) => {
  for (const tc of vectors.seventh) {
    await t.test(tc.name, () => {
      const result = addSeventh(tc.voiced, tc.triad)
      assert.deepEqual(result, tc.expected)
    })
  }
})

test('walk', async (t) => {
  for (const tc of vectors.walk) {
    await t.test(tc.name, async (t2) => {
      for (const sample of tc.samples) {
        const label = `pos=${sample.pos}` + (sample.note ? `: ${sample.note}` : '')
        await t2.test(label, () => {
          const result = walk(tc.state, sample.pos)
          assert.deepEqual(pcSet(result), sample.expected_pcs)
        })
      }
    })
  }
})
