'use strict'

const http = require('http')
const path = require('path')
const fs = require('fs')
const { WebSocketServer } = require('ws')

const { ensureKey } = require('./lib/auth')
const { encrypt, decrypt } = require('./lib/crypto')
const { scanFiles, readFile, folderId, extractTitleFromText } = require('./lib/files')
const { createWatcher } = require('./lib/watcher')
const notesStore = require('./lib/notes')
const {
  probeOllama,
  proxyChatCompletion,
  DEFAULT_URL: OLLAMA_DEFAULT_URL,
  DEFAULT_MODEL: OLLAMA_DEFAULT_MODEL,
  LIVE_PROBE_TIMEOUT_MS,
} = require('./lib/llm')

// ── Public library entry ──────────────────────────────────────────────────────
//
// const { createServer } = require('nutshell-server')
// const server = createServer({ port: 4242, name: 'My Project' })
// await server.start()
//
// Projects register at runtime via POST /projects/register. For one-off CLI
// use, pass `docsPath` and the server registers a "default" project at start.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const WS_HELLO_TIMEOUT_MS = 5_000
const DEFAULT_PROJECT_ID = 'default'

// Tiny log-formatting helpers used by the /llm progress lines.
function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function createServer(options = {}) {
  const port = options.port || 4242
  const initialDocsPath = options.docsPath ? path.resolve(options.docsPath) : null
  const name = options.name || 'Nutshell Server'
  const keyFilePath = options.keyFilePath || path.join(process.cwd(), '.nutshell-api-key')

  const ollama = options.ollama
    ? {
        enabled: true,
        url: options.ollama.url || OLLAMA_DEFAULT_URL,
        model: options.ollama.model || OLLAMA_DEFAULT_MODEL,
      }
    : { enabled: false }

  const { key: API_KEY, isFirstRun } = ensureKey(keyFilePath)

  let llmReady = false
  let llmProbeError = null

  const clients = new Set()
  let httpServer = null
  let wss = null

  // Registered projects. Each has its own chokidar watcher.
  const projects = new Map()

  // Notes storage. JSON-on-disk under <cwd>/notes/. The phone is the schema
  // authority; this server just round-trips opaque objects keyed by id.
  // Survives restarts; survives the phone's beta repackages (which is the
  // whole point — notes outlive the webview origin).
  const notesDir = options.notesDir
    ? path.resolve(options.notesDir)
    : path.join(path.dirname(keyFilePath), 'notes')
  notesStore.ensureDir(notesDir)

  // ── Helpers ───────────────────────────────────────────────────────────────

  function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS })
    res.end(JSON.stringify(body))
  }

  function sendEncrypted(res, status, plaintext) {
    sendJson(res, status, encrypt(plaintext, API_KEY))
  }

  function readJsonBody(req, limitBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
      let total = 0
      const chunks = []
      req.on('data', (chunk) => {
        total += chunk.length
        if (total > limitBytes) {
          reject(new Error('Request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve(text ? JSON.parse(text) : {})
        } catch (err) {
          reject(err)
        }
      })
      req.on('error', reject)
    })
  }

  // Most endpoints stay at the default 64 KB envelope budget. Push-file
  // endpoints take a larger limit so a single .md file plus base64 overhead
  // fits comfortably (10 MB raw covers the practical range).
  async function decryptBody(req, limitBytes) {
    const envelope = await readJsonBody(req, limitBytes)
    return JSON.parse(decrypt(envelope, API_KEY))
  }

  function broadcast(event) {
    const envelope = encrypt(JSON.stringify(event), API_KEY)
    const msg = JSON.stringify(envelope)
    let count = 0
    for (const ws of clients) {
      if (ws.readyState === 1) {
        try {
          ws.send(msg)
          count++
        } catch {}
      }
    }
    if (event.type) {
      console.log(`[ws] broadcast ${event.type} -> ${count} client${count !== 1 ? 's' : ''}`)
    }
    return count
  }

  function clientAddr(req) {
    return (
      req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
      req.socket?.remoteAddress?.replace(/^::ffff:/, '') ||
      'unknown'
    )
  }

  // Wrap decryptBody to log auth failures with a reason. The wire format
  // is opaque to clients (they just get 401), but the server log shows
  // whether the key was wrong, the envelope was malformed, etc.
  async function decryptBodyLogged(req, scope) {
    try {
      const envelope = await readJsonBody(req)
      try {
        const plain = decrypt(envelope, API_KEY)
        return JSON.parse(plain)
      } catch (err) {
        console.warn(
          `[auth] ${scope} rejected from ${clientAddr(req)} — key mismatch or malformed envelope (${err.message})`,
        )
        const e = new Error('unauthorized')
        e.authFail = true
        throw e
      }
    } catch (err) {
      if (err.authFail) throw err
      console.warn(`[auth] ${scope} rejected from ${clientAddr(req)} — bad request body (${err.message})`)
      const e = new Error('unauthorized')
      e.authFail = true
      throw e
    }
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  // Project state has two flavors:
  //
  //   fs   — server filesystem-watches a path (chokidar). Used when the
  //          extension is on the same machine as the server, so the server
  //          can read docs directly from disk.
  //
  //   push — extension is the source of truth (typically because the
  //          server is on a different machine). Extension pushes file
  //          contents via /projects/files/upsert; server caches in memory.
  //          No watcher; no disk reads.
  //
  // Mode is decided at register time by which fields the payload carries:
  // `docsPath` -> fs, `files` -> push. Both flavors expose the same
  // /files and /file shape to the phone.
  function projectSummary(proj) {
    if (proj.mode === 'push') {
      return { id: proj.id, name: proj.name, mode: 'push', fileCount: proj.files.size }
    }
    return { id: proj.id, name: proj.name, mode: 'fs', docsPath: proj.docsPath }
  }

  function projectsList() {
    return [...projects.values()].map(projectSummary)
  }

  // Coerce one push-mode file payload into the canonical FileEntry shape
  // (matching scanFiles output) plus the in-memory `content` field. Returns
  // null when validation fails so the caller can 400.
  function normalizePushFile(raw) {
    if (!raw || typeof raw !== 'object') return null
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!id || id.includes('..')) return null
    const content = typeof raw.content === 'string' ? raw.content : ''
    const name = typeof raw.name === 'string' && raw.name
      ? raw.name
      : id.split('/').pop().replace(/\.md$/, '')
    const folder = typeof raw.folder === 'string' ? raw.folder : folderId(id)
    const modifiedAt = Number.isFinite(raw.modifiedAt) ? raw.modifiedAt : Date.now()
    const size = Number.isFinite(raw.size) ? raw.size : Buffer.byteLength(content, 'utf8')
    const title = extractTitleFromText(content) || name
    const meta = { id, name, title, folder, path: id, modifiedAt, size }
    return { meta, content }
  }

  function tearDownProject(proj) {
    if (proj.watcher) {
      try { proj.watcher.close() } catch {}
    }
  }

  function registerProject({ id, name: projectName, docsPath, files }) {
    const isPush = Array.isArray(files)

    const prev = projects.get(id)
    const isNew = !prev
    if (prev) tearDownProject(prev)

    let project
    if (isPush) {
      const fileMap = new Map()
      for (const raw of files) {
        const normalized = normalizePushFile(raw)
        if (!normalized) {
          throw Object.assign(new Error('Invalid file entry in push payload'), { status: 400 })
        }
        fileMap.set(normalized.meta.id, normalized)
      }
      project = { id, name: projectName, mode: 'push', files: fileMap }
    } else {
      const absPath = path.resolve(docsPath)
      if (!fs.existsSync(absPath)) {
        throw Object.assign(new Error(`docsPath does not exist: ${absPath}`), { status: 400 })
      }
      const watcher = createWatcher(absPath, (event) => {
        broadcast({ ...event, projectId: id })
      })
      project = { id, name: projectName, mode: 'fs', docsPath: absPath, watcher }
    }

    projects.set(id, project)
    broadcast({ type: 'project-registered', id, name: projectName })
    const where = isPush
      ? `push (${project.files.size} file${project.files.size !== 1 ? 's' : ''})`
      : project.docsPath
    console.log(
      `[projects] ${isNew ? 'registered' : 're-registered'} ${id} "${projectName}" -> ${where} (total: ${projects.size})`,
    )
    return project
  }

  function unregisterProject(id) {
    const proj = projects.get(id)
    if (!proj) {
      console.log(`[projects] unregister no-op (id ${id} not found)`)
      return false
    }
    tearDownProject(proj)
    projects.delete(id)
    broadcast({ type: 'project-unregistered', id })
    console.log(`[projects] unregistered ${id} "${proj.name}" (total: ${projects.size})`)
    return true
  }

  // ── HTTP routes ───────────────────────────────────────────────────────────

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const { pathname } = url
    const startedAt = Date.now()
    const addr = clientAddr(req)

    // /health is high-frequency (heartbeat polls every 30s) -- skip noisy
    // logging there and for OPTIONS preflight. Everything else gets logged.
    const skipLog = pathname === '/health' || req.method === 'OPTIONS'
    if (!skipLog) {
      console.log(`[req] ${req.method} ${pathname} from ${addr}`)
    }
    res.on('finish', () => {
      if (skipLog) return
      const ms = Date.now() - startedAt
      console.log(`[req] ${req.method} ${pathname} -> ${res.statusCode} in ${ms} ms`)
    })

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    // /health — plaintext, no auth
    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        name,
        features: {
          multiProject: true,
          url: true,
          llm: llmReady,
          llmModel: llmReady ? ollama.model : undefined,
          push: true,
        },
        projectCount: projects.size,
        // Random UUIDs; safe to expose unauthenticated. The VS Code
        // extension uses this to decide whether to re-register on
        // heartbeat (no-op when its id is already in this list).
        projectIds: [...projects.keys()],
      })
      return
    }

    // /ping — encrypted auth check
    if (req.method === 'POST' && pathname === '/ping') {
      try {
        await decryptBody(req)
      } catch {
        sendJson(res, 401, { error: 'Unauthorized' })
        return
      }
      sendEncrypted(res, 200, JSON.stringify({ ok: true, name }))
      return
    }

    // /projects — list
    if (req.method === 'POST' && pathname === '/projects') {
      try {
        await decryptBody(req)
      } catch {
        sendJson(res, 401, { error: 'Unauthorized' })
        return
      }
      sendEncrypted(res, 200, JSON.stringify(projectsList()))
      return
    }

    // /projects/register — upsert. Accepts either shape:
    //   fs   mode: { id, name, docsPath }
    //   push mode: { id, name, files: [{id, name, folder, modifiedAt, size, content}] }
    if (req.method === 'POST' && pathname === '/projects/register') {
      let payload
      try {
        // Push-mode register carries the entire initial file set in one
        // request. 50 MB covers the practical upper bound (the user
        // estimated <10 MB total per project) with envelope overhead.
        payload = await decryptBody(req, 50 * 1024 * 1024)
      } catch {
        sendJson(res, 401, { error: 'Unauthorized' })
        return
      }
      const id = typeof payload.id === 'string' ? payload.id.trim() : ''
      const pname = typeof payload.name === 'string' ? payload.name.trim() : ''
      const pDocsPath = typeof payload.docsPath === 'string' ? payload.docsPath : ''
      const pFiles = Array.isArray(payload.files) ? payload.files : null
      if (!id || !pname) {
        console.warn(`[projects] register rejected — missing id or name`)
        sendEncrypted(res, 400, JSON.stringify({ error: 'Missing id or name' }))
        return
      }
      if (!pDocsPath && !pFiles) {
        console.warn(`[projects] register rejected — payload missing both docsPath and files`)
        sendEncrypted(
          res,
          400,
          JSON.stringify({ error: 'Payload must include either docsPath (fs mode) or files[] (push mode)' }),
        )
        return
      }
      try {
        const proj = pFiles
          ? registerProject({ id, name: pname, files: pFiles })
          : registerProject({ id, name: pname, docsPath: pDocsPath })
        sendEncrypted(res, 200, JSON.stringify({ ok: true, project: projectSummary(proj) }))
      } catch (err) {
        console.warn(`[projects] register failed — ${err.message}`)
        sendEncrypted(res, err.status || 500, JSON.stringify({ error: err.message }))
      }
      return
    }

    // /projects/unregister
    if (req.method === 'POST' && pathname === '/projects/unregister') {
      let payload
      try {
        payload = await decryptBody(req)
      } catch {
        sendJson(res, 401, { error: 'Unauthorized' })
        return
      }
      const id = typeof payload.id === 'string' ? payload.id.trim() : ''
      if (!id) {
        sendEncrypted(res, 400, JSON.stringify({ error: 'Missing id' }))
        return
      }
      const removed = unregisterProject(id)
      sendEncrypted(res, 200, JSON.stringify({ ok: true, removed }))
      return
    }

    // /files — list files in a project. Same response shape regardless of
    // the project's mode; phone has no notion of fs vs push.
    if (req.method === 'POST' && pathname === '/files') {
      let payload
      try {
        payload = await decryptBody(req)
      } catch {
        sendJson(res, 401, { error: 'Unauthorized' })
        return
      }
      const projectId = typeof payload.projectId === 'string' ? payload.projectId : ''
      if (!projectId) {
        sendEncrypted(res, 400, JSON.stringify({ error: 'Missing projectId' }))
        return
      }
      const proj = projects.get(projectId)
      if (!proj) {
        sendEncrypted(res, 404, JSON.stringify({ error: 'Project not found' }))
        return
      }
      const files = proj.mode === 'push'
        ? [...proj.files.values()].map((entry) => entry.meta)
        : await scanFiles(proj.docsPath)
      sendEncrypted(res, 200, JSON.stringify(files))
      return
    }

    // /file — read one file in a project.
    if (req.method === 'POST' && pathname === '/file') {
      let payload
      try {
        payload = await decryptBody(req)
      } catch {
        sendJson(res, 401, { error: 'Unauthorized' })
        return
      }
      const projectId = typeof payload.projectId === 'string' ? payload.projectId : ''
      const fileId = typeof payload.id === 'string' ? payload.id : ''
      if (!projectId || !fileId) {
        sendEncrypted(res, 400, JSON.stringify({ error: 'Missing projectId or id' }))
        return
      }
      const proj = projects.get(projectId)
      if (!proj) {
        sendEncrypted(res, 404, JSON.stringify({ error: 'Project not found' }))
        return
      }
      let content
      if (proj.mode === 'push') {
        const entry = proj.files.get(fileId)
        content = entry ? entry.content : null
      } else {
        content = await readFile(proj.docsPath, fileId)
      }
      if (content === null) {
        sendEncrypted(res, 404, JSON.stringify({ error: 'Not found' }))
      } else {
        sendEncrypted(res, 200, content)
      }
      return
    }

    // /projects/files/upsert — push a single file's content into a
    // push-mode project. Idempotent. Broadcasts file-added on first sight,
    // file-updated on subsequent calls.
    if (req.method === 'POST' && pathname === '/projects/files/upsert') {
      let payload
      try {
        payload = await decryptBody(req, 10 * 1024 * 1024)
      } catch {
        sendJson(res, 401, { error: 'Unauthorized' })
        return
      }
      const projectId = typeof payload.projectId === 'string' ? payload.projectId : ''
      const proj = projects.get(projectId)
      if (!projectId || !proj) {
        sendEncrypted(res, 404, JSON.stringify({ error: 'Project not found' }))
        return
      }
      if (proj.mode !== 'push') {
        sendEncrypted(res, 400, JSON.stringify({ error: 'Project is not in push mode' }))
        return
      }
      const normalized = normalizePushFile(payload.file)
      if (!normalized) {
        sendEncrypted(res, 400, JSON.stringify({ error: 'Invalid file payload' }))
        return
      }
      const wasPresent = proj.files.has(normalized.meta.id)
      proj.files.set(normalized.meta.id, normalized)
      broadcast({
        type: wasPresent ? 'file-updated' : 'file-added',
        projectId,
        id: normalized.meta.id,
        name: normalized.meta.name,
        folder: normalized.meta.folder,
      })
      sendEncrypted(res, 200, JSON.stringify({ ok: true, created: !wasPresent }))
      return
    }

    // /projects/files/delete — remove a file from a push-mode project.
    if (req.method === 'POST' && pathname === '/projects/files/delete') {
      let payload
      try {
        payload = await decryptBody(req)
      } catch {
        sendJson(res, 401, { error: 'Unauthorized' })
        return
      }
      const projectId = typeof payload.projectId === 'string' ? payload.projectId : ''
      const fileId = typeof payload.id === 'string' ? payload.id : ''
      const proj = projects.get(projectId)
      if (!projectId || !proj) {
        sendEncrypted(res, 404, JSON.stringify({ error: 'Project not found' }))
        return
      }
      if (proj.mode !== 'push') {
        sendEncrypted(res, 400, JSON.stringify({ error: 'Project is not in push mode' }))
        return
      }
      if (!fileId) {
        sendEncrypted(res, 400, JSON.stringify({ error: 'Missing id' }))
        return
      }
      const removed = proj.files.delete(fileId)
      if (removed) {
        broadcast({ type: 'file-removed', projectId, id: fileId })
      }
      sendEncrypted(res, 200, JSON.stringify({ ok: true, removed }))
      return
    }

    // /llm/ping — fast liveness probe for the local LLM. Used by clients
    // to decide whether to commit to a local-LLM call or fall back fast.
    // 200 + { ready: true, model } when Ollama is up and the configured
    // model is pulled. 503 + { ready: false, reason } otherwise.
    if (req.method === 'POST' && pathname === '/llm/ping') {
      try {
        await decryptBody(req)
      } catch {
        sendJson(res, 401, { error: 'Unauthorized' })
        return
      }
      const pingFrom = clientAddr(req)
      if (!ollama.enabled) {
        console.log(`[llm-ping] ${pingFrom} → not-ready (LLM not enabled)`)
        sendEncrypted(res, 503, JSON.stringify({
          ready: false,
          reason: 'LLM not enabled on this server',
        }))
        return
      }
      const probe = await probeOllama({
        url: ollama.url,
        model: ollama.model,
        timeoutMs: LIVE_PROBE_TIMEOUT_MS,
      })
      if (!probe.ok) {
        console.log(
          `[llm-ping] ${pingFrom} → not-ready (${probe.error || 'probe failed'})`,
        )
        sendEncrypted(res, 503, JSON.stringify({
          ready: false,
          reason: probe.error || 'probe failed',
          model: probe.model,
        }))
        return
      }
      // Model-not-pulled returns ok:true with an error field; treat as
      // not-ready for routing purposes so the client doesn't hit /llm with
      // a missing model.
      if (probe.error) {
        console.log(
          `[llm-ping] ${pingFrom} → not-ready (${probe.error})`,
        )
        sendEncrypted(res, 503, JSON.stringify({
          ready: false,
          reason: probe.error,
          model: probe.model,
        }))
        return
      }
      console.log(`[llm-ping] ${pingFrom} → ready (model ${probe.model})`)
      sendEncrypted(res, 200, JSON.stringify({
        ready: true,
        model: probe.model,
      }))
      return
    }

    // /llm — OpenAI-compatible chat completion proxy (unchanged)
    if (req.method === 'POST' && pathname === '/llm') {
      let payload
      try {
        payload = await decryptBody(req)
      } catch {
        sendJson(res, 401, { error: 'Unauthorized' })
        return
      }
      // Short request id so concurrent calls can be followed in the log.
      const reqId = Math.random().toString(36).slice(2, 8)
      const reqBytes = Buffer.byteLength(JSON.stringify(payload))
      const msgCount = Array.isArray(payload?.messages) ? payload.messages.length : 0
      console.log(
        `[llm ${reqId}] received from ${clientAddr(req)} — ${formatBytes(reqBytes)}, ${msgCount} message${msgCount !== 1 ? 's' : ''}`,
      )

      if (!llmReady) {
        console.warn(`[llm ${reqId}] rejected — ${llmProbeError || 'LLM not enabled'}`)
        sendEncrypted(res, 503, JSON.stringify({
          error: {
            message: llmProbeError || 'LLM not enabled on this server',
            type: 'unavailable',
          },
        }))
        return
      }
      const startedAt = Date.now()
      console.log(`[llm ${reqId}] inference start — model ${ollama.model}`)
      try {
        const body = await proxyChatCompletion(ollama, payload)
        const ms = Date.now() - startedAt
        const usage = body?.usage
        const tokenInfo = usage
          ? ` · ${usage.prompt_tokens || 0} in + ${usage.completion_tokens || 0} out tokens`
          : ''
        console.log(`[llm ${reqId}] complete in ${formatDuration(ms)}${tokenInfo}`)
        sendEncrypted(res, 200, JSON.stringify(body))
      } catch (err) {
        const ms = Date.now() - startedAt
        console.warn(`[llm ${reqId}] failed after ${formatDuration(ms)} — ${err.message}`)
        sendEncrypted(res, err.status || 502, JSON.stringify({
          error: { message: err.message, type: 'upstream' },
        }))
      }
      return
    }

    // /analyze — global URL channel, not scoped to any project
    if (req.method === 'POST' && pathname === '/analyze') {
      let payload
      try {
        payload = await decryptBody(req)
      } catch {
        sendJson(res, 401, { error: 'Unauthorized' })
        return
      }
      const targetUrl = typeof payload.url === 'string' ? payload.url.trim() : ''
      if (!targetUrl) {
        sendEncrypted(res, 400, JSON.stringify({ error: 'Missing url' }))
        return
      }
      const delivered = broadcast({
        type: 'url',
        url: targetUrl,
        title: typeof payload.title === 'string' ? payload.title : undefined,
        // Optional routing hint from the browser extension. `true` tells the
        // phone to route this URL's ingest through its local LLM (hard-prefer
        // mode). The phone still honors its own "use server LLM" OFF toggle
        // as a veto.
        preferLocalLlm: payload.preferLocalLlm === true ? true : undefined,
        receivedAt: Date.now(),
      })
      sendEncrypted(res, 200, JSON.stringify({ ok: true, delivered }))
      return
    }

    // ── Notes endpoints ──────────────────────────────────────────────────
    // Phone-managed user notes (file ingests, URL summaries, voice asks,
    // etc.). Stored as JSON files at <notesDir>/<id>.json. Phone is schema
    // authority. See lib/notes.js + docs/api.md.

    if (req.method === 'POST' && pathname === '/notes') {
      try { await decryptBody(req) } catch {
        sendJson(res, 401, { error: 'Unauthorized' }); return
      }
      try {
        const list = notesStore.listNotes(notesDir)
        sendEncrypted(res, 200, JSON.stringify(list))
      } catch (err) {
        sendEncrypted(res, 500, JSON.stringify({ error: err.message }))
      }
      return
    }

    if (req.method === 'POST' && pathname === '/note') {
      let payload
      try { payload = await decryptBody(req) } catch {
        sendJson(res, 401, { error: 'Unauthorized' }); return
      }
      const id = typeof payload.id === 'string' ? payload.id : ''
      if (!id) {
        sendEncrypted(res, 400, JSON.stringify({ error: 'Missing id' }))
        return
      }
      const note = notesStore.readNote(notesDir, id)
      if (!note) {
        sendEncrypted(res, 404, JSON.stringify({ error: 'Not found' }))
        return
      }
      sendEncrypted(res, 200, JSON.stringify(note))
      return
    }

    if (req.method === 'POST' && pathname === '/notes/upsert') {
      let payload
      try { payload = await decryptBody(req) } catch {
        sendJson(res, 401, { error: 'Unauthorized' }); return
      }
      // Body is the full Item — we don't validate its shape, just sanity-
      // check the id so we don't write anywhere unexpected on disk.
      if (!payload || !notesStore.isValidId(payload.id)) {
        sendEncrypted(res, 400, JSON.stringify({ error: 'Missing or invalid id' }))
        return
      }
      try {
        const result = notesStore.upsertNote(notesDir, payload)
        broadcast({
          type: result.created ? 'note-added' : 'note-updated',
          id: payload.id,
          title: typeof payload.title === 'string' ? payload.title : '',
        })
        sendEncrypted(res, 200, JSON.stringify({ ok: true, ...result }))
      } catch (err) {
        sendEncrypted(res, 400, JSON.stringify({ error: err.message }))
      }
      return
    }

    if (req.method === 'POST' && pathname === '/notes/delete') {
      let payload
      try { payload = await decryptBody(req) } catch {
        sendJson(res, 401, { error: 'Unauthorized' }); return
      }
      const id = typeof payload.id === 'string' ? payload.id : ''
      if (!id) {
        sendEncrypted(res, 400, JSON.stringify({ error: 'Missing id' }))
        return
      }
      const result = notesStore.deleteNote(notesDir, id)
      if (result.removed) {
        broadcast({ type: 'note-removed', id })
      }
      sendEncrypted(res, 200, JSON.stringify({ ok: true, ...result }))
      return
    }

    // ── Admin endpoints ────────────────────────────────────────────────
    // Remote management. Used by the VS Code extension in remote mode.

    // /admin/shutdown — graceful shutdown. Respond first, then tear down.
    if (req.method === 'POST' && pathname === '/admin/shutdown') {
      try {
        await decryptBody(req)
      } catch {
        sendJson(res, 401, { error: 'Unauthorized' })
        return
      }
      console.log('[admin] shutdown requested by remote client')
      sendEncrypted(res, 200, JSON.stringify({ ok: true, action: 'shutdown' }))
      // Defer shutdown so the response has time to flush.
      setTimeout(async () => {
        await stop()
        process.exit(0)
      }, 200)
      return
    }

    // /admin/restart — hot-restart: close listeners, re-create, re-listen.
    // Projects and notes survive (the project map is rebuilt by clients
    // re-registering via heartbeat). Useful when the server needs to pick up
    // config changes without a full process exit.
    if (req.method === 'POST' && pathname === '/admin/restart') {
      try {
        await decryptBody(req)
      } catch {
        sendJson(res, 401, { error: 'Unauthorized' })
        return
      }
      console.log('[admin] restart requested by remote client')
      sendEncrypted(res, 200, JSON.stringify({ ok: true, action: 'restart' }))
      // Defer restart so the response has time to flush.
      setTimeout(async () => {
        try {
          await stop()
          await start()
          console.log(`[admin] restarted — listening on :${port}`)
        } catch (err) {
          console.error(`[admin] restart failed: ${err.message}`)
          process.exit(1)
        }
      }, 200)
      return
    }

    sendJson(res, 404, { error: 'Not found' })
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  function handleConnection(ws, req) {
    let authenticated = false
    const addr = req ? clientAddr(req) : 'unknown'
    console.log(`[ws] connection opened from ${addr}`)
    const timeout = setTimeout(() => {
      if (!authenticated) {
        console.warn(`[ws] hello timeout from ${addr}`)
        try { ws.close(4401, 'hello timeout') } catch {}
      }
    }, WS_HELLO_TIMEOUT_MS)

    ws.on('message', (raw) => {
      if (authenticated) return
      let envelope
      try { envelope = JSON.parse(raw.toString('utf8')) }
      catch {
        console.warn(`[ws] malformed envelope from ${addr}`)
        ws.close(4400, 'malformed'); return
      }

      let plain
      try { plain = decrypt(envelope, API_KEY) }
      catch {
        console.warn(`[ws] auth rejected from ${addr} — key mismatch`)
        ws.close(4401, 'unauthorized'); return
      }

      let msg
      try { msg = JSON.parse(plain) }
      catch {
        console.warn(`[ws] malformed plaintext from ${addr}`)
        ws.close(4400, 'malformed'); return
      }

      if (msg && msg.type === 'hello') {
        authenticated = true
        clearTimeout(timeout)
        clients.add(ws)
        console.log(`[ws] authenticated ${addr} (total: ${clients.size})`)
        try {
          ws.send(
            JSON.stringify(
              encrypt(
                JSON.stringify({
                  type: 'welcome',
                  name,
                  projects: projectsList(),
                }),
                API_KEY,
              ),
            ),
          )
        } catch {}
        return
      }
      console.warn(`[ws] expected hello from ${addr}, got ${msg?.type}`)
      ws.close(4400, 'expected hello')
    })

    ws.on('close', () => {
      clearTimeout(timeout)
      const wasMember = clients.delete(ws)
      if (wasMember || authenticated) {
        console.log(`[ws] closed from ${addr} (total: ${clients.size})`)
      }
    })
    ws.on('error', (err) => {
      clearTimeout(timeout)
      clients.delete(ws)
      console.warn(`[ws] error from ${addr}: ${err.message}`)
    })
  }

  // ── Start / stop ──────────────────────────────────────────────────────────

  async function start() {
    if (ollama.enabled) {
      const result = await probeOllama({ url: ollama.url, model: ollama.model })
      if (result.ok && !result.error) {
        llmReady = true
        llmProbeError = null
      } else {
        llmReady = false
        llmProbeError = result.error || 'Ollama unreachable'
      }
    }

    httpServer = http.createServer(handleRequest)
    wss = new WebSocketServer({ noServer: true })
    wss.on('connection', (ws, req) => handleConnection(ws, req))

    httpServer.on('upgrade', (req, socket, head) => {
      const u = new URL(req.url, 'http://localhost')
      if (u.pathname !== '/events') {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    })

    // Legacy: if the user passed --docs, register a default project so one-off
    // CLI use still works (`nutshell-server --docs ./docs`).
    if (initialDocsPath && fs.existsSync(initialDocsPath)) {
      try {
        registerProject({
          id: DEFAULT_PROJECT_ID,
          name,
          docsPath: initialDocsPath,
        })
      } catch (err) {
        console.warn(`[nutshell-server] could not register default project: ${err.message}`)
      }
    }

    await new Promise((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(port, '0.0.0.0', () => {
        httpServer.off('error', reject)
        resolve()
      })
    })
  }

  async function stop() {
    for (const proj of projects.values()) {
      if (proj.watcher) {
        try { await proj.watcher.close() } catch {}
      }
    }
    projects.clear()

    if (wss) {
      for (const ws of clients) {
        try { ws.close() } catch {}
      }
      clients.clear()
      wss.close()
      wss = null
    }
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(() => resolve()))
      httpServer = null
    }
  }

  return {
    start,
    stop,
    apiKey: API_KEY,
    isFirstRun,
    port,
    name,
    initialDocsPath,
    get projectCount() { return projects.size },
    get projects() { return projectsList() },
    get llmReady() { return llmReady },
    get llmProbeError() { return llmProbeError },
    get llmModel() { return ollama.enabled ? ollama.model : null },
    get llmUrl() { return ollama.enabled ? ollama.url : null },
  }
}

module.exports = { createServer }
