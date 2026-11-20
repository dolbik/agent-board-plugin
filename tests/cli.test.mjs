import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { format, normalizeRemote, parseDuration } from '../cli/agb.mjs'

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
