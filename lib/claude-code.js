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

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

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
        // Read up to first 8 KB and inspect the head — first JSONL line
        // typically has a {"cwd":...,"summary":...} init record.
        const fd = fs.openSync(filePath, 'r')
        try {
          const buf = Buffer.alloc(Math.min(8192, size))
          const n = fs.readSync(fd, buf, 0, buf.length, 0)
          const head = buf.subarray(0, n).toString('utf8')
          for (const line of head.split('\n')) {
            if (!line.trim()) continue
            try {
              const parsed = JSON.parse(line)
              if (typeof parsed.cwd === 'string' && !cwd) cwd = parsed.cwd
              if (typeof parsed.summary === 'string' && !summary) summary = parsed.summary
              if (cwd && summary) break
            } catch {
              // Skip malformed line; keep scanning.
            }
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
  }
  if (sessionId) options.resume = sessionId
  if (cwd) options.cwd = cwd

  const q = sdk.query({ prompt, options })

  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      onEvent({ kind: 'system', sessionId: msg.session_id })
      continue
    }
    if (msg.type === 'assistant') {
      const blocks = (msg.message && msg.message.content) || []
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          onEvent({ kind: 'text', delta: block.text })
        } else if (block.type === 'tool_use') {
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
  isReadOnlyTool,
  isInstalled,
  listSessions,
  streamClaudeCode,
}
