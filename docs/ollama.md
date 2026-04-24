# Local LLM integration

`nutshell-server` can proxy OpenAI-compatible chat completions to a local
[Ollama](https://ollama.com) instance. When enabled, the phone can route any
OpenRouter call through the server instead by changing the URL — the request
and response shapes are identical.

## Enable it

```bash
nutshell-server --ollama
# or
nutshell-server --ollama --ollama-model qwen2.5:7b --ollama-url http://localhost:11434
```

Or use the one-command script:

```bash
npm run start:llm
```

which handles installing/running Ollama and pulling the model (see
[`../scripts/start-with-llm.sh`](../scripts/start-with-llm.sh)).

## What happens at startup

When `--ollama` is set:

1. Server calls `GET <ollama-url>/api/tags` with a 2 s timeout
2. Parses the returned model list
3. Checks the configured model is present (matches either exactly or as a
   prefix, so `llama3.2:3b` matches `llama3.2:3b-instruct-q8_0` too)
4. If all OK → `llmReady = true`, `/health` reports `features.llm: true`, and
   `POST /llm` is live
5. If Ollama is unreachable → logs the error, sets `llmReady = false`, server
   keeps running. `/llm` returns `503`. Other features are unaffected
6. If Ollama is reachable but the model isn't pulled → same as (5), but the
   logged error includes the exact `ollama pull <model>` command

This probe runs once, at startup. If you pull a new model later, restart the
server to pick it up.

## Endpoint

See [`api.md#post-llm`](api.md#post-llm) for the request/response shape.

Key points:

- Request body is OpenAI `/v1/chat/completions` verbatim
- Server **overrides** the `model` field with its configured Ollama model
  before forwarding — clients can send any model ID (e.g., an OpenRouter
  model name) and it'll be ignored
- Server strips OpenRouter-only fields: `plugins`, `provider`, `transforms`
- Response is Ollama's OpenAI-compatible response verbatim (with the correct
  `model` field, streaming fields where applicable, etc.)

## Model recommendations

The sweet spot for the HUD reformat task is 3-7B params. Small enough to run
on CPU, big enough to follow the formatting rules reliably.

| Model | Size | Notes |
| --- | --- | --- |
| `llama3.2:3b` | 2 GB | **Default.** Good quality-per-byte. Runs on any 8 GB Mac. |
| `qwen2.5:3b` | 2 GB | Strong at structured output; slightly better at rule-following. |
| `qwen2.5:7b` | 4.7 GB | Noticeably higher quality. Needs 16 GB+ RAM. |
| `llama3.2:1b` | 1.3 GB | Tiny/fast but struggles with the full reformat harness. Good for short queries. |
| `phi3.5:3.8b` | 2.2 GB | Microsoft's compact model. |

Override via `--ollama-model qwen2.5:7b` or the `OLLAMA_MODEL` env var.

## Harness variants

Two G2 reformat prompts ship with the server:

- `prompts/reformat-note.txt` — full spec (~50 lines). Ideal for capable
  cloud models or 7B+ local models
- `prompts/reformat-note-compact.txt` — trimmed (~15 lines). Better for 1-3B
  models where long instructions cause drift

The server doesn't auto-select today — the phone sends the full system
prompt verbatim. For smaller models, a future phase should have the phone
detect `features.llmModel` and pick a trimmed prompt accordingly.

## Phone-side integration (Phase 2)

As of `app.json` 0.8.4, the phone honours a global toggle in Settings →
**Use connected server's LLM when available**. When it's on AND a connected
server reports `features.llm`, `generateItem` sends its OpenAI-compatible
body to `POST /llm` instead of OpenRouter. Response parsing is identical
because `/llm` is a verbatim pass-through.

Fall-back to OpenRouter is automatic if the `/llm` call fails for any reason
(status ≠ 200, network error, schema validation failure). The toggle is
global — one `localStorage` key, one routing decision. See
`even/docs/NutshellServer/architecture.md` for the phone-side design.

## Future: server-side URL ingestion (Phase 3)

Today when the browser extension sends a URL:

```text
extension → /analyze → WS {type:'url', ...} → phone → Jina → LLM → Item
```

Phase 3 moves the pipeline to the server:

```text
extension → /analyze → (server fetches Jina, runs LLM, parses sections)
                     → WS {type:'item-ready', item:{...}} → phone stores it
```

Cuts latency, works when the phone has no OpenRouter key, and puts the
resource-intensive work on whatever machine the server is running on.
Not yet implemented.

## Running remotely

Because the server, phone, and extension are decoupled, you can host the
LLM on a beefy machine and reach it from your laptop/phone over Tailscale:

```bash
# on the workstation
nutshell-server --ollama --ollama-model qwen2.5:7b

# on your laptop / phone: point at the Tailscale IP
# 100.x.y.z:4242 + API key
```

The server binds `0.0.0.0` so Tailscale just works. The PSK encryption means
the traffic is safe over untrusted hops too — though Tailscale already
encrypts at the network layer via WireGuard.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `/health.features.llm` is `false` despite `--ollama` | Ollama daemon not running | `ollama serve` or `brew services start ollama` |
| Probe error `model "X" not pulled` | Exactly what it says | `ollama pull X` |
| Probe error `fetch failed` | Wrong `--ollama-url` or firewalled | Confirm with `curl $URL/api/tags` |
| `/llm` returns `502` | Ollama returned an error to the proxy | Check Ollama's own logs (`~/.ollama/logs/server.log`) |
| `/llm` returns `503` when you expected `200` | Probe failed at startup | Restart after fixing the probe cause |

## See also

- [`architecture.md`](architecture.md) — server internals
- [`api.md`](api.md) — endpoint reference
- Ollama's OpenAI compatibility docs:
  <https://github.com/ollama/ollama/blob/main/docs/openai.md>
