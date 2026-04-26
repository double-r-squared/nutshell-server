# API reference

All requests and responses are JSON. Everything except `GET /health` is
wrapped in the encrypted envelope — see [`crypto.md`](crypto.md) for the
envelope format.

Statuses:

| Code | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad request (missing field, malformed body) |
| `401` | Decryption failed — sender doesn't know the key |
| `404` | File or project not found |
| `503` | Feature disabled (only from `/llm` when `--ollama` is off) |
| `502` | Upstream error (only from `/llm` when Ollama returns a fault) |

## `GET /health`

Plaintext. No auth. Used by clients to probe reachability before entering the
encrypted flow.

**Response 200**:

```json
{
  "ok": true,
  "name": "My Project",
  "features": {
    "multiProject": true,
    "url": true,
    "llm": true,
    "llmModel": "llama3.2:3b"
  },
  "projectCount": 3
}
```

## `POST /ping`

Round-trip encrypted auth check.

**Request (decrypted)**: `{}`

**Response 200 (decrypted)**:

```json
{ "ok": true, "name": "Nutshell Server" }
```

## `POST /projects`

List all projects currently registered on the server.

**Request (decrypted)**: `{}`

**Response 200 (decrypted)**:

```json
[
  { "id": "proj-uuid-1", "name": "Alpha",  "docsPath": "/Users/you/alpha/docs" },
  { "id": "proj-uuid-2", "name": "Beta",   "docsPath": "/Users/you/beta/docs" }
]
```

## `POST /projects/register`

Add or update a project. Idempotent — sending the same `id` with new fields
upserts the existing entry (old watcher is closed, new one opens).

**Request (decrypted)**:

```json
{
  "id": "proj-uuid-1",
  "name": "Alpha",
  "docsPath": "/Users/you/alpha/docs"
}
```

`id` should be stable across the lifetime of the project. The VS Code
extension generates a UUID v4 and stores it in `.vscode/nutshell-project-id`
inside the workspace.

**Response 200 (decrypted)**:

```json
{
  "ok": true,
  "project": { "id": "proj-uuid-1", "name": "Alpha", "docsPath": "..." }
}
```

**Response 400 (decrypted)**: `{"error": "docsPath does not exist: ..."}`
— or missing fields.

Side effect: server broadcasts `{type: "project-registered", id, name}` over
WebSocket.

## `POST /projects/unregister`

Remove a project.

**Request (decrypted)**: `{ "id": "proj-uuid-1" }`

**Response 200 (decrypted)**: `{ "ok": true, "removed": true }`
(`removed: false` if the project wasn't registered)

Side effect: WS broadcast `{type: "project-unregistered", id}`. The project's
watcher is closed; its files disappear from the phone's list.

## `POST /files`

List all `.md` files in a specific project.

**Request (decrypted)**:

```json
{ "projectId": "proj-uuid-1" }
```

**Response 200 (decrypted)**: JSON array of file entries.

```json
[
  {
    "id": "getting-started/overview.md",
    "name": "overview",
    "title": "Overview",
    "folder": "getting-started",
    "path": "getting-started/overview.md",
    "modifiedAt": 1714000000000,
    "size": 4096
  }
]
```

Field notes (unchanged from the pre-multi-tenancy version):

- `id` — POSIX-style path relative to the project's `docsPath`. Stable across
  restarts. Used as the file's primary key within the project
- `folder` — first path segment of `id`. Empty for root-level files
- `title` — first `# ` heading found in the first 2 KB; falls back to `name`
- `name` — filename without `.md` extension

**Response 404 (decrypted)**: `{"error": "Project not found"}`

## `POST /file`

Read one file's markdown content.

**Request (decrypted)**:

```json
{ "projectId": "proj-uuid-1", "id": "getting-started/overview.md" }
```

**Response 200 (decrypted)**: raw markdown text (UTF-8).

**Response 404 (decrypted)**: `{"error": "Not found"}` (file missing) or
`{"error": "Project not found"}` (unknown project ID).

Path traversal is blocked — the resolved absolute path must be a descendant
of the project's `docsPath`. Escaping returns `404`.

## `POST /notes`

List user notes (metadata only — content is fetched per-id via `POST /note`).
Used by the phone for the boot/reconnect reconciliation flow.

**Request (decrypted)**: `{}`

**Response 200 (decrypted)**: JSON array of summaries (newest first by
`createdAt`):

```json
[
  {
    "id": "item-1714000000000-abc123",
    "title": "Article title",
    "type": "long",
    "createdAt": 1714000000000,
    "updatedAt": 1714000000000,
    "qaCount": 0
  }
]
```

Empty array if no notes have been stored. The notes directory is created on
first access.

## `POST /note`

Read one note's full payload (sections, qas, everything).

**Request (decrypted)**:

```json
{ "id": "item-1714000000000-abc123" }
```

**Response 200 (decrypted)**: the full `Item` object, schema authority for
which is the phone repo's `src/types.ts`. Server doesn't validate.

**Response 404 (decrypted)**: `{"error": "Not found"}` — note id doesn't
exist on the server.

## `POST /notes/upsert`

Create or update a note. Idempotent on `id` — sending the same id with new
fields overwrites.

**Request (decrypted)**: a full `Item` object. Must have an `id` matching
`/^[A-Za-z0-9._-]{1,128}$/` (the phone uses `item-${ms}-${random6}` which
fits trivially).

**Response 200 (decrypted)**: `{ "ok": true, "id": "<id>", "created": true|false }`

**Response 400 (decrypted)**: `{ "error": "Missing or invalid id" }`

Side effect: WS broadcast `{type: "note-added", id, title}` if `created` was
true, or `{type: "note-updated", id, title}` otherwise.

## `POST /notes/delete`

Remove a note from the server. Used by the phone's per-note delete flow
(atomic both-sides) and by the "Discard server-only notes" sync prompt.

**Request (decrypted)**: `{ "id": "<id>" }`

**Response 200 (decrypted)**: `{ "ok": true, "removed": true|false }`
(`removed: false` if the note wasn't present)

Side effect: WS broadcast `{type: "note-removed", id}` if `removed` was true.

## `POST /analyze`

Broadcast a URL to all connected WebSocket clients. Used by the browser
extension. **Not scoped to any project** — URL events are global.

**Request (decrypted)**:

```json
{
  "url": "https://example.com/article",
  "title": "Article title (optional)",
  "preferLocalLlm": false
}
```

`preferLocalLlm` is optional. When `true`, phone clients receiving this URL
event will route the ingest through their local LLM (hard-prefer mode) if
their master `use-server-llm` toggle is on. Defaults to `false` / absent.

**Response 200 (decrypted)**: `{ "ok": true, "delivered": 1 }`

Side effect: WS broadcast to every connected client:

```json
{
  "type": "url",
  "url": "https://example.com/article",
  "title": "Article title",
  "preferLocalLlm": true,
  "receivedAt": 1714000000000
}
```

`preferLocalLlm` is only present in the WS event when the caller explicitly
set it to `true`. Clients should treat absence as `false`.

## `POST /llm/ping`

Fast liveness probe for the local LLM. Clients (the phone app) use this
before committing to a local-LLM call, so they can fall back to OpenRouter
quickly when Ollama is dead rather than hanging on a full chat-completion
request.

Internal probe has a short timeout (800 ms) so the ping itself is cheap
even when Ollama is unreachable.

**Request (decrypted)**: `{}`

**Response 200 (decrypted)**: `{ "ready": true, "model": "llama3.2:3b" }`

**Response 503 (decrypted)**: `{ "ready": false, "reason": "<short>",
"model": "llama3.2:3b" }` — reason values include:

- `"LLM not enabled on this server"` — server was started without `--ollama`
- `"timeout"` — Ollama didn't respond within 800 ms
- `"model \"<m>\" not pulled (run: ollama pull <m>)"` — Ollama up but the
  configured model isn't on disk
- `"tags <N>"` — Ollama replied with a non-200 on `/api/tags`

Clients should treat any non-200 as "not ready, route elsewhere."

## `POST /llm`

OpenAI-compatible chat completions proxy to local Ollama. Unchanged from
pre-multi-tenancy — not project-scoped.

See [`ollama.md`](ollama.md) for the full integration details and
[`api.md#post-llm-old`](#) for request/response shape (identical to
OpenRouter's chat completions).

## `WebSocket /events`

### Handshake

1. Client opens the WS (no query string)
2. Client sends an encrypted `{ "type": "hello" }` frame within 5 s
3. Server decrypts. On success sends back:

   ```json
   {
     "type": "welcome",
     "name": "Nutshell Server",
     "projects": [
       { "id": "proj-uuid-1", "name": "Alpha" },
       { "id": "proj-uuid-2", "name": "Beta" }
     ]
   }
   ```

4. Server starts delivering events

Close codes: `4400` malformed, `4401` unauthorized/timeout.

### Event types

All events are encrypted envelopes. Payloads:

| Type | Payload | Fires on |
| --- | --- | --- |
| `welcome` | `{type, name, projects[]}` | Immediately after successful hello |
| `project-registered` | `{type, id, name}` | `POST /projects/register` succeeds |
| `project-unregistered` | `{type, id}` | `POST /projects/unregister` succeeds |
| `file-added` | `{type, projectId, id, name, folder}` | Chokidar `add` for a `.md` file |
| `file-updated` | `{type, projectId, id}` | Chokidar `change` |
| `file-removed` | `{type, projectId, id}` | Chokidar `unlink` |
| `url` | `{type, url, title, receivedAt}` | `POST /analyze` succeeds (no project) |
| `note-added` | `{type, id, title}` | `POST /notes/upsert` creates a new note |
| `note-updated` | `{type, id, title}` | `POST /notes/upsert` overwrites existing |
| `note-removed` | `{type, id}` | `POST /notes/delete` succeeds |

Clients filter by `type` and dispatch. Note: the phone client (`even/`)
intentionally does not act on `note-*` events — the phone is the source
of truth for its own note set, so accepting a remote-initiated delete
would let any other client wipe local notes. The events are still
broadcast for future siblings (read-only dashboards, cross-device sync).

## `POST /admin/shutdown`

Graceful remote shutdown. Authenticated via the PSK envelope. The server
sends 200, then tears down listeners and exits after a short flush delay.

**Request (decrypted)**: `{}`

**Response 200 (decrypted)**: `{ "ok": true, "action": "shutdown" }`

Side effect: the server process calls `stop()` and exits with code 0
approximately 200 ms after responding. If the server is managed by a process
supervisor (pm2, systemd), it will be restarted by the supervisor.

## `POST /admin/restart`

Hot-restart: close all listeners and WebSocket connections, then re-create
and re-listen on the same port. Projects are cleared (clients re-register
via heartbeat). No process exit.

**Request (decrypted)**: `{}`

**Response 200 (decrypted)**: `{ "ok": true, "action": "restart" }`

Side effect: existing WS connections are dropped. The server is briefly
unreachable (~200 ms) while the HTTP listener restarts. Clients should
re-probe `/health` after a short delay.

---

## Changelog

### 0.5.1 — request and connection logging

Per-request and connection-lifecycle logging so remote-mode debugging
(e.g. from the VS Code extension) is no longer a silent black box.

- `[req] METHOD /path from <addr>` on every incoming request, then
  `[req] METHOD /path -> <status> in <ms>` on response (skipping
  `/health` heartbeats and `OPTIONS` preflight to avoid spam).
- `[auth] /<path> rejected from <addr> — key mismatch or malformed
  envelope` when the encrypted-envelope decrypt fails.
- `[projects] registered/re-registered/unregistered <id> "<name>" ->
  <path> (total: N)` for project lifecycle.
- `[ws] connection opened from <addr>` / `authenticated` /
  `hello timeout` / `auth rejected — key mismatch` / `closed`,
  with running client count.
- `[ws] broadcast <type> -> N client(s)` for outbound broadcasts.

No wire change. Internal cleanup: `module.exports` no longer re-exports
`encrypt` / `decrypt` (no consumer used them).

### 0.5.0 — remote admin endpoints

- New endpoint `POST /admin/shutdown` — authenticated graceful shutdown.
  Responds 200, then calls `stop()` + `process.exit(0)` after a 200 ms
  flush delay.
- New endpoint `POST /admin/restart` — authenticated hot-restart. Tears
  down all listeners, WS connections, and project watchers, then
  re-creates and re-listens on the same port. Projects are cleared
  (clients re-register via heartbeat).
- Used by `nutshell-vscode` 0.3.0+ in remote mode to manage the server
  lifecycle without SSH or manual intervention.

### 0.4.2 — `start-with-llm.sh` bootstraps Node.js

`bash scripts/start-with-llm.sh --install` now also installs Node.js + npm
when missing — via nvm on Linux (no sudo, $HOME-scoped, pinned to Node
20 by default) and Homebrew on macOS. It also runs `npm install` once if
`node_modules/` doesn't exist, and refuses to start on Node <18 with a
clear error instead of letting `node` blow up later.

This makes the script a true one-touch bootstrap on a fresh Linux box.
No wire change.

### 0.4.1 — `/llm` progress logging

`POST /llm` now logs three lines per request to stdout so operators can
follow inference progress. Concurrent requests are disambiguated by a short
random id:

```
[llm 4kp8a2] received — 12.3 KB, 3 messages
[llm 4kp8a2] inference start — model llama3.2:3b
[llm 4kp8a2] complete in 4.21 s · 1234 in + 567 out tokens
```

On failure: `[llm <id>] failed after <duration> — <reason>`. On rejection
(server has `--ollama` off or the startup probe failed):
`[llm <id>] rejected — <reason>`.

Token counts are taken from the upstream Ollama response's `usage` block;
omitted from the log line when absent. No wire change.

### 0.4.0 — server-backed notes

- New endpoint family: `POST /notes`, `POST /note`, `POST /notes/upsert`,
  `POST /notes/delete`. Stores user notes (file ingests, URL summaries,
  voice asks, etc.) as JSON files at `<cwd>/notes/<id>.json`. Survives
  server restarts. Not project-scoped — global to the server.
- New WS events: `note-added`, `note-updated`, `note-removed`.
- The phone (`even` 0.11.0+) uses these to persist notes outside the
  webview origin so they survive Even Hub repackages that wipe
  localStorage. See the phone's `docs/notes-sync.md` for the reconcile
  algorithm and the Sync/Discard prompt flow.
- Phone is the schema authority — server round-trips opaque `Item`
  objects, validating only the `id` (matches `/^[A-Za-z0-9._-]{1,128}$/`).
- Server option `notesDir` defaults to a `notes/` folder next to the
  `.nutshell-api-key` file. Can be overridden when calling
  `createServer({ notesDir })`.

### 0.3.1 — `/analyze` accepts `preferLocalLlm`

- `POST /analyze` now accepts an optional `preferLocalLlm: boolean` in the
  request body; when `true`, the WS `url` event includes it so phone
  clients can route the ingest through their local LLM for this specific
  URL. No breaking change — absent or `false` preserves the old behavior.
- Browser extension 0.3.0+ surfaces a "Send to local LLM on the phone"
  toggle that sets this flag.

### 0.3.0 — `POST /llm/ping` for fast client-side routing

- New endpoint `POST /llm/ping` — encrypted liveness probe with 800 ms
  timeout. Returns `{ready: true|false, reason?, model?}`.
- Phone clients (`even` 0.10.x+) hit this before committing to a local-LLM
  call; if `ready:false`, they fall back to OpenRouter fast rather than
  hanging on `/llm`.
- `lib/llm.js::probeOllama` now accepts a `timeoutMs` parameter; startup
  probe still uses 2 s, live probe uses 800 ms (`LIVE_PROBE_TIMEOUT_MS`).

### 0.2.2 — prompt updates: preserve code line breaks

- `prompts/reformat-note.txt` and `prompts/reformat-note-compact.txt` updated
  so the reformatter preserves line breaks inside code snippets. Previously
  some models flattened multi-line code into walls of text when pushed
  through the VS Code transform flow.
- No wire or endpoint changes.

### 0.2.1 — `start:llm` no longer registers a default project

- `scripts/start-with-llm.sh` / `npm run start:llm` now passes `--no-docs` by
  default. The previous behaviour was to register the server's own working
  directory (`./docs` → `nutshell-server/docs/`, the API-docs folder itself)
  as a default project, which showed up on the glasses as a stray `Nutshell
  Server (0)` row. Projects should only be registered by clients at runtime
- To run the script in legacy single-tenant mode, invoke the CLI directly
  (`nutshell-server --docs ./my-notes --ollama`); `--no-docs` wins over
  `--docs` when both are present
- No wire-protocol changes

### 0.2.0 — multi-tenancy

- `POST /projects`, `POST /projects/register`, `POST /projects/unregister` added
- `POST /files` now requires `projectId` in the body
- `POST /file` now requires `projectId` alongside `id`
- WS `welcome` now includes `projects[]`
- File events now include `projectId`
- `GET /health` reports `features.multiProject: true` and `projectCount`
- CLI `--docs <path>` still works: registers the folder as a `default` project
  at startup for one-off use
