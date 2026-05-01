import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Bundled output produced by `pnpm bundle:host` (run via `pnpm bake`).
// The file is .gitignored — fresh checkouts won't have it until first bake.
const BUNDLE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'oedipa-host.mjs')

describe('oedipa-host.mjs bundle (ADR 007 Phase 5)', () => {
  test('bundle file exists', { skip: !existsSync(BUNDLE) ? 'bundle not built — run `pnpm bake` from m4l/' : false }, () => {
    assert.ok(existsSync(BUNDLE))
  })

  test(`only 'max-api' remains as runtime import`, { skip: !existsSync(BUNDLE) ? 'bundle not built — run `pnpm bake` from m4l/' : false }, () => {
    const text = readFileSync(BUNDLE, 'utf8')
    // Match top-level ESM static imports (with or without `from`).
    const importRe = /(?:^|\n)\s*import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g
    const externals = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = importRe.exec(text)) !== null) externals.add(m[1])
    const allowed = new Set(['max-api'])
    const unexpected = [...externals].filter((s) => !allowed.has(s))
    assert.deepEqual(
      unexpected,
      [],
      `Bundled oedipa-host.mjs has unexpected runtime imports: ${unexpected.join(', ')}.\n` +
        `Only 'max-api' should be external (Max provides it at runtime). All other deps\n` +
        `must be bundled in. If freeze is to capture the entire host, the entry needs to\n` +
        `be self-contained except for the Max-injected runtime.`,
    )
  })
})
