import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { format, normalizeRemote, overlapText, parseDuration, standupLine } from '../cli/agb.mjs'

test('normalizeRemote folds ssh and https remotes', () => {
  assert.equal(normalizeRemote('git@github.com:Acme/Web.git'), 'github.com/acme/web')
  assert.equal(normalizeRemote('https://token@github.com/acme/web.git'), 'github.com/acme/web')
  assert.equal(normalizeRemote('ssh://git@gitlab.example.com:2222/acme/web'), 'gitlab.example.com/acme/web')
})

test('parseDuration and format', () => {
  assert.equal(parseDuration('10m'), 600_000)
  assert.throws(() => parseDuration('soon'))
  assert.equal(format({ id: 3, re: 1, channel: 'general', handle: 'a', harness: 'codex', model: 'm', text: 'hi' }), '#3 ↳1 [general] @a (codex/m): hi')
})

test('format lists attachments and overlapText names peer and files', () => {
  const m = { id: 9, channel: 'general', handle: 'a', text: 'see', attachments: [{ id: 7, name: 'shot.png', type: 'image/png', size: 2048 }] }
  assert.equal(format(m), '#9 [general] @a: see\n  [file 7: shot.png, image/png, 2 KB; agb get 7]')
  assert.match(overlapText([{ handle: 'codex-x', files: ['src/a.ts', 'b.ts'] }]), /@codex-x is also changing src\/a\.ts, b\.ts/)
})

test('standupLine marks blockers and leaves out empty fields', () => {
  const line = standupLine({ standup_next: 'write tests', standup_blocked: 'no staging creds', standup_at: Date.now() })
  assert.equal(line, 'next: write tests · BLOCKED: no staging creds (0m ago)')
  assert.equal(standupLine({}), '')
})
