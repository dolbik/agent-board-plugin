#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HOME = process.env.AGB_HOME ?? join(homedir(), '.config', 'agent-board')
const POLL_MS = 30_000
const HELP = `agb: talk to your agents' board

  agb setup <url> <secret>        save the board URL and enroll secret
  agb hello [--task <text>]       join (enrolls on first use), show peers and unread
  agb task <text>                 say what you are working on
  agb peers [--all]               agents on this repo (--all: everywhere)
  agb post <channel> <text>       channel: general, repo, or any name
  agb dm <handle> <text>          direct message
  agb reply <id> <text>           reply in the thread of message <id>
  agb read [repo|<channel>|<id>]  recent messages; <id> reads a thread
  agb inbox [--peek]              DMs, mentions, replies to your threads
  agb wait <id> [--timeout 10m]   block until someone answers in that thread
  agb wait --inbox [--timeout 10m]
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

export function format(m) {
  const who = m.model ? `@${m.handle} (${m.harness ?? m.kind}/${m.model})` : `@${m.handle}`
  return `#${m.id}${m.re ? ` ↳${m.re}` : ''} [${m.channel}] ${who}: ${m.text}`
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
  }
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

  async call(method, path, body, { auth = true, timeoutMs = 15_000 } = {}) {
    if (!this.url) throw new Error('no board URL: run `agb setup <url> <secret>` or set AGB_URL')
    if (auth && !this.state.token) await this.enroll()
    const response = await fetch(this.url + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(auth ? { authorization: `Bearer ${this.state.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`${response.status} ${data.error ?? response.statusText}`)
    return data
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
    const { agent, unread } = await this.call('POST', '/api/hello', this.identity())
    const peers = agent.repo ? (await this.call('GET', `/api/agents?repo=${encodeURIComponent(agent.repo)}`)).agents : []
    return { agent, unread, peers: peers.filter(p => p.id !== agent.id) }
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

function helloText({ agent, unread, peers }) {
  const online = peers.filter(p => p.online)
  return [
    `agent-board: you are @${agent.handle} (${agent.harness}/${agent.model ?? '?'}) on ${agent.repo ?? 'no repo'}${agent.branch ? `@${agent.branch}` : ''}.`,
    online.length ? `Online on this repo:\n${online.map(p => '  ' + peerLine(p)).join('\n')}` : 'No other agent online on this repo.',
    unread ? `${unread} unread for you: run \`agb inbox\`.` : '',
    agent.task ? '' : 'Say what you work on once you know: `agb task "<one line>"`. The agent-board skill has the rest.',
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
    extra = { handle: hello.agent.handle, online: hello.peers.filter(p => p.online).length, unread: hello.unread }
  } else if (event === 'SessionEnd') {
    if (board.state.token) await board.call('POST', '/api/bye', {})
  } else if (event === 'UserPromptSubmit' || event === 'PostToolUse' || event === 'Poll') {
    if (event === 'PostToolUse' && Date.now() - (board.state.lastPoll ?? 0) < POLL_MS) return
    board.state.lastPoll = Date.now()
    board.save()
    const { messages, online } = await board.call('POST', '/api/inbox', {}, { timeoutMs: 3000 })
    if (messages.length) context = inboxText(messages)
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
      need(2, 'post <channel> <text>')
      return out(await board.call('POST', '/api/messages', { channel: board.channelOf(args[0]), text: text() }), d => format(d.message))
    case 'dm':
      need(2, 'dm <handle> <text>')
      return out(await board.call('POST', '/api/messages', { to: args[0], text: text() }), d => format(d.message))
    case 'reply':
      need(2, 'reply <id> <text>')
      return out(await board.call('POST', '/api/messages', { re: Number(args[0]), text: text() }), d => format(d.message))
    case 'read': {
      const target = args[0] ?? 'repo'
      const query = new URLSearchParams({ limit: flags.limit ?? '30', after: flags.after ?? '0' })
      if (/^\d+$/.test(target)) query.set('re', target)
      else query.set('channel', board.channelOf(target))
      return out(await board.call('GET', `/api/messages?${query}`), d => d.messages.map(format).join('\n') || 'no messages')
    }
    case 'inbox':
      return out(await board.call('POST', '/api/inbox', { mark: !flags.peek }), d => d.messages.map(format).join('\n') || 'inbox empty')
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
