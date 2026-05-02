'use strict'

// Claude Code (Anthropic Agent SDK) wrapper.
//
// The SDK ships ESM-only; this server is CJS, so all SDK imports go
// through the loadSdk() lazy `import()` so cold-start cost only hits
// when the user actually invokes a CC turn. Same trick for zod (used
// to declare the prompt_user_choice tool's input schema).
//
// Public surface:
//
//   listSessions()             — scan ~/.claude/projects for resumable sessions
//   isInstalled()              — does the local SDK + node_modules look healthy?
//   isReadOnlyTool(name)       — permission policy: read-only auto-allows
//   streamClaudeCode(opts)     — drive a turn end-to-end, fanning events out
//                                via opts.onEvent + bridging permission/choice
//                                back through opts.askPermission/askChoice
//
// streamClaudeCode normalizes the SDK's verbose message stream down to
// a tight set of events the WS layer in index.js relays straight to the
// phone:
//
//   {kind:'system',      sessionId}
//   {kind:'text',        delta}
//   {kind:'tool-use',    toolName, input, toolUseId}
//   {kind:'tool-result', toolUseId, result}
//   {kind:'error',       error}
//   {kind:'done',        sessionId}
//
// Permission and choice handlers are async — they post a request frame
// to the phone and wait for the response frame before resolving.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

// Resolve the Claude Code CLI binary the SDK should drive. The SDK's
// own auto-detection picks one of its bundled platform-specific
// binaries (claude-agent-sdk-linux-x64, -linux-x64-musl, -darwin-x64,
// etc.) but the libc heuristic misfires on some glibc distros — it
// picks the musl binary which then errors out because no musl runtime
// is installed. Side-stepping the auto-detect: we point the SDK at
// the user's existing `claude` CLI (the one they used to authenticate)
// via options.pathToClaudeCodeExecutable.
//
// Resolution order:
//   1. NUTSHELL_CLAUDE_PATH env var (explicit override)
//   2. `which claude` (PATH lookup) — works on macOS/Linux
//   3. null — caller falls back to SDK's own auto-detect
//
// Cached for the process lifetime; bounce the server if claude moves.
let resolvedClaudePath = undefined
function resolveClaudePath() {
  if (resolvedClaudePath !== undefined) return resolvedClaudePath
  const override = process.env.NUTSHELL_CLAUDE_PATH
  if (override && fs.existsSync(override)) {
    console.log(`[claude-code] using NUTSHELL_CLAUDE_PATH override: ${override}`)
    resolvedClaudePath = override
    return resolvedClaudePath
  }
  try {
    const out = execFileSync('which', ['claude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out && fs.existsSync(out)) {
      console.log(`[claude-code] resolved claude binary via which: ${out}`)
      resolvedClaudePath = out
      return resolvedClaudePath
    }
  } catch {
    // `which` not present, or claude not on PATH. Fall through.
  }
  console.warn('[claude-code] could not resolve claude CLI binary; SDK will fall back to its own auto-detect (may pick the wrong platform package on Debian/glibc systems)')
  resolvedClaudePath = null
  return resolvedClaudePath
}

// Read-only tools that auto-allow without prompting the user. Anything
// not in this set goes through askPermission. Conservative — when in
// doubt, ask.
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
])

function isReadOnlyTool(toolName) {
  return READ_ONLY_TOOLS.has(toolName)
}

// Lazy loaders — ESM-only deps, only paid at first use.
let sdkPromise = null
function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import('@anthropic-ai/claude-agent-sdk').catch((err) => {
      sdkPromise = null
      throw err
    })
  }
  return sdkPromise
}

// `isInstalled()` does a soft probe — require resolution succeeds means
// the package is on disk. We don't actually invoke the SDK here; that
// happens on first `streamClaudeCode`. Used by /claude-code/status.
function isInstalled() {
  try {
    require.resolve('@anthropic-ai/claude-agent-sdk')
    require.resolve('zod')
    return true
  } catch {
    return false
  }
}

// Scan ~/.claude/projects for resumable sessions. Each file at
// <project-hash>/<session-id>.jsonl is a session; first line carries
// metadata (cwd, summary). Returns newest-first.
function listSessions() {
  if (!fs.existsSync(PROJECTS_DIR)) return []
  const out = []
  let projectDirs
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR)
  } catch {
    return []
  }
  for (const projectDir of projectDirs) {
    const dir = path.join(PROJECTS_DIR, projectDir)
    let stat
    try {
      stat = fs.statSync(dir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    let files
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const sessionId = file.slice(0, -'.jsonl'.length)
      const filePath = path.join(dir, file)
      let mtime = 0
      let size = 0
      let cwd = ''
      let summary = ''
      try {
        const fstat = fs.statSync(filePath)
        mtime = Math.floor(fstat.mtimeMs)
        size = fstat.size
        // Read up to first 32 KB and inspect the head. Pre-summary
        // sessions (the SDK writes a `summary` record only after a
        // compaction step) have no summary on the first line — we
        // fall back to the first user message's text, truncated, so
        // the picker shows something useful instead of "(no summary)".
        // 32 KB is enough for the cwd record + at least one user
        // message in nearly every session we've seen.
        const fd = fs.openSync(filePath, 'r')
        try {
          const buf = Buffer.alloc(Math.min(32768, size))
          const n = fs.readSync(fd, buf, 0, buf.length, 0)
          const head = buf.subarray(0, n).toString('utf8')
          let firstUserText = ''
          for (const line of head.split('\n')) {
            if (!line.trim()) continue
            try {
              const parsed = JSON.parse(line)
              if (typeof parsed.cwd === 'string' && !cwd) cwd = parsed.cwd
              if (typeof parsed.summary === 'string' && !summary) summary = parsed.summary
              if (!firstUserText && parsed.type === 'user' && parsed.message) {
                const content = parsed.message.content
                if (typeof content === 'string') {
                  firstUserText = content
                } else if (Array.isArray(content)) {
                  for (const block of content) {
                    if (block && block.type === 'text' && typeof block.text === 'string') {
                      firstUserText = block.text
                      break
                    }
                  }
                }
              }
              if (cwd && summary) break
            } catch {
              // Skip malformed line; keep scanning.
            }
          }
          if (!summary && firstUserText) {
            // Truncate to ~80 chars and strip newlines so the picker
            // row stays single-line. Phone-side picker further clamps
            // to its own row width.
            summary = firstUserText.replace(/\s+/g, ' ').trim()
            if (summary.length > 80) summary = `${summary.slice(0, 79)}…`
          }
        } finally {
          fs.closeSync(fd)
        }
      } catch {
        // File unreadable — skip.
        continue
      }
      out.push({ sessionId, cwd, summary, mtime, size })
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

// Read the full transcript of an on-disk session and collapse it into
// Turn-shaped {prompt, reply, createdAt, toolEvents} pairs the phone
// can drop straight into Session.turns. Used by the chat detail pane
// on first open of a resumed session so the user sees the existing
// history rather than an empty pane.
//
// Pairing logic (best-effort — the .jsonl's structure is loose):
//   - A `type: 'user'` record whose content is a plain string OR
//     contains a text block (and no tool_result block) opens a new
//     turn. Pure tool_result user messages are skipped — they're
//     internal to the SDK's tool round-trip, not user prompts.
//   - All `type: 'assistant'` text blocks that follow accumulate into
//     the open turn's reply (split across multiple assistant messages
//     when tools fire mid-turn).
//   - tool_use blocks become entries in toolEvents; tool_result
//     blocks pair to them by toolUseId. Both types fold into the
//     current turn's tool stream.
//   - `type: 'result'` closes the current turn.
//
// Returns [] when the file doesn't exist or fails to parse.
function readSessionTurns(sessionId) {
  if (!fs.existsSync(PROJECTS_DIR)) return []
  let projectDirs
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR)
  } catch {
    return []
  }
  let filePath = null
  for (const projectDir of projectDirs) {
    const candidate = path.join(PROJECTS_DIR, projectDir, `${sessionId}.jsonl`)
    if (fs.existsSync(candidate)) {
      filePath = candidate
      break
    }
  }
  if (!filePath) return []
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  const turns = []
  let current = null
  const closeCurrent = () => {
    if (current) {
      turns.push(current)
      current = null
    }
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (!rec || typeof rec !== 'object') continue
    const ts = typeof rec.timestamp === 'string'
      ? Date.parse(rec.timestamp)
      : (typeof rec.timestamp === 'number' ? rec.timestamp : 0)
    if (rec.type === 'user' && rec.message && typeof rec.message === 'object') {
      const content = rec.message.content
      let promptText = ''
      let isToolResultOnly = false
      if (typeof content === 'string') {
        promptText = content
      } else if (Array.isArray(content)) {
        const textBlocks = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        const toolResultBlocks = content.filter((b) => b && b.type === 'tool_result')
        if (textBlocks.length === 0 && toolResultBlocks.length > 0) {
          isToolResultOnly = true
          // Fold tool_result blocks onto the current turn's tool stream.
          if (current) {
            for (const tr of toolResultBlocks) {
              let result = ''
              if (typeof tr.content === 'string') {
                result = tr.content
              } else if (Array.isArray(tr.content)) {
                result = tr.content
                  .map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
                  .filter(Boolean)
                  .join('\n')
              }
              current.toolEvents.push({
                kind: 'tool-result',
                toolUseId: tr.tool_use_id || '',
                result,
              })
            }
          }
        } else {
          promptText = textBlocks.map((b) => b.text).join('\n')
        }
      }
      if (isToolResultOnly) continue
      // New user prompt — close the previous turn and open a new one.
      closeCurrent()
      current = {
        id: rec.uuid || `turn-imported-${ts || Date.now()}-${turns.length}`,
        prompt: promptText,
        reply: '',
        createdAt: ts || Date.now(),
        toolEvents: [],
      }
      continue
    }
    if (rec.type === 'assistant' && rec.message && Array.isArray(rec.message.content)) {
      if (!current) continue
      for (const block of rec.message.content) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string') {
          current.reply = current.reply
            ? `${current.reply}${block.text}`
            : block.text
        } else if (block.type === 'tool_use') {
          current.toolEvents.push({
            kind: 'tool-use',
            toolUseId: block.id || '',
            toolName: block.name || '',
            input: block.input,
          })
        }
      }
      continue
    }
    if (rec.type === 'result') {
      closeCurrent()
      continue
    }
  }
  closeCurrent()
  return turns
}

// Drive a single CC turn. Streams events via onEvent; awaits user
// responses via askPermission / askChoice. Resumes a previous session
// when sessionId is set; otherwise starts fresh.
//
// Throws on transport / SDK errors. Caller wraps in try/catch and emits
// {kind:'error'} accordingly.
async function streamClaudeCode({
  sessionId,
  prompt,
  cwd,
  askPermission,
  askChoice,
  onEvent,
  // Caller-supplied addendum to Claude Code's built-in system prompt.
  // Used by the phone to constrain output formatting (no markdown / no
  // code fences / etc.) without losing the SDK's default agent-mode
  // intelligence. Pass-through to options.appendSystemPrompt; ignored
  // when empty.
  appendSystemPrompt,
}) {
  const sdk = await loadSdk()
  const { z } = await import('zod')

  // Custom MCP server registers a single `prompt_user_choice` tool
  // Claude can call when it needs the user to pick from N options.
  // The handler bridges to askChoice(), which posts a request frame
  // to the phone and resolves with the user's pick.
  const choiceServer = sdk.createSdkMcpServer({
    name: 'nutshell-choice',
    version: '0.1.0',
    tools: [
      sdk.tool(
        'prompt_user_choice',
        'Ask the user to pick exactly one of N options. Use this when the response should branch on a user decision and a free-text reply would be ambiguous. Return the user\'s selection as the function result.',
        {
          question: z.string().describe('The question shown to the user.'),
          options: z
            .array(z.string())
            .min(2)
            .describe('Selectable options. Each is shown as a button-like row.'),
        },
        async ({ question, options }) => {
          const choice = await askChoice(question, options)
          return {
            content: [{ type: 'text', text: choice }],
          }
        },
      ),
    ],
  })

  // canUseTool fires for every tool BEFORE Claude executes it. Read-
  // only tools auto-allow; everything else routes to askPermission,
  // which posts a request frame to the phone and resolves once the
  // user picks allow / deny / always-allow.
  const canUseTool = async (toolName, input) => {
    if (isReadOnlyTool(toolName)) {
      return { behavior: 'allow' }
    }
    let decision
    try {
      decision = await askPermission(toolName, input)
    } catch (err) {
      const message = err && err.message ? err.message : String(err)
      return { behavior: 'deny', message: `permission request failed: ${message}` }
    }
    if (decision === 'allow') {
      return { behavior: 'allow' }
    }
    if (decision === 'always-allow') {
      return {
        behavior: 'allow',
        updatedPermissions: [
          {
            type: 'addRules',
            destination: 'session',
            behavior: 'allow',
            rules: [{ toolName }],
          },
        ],
      }
    }
    return { behavior: 'deny', message: 'User denied' }
  }

  const options = {
    canUseTool,
    mcpServers: { 'nutshell-choice': choiceServer },
    // Enable token-level streaming so the phone can render text as
    // it arrives instead of waiting for the assistant message to
    // complete. The SDK emits `stream_event` records carrying
    // Anthropic's raw streaming format; we translate
    // content_block_delta text_delta events into our wire-level
    // `cc-text` deltas. Without this, the SDK only delivers the
    // assistant message once with the whole text block — the phone
    // sees one big chunk land at done time, which feels like async
    // mode whether or not the user wants it.
    includePartialMessages: true,
  }
  if (sessionId) options.resume = sessionId
  if (cwd) options.cwd = cwd
  if (typeof appendSystemPrompt === 'string' && appendSystemPrompt.trim()) {
    options.appendSystemPrompt = appendSystemPrompt
  }
  const claudePath = resolveClaudePath()
  if (claudePath) options.pathToClaudeCodeExecutable = claudePath

  const q = sdk.query({ prompt, options })

  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      onEvent({ kind: 'system', sessionId: msg.session_id })
      continue
    }
    // Token-level streaming via includePartialMessages. The SDK emits
    // Anthropic's raw streaming events; we forward content_block_delta
    // text_deltas as `cc-text` events. The complete assistant message
    // arriving later carries the same text — we skip its text blocks
    // (see the assistant branch below) so the phone doesn't see it
    // twice.
    if (msg.type === 'stream_event' && msg.event) {
      const evt = msg.event
      if (
        evt.type === 'content_block_delta' &&
        evt.delta &&
        evt.delta.type === 'text_delta' &&
        typeof evt.delta.text === 'string'
      ) {
        onEvent({ kind: 'text', delta: evt.delta.text })
      }
      continue
    }
    if (msg.type === 'assistant') {
      const blocks = (msg.message && msg.message.content) || []
      for (const block of blocks) {
        if (block.type === 'text') {
          // Text already streamed via stream_event deltas above —
          // skip the complete-message version to avoid duplicating
          // the whole reply at done time.
          continue
        }
        if (block.type === 'tool_use') {
          onEvent({
            kind: 'tool-use',
            toolName: block.name,
            input: block.input,
            toolUseId: block.id,
          })
        }
      }
      continue
    }
    if (msg.type === 'user') {
      const blocks = (msg.message && msg.message.content) || []
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          // Result content can be a string or an array of content blocks.
          // Coerce to a string for the wire format; the phone is the only
          // place that needs to render it.
          let result = ''
          if (typeof block.content === 'string') {
            result = block.content
          } else if (Array.isArray(block.content)) {
            result = block.content
              .map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
              .filter(Boolean)
              .join('\n')
          }
          onEvent({ kind: 'tool-result', toolUseId: block.tool_use_id, result })
        }
      }
      continue
    }
    if (msg.type === 'result') {
      onEvent({ kind: 'done', sessionId: msg.session_id })
      break
    }
    // Other message types (status / hook / partial / compaction / etc.)
    // are ignored at the wire level for now. We can surface them later
    // if a use case shows up.
  }
}

module.exports = {
  resolveClaudePath,
  isReadOnlyTool,
  isInstalled,
  listSessions,
  readSessionTurns,
  streamClaudeCode,
}
