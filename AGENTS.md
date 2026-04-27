# Repository Guide for AI Coding Agents — `nutshell-server`

Canonical onboarding file for agents contributing to the Nutshell server.
Read top-to-bottom before touching code. [CLAUDE.md](CLAUDE.md) delegates
here plus adds Claude-specific notes.

---

## What this is

`nutshell-server` is a **local HTTP + WebSocket relay** for the Nutshell
phone app. It does three jobs:

1. Serves project docs (markdown files) to the phone, scoped by project.
2. Relays URLs from the browser extension to connected phones.
3. Optionally proxies LLM calls to a local Ollama instance (OpenAI-compatible
   `/llm` endpoint) so the phone can skip OpenRouter.

It is **multi-tenant**: one server hosts any number of projects, each
registered at runtime by a client (usually the VS Code extension). Projects
have their own `docsPath` and chokidar watcher.

All transport except `GET /health` is AES-256-GCM encrypted with a
pre-shared key (PSK) that never crosses the wire. See
[`docs/crypto.md`](docs/crypto.md) for the threat model.

Published to npm as `nutshell-server`; also importable as a library
(`const { createServer } = require('nutshell-server')`).

---

## Quick start

```bash
npm install                          # once
node bin/cli.js                      # bare URL-relay start (no default project)
node bin/cli.js --docs ./my-notes    # legacy single-tenant: register "default" project
npm run start:llm                    # --no-docs + --ollama + daemon/model setup
npm run start:llm -- --install       # auto-install Ollama (macOS brew / Linux script)
```

First run prints the generated API key and saves it to `.nutshell-api-key`
in the CWD. Paste that key into the phone, browser extension, and VS Code
extension.

Ports: default `4242`, override with `--port` or `NUTSHELL_PORT`. See
[`docs/cli.md`](docs/cli.md) for every flag.

---

## Repo layout

```
.
├── bin/cli.js             # CLI entrypoint — parses args, calls createServer
├── index.js               # Library entrypoint — the full createServer function
│
├── lib/
│   ├── crypto.js          # AES-256-GCM PSK envelope; {iv, data} base64
│   ├── auth.js            # ensureKey — generate/load .nutshell-api-key
│   ├── files.js           # scanFiles (recursive .md), readFile (traversal-guarded)
│   ├── watcher.js         # chokidar.watch wrapper per project
│   ├── llm.js             # Ollama probe + /v1/chat/completions passthrough
│   └── notes.js           # JSON notes store at <cwd>/notes/<id>.json
│
├── prompts/
│   ├── reformat-note.txt          # G2 reformat spec (used by VS Code transform)
│   └── reformat-note-compact.txt  # Shorter variant
│
├── scripts/
│   └── start-with-llm.sh  # Ollama setup + `node cli.js --no-docs --ollama ...`
│
├── docs/
│   ├── api.md             # Endpoint reference + changelog
│   ├── architecture.md    # Internals — project registry, watchers, WS lifecycle
│   ├── cli.md             # CLI flag reference
│   ├── crypto.md          # PSK AES-GCM scheme + threat model
│   └── ollama.md          # Local LLM integration
│
├── AGENTS.md · CLAUDE.md · README.md
└── package.json           # main=index.js, bin=cli.js
```

---

## Core architecture

### Project registry

In-memory `Map<projectId, {name, docsPath, watcher}>`. Clients register via
`POST /projects/register` (upsert-idempotent): sending the same `id` with new
fields replaces the old entry — the old watcher is closed, a new one opens.

`id` is stable across the project lifetime — the VS Code extension generates
a UUID v4 and stores it in `.vscode/nutshell-project-id`. The server uses
`id` as the primary key for all project-scoped operations.

### Notes store

Separate from projects. Stores user-authored notes from the phone (file
ingests, URL summaries, voice asks) as JSON files at `<cwd>/notes/<id>.json`
(default; `notesDir` option overrides). One file per note, no database.

The phone is the schema authority — this server round-trips opaque `Item`
objects keyed by `id`. We validate only that `id` matches
`/^[A-Za-z0-9._-]{1,128}$/` so writes can't escape `notesDir`. See
[`lib/notes.js`](lib/notes.js) for the on-disk layer.

Notes survive server restarts. They survive the phone's webview being wiped
(which is the whole reason this exists — see the phone's
`docs/notes-sync.md` for the full reconciliation algorithm).

### Endpoints

All encrypted except `/health`. Full reference: [`docs/api.md`](docs/api.md).

| Method · Path | Purpose |
|---|---|
| `GET /health` | Plaintext liveness + feature advertisement (used before entering the encrypted flow) |
| `POST /ping` | Encrypted auth round-trip — confirms the caller has the right key |
| `POST /projects` | List registered projects |
| `POST /projects/register` | Upsert a project (opens watcher) |
| `POST /projects/unregister` | Remove a project (closes watcher) |
| `POST /files` | List `.md` files in a project (body: `{projectId}`) |
| `POST /file` | Read one file's raw markdown (body: `{projectId, id}`) — traversal-guarded |
| `POST /notes` | List user notes from the phone (metadata only) |
| `POST /note` | Read one note's full payload (body: `{id}`) |
| `POST /notes/upsert` | Create/update a note from the phone (idempotent on `id`) |
| `POST /notes/delete` | Remove a note (body: `{id}`) |
| `POST /analyze` | Accept a URL from the browser extension, broadcast to WS clients |
| `POST /llm/ping` | Fast liveness probe for the local LLM (~800 ms timeout) |
| `POST /llm` | OpenAI-compatible chat completions passthrough to Ollama (only when `--ollama`) |
| `WS /events` | Event stream — file events, project events, URL events, note events |

### WebSocket lifecycle

1. Client opens the WS (no query string, no headers beyond upgrade).
2. Client sends an **encrypted** `{type: "hello"}` frame within 5 seconds.
3. Server decrypts; on success sends `{type: "welcome", name, projects[]}`.
4. Server streams events. Close codes: `4400` malformed, `4401` unauth/timeout.

Emitted events (all encrypted):

| Type | Payload |
|---|---|
| `welcome` | `{type, name, projects[]}` (first frame after hello) |
| `project-registered` | `{type, id, name}` on register |
| `project-unregistered` | `{type, id}` on unregister |
| `file-added` · `file-updated` · `file-removed` | `{type, projectId, id, name?, folder?}` from chokidar |
| `url` | `{type, url, title, receivedAt}` from `POST /analyze` (global — not project-scoped) |

### Convenience script

`scripts/start-with-llm.sh` (aliased `npm run start:llm`) is the common entry
point for dev. It:

1. Checks Ollama is installed (`--install` to auto-install via brew/script).
2. Starts the Ollama daemon if not already running.
3. Pulls the model if not already on disk.
4. Execs `node bin/cli.js --no-docs --ollama ...`.

**Why `--no-docs`?** The script runs from `scripts/../` = `nutshell-server/`.
Without `--no-docs` the server's default `./docs` would register the
*server's own API docs folder* as a default project — the bug that produced
a stray `Nutshell Server (0)` row on the glasses. Projects should only be
registered by clients at runtime.

To run with a legacy single-tenant default project, invoke the CLI directly:
`nutshell-server --docs ./my-notes --ollama`. `--no-docs` always wins over
`--docs` when both are set, so passthrough args won't override the script.

### Auto-updater (deploy machines)

For machines that exist solely to host the server, `scripts/install-updater.sh`
sets up a 60-second polling loop that does `git fetch && git reset --hard
origin/main` and restarts via `start-with-llm.sh` whenever new commits land.
State lives at `~/.nutshell/` — outside the repo on purpose, since
`git reset --hard` would wipe anything inside it. Never move runtime state
(notes, keys, PID files) into the repo. See [`docs/auto-update.md`](docs/auto-update.md)
for the full story.

---

## Conventions

### Code style

- CommonJS (`require`/`module.exports`). Don't convert to ESM unless the whole
  repo moves together.
- Node 18+ (relies on built-in `fetch`, `AbortSignal.timeout`).
- No framework — `http`, `ws`, `chokidar` only. Keep it that way.
- **No emojis in log output** or doc prose. The user is strict on this.
  UI-visible strings that quote the phone's glasses labels (e.g. describing
  `📡 <Name> (N)` rows) are the narrow exception.

### Logging

Startup banner goes to stdout directly. Runtime logs are plain `console.log`
with short action-first messages — the server is CLI-launched and its output
is already scoped.

### Versioning

- `package.json` version bumps on every wire change (patch for fixes, minor
  for non-breaking features, major for wire-incompatible changes).
- [`docs/api.md`](docs/api.md) has a changelog section — update it with every
  wire change.

### When to update docs

- New endpoint or changed payload → [`docs/api.md`](docs/api.md) + changelog.
- New CLI flag → [`docs/cli.md`](docs/cli.md).
- New crypto behaviour → [`docs/crypto.md`](docs/crypto.md).
- New internal module → [`docs/architecture.md`](docs/architecture.md).

---

## What NOT to do

- **Don't add server state that isn't represented in-memory or by chokidar.**
  The server is intentionally stateless modulo the project registry. No
  database, no persistent queue.
- **Don't commit `.nutshell-api-key`.** Already gitignored — verify your
  editor isn't bypassing the rule.
- **Don't log API keys, decrypted payloads, or request bodies.** The crypto
  layer lets a packet sniffer see only ciphertext; don't leak plaintext via
  logs.
- **Don't assume caller identity beyond "has the PSK".** The key *is* the
  identity. No per-project keys, no role-based anything. If a caller
  decrypted a request, they can register or unregister any project.
- **Don't tighten path traversal in `lib/files.js` without reading the
  tests-you-must-still-write.** The current guard resolves the requested
  path absolutely and verifies it's a descendant of `docsPath`. Change it
  carefully — symlinks, Windows path separators, and double-slash escapes
  are all prior failure modes.
- **Don't add cross-project leaks.** `/files` and `/file` must reject
  requests without a `projectId`. `GET /analyze` is global (URLs are
  broadcast to every connected WS client by design) but file access never
  should be.

---

## Related

### Sibling repos

| Repo | Relationship |
|---|---|
| [`nutshell-vscode`](https://github.com/double-r-squared/nutshell-vscode) | Primary client — registers projects, spawns server if none running |
| [`nutshell-browser`](https://github.com/double-r-squared/nutshell-browser) | URL relay source — calls `/analyze` |
| [`even` (phone app)](https://github.com/refact0r/even) | Consumer — reads projects, opens WS, runs LLM calls through `/llm` |

### Docs

- [`docs/api.md`](docs/api.md) — endpoint + wire reference (authoritative)
- [`docs/architecture.md`](docs/architecture.md) — internals
- [`docs/cli.md`](docs/cli.md) — flags + recipes
- [`docs/crypto.md`](docs/crypto.md) — envelope format + threat model
- [`docs/ollama.md`](docs/ollama.md) — LLM proxy
