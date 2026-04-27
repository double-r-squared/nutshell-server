# nutshell-server

Local server for [Nutshell](https://github.com/...) — streams project docs and
URLs from your browser to the Even Realities G2 glasses companion app.

- **Multi-project doc streaming** — any number of clients can register
  their own docs folders. Each project shows up as its own row on the glasses
  home screen
- **URL relay** — accepts URLs from the Nutshell browser extension and
  broadcasts them to the phone app (which runs them through the article-ingest
  pipeline)
- **Optional local LLM proxy** — with `--ollama`, exposes an OpenAI-compatible
  `/llm` endpoint so the phone can skip OpenRouter entirely
- **End-to-end encrypted** with a pre-shared key; the key itself is never
  transmitted, so a packet sniffer on your LAN sees only opaque ciphertext

## Install

```bash
npm install -g nutshell-server
```

Or run once without installing:

```bash
npx nutshell-server
```

## Run

Without any args the server starts URL-relay-only:

```bash
nutshell-server
```

First run prints the generated API key. Paste it into:

- Your **Nutshell browser extension** (for URL analysis)
- The **Nutshell phone app** (`Settings → Nutshell Servers`)
- Each **Nutshell VS Code extension** — they auto-read it from
  `.nutshell-api-key` in the workspace root

### Auto-updates (deploy machines)

If this machine exists to host the server (not edit it), set up the
auto-updater so pushes to `main` deploy themselves:

```bash
bash scripts/install-updater.sh --ollama
```

Polls every minute, in-place `git reset --hard origin/main`, restart on
change. See [`docs/auto-update.md`](docs/auto-update.md).

### Register projects

In the multi-project world, the VS Code extension is how folders usually get
registered. But for a one-off CLI run, pass `--docs`:

```bash
nutshell-server --docs ./my-docs --name "My Docs"
```

That registers the folder as a `default` project at startup. To register more
projects at runtime, use `POST /projects/register` (the VS Code extension does
this for you).

## Options

```text
nutshell-server [options]

  -p, --port <port>       Port to listen on (default 4242)
  -d, --docs <path>       Docs folder to serve (default ./docs)
      --no-docs           URL relay only (no file serving)
  -n, --name <name>       Display name on the phone (default "Nutshell Server")
      --key-file <path>   API key file location (default ./.nutshell-api-key)
      --ollama            Enable the local LLM proxy via Ollama
      --ollama-model <m>  Model to use (default llama3.2:3b)
      --ollama-url <url>  Ollama address (default http://localhost:11434)
  -h, --help              Show help
```

Environment variables: `NUTSHELL_PORT`, `NUTSHELL_DOCS`, `NUTSHELL_NAME`,
`NUTSHELL_OLLAMA`, `NUTSHELL_OLLAMA_MODEL`, `NUTSHELL_OLLAMA_URL`.

## Local LLM (optional)

The server can proxy chat completions to a local Ollama instance so the phone
doesn't need an OpenRouter key. The wire contract is identical to OpenRouter
(OpenAI chat completions format), so the phone can route any existing call
through the server by changing the URL.

### Setup (one command)

```bash
npm run start:llm -- --install
```

That's it. The script will:

1. Install Ollama if missing (via `brew` on macOS or the official install
   script on Linux)
2. Start the Ollama daemon if it isn't running
3. Pull `llama3.2:3b` if it isn't on disk
4. Start `nutshell-server --ollama`

Drop `--install` on subsequent runs — it's only needed the first time:

```bash
npm run start:llm
```

Pass-through extra flags after `--`:

```bash
npm run start:llm -- --port 4245 --docs ./my-docs
OLLAMA_MODEL=qwen2.5:7b npm run start:llm
```

### Setup (manual)

If you'd rather drive it step-by-step:

```bash
# macOS:  brew install ollama
# Linux:  curl -fsSL https://ollama.com/install.sh | sh
ollama serve &
ollama pull llama3.2:3b
nutshell-server --ollama
```

The startup banner reports LLM status. If Ollama is reachable and the model is
pulled, `POST /llm` and `features.llm: true` on `/health` go live. If not, the
server runs as usual and the `/llm` endpoint returns `503` — other features
(docs streaming, URL relay) are unaffected.

### Model recommendations

| Model | Size | Use it when |
| --- | --- | --- |
| `llama3.2:3b` | 2 GB | **Default.** Best quality per byte for the reformat task; runs on any 8 GB Mac. |
| `qwen2.5:3b` | 2 GB | Strong at structured output; slightly better at following rules. |
| `qwen2.5:7b` | 4.7 GB | Noticeably higher quality if you have 16 GB+ RAM. |
| `llama3.2:1b` | 1.3 GB | Tiny + fast, but struggles with the full reformat harness. Good for short Ask-style queries. |
| `phi3.5:3.8b` | 2.2 GB | Microsoft's compact model. |

Override with `--ollama-model qwen2.5:7b` for example.

### Running on another machine

Because `nutshell-server`, the phone, and the browser extension are decoupled,
you can host the LLM somewhere beefier (a workstation with a GPU) and reach it
from your laptop / phone over Tailscale:

```bash
# on the beefy box:
nutshell-server --ollama --ollama-model qwen2.5:7b

# on your laptop / phone, point at the Tailscale IP:
#   100.x.y.z:4242  + API key from the banner
```

### Endpoint shape

`POST /llm` (encrypted) takes the OpenAI chat completions request body
verbatim and returns the OpenAI chat completions response verbatim. The server
overrides the `model` field with its configured Ollama model; the phone is
free to send whatever model identifier it wants (it'll be ignored).

See `lib/llm.js` for the proxy implementation.

## Security model

All payloads are AES-256-GCM encrypted with a key derived from the shared API
key (`aesKey = SHA-256(apiKey)`). **The API key itself is never transmitted** —
it's a pre-shared secret. Authentication is implicit: a successful decryption
proves the sender knew the key.

The one non-encrypted endpoint is `GET /health`, which returns
`{ ok: true, name: "...", features: {...} }` for connection probing.

## Endpoints

| Method | Path | Encrypted | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | no | Liveness probe + feature flags |
| `POST` | `/ping` | yes | Key check (decrypt round-trip) |
| `POST` | `/projects` | yes | List registered projects |
| `POST` | `/projects/register` | yes | Add/update a project `{id, name, docsPath}` |
| `POST` | `/projects/unregister` | yes | Remove a project `{id}` |
| `POST` | `/files` | yes | List markdown files for a project `{projectId}` |
| `POST` | `/file` | yes | Read one file `{projectId, id}` |
| `POST` | `/analyze` | yes | Queue URL for phone pipeline (`{url, title?}`) |
| `POST` | `/llm` | yes | OpenAI-compatible chat completion via Ollama |
| `WS` | `/events` | yes | Live file + project + URL events |

Full reference: [`docs/api.md`](docs/api.md).

### Wire format

Every encrypted request/response body is:

```json
{ "iv": "<base64 12-byte IV>", "data": "<base64 ciphertext+16-byte GCM tag>" }
```

### WebSocket handshake

Client sends an encrypted `{ "type": "hello" }` frame within 5 seconds of
connecting. Server replies with an encrypted welcome and then forwards:

```json
{ "type": "file-added",   "id": "...", "name": "...", "folder": "..." }
{ "type": "file-updated", "id": "..." }
{ "type": "file-removed", "id": "..." }
{ "type": "url",          "url": "https://...", "title": "...", "receivedAt": 1714000000000 }
```

## Library usage

```js
const { createServer } = require('nutshell-server')

const server = createServer({
  port: 4242,
  docsPath: './docs',
  name: 'My Project',
})

await server.start()
console.log('API key:', server.apiKey)
```

The VS Code extension uses this entry to embed the server in-process.

## G2 reformat prompt

`prompts/reformat-note.txt` is the formatting spec for Even Realities G2
display. The phone app uses it to reformat arbitrary notes on demand, and the
Nutshell VS Code extension uses the same prompt when transforming a docs folder
into its G2-formatted mirror.

## License

MIT
