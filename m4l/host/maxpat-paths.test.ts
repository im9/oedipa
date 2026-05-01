import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const MAXPAT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'Oedipa.maxpat')

describe('Oedipa.maxpat path conventions (ADR 007)', () => {
  test('contains no developer-machine absolute paths', () => {
    const text = readFileSync(MAXPAT, 'utf8')
    const forbidden: Array<{ name: string; pattern: RegExp }> = [
      { name: '/Users/ (macOS home)', pattern: /\/Users\//g },
      { name: '/home/ (Linux home)', pattern: /\/home\//g },
      { name: 'C:\\ (Windows drive)', pattern: /[A-Z]:\\\\/g },
    ]
    const offenders = forbidden
      .map(({ name, pattern }) => ({ name, count: (text.match(pattern) ?? []).length }))
      .filter((o) => o.count > 0)

    assert.deepEqual(
      offenders,
      [],
      `Oedipa.maxpat contains absolute paths (ADR 007 forbids them):\n` +
        offenders.map((o) => `  - ${o.name}: ${o.count} occurrence(s)`).join('\n') +
        `\nReplace with Max-native relative refs:\n` +
        `  - jsui: bare sibling filename (e.g. cellstrip-renderer.js)\n` +
        `  - node.script: bare sibling filename (e.g. oedipa-host.js)`,
    )
  })
})
