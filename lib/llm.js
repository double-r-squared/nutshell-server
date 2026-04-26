'use strict'

// Ollama proxy. Uses the OpenAI-compatible /v1/chat/completions endpoint so
// the phone can re-use its existing OpenRouter client code — same request
// shape, same response shape, just a different URL wrapped in our encrypted
// envelope.

const DEFAULT_URL = 'http://localhost:11434'
const DEFAULT_MODEL = 'llama3.2:3b'
const DEFAULT_PROBE_TIMEOUT_MS = 2_000
const LIVE_PROBE_TIMEOUT_MS = 800

// Probe Ollama. Returns { ok, model, tags, error? }. Used both at startup
// (to set the features.llm flag on /health) and at runtime via POST /llm/ping
// (for phone clients deciding whether to commit to a local-LLM call).
//
// `timeoutMs` defaults to 2 s for startup probes; callers on the hot path
// should pass a tighter value (LIVE_PROBE_TIMEOUT_MS).
async function probeOllama({
  url = DEFAULT_URL,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/tags`, { signal: ctrl.signal })
    if (!res.ok) return { ok: false, model, error: `tags ${res.status}` }
    const body = await res.json()
    const tags = (body.models || []).map((m) => m.name)
    const has = tags.some((t) => t === model || t.startsWith(`${model}:`))
    if (!has) {
      return {
        ok: true,
        model,
        tags,
        error: `model "${model}" not pulled (run: ollama pull ${model})`,
      }
    }
    return { ok: true, model, tags }
  } catch (err) {
    return { ok: false, model, error: err.name === 'AbortError' ? 'timeout' : err.message }
  } finally {
    clearTimeout(timer)
  }
}

// Proxy a chat-completions request to Ollama. The incoming body is whatever
// the phone sent — same shape as OpenAI/OpenRouter. We override `model` with
// the server's configured model and forward the rest verbatim.
//
// Returns the raw OpenAI-compatible response body (parsed JSON) so the caller
// can re-wrap it in our encrypted envelope and hand it back to the client.
async function proxyChatCompletion({ url = DEFAULT_URL, model = DEFAULT_MODEL }, reqBody) {
  const body = { ...(reqBody || {}), model }
  // Strip OpenRouter-only fields Ollama doesn't recognize. `plugins`, in
  // particular, is used for the PDF parser and has no local equivalent.
  delete body.plugins
  delete body.provider
  delete body.transforms

  const endpoint = `${url.replace(/\/$/, '')}/v1/chat/completions`
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    const err = new Error(`Ollama returned non-JSON (${res.status})`)
    err.status = 502
    throw err
  }

  if (!res.ok) {
    const err = new Error(json.error?.message || json.error || `Ollama returned ${res.status}`)
    err.status = res.status
    err.body = json
    throw err
  }

  return json
}

module.exports = {
  probeOllama,
  proxyChatCompletion,
  DEFAULT_URL,
  DEFAULT_MODEL,
  LIVE_PROBE_TIMEOUT_MS,
}
