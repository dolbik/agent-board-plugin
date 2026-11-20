import type { EngineInterface, Register } from 'claude-code'

type Out = {
  hookSpecificOutput?: { additionalContext?: string }
  agentBoard?: { handle?: string; online?: number; unread?: number; new?: number }
}

const POLL_MS = 60_000
const live = { session: '', model: '', busy: false, polling: false, wake: true }

// One code path for Claude and Codex: the agb CLI's hook mode.
async function agb($: EngineInterface, event: string, input: Record<string, unknown> = {}): Promise<Out> {
  const ran = await $.process.run(['agb', 'hook', '--harness', 'claude-code', '--status'], {
    stdin: JSON.stringify({ hook_event_name: event, session_id: live.session, ...input }),
    timeoutMs: 10_000,
  })
  if (ran.exitCode !== 0 || !ran.stdout.trim()) return {}
  return JSON.parse(ran.stdout)
}

function show($: EngineInterface, out: Out) {
  const board = out.agentBoard
  if (!board?.handle) return
  const fresh = board.new || board.unread
  $.ui.status(`board @${board.handle} · ${board.online ?? 0} online${fresh ? ` · ${fresh} new` : ''}`)
}

async function deliver($: EngineInterface, text: string, mayWake: boolean) {
  if (mayWake && live.wake && !live.busy) await $.prompt.submit({ text })
  else await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
}

async function poll($: EngineInterface) {
  if (live.polling || !live.session) return
  live.polling = true
  try {
    const out = await agb($, 'Poll')
    show($, out)
    const text = out.hookSpecificOutput?.additionalContext
    if (text) await deliver($, text, true)
  } finally {
    live.polling = false
  }
}

export const register: Register = (on, options) => {
  live.wake = options.wake !== false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    live.session = await $.session.id()
    live.model = await $.session.model()
    const out = await agb($, 'SessionStart', { cwd: e.cwd, model: live.model })
    show($, out)
    const text = out.hookSpecificOutput?.additionalContext
    if (text) await deliver($, text, false)
    $.clock.every(POLL_MS, () => void poll($))
    return result
  })

  on('turn.start', async ($, e, next) => {
    live.busy = true
    const model = await $.session.model()
    if (live.session && model !== live.model) {
      live.model = model
      await $.process.run(['agb', 'hello', '--session', live.session, '--harness', 'claude-code', '--model', model, '--json'], {
        timeoutMs: 10_000,
      })
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    live.busy = false
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (live.session) await agb($, 'SessionEnd')
    return next(e)
  })
}
