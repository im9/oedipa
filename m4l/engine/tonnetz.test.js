const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const vectors = require(path.join(__dirname, '..', '..', 'docs', 'ai', 'tonnetz-test-vectors.json'))
const { identifyTriad, applyTransform, applyVoicing, addSeventh, walk } = require('./tonnetz')

function pcSet(notes) {
  const pcs = notes.map(n => ((n % 12) + 12) % 12)
  return [...new Set(pcs)].sort((a, b) => a - b)
}

test('identifyTriad', async (t) => {
  for (const tc of vectors.identify_triad) {
    await t.test(tc.name, () => {
      const result = identifyTriad(tc.input)
      assert.strictEqual(result.rootPc, tc.expected.root_pc, 'rootPc')
      assert.strictEqual(result.quality, tc.expected.quality, 'quality')
    })
  }
})

test('applyTransform', async (t) => {
  for (const tc of vectors.apply_transform) {
    await t.test(tc.name, () => {
      const result = applyTransform(tc.input, tc.op)
      assert.deepStrictEqual(pcSet(result), tc.expected_pcs)
    })
  }
})

test('roundtrip (involution)', async (t) => {
  for (const tc of vectors.roundtrip) {
    await t.test(tc.name, () => {
      let result = tc.input
      for (const op of tc.ops) {
        result = applyTransform(result, op)
      }
      assert.deepStrictEqual(pcSet(result), tc.expected_pcs)
    })
  }
})

test('applyVoicing', async (t) => {
  for (const tc of vectors.voicing) {
    await t.test(tc.name, () => {
      const result = applyVoicing(tc.input, tc.mode)
      assert.deepStrictEqual(result, tc.expected)
    })
  }
})

test('addSeventh', async (t) => {
  for (const tc of vectors.seventh) {
    await t.test(tc.name, () => {
      const result = addSeventh(tc.voiced, tc.triad)
      assert.deepStrictEqual(result, tc.expected)
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
          assert.deepStrictEqual(pcSet(result), sample.expected_pcs)
        })
      }
    })
  }
})
