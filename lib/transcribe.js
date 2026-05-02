'use strict'

// Server-side speech-to-text. Wraps a long-running Python daemon
// (faster-whisper, see scripts/transcribe-daemon.py) so the Node
// server can stream audio in and stream transcripts back without
// paying subprocess startup cost per utterance.
//
// Public surface:
//
//   isAvailable()         — does the local install have python3 +
//                           faster_whisper? Probed once at module
//                           load via `python3 -c "import faster_whisper"`.
//   startStream(opts)     — start a streaming transcription session.
//                           Spawns the daemon on first use; reuses it
//                           thereafter. Returns a TranscriptionStream
//                           with sendAudio / end / abort + onPartial /
//                           onFinal / onError callbacks. Mirrors the
//                           toolkit's STTProvider interface so the
//                           phone-side adapter stays a thin wrapper.
//
// Daemon lifecycle is process-scoped — one daemon per nutshell-server
// process, model loaded once, sessions multiplexed by sessionId. If
// the daemon crashes mid-session, every active stream emits an error
// and the next startStream() respawns.
//
// To enable: pip install faster-whisper numpy. /health.features.
// transcribe reflects whether the probe succeeded.

const { execSync, spawn } = require('child_process')
const path = require('path')

const DAEMON_SCRIPT = path.join(__dirname, '..', 'scripts', 'transcribe-daemon.py')

// Probe Python + faster-whisper availability once at module load.
// Sync exec is fine — the worst case (Python missing) errors fast,
// and we want this answer ready by the time /health is hit.
let probedAvailable = null
let probedReason = null
function probeAvailability() {
  if (probedAvailable !== null) return probedAvailable
  try {
    execSync('python3 -c "import faster_whisper"', {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    probedAvailable = true
    return true
  } catch (err) {
    probedAvailable = false
    probedReason = err && err.stderr
      ? err.stderr.toString().trim().split('\n')[0]
      : (err && err.message) || 'unknown'
    console.warn(
      `[transcribe] python3 + faster_whisper not available — STT disabled. To enable: pip install faster-whisper numpy. (${probedReason})`,
    )
    return false
  }
}

function isAvailable() {
  return probeAvailability()
}

// ── Daemon manager ──────────────────────────────────────────────────────────
//
// Lazy-spawned single subprocess. State machine:
//   spawning → ready → (alive while server runs)
//   on exit  → null (will respawn on next startStream)

let daemon = null

function ensureDaemon(model) {
  if (daemon && daemon.proc) return daemon
  if (!isAvailable()) {
    throw new Error(
      `transcription provider not configured: ${probedReason || 'python3 + faster_whisper missing'}`,
    )
  }
  const args = [DAEMON_SCRIPT, '--model', model || 'base']
  const proc = spawn('python3', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')

  const state = {
    proc,
    ready: false,
    sessionStreams: new Map(),  // sessionId -> TranscriptionStream
    lineBuffer: '',
    waitingForReady: [],
  }

  proc.stdout.on('data', (chunk) => {
    state.lineBuffer += chunk
    let idx
    while ((idx = state.lineBuffer.indexOf('\n')) !== -1) {
      const line = state.lineBuffer.slice(0, idx)
      state.lineBuffer = state.lineBuffer.slice(idx + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch {
        console.warn(`[transcribe] daemon emitted malformed line: ${line.slice(0, 80)}`)
        continue
      }
      if (msg.type === 'ready') {
        state.ready = true
        const waiters = state.waitingForReady
        state.waitingForReady = []
        for (const w of waiters) try { w() } catch {}
        continue
      }
      const stream = state.sessionStreams.get(msg.sessionId)
      if (!stream) continue
      if (msg.type === 'partial' && typeof msg.text === 'string') {
        stream._emitPartial(msg.text)
      } else if (msg.type === 'final' && typeof msg.text === 'string') {
        stream._emitFinal(msg.text)
        state.sessionStreams.delete(msg.sessionId)
      } else if (msg.type === 'error') {
        stream._emitError(msg.error || 'daemon error')
        state.sessionStreams.delete(msg.sessionId)
      }
    }
  })

  proc.stderr.on('data', (chunk) => {
    // Daemon writes diagnostic logs here. Forward verbatim with a
    // tag so the user can correlate with their server logs.
    for (const line of chunk.split('\n')) {
      if (line.trim()) console.log(`[transcribe-daemon] ${line}`)
    }
  })

  proc.on('exit', (code, signal) => {
    console.warn(
      `[transcribe] daemon exited code=${code} signal=${signal || 'none'}`,
    )
    // Tell every active stream the world is ending.
    for (const stream of state.sessionStreams.values()) {
      try { stream._emitError('transcribe daemon exited') } catch {}
    }
    state.sessionStreams.clear()
    if (daemon === state) daemon = null
  })

  proc.on('error', (err) => {
    console.warn(`[transcribe] daemon spawn error: ${err.message}`)
    if (daemon === state) daemon = null
  })

  daemon = state
  return state
}

function awaitReady(state) {
  if (state.ready) return Promise.resolve()
  return new Promise((resolve) => state.waitingForReady.push(resolve))
}

function sendToDaemon(state, msg) {
  if (!state.proc || !state.proc.stdin.writable) return
  try {
    state.proc.stdin.write(JSON.stringify(msg) + '\n')
  } catch (err) {
    console.warn(`[transcribe] daemon stdin write failed: ${err.message}`)
  }
}

// ── Public TranscriptionStream ──────────────────────────────────────────────

class TranscriptionStream {
  constructor() {
    this._partialCbs = []
    this._finalCbs = []
    this._errorCbs = []
    this._closed = false
    this._sessionId = null
    this._daemon = null
  }
  onPartial(cb) {
    this._partialCbs.push(cb)
    return () => { this._partialCbs = this._partialCbs.filter((c) => c !== cb) }
  }
  onFinal(cb) {
    this._finalCbs.push(cb)
    return () => { this._finalCbs = this._finalCbs.filter((c) => c !== cb) }
  }
  onError(cb) {
    this._errorCbs.push(cb)
    return () => { this._errorCbs = this._errorCbs.filter((c) => c !== cb) }
  }
  _emitPartial(text) {
    for (const cb of this._partialCbs) try { cb(text) } catch {}
  }
  _emitFinal(text) {
    for (const cb of this._finalCbs) try { cb(text) } catch {}
  }
  _emitError(message) {
    for (const cb of this._errorCbs) try { cb(message) } catch {}
  }
  sendAudio(pcmBytes) {
    if (this._closed || !this._daemon) return
    const b64 = Buffer.isBuffer(pcmBytes)
      ? pcmBytes.toString('base64')
      : Buffer.from(pcmBytes).toString('base64')
    sendToDaemon(this._daemon, {
      type: 'audio',
      sessionId: this._sessionId,
      pcm: b64,
    })
  }
  end() {
    if (this._closed || !this._daemon) return
    sendToDaemon(this._daemon, { type: 'end', sessionId: this._sessionId })
    // Don't mark closed yet — daemon still needs to emit the final
    // before we're truly done. Final / error handler in the daemon
    // listener removes us from sessionStreams, which is the real
    // completion signal.
  }
  abort() {
    if (this._closed) return
    this._closed = true
    if (this._daemon) {
      sendToDaemon(this._daemon, { type: 'abort', sessionId: this._sessionId })
      this._daemon.sessionStreams.delete(this._sessionId)
    }
  }
}

function startStream(opts) {
  const model = (opts && opts.model) || 'base'
  const state = ensureDaemon(model)
  const sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const stream = new TranscriptionStream()
  stream._sessionId = sessionId
  stream._daemon = state
  state.sessionStreams.set(sessionId, stream)

  const startMsg = {
    type: 'start',
    sessionId,
    sampleRate: (opts && typeof opts.sampleRate === 'number') ? opts.sampleRate : 16000,
    language: (opts && typeof opts.language === 'string') ? opts.language : null,
    model: (opts && typeof opts.model === 'string') ? opts.model : null,
  }

  // If the daemon hasn't finished loading the model yet, queue the
  // start message until it has. Audio frames sent before ready get
  // the same treatment via this Promise.
  if (state.ready) {
    sendToDaemon(state, startMsg)
  } else {
    awaitReady(state).then(() => sendToDaemon(state, startMsg))
  }

  return stream
}

// Graceful shutdown — kill the daemon when the server stops.
function shutdown() {
  if (!daemon || !daemon.proc) return
  try { daemon.proc.kill('SIGTERM') } catch {}
  daemon = null
}

module.exports = {
  isAvailable,
  startStream,
  shutdown,
}
