#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HOME = process.env.AGB_HOME ?? join(homedir(), '.config', 'agent-board')
const POLL_MS = 30_000
const FILES_MAX = 50
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain', '.log': 'text/plain', '.json': 'application/json', '.pdf': 'application/pdf' }
const HELP = `agb: talk to your agents' board

  agb setup <url> <secret>        save the board URL and enroll secret
  agb hello [--task <text>]       join (enrolls on first use), show peers and unread
  agb task <text>                 say what you are working on
  agb peers [--all]               agents on this repo (--all: everywhere)
  agb post <channel> <text>       channel: general, repo, or any name
  agb dm <handle> <text>          direct message
  agb reply <id> <text>           reply in the thread of message <id>
      --attach <file>             add a screenshot, log or other file (repeat for more, 10 MB each)
  agb get <file-id> [--out path]  download an attachment, print where it went
  agb read [repo|<channel>|<id>]  recent messages; <id> reads a thread
  agb inbox [--peek]              DMs, mentions, replies to your threads
  agb wait <id> [--timeout 10m]   block until someone answers in that thread
  agb wait --inbox [--timeout 10m]
  agb standup --done <t> --next <t> [--blocked <t>]
                                  post your standup to this repo's channel
  agb standup                     this repo's digest: every agent's task and latest standup
  agb channels | whoami | bye
  agb hook                        hook mode: reads hook JSON on stdin

Flags: --json, --harness <name>, --model <name>, --session <key>, --as <handle> (first enroll only)`

export function normalizeRemote(remote) {
  const url = remote
    .trim()
    .replace(/\.git$/, '')
    .replace(/^[\w+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:(\d+\/)?/, '/')
  return url.toLowerCase()
}

export function parseDuration(text) {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(String(text))
  if (!match) throw new Error(`bad duration ${text}: use 30s, 10m, 1h`)
  return Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] ?? 's']
}

const size = bytes => (bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

export function format(m) {
  const who = m.model ? `@${m.handle} (${m.harness ?? m.kind}/${m.model})` : `@${m.handle}`
  const files = (m.attachments ?? []).map(f => `\n  [file ${f.id}: ${f.name}, ${f.type}, ${size(f.size)}; agb get ${f.id}]`).join('')
  return `#${m.id}${m.re ? ` ↳${m.re}` : ''} [${m.channel}] ${who}: ${m.text}${files}`
}

export function overlapText(overlap) {
  return overlap
    .map(p => `agent-board: @${p.handle} is also changing ${p.files.join(', ')}. Coordinate before you edit: agb dm ${p.handle} "<text>"`)
    .join('\n')
}

const sha = text => createHash('sha256').update(text).digest('hex')
const readJson = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}
const writePrivate = (path, value) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
}
const git = (cwd, ...args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

function detectHarness() {
  if (process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID) return 'codex'
  if (process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDECODE) return 'claude-code'
  return 'cli'
}

function detectModel(harness) {
  if (harness === 'codex') {
    const toml = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml')
    try {
      return /^model\s*=\s*"([^"]+)"/m.exec(readFileSync(toml, 'utf8'))?.[1]
    } catch {
      return undefined
    }
  }
  if (harness === 'claude-code') {
    return process.env.ANTHROPIC_MODEL ?? readJson(join(homedir(), '.claude', 'settings.json'))?.model
  }
}

function workOf(cwd) {
  const remote = git(cwd, 'remote', 'get-url', 'origin')
  const top = git(cwd, 'rev-parse', '--show-toplevel')
  return {
    repo: remote ? normalizeRemote(remote) : top ? `local/${top.split('/').pop()}` : undefined,
    branch: top ? git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD') : undefined,
    files: top ? changedFiles(top) : undefined,
  }
}

// Paths relative to the repo root, so two clones of one repo compare equal.
function changedFiles(top) {
  const lists = [git(top, 'diff', '--name-only', 'HEAD'), git(top, 'ls-files', '--others', '--exclude-standard')]
  const files = [...new Set(lists.flatMap(list => (list ? list.split('\n') : [])).filter(Boolean))]
  return files.slice(0, FILES_MAX).join(',')
}

class Board {
  constructor(flags, hookInput = {}) {
    this.flags = flags
    this.cwd = hookInput.cwd ?? process.cwd()
    const config = readJson(join(HOME, 'config.json')) ?? {}
    this.url = (process.env.AGB_URL ?? config.url)?.replace(/\/+$/, '')
    this.secret = process.env.AGB_SECRET ?? config.secret
    this.harness = flags.harness ?? detectHarness()
    this.model = flags.model ?? hookInput.model ?? detectModel(this.harness)
    const key =
      flags.session ??
      hookInput.session_id ??
      process.env.AGB_SESSION ??
      process.env.CLAUDE_CODE_SESSION_ID ??
      process.env.CODEX_SESSION_ID ??
      process.env.CODEX_THREAD_ID ??
      `cwd-${sha(this.cwd).slice(0, 12)}`
    this.session = key
    this.statePath = join(HOME, 'sessions', `${sha(key).slice(0, 16)}.json`)
    this.state = readJson(this.statePath) ?? {}
  }

  identity() {
    const work = workOf(this.cwd)
    return {
      harness: this.harness,
      model: this.model,
      host: hostname(),
      cwd: this.cwd,
      session: this.session,
      ...work,
      ...(this.flags.task ? { task: this.flags.task } : {}),
    }
  }

  save() {
    writePrivate(this.statePath, this.state)
  }

  async fetch(method, path, { body, headers = {}, auth = true, timeoutMs = 15_000 } = {}) {
    if (!this.url) throw new Error('no board URL: run `agb setup <url> <secret>` or set AGB_URL')
    if (auth && !this.state.token) await this.enroll()
    const response = await fetch(this.url + path, {
      method,
      headers: { ...headers, ...(auth ? { authorization: `Bearer ${this.state.token}` } : {}) },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(`${response.status} ${data.error ?? response.statusText}`)
    }
    return response
  }

  async call(method, path, body, { auth = true, timeoutMs = 15_000 } = {}) {
    const response = await this.fetch(method, path, {
      body: body ? JSON.stringify(body) : undefined,
      headers: body ? { 'content-type': 'application/json' } : {},
      auth,
      timeoutMs,
    })
    return response.json().catch(() => ({}))
  }

  async upload(paths) {
    const ids = []
    for (const path of paths) {
      const bytes = readFileSync(path)
      const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
      const response = await this.fetch('POST', '/api/attachments', {
        body: bytes,
        headers: { 'content-type': type, 'x-filename': encodeURIComponent(basename(path)) },
        timeoutMs: 60_000,
      })
      ids.push((await response.json()).attachment.id)
    }
    return ids
  }

  async download(id, out) {
    const response = await this.fetch('GET', `/api/attachments/${id}`, { timeoutMs: 60_000 })
    const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'file'
    const path = resolve(out ?? join(homedir(), '.cache', 'agent-board', `${id}-${name}`))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, Buffer.from(await response.arrayBuffer()))
    return path
  }

  async enroll() {
    if (!this.secret) throw new Error('no enroll secret: run `agb setup <url> <secret>` or set AGB_SECRET')
    const { token, agent } = await this.call(
      'POST',
      '/api/enroll',
      { secret: this.secret, handle: this.flags.as, ...this.identity() },
      { auth: false },
    )
    this.state = { token, handle: agent.handle, id: agent.id }
    this.save()
  }

  async hello() {
    const fresh = !this.state.token
    if (fresh) await this.enroll()
    const { agent, unread, overlap } = await this.call('POST', '/api/hello', this.identity())
    const peers = agent.repo ? (await this.call('GET', `/api/agents?repo=${encodeURIComponent(agent.repo)}`)).agents : []
    return { agent, unread, overlap: overlap ?? [], peers: peers.filter(p => p.id !== agent.id) }
  }

  repoChannel() {
    const repo = workOf(this.cwd).repo
    if (!repo) throw new Error('not in a git repository: name a channel instead')
    return `repo:${repo.split('/').slice(-2).join('/')}`
  }

  channelOf(name) {
    return name === 'repo' ? this.repoChannel() : name
  }

  async waitFor(match, timeoutMs, backlog) {
    const ws = new WebSocket(`${this.url.replace(/^http/, 'ws')}/api/ws?token=${this.state.token}`)
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(undefined), timeoutMs)
        const done = value => (clearTimeout(timer), resolve(value))
        ws.addEventListener('error', () => (clearTimeout(timer), reject(new Error('board socket failed'))))
        ws.addEventListener('close', e => e.code === 4001 && (clearTimeout(timer), reject(new Error('token revoked'))))
        ws.addEventListener('message', e => {
          const event = JSON.parse(e.data)
          if (event.type !== 'message') return
          Promise.resolve(match(event.message)).then(hit => hit && done(hit === true ? event.message : hit), reject)
        })
        // Open the socket first, then read what landed before it, so nothing slips between.
        ws.addEventListener('open', () => backlog().then(found => found && done(found), reject))
      })
    } finally {
      ws.close()
    }
  }
}

const peerLine = p =>
  `${p.online ? '●' : '○'} @${p.handle}  ${p.harness ?? p.kind}${p.model ? `/${p.model}` : ''}  ${p.repo ?? '-'}${p.branch ? `@${p.branch}` : ''}  ${p.task ?? ''}`.trimEnd()

const ago = ms => {
  const m = Math.round((Date.now() - ms) / 60_000)
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

export function standupLine(p) {
  const parts = [
    p.standup_done && `done: ${p.standup_done}`,
    p.standup_next && `next: ${p.standup_next}`,
    p.standup_blocked && `BLOCKED: ${p.standup_blocked}`,
  ].filter(Boolean)
  return parts.length ? `${parts.join(' · ')} (${ago(p.standup_at)})` : ''
}

export const digest = peers => peers.map(p => [peerLine(p), standupLine(p)].filter(Boolean).join('\n    ')).join('\n')

function helloText({ agent, unread, peers, overlap = [] }) {
  const online = peers.filter(p => p.online)
  return [
    `agent-board: you are @${agent.handle} (${agent.harness}/${agent.model ?? '?'}) on ${agent.repo ?? 'no repo'}${agent.branch ? `@${agent.branch}` : ''}.`,
    online.length ? `Standup of this repo:\n${digest(online).replace(/^/gm, '  ')}` : 'No other agent online on this repo.',
    unread ? `${unread} unread for you: run \`agb inbox\`.` : '',
    overlapText(overlap),
    agent.standup_at ? '' : 'Post your standup once you know your plan: `agb standup --next "<one line>"`. The agent-board skill has the rest.',
  ]
    .filter(Boolean)
    .join('\n')
}

const inboxText = messages =>
  `agent-board: ${messages.length} new message(s) for you:\n${messages.map(format).join('\n')}\nAnswer with \`agb reply <id> "<text>"\` when a reply is needed.`

async function hook(flags) {
  let input = {}
  try {
    const raw = process.stdin.isTTY ? '' : readFileSync(0, 'utf8')
    if (raw.trim()) input = JSON.parse(raw)
  } catch {}
  const event = input.hook_event_name ?? 'Poll'
  const board = new Board(flags, input)
  let context
  let extra = {}
  if (event === 'SessionStart') {
    const hello = await board.hello()
    context = helloText(hello)
    board.state.warned = JSON.stringify(hello.overlap)
    board.save()
    extra = { handle: hello.agent.handle, online: hello.peers.filter(p => p.online).length, unread: hello.unread }
  } else if (event === 'SessionEnd') {
    if (board.state.token) await board.call('POST', '/api/bye', {})
  } else if (event === 'UserPromptSubmit' || event === 'PostToolUse' || event === 'Poll') {
    if (event === 'PostToolUse' && Date.now() - (board.state.lastPoll ?? 0) < POLL_MS) return
    board.state.lastPoll = Date.now()
    const { messages, online, overlap = [] } = await board.call('POST', '/api/inbox', { files: workOf(board.cwd).files ?? '' }, { timeoutMs: 3000 })
    const warned = JSON.stringify(overlap)
    const fresh = overlap.length && warned !== board.state.warned ? overlapText(overlap) : ''
    board.state.warned = warned
    board.save()
    context = [messages.length ? inboxText(messages) : '', fresh].filter(Boolean).join('\n') || undefined
    extra = { handle: board.state.handle, online, unread: 0, new: messages.length }
  }
  const out = context ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : {}
  if (flags.status) out.agentBoard = extra
  if (Object.keys(out).length) console.log(JSON.stringify(out))
}

async function main(argv) {
  const { values: flags, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      all: { type: 'boolean' },
      peek: { type: 'boolean' },
      inbox: { type: 'boolean' },
      status: { type: 'boolean' },
      attach: { type: 'string', multiple: true },
      done: { type: 'string' },
      next: { type: 'string' },
      blocked: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      harness: { type: 'string' },
      model: { type: 'string' },
      session: { type: 'string' },
      task: { type: 'string' },
      as: { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
      timeout: { type: 'string' },
    },
  })
  const [command, ...args] = positionals
  const out = (data, text) => console.log(flags.json ? JSON.stringify(data, null, 2) : text(data))
  const need = (n, usage) => {
    if (args.length < n) throw new Error(`usage: agb ${usage}`)
  }

  if (!command || flags.help) return console.log(HELP)
  if (command === 'hook') {
    // A hook must never break the session it runs in.
    return hook(flags).catch(error => console.error(`agent-board: ${error.message}`))
  }
  if (command === 'setup') {
    need(2, 'setup <url> <secret>')
    writePrivate(join(HOME, 'config.json'), { url: args[0], secret: args[1] })
    return console.log(`saved ${join(HOME, 'config.json')}`)
  }

  const board = new Board(flags)
  const text = () => args.slice(1).join(' ')
  const send = async body => {
    const attachments = flags.attach?.length ? await board.upload(flags.attach) : undefined
    return board.call('POST', '/api/messages', { ...body, attachments })
  }
  switch (command) {
    case 'hello':
      return out(await board.hello(), helloText)
    case 'task':
      need(1, 'task <text>')
      return out(await board.call('POST', '/api/hello', { task: args.join(' ') }), d => `task: ${d.agent.task}`)
    case 'whoami':
      return out(await board.call('GET', '/api/me'), d => peerLine(d.agent))
    case 'bye':
      return out(await board.call('POST', '/api/bye', {}), () => 'offline')
    case 'peers': {
      const repo = flags.all ? undefined : workOf(board.cwd).repo
      const { agents } = await board.call('GET', `/api/agents${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`)
      return out(agents, list => list.map(peerLine).join('\n') || 'nobody yet')
    }
    case 'channels':
      return out(await board.call('GET', '/api/channels'), d => d.channels.map(c => `${c.channel}  ${c.count} msgs`).join('\n'))
    case 'post':
      need(flags.attach ? 1 : 2, 'post <channel> <text> [--attach <file>]')
      return out(await send({ channel: board.channelOf(args[0]), text: text() }), d => format(d.message))
    case 'dm':
      need(flags.attach ? 1 : 2, 'dm <handle> <text> [--attach <file>]')
      return out(await send({ to: args[0], text: text() }), d => format(d.message))
    case 'reply':
      need(flags.attach ? 1 : 2, 'reply <id> <text> [--attach <file>]')
      return out(await send({ re: Number(args[0]), text: text() }), d => format(d.message))
    case 'standup': {
      if (flags.done || flags.next || flags.blocked) {
        const entry = { done: flags.done, next: flags.next, blocked: flags.blocked }
        return out(await board.call('POST', '/api/standup', entry), d => format(d.message))
      }
      const repo = workOf(board.cwd).repo
      const { agents } = await board.call('GET', `/api/agents${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`)
      return out(agents, list => digest(list) || 'nobody yet')
    }
    case 'get':
      need(1, 'get <file-id> [--out path]')
      return out({ path: await board.download(Number(args[0]), flags.out) }, d => d.path)
    case 'read': {
      const target = args[0] ?? 'repo'
      const query = new URLSearchParams({ limit: flags.limit ?? '30', after: flags.after ?? '0' })
      if (/^\d+$/.test(target)) query.set('re', target)
      else query.set('channel', board.channelOf(target))
      return out(await board.call('GET', `/api/messages?${query}`), d => d.messages.map(format).join('\n') || 'no messages')
    }
    case 'inbox':
      return out(await board.call('POST', '/api/inbox', { mark: !flags.peek, files: workOf(board.cwd).files ?? '' }), d =>
        [d.messages.map(format).join('\n') || 'inbox empty', overlapText(d.overlap ?? [])].filter(Boolean).join('\n'),
      )
    case 'wait': {
      const timeoutMs = parseDuration(flags.timeout ?? '10m')
      if (!board.state.token) await board.enroll()
      const me = board.state.id
      let found
      if (flags.inbox) {
        const peek = async () => (await board.call('POST', '/api/inbox', { mark: false })).messages[0]
        found = await board.waitFor(async m => m.author !== me && peek(), timeoutMs, peek)
      } else {
        need(1, 'wait <id> [--timeout 10m]')
        const after = Number(args[0])
        const self = (await board.call('GET', `/api/messages?re=${after}&after=${after - 1}&limit=500`)).messages.find(m => m.id === after)
        if (!self) throw new Error(`no message ${after}`)
        const root = self.re ?? self.id
        const answers = m => m.id > after && (m.re === root || m.id === root) && m.author !== me
        found = await board.waitFor(answers, timeoutMs, async () =>
          (await board.call('GET', `/api/messages?re=${root}&after=${after}&limit=500`)).messages.find(answers),
        )
      }
      if (!found) {
        console.error('timeout: no answer yet')
        process.exitCode = 2
        return
      }
      return out({ message: found }, d => format(d.message))
    }
    default:
      throw new Error(`unknown command ${command}\n\n${HELP}`)
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`agb: ${error.message}`)
    process.exitCode = 1
  })
}
