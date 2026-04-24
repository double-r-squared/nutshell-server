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

## `POST /analyze`

Broadcast a URL to all connected WebSocket clients. Used by the browser
extension. **Not scoped to any project** — URL events are global.

**Request (decrypted)**:

```json
{ "url": "https://example.com/article", "title": "Article title (optional)" }
```

**Response 200 (decrypted)**: `{ "ok": true, "delivered": 1 }`

Side effect: WS broadcast to every connected client:

```json
{
  "type": "url",
  "url": "https://example.com/article",
  "title": "Article title",
  "receivedAt": 1714000000000
}
```

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

Clients filter by `type` and dispatch.

## Changelog

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
