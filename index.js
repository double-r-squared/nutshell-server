'use strict'

const http = require('http')
const path = require('path')
const fs = require('fs')
const { WebSocketServer } = require('ws')

const { ensureKey } = require('./lib/auth')
const { encrypt, decrypt } = require('./lib/crypto')
const { scanFiles, readFile } = require('./lib/files')
const { createWatcher } = require('./lib/watcher')
const {
  probeOllama,
  proxyChatCompletion,
  DEFAULT_URL: OLLAMA_DEFAULT_URL,
  DEFAULT_MODEL: OLLAMA_DEFAULT_MODEL,
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

  async function decryptBody(req) {
    const envelope = await readJsonBody(req)
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
    return count
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  function projectSummary(proj) {
    return { id: proj.id, name: proj.name, docsPath: proj.docsPath }
  }

  function projectsList() {
    return [...projects.values()].map(projectSummary)
  }

  function registerProject({ id, name: projectName, docsPath }) {
    const absPath = path.resolve(docsPath)
    if (!fs.existsSync(absPath)) {
      throw Object.assign(new Error(`docsPath does not exist: ${absPath}`), { status: 400 })
    }

    // Tear down the old watcher if re-registering an existing project.
    const prev = projects.get(id)
    if (prev && prev.watcher) {
      try { prev.watcher.close() } catch {}
    }

    const watcher = createWatcher(absPath, (event) => {
      broadcast({ ...event, projectId: id })
    })
    const project = { id, name: projectName, docsPath: absPath, watcher }
    projects.set(id, project)
    broadcast({ type: 'project-registered', id, name: projectName })
    return project
  }

  function unregisterProject(id) {
    const proj = projects.get(id)
    if (!proj) return false
    if (proj.watcher) {
      try { proj.watcher.close() } catch {}
    }
    projects.delete(id)
    broadcast({ type: 'project-unregistered', id })
    return true
  }

  // ── HTTP routes ───────────────────────────────────────────────────────────

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const { pathname } = url

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
        },
        projectCount: projects.size,
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

    // /projects/register — upsert
    if (req.method === 'POST' && pathname === '/projects/register') {
      let payload
      try {
        payload = await decryptBody(req)
      } catch {
        sendJson(res, 401, { error: 'Unauthorized' })
        return
      }
      const id = typeof payload.id === 'string' ? payload.id.trim() : ''
      const pname = typeof payload.name === 'string' ? payload.name.trim() : ''
      const pDocsPath = typeof payload.docsPath === 'string' ? payload.docsPath : ''
      if (!id || !pname || !pDocsPath) {
        sendEncrypted(res, 400, JSON.stringify({ error: 'Missing id, name, or docsPath' }))
        return
      }
      try {
        const proj = registerProject({ id, name: pname, docsPath: pDocsPath })
        sendEncrypted(res, 200, JSON.stringify({ ok: true, project: projectSummary(proj) }))
      } catch (err) {
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

    // /files — list files in a project
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
      const files = await scanFiles(proj.docsPath)
      sendEncrypted(res, 200, JSON.stringify(files))
      return
    }

    // /file — read one file in a project
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
      const content = await readFile(proj.docsPath, fileId)
      if (content === null) {
        sendEncrypted(res, 404, JSON.stringify({ error: 'Not found' }))
      } else {
        sendEncrypted(res, 200, content)
      }
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
      if (!llmReady) {
        sendEncrypted(res, 503, JSON.stringify({
          error: {
            message: llmProbeError || 'LLM not enabled on this server',
            type: 'unavailable',
          },
        }))
        return
      }
      try {
        const body = await proxyChatCompletion(ollama, payload)
        sendEncrypted(res, 200, JSON.stringify(body))
      } catch (err) {
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
        receivedAt: Date.now(),
      })
      sendEncrypted(res, 200, JSON.stringify({ ok: true, delivered }))
      return
    }

    sendJson(res, 404, { error: 'Not found' })
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  function handleConnection(ws) {
    let authenticated = false
    const timeout = setTimeout(() => {
      if (!authenticated) {
        try { ws.close(4401, 'hello timeout') } catch {}
      }
    }, WS_HELLO_TIMEOUT_MS)

    ws.on('message', (raw) => {
      if (authenticated) return
      let envelope
      try { envelope = JSON.parse(raw.toString('utf8')) }
      catch { ws.close(4400, 'malformed'); return }

      let plain
      try { plain = decrypt(envelope, API_KEY) }
      catch { ws.close(4401, 'unauthorized'); return }

      let msg
      try { msg = JSON.parse(plain) }
      catch { ws.close(4400, 'malformed'); return }

      if (msg && msg.type === 'hello') {
        authenticated = true
        clearTimeout(timeout)
        clients.add(ws)
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
      ws.close(4400, 'expected hello')
    })

    ws.on('close', () => {
      clearTimeout(timeout)
      clients.delete(ws)
    })
    ws.on('error', () => {
      clearTimeout(timeout)
      clients.delete(ws)
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
    wss.on('connection', handleConnection)

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

module.exports = { createServer, encrypt, decrypt }
