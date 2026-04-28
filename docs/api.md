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
  "version": "0.7.1",
  "gitSha": "c15f8c7",
  "features": {
    "multiProject": true,
    "url": true,
    "llm": true,
    "llmModel": "llama3.2:3b",
    "push": true
  },
  "projectCount": 3,
  "projectIds": ["proj-uuid-1", "proj-uuid-2", "proj-uuid-3"]
}
```

`projectIds` is the list of project UUIDs the server currently knows
about. Random UUIDs; safe to expose unauthenticated. Clients use this to
detect when their project has been evicted (server restart, manual
unregister) and re-register without re-pushing on every heartbeat.

`version` is the server's `package.json` version. `gitSha` is the short
SHA of the running checkout (`git rev-parse --short HEAD`). Both fields
are best-effort: absent when the server isn't running from a git
checkout (npm-installed package, downloaded tarball). Clients should
treat them as optional informational strings — never gate behavior on
them.

`features.push` advertises that the server understands push-mode
registrations (`POST /projects/register` with `files[]`) and the
`/projects/files/upsert` and `/projects/files/delete` endpoints.

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
  { "id": "proj-uuid-1", "name": "Alpha", "mode": "fs",   "docsPath": "/Users/you/alpha/docs" },
  { "id": "proj-uuid-2", "name": "Beta",  "mode": "push", "fileCount": 42 }
]
```

`mode` distinguishes how the server obtained the project's files:

- `fs`   — server filesystem-watches `docsPath` via chokidar. Used when the
  Nutshell client (typically the VS Code extension) and the server live on
  the same machine.
- `push` — extension scans the local filesystem and streams files to the
  server, which caches them in memory. Used when the server is on a
  different machine and cannot read the user's local disk.

The phone never has to care which mode a project uses — `/files` and
`/file` return identical shapes either way.

## `POST /projects/register`

Add or update a project. Idempotent — sending the same `id` with new fields
upserts the existing entry (old watcher / cached file set is replaced).

The endpoint accepts two payload shapes; the server picks the project's
mode at register time based on which fields are present.

**Request — fs mode (decrypted)**:

```json
{
  "id": "proj-uuid-1",
  "name": "Alpha",
  "docsPath": "/Users/you/alpha/docs"
}
```

**Request — push mode (decrypted)**:

```json
{
  "id": "proj-uuid-1",
  "name": "Alpha",
  "files": [
    {
      "id": "overview.md",
      "name": "overview",
      "folder": "",
      "modifiedAt": 1714000000000,
      "size": 4096,
      "content": "# Overview\n\nFull markdown body of the file..."
    }
  ]
}
```

The push payload carries the entire file set with content baked in.
Acts as a snapshot: re-registering replaces the project's cached file
set atomically. Server computes `title` from each file's content (first
H1 in the first 2 KB) so the response shape of `/files` matches fs mode.

`id` should be stable across the lifetime of the project. The VS Code
extension generates a UUID v4 and stores it in `.vscode/nutshell-project-id`
inside the workspace.

**Response 200 (decrypted)**:

```json
{
  "ok": true,
  "project": { "id": "proj-uuid-1", "name": "Alpha", "mode": "push", "fileCount": 1 }
}
```

**Response 400 (decrypted)**:
- `{"error": "Missing id or name"}`
- `{"error": "Payload must include either docsPath (fs mode) or files[] (push mode)"}`
- `{"error": "docsPath does not exist: ..."}` (fs mode)
- `{"error": "Invalid file entry in push payload"}` (push mode)

Push-mode register accepts envelopes up to 50 MB; fs-mode register stays
on the default 64 KB envelope budget.

Side effect: server broadcasts `{type: "project-registered", id, name}` over
WebSocket. In push mode, no `file-added` events fire for the initial
snapshot — the phone learns the file set by calling `/files` on connect.

## `POST /projects/files/upsert` (push mode only)

Push a single file's content into a push-mode project. Idempotent.

**Request (decrypted)**:

```json
{
  "projectId": "proj-uuid-1",
  "file": {
    "id": "overview.md",
    "name": "overview",
    "folder": "",
    "modifiedAt": 1714000000000,
    "size": 4096,
    "content": "# Overview\n\n..."
  }
}
```

**Response 200 (decrypted)**: `{ "ok": true, "created": true }` — `created`
is `true` on first sight of this `id`, `false` on overwrite.

**Response 400 (decrypted)**:
- `{"error": "Project is not in push mode"}` — the project was registered
  in fs mode; use file system writes to update its docs instead.
- `{"error": "Invalid file payload"}`

**Response 404 (decrypted)**: `{"error": "Project not found"}`

Side effect: WS broadcast `{type: "file-added", projectId, id, name, folder}`
on first sight, or `{type: "file-updated", projectId, id, name, folder}` on
overwrite. The phone uses these to invalidate any cached read of the file.

Envelopes up to 10 MB are accepted (covers any practical single .md file).

## `POST /projects/files/delete` (push mode only)

Remove a file from a push-mode project's cached set.

**Request (decrypted)**: `{ "projectId": "proj-uuid-1", "id": "overview.md" }`

**Response 200 (decrypted)**: `{ "ok": true, "removed": true }` — `removed`
is `false` if the id wasn't in the cache.

**Response 400 (decrypted)**: `{"error": "Project is not in push mode"}`
or `{"error": "Missing id"}`.

**Response 404 (decrypted)**: `{"error": "Project not found"}`

Side effect: WS broadcast `{type: "file-removed", projectId, id}` if the
file was actually present.

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

## `POST /broadcast-status`

Cross-client ingest-status relay. Used by clients that run their own
ingest pipeline (browser extension as of 0.6.0) to surface "I'm working
on it / done / errored" to other clients without participating in the
data path itself. Phone subscribes to the resulting WS event and drives
its `IngestStatus` slot.

**Request (decrypted)**:

```json
{
  "kind": "loading",
  "source": "extension",
  "label": "example.com — Article title",
  "message": "Sent · 0 phones"
}
```

- `kind` (required): one of `idle`, `loading`, `success`, `warning`, `error`.
- `source` (required): one of `phone`, `extension`.
- `label` (optional, ≤256 chars): short identifier of what's being worked on.
- `message` (optional, ≤256 chars): outcome text for `success` / `warning` / `error`.

Out-of-shape inputs (bad enum, bad type) land **400** rather than relaying
garbage. Length excess on `label` / `message` is silently truncated.

**Response 200 (decrypted)**: `{ "ok": true, "delivered": 1 }`

Side effect: WS broadcast to every connected client:

```json
{
  "type": "ingest-progress",
  "kind": "loading",
  "source": "extension",
  "label": "example.com — Article title",
  "receivedAt": 1714000000000
}
```

Fire-and-forget. The endpoint does not coordinate ordering or
deduplicate — clients should be tolerant of a `success` arriving before
the corresponding `loading` (rare but possible under packet reordering
on weak networks).

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
| `ingest-progress` | `{type, kind, source, label?, message?, receivedAt}` | `POST /broadcast-status` with `kind` ∈ `idle`/`loading`/`success`/`warning`/`error` |
| `server-status` | `{type, kind, source, label?, receivedAt}` | `POST /broadcast-status` with `kind: 'server-updating'` (auto-updater pre-shutdown signal) |

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

### 0.7.4 — `server-updating` pre-signal + `server-status` WS event

`POST /broadcast-status` now accepts `kind: 'server-updating'` with
`source: 'server'`. When that combination arrives, the server
broadcasts a different WS event type — `server-status` instead of
`ingest-progress` — so phones can drive a different UI surface
(server-update banner vs in-flight ingest hero).

Used by the auto-updater script: right before it kills the running
server for a `git reset --hard` cycle, it POSTs to its own
`/broadcast-status` with `{ kind: 'server-updating', source: 'server',
label: '<from-sha> → <to-sha>' }`. Connected phones receive the
event and show their "Server Updating…" banner immediately rather
than inferring it from the eventual WS disconnect.

Best-effort. The updater script silently skips the pre-signal if
curl/node/key-file is unavailable. Phone falls back to its WS
disconnect heuristic in that case (covered by phone 0.17.0).

### 0.7.3 — `POST /broadcast-status` for cross-client ingest progress

New endpoint and WS event. Lets clients that run their own ingest
pipeline (browser extension 0.6.0+) surface progress to other clients
without participating in the data path. Validated enum on `kind` and
`source`; 256-char cap on `label` and `message`. Wire-additive — older
clients ignore the new event type.

### 0.7.2 — `[notes] upsert rejected` logging

`POST /notes/upsert` previously responded 400 silently when the
payload's id failed `isValidId`. Now logs the offending id (and
requester address) on rejection, and the underlying error message on
the rare `notesStore.upsertNote` throw path. Unblocks future debugging
of "the phone said it sent the note but the file isn't on disk."

No wire-format change.

### 0.7.1 — `version` + `gitSha` on `/health`

`GET /health` now returns two new optional fields: `version` (from
`package.json`) and `gitSha` (short SHA of the running checkout, via
`git rev-parse --short HEAD`). Backwards-compatible — older clients
ignore the new fields, and clients written against 0.7.1 must treat
them as optional since servers running from non-git installs (npm,
tarball) won't populate `gitSha`.

The phone displays `[v0.7.1]` next to the server name in Settings and
exposes `v0.7.1 · <sha>` as a copyable row in the expanded server card,
so bug reports can include the exact commit the deploy box is running.

### 0.7.0 — banner redesign + connection QR + network flags

The CLI banner is rewritten to mirror the Even Terminal layout: ASCII
"E" logo on the left, a key/value column on the right (server name +
version, Tailscale, LAN, truncated key, CWD), the tagline, then a
connection block showing the full key, the connect URL, and a
QR-rendered version of the same URL.

**Localhost is no longer displayed anywhere** in the banner.
Every Nutshell client (phone, browser extension, VS Code extension)
connects from a different network namespace; localhost was always
misleading. The browser extension still defaults to `localhost:4242`
in its own popup as a same-machine convenience.

URL format encoded in the QR and printed below it:

```
http://<host>:<port>?key=<api-key>
```

Phone clients parse host + port + key from this URL to populate the
connection form. The query-string `?key=` is informational only — the
server's auth is unchanged (PSK envelope).

**New CLI flags:**

- `--tailscale` — only display the Tailscale address. Errors with a
  clear message if no Tailscale interface is detected. Useful when
  multiple network paths exist and you want to be unambiguous about
  which one phones should use.
- `--lan` — counterpart to `--tailscale`. Only display LAN.
- `--no-qr` — suppress the connection block (URL + QR + tagline).
  The VS Code extension passes this when spawning the server, since
  the extension already manages credentials directly via
  `.nutshell-api-key`.

The default (no flag) prefers Tailscale if present, otherwise falls
back to LAN. Both are displayed in the banner; the QR encodes the
primary (Tailscale) when available.

New dep: `qrcode-terminal` (~5 KB, MIT). No wire change.

Pairing clients: `nutshell-vscode` 0.4.2 (passes `--no-qr` on spawn),
`nutshell-browser` 0.4.0 (broader `host_permissions` + iOS hint).

### 0.6.0 — push-mode projects (remote-server support)

Servers can now hold project files in memory rather than reading from
disk, so a single Nutshell server on a remote machine (e.g. one reached
over Tailscale) can serve docs that live on the user's local laptop.

- `POST /projects/register` accepts a second payload shape:
  `{id, name, files: [{id, name, folder, modifiedAt, size, content}]}`.
  The presence of `files[]` puts the project in push mode (no chokidar,
  no disk reads). The legacy `{id, name, docsPath}` shape is unchanged
  and stays in fs mode.
- `POST /projects/files/upsert` — push a single file's full content into
  a push-mode project. Broadcasts `file-added` (first sight) or
  `file-updated` (overwrite).
- `POST /projects/files/delete` — remove a file. Broadcasts `file-removed`.
- `POST /files` and `POST /file` return identical shapes whether the
  project is fs- or push-mode; the phone needs no changes.
- `GET /health` now includes `projectIds: [...]` (random UUIDs, safe
  unauthenticated) and `features.push: true`. Clients use the id list to
  decide whether to re-register on heartbeat or no-op.
- Server `projectsList` and `projectSummary` include a `mode` field on
  each project entry (`fs` or `push`).
- Server-side payload limits raised: `/projects/register` accepts up to
  50 MB envelopes (covers the practical upper bound of a single
  project's full file set with envelope overhead). `/projects/files/upsert`
  accepts up to 10 MB. Other endpoints stay at 64 KB.

The phone (`even/`) is unchanged. Pairing client: `nutshell-vscode` 0.4.0+,
which switches to push mode automatically when `serverMode: "remote"`.

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
