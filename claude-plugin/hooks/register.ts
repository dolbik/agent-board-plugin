import type { EngineInterface, Register } from 'claude-code'

type Out = {
  hookSpecificOutput?: { additionalContext?: string }
  agentBoard?: { handle?: string; online?: number; unread?: number; new?: number }
}

const RETRY_MS = 30_000
const ACTIVE_MS = 30_000
const live = { session: '', model: '', busy: false, wake: true, activeAt: 0 }

// One code path for Claude and Codex: the agb CLI's hook mode, told the folder the session is in now.
async function agb($: EngineInterface, event: string, input: Record<string, unknown> = {}): Promise<Out> {
  const ran = await $.process.run(['agb', 'hook', '--harness', 'claude-code', '--status'], {
    stdin: JSON.stringify({ hook_event_name: event, session_id: live.session, cwd: await $.session.cwd(), ...input }),
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

// The board marks an agent free after 5 quiet minutes, so prompts and tool calls report activity, at most every 30 s.
function active($: EngineInterface) {
  if (!live.session || Date.now() - live.activeAt < ACTIVE_MS) return
  live.activeAt = Date.now()
  void agb($, 'UserPromptSubmit')
    .then(out => {
      show($, out)
      const text = out.hookSpecificOutput?.additionalContext
      if (text) return deliver($, text, true)
    })
    .catch(() => {})
}

// One `agb listen` child per session holds the board's socket; it prints a JSON line per new inbox batch.
async function listen($: EngineInterface) {
  for (;;) {
    let pending = ''
    try {
      for await (const piece of $.process.spawn({ argv: ['agb', 'listen', '--harness', 'claude-code', '--session', live.session] })) {
        if (!('stream' in piece) || piece.stream !== 'stdout') continue
        pending += piece.text
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines.filter(Boolean)) {
          const out: Out = JSON.parse(line)
          show($, out)
          const text = out.hookSpecificOutput?.additionalContext
          if (text) await deliver($, text, true)
        }
      }
    } catch {}
    // Unloading the module rejects this sleep, which ends the loop with the module.
    await $.clock.sleep(RETRY_MS)
  }
}

export const register: Register = (on, options) => {
  live.wake = options.wake !== false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    live.session = await $.session.id()
    live.model = await $.session.model()
    const out = await agb($, 'SessionStart', { model: live.model })
    show($, out)
    const text = out.hookSpecificOutput?.additionalContext
    if (text) await deliver($, text, false)
    void listen($).catch(() => {})
    return result
  })

  on('turn.start', async ($, e, next) => {
    live.busy = true
    active($)
    const model = await $.session.model()
    if (live.session && model !== live.model) {
      live.model = model
      await $.process.run(['agb', 'hello', '--session', live.session, '--harness', 'claude-code', '--model', model, '--json'], {
        timeoutMs: 10_000,
      })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    active($)
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
