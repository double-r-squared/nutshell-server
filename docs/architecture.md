# Architecture

`nutshell-server` is a small, self-contained Node.js server that does three
things:

1. **Doc streaming** — scans a folder of markdown files, serves them over
   encrypted HTTP, and broadcasts file changes via WebSocket
2. **URL relay** — accepts URLs from the Nutshell browser extension and
   forwards them to connected phones
3. **LLM proxy** (optional) — mirrors the OpenAI chat completions shape so
   phones can route their inference through a local Ollama instance

No framework. Node's built-in `http` + [`ws`](https://www.npmjs.com/package/ws)
for the socket server + [`chokidar`](https://www.npmjs.com/package/chokidar)
for file watching. That's the whole dependency surface.

## System context

```text
┌─────────────────────┐      ┌─────────────────────┐
│ VS Code extension   │      │ Browser extension   │
│ (embeds this server)│      │ (client only)       │
└──────────┬──────────┘      └──────────┬──────────┘
           │                            │
           ▼                            ▼
        ┌─────────────────────────────────────┐
        │ nutshell-server (this)              │
        │                                     │
        │  bin/cli.js  ─► createServer(opts)  │
        │                  │                  │
        │           ┌──────┴───────┐          │
        │           ▼              ▼          │
        │        HTTP 4242      WS /events    │
        └──────────────┬──────────────────────┘
                       │  LAN / Tailscale
                       ▼
          ┌─────────────────────────────┐
          │ Phone companion app         │
          └─────────────────────────────┘
```

The CLI is a thin wrapper around the library entry. Anything that runs
server-side (VS Code extension, `npx`, a future Electron shell) can import
`createServer` directly.

## File layout

```text
nutshell-server/
├── bin/
│   └── cli.js             # CLI entry, flag parsing, banner
├── index.js               # Library entry — createServer(opts)
├── lib/
│   ├── auth.js            # API key bootstrap (.nutshell-api-key file)
│   ├── crypto.js          # AES-256-GCM envelope (Node crypto)
│   ├── files.js           # scanFiles, readFile, folderId derivation
│   ├── watcher.js         # chokidar setup, typed file events
│   └── llm.js             # Ollama probe + /v1/chat/completions proxy
├── prompts/
│   ├── reformat-note.txt          # Full G2 reformat spec
│   └── reformat-note-compact.txt  # Trimmed spec for small local models
├── scripts/
│   └── start-with-llm.sh  # One-command Ollama setup + server start
├── docs/                  # This folder
├── package.json
└── README.md              # High-level overview
```

## Entry points

### Library: `createServer(options)`

```js
const { createServer } = require('nutshell-server')
const server = createServer({
  port: 4242,
  docsPath: './docs',       // null for URL-relay-only
  name: 'My Project',
  keyFilePath: './.nutshell-api-key',
  ollama: {                 // omit to disable the /llm proxy
    url: 'http://localhost:11434',
    model: 'llama3.2:3b',
  },
})

await server.start()
console.log(server.apiKey)     // paste into phone + extension
await server.stop()            // graceful shutdown
```

Returned object also exposes `isFirstRun`, `docsExist`, `llmReady`,
`llmProbeError`, `llmModel`. The VS Code extension reads these to render its
status bar item.

### CLI: `bin/cli.js`

Parses argv into the same options bag, prints the startup banner, wires SIGINT
to `server.stop()`. See `docs/cli.md` for the full flag list.

## Request routing

`handleRequest` in `index.js` is a linear if-chain — there are only a handful
of routes and a router dep would be overkill. Order of checks:

1. `OPTIONS` → `204` with CORS headers (for the browser extension)
2. `GET /health` → plaintext JSON (no auth)
3. `POST /ping` → encrypted auth check
4. `POST /files` → encrypted file list
5. `POST /file` → encrypted single-file content
6. `POST /llm` → encrypted LLM proxy (`503` if LLM disabled)
7. `POST /analyze` → encrypted URL event broadcast
8. Anything else → `404`

All encrypted endpoints follow the same skeleton:

```js
try {
  payload = await decryptBody(req)
} catch {
  sendJson(res, 401, { error: 'Unauthorized' })
  return
}
// ... handle payload
sendEncrypted(res, 200, JSON.stringify(responseBody))
```

If decryption fails, the auth tag didn't validate — sender didn't know the
key. That's the only auth mechanism; there is no separate Bearer token.

## WebSocket lifecycle

```text
client TCP connect ──► HTTP upgrade /events ──► wss.handleUpgrade
                                                   │
                                                   ▼
                                         connection event
                                                   │
                   ┌───────────── 5s timer ────────┤
                   │                                │
                   │ (no hello)                     │ (hello frame)
                   ▼                                ▼
            close 4401                     verify via decrypt
                                                   │
                                                   ▼
                                   mark authenticated; add to clients
                                                   │
                                                   ▼
                                         broadcast events as they come
```

- Hello frame must decrypt to `{ type: "hello" }` within
  `WS_HELLO_TIMEOUT_MS` (5 s). Otherwise → `close(4401)`
- File watcher events and `/analyze` both call `broadcast(event)`, which
  encrypts each event per-client and skips non-`OPEN` sockets
- No reconnect logic on the server side — clients do the backoff

## Configuration resolution

In order of precedence (highest wins):

1. CLI flag (`--port`, `--docs`, `--ollama`, etc.)
2. Environment variable (`NUTSHELL_PORT`, `NUTSHELL_DOCS`, `NUTSHELL_OLLAMA`,
   etc.)
3. Hard-coded default

`docsPath` is always resolved against `process.cwd()` so running the server
from a project root picks up `./docs/` by default.

## Feature flags on `/health`

`/health` returns both liveness and what the server actually supports:

```json
{
  "ok": true,
  "name": "My Project",
  "features": {
    "docs": true,            // docsPath exists and has files
    "url": true,             // always true today
    "llm": true,             // --ollama is set AND probe succeeded
    "llmModel": "llama3.2:3b"
  }
}
```

Clients use this to decide what to show in their UI (e.g., the phone's
"Use server LLM" toggle is disabled unless `features.llm` is `true`).

## See also

- [`api.md`](api.md) — endpoint reference with request/response shapes
- [`crypto.md`](crypto.md) — PSK scheme, wire format, threat model
- [`ollama.md`](ollama.md) — local LLM integration details
- [`cli.md`](cli.md) — CLI flags + env vars
