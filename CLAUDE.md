# CLAUDE.md — `nutshell-server`

Claude Code entry point. The canonical guide — architecture, repo layout,
endpoints, conventions, gotchas — lives in [`AGENTS.md`](AGENTS.md).
**Read it before making changes.**

This file only adds Claude-specific notes.

---

## Before editing code

1. Read [`AGENTS.md`](AGENTS.md).
2. For wire-format work, also read [`docs/api.md`](docs/api.md) — the
   changelog at the bottom is the source of truth for what shipped when.
3. For crypto changes, read [`docs/crypto.md`](docs/crypto.md) and verify
   the phone's `src/client/crypto.ts` and the browser extension's
   `crypto.js` still round-trip against your server changes.

## Tooling quirks

- **Node 18+ required** — uses built-in `fetch` and `AbortSignal.timeout`.
- **No test suite yet.** Manual flow:
  1. `node bin/cli.js --no-docs` in one terminal
  2. `curl localhost:4242/health` — expect `{ok: true, ...}`
  3. The VS Code extension or the phone app exercises the encrypted paths
- **Debugging clients.** Clients logging `[auth] key rejected` means the
  PSK doesn't match — look for stale `.nutshell-api-key` files in either
  end.
- **Key file location** is important. Server writes `.nutshell-api-key` to
  `process.cwd()` by default, not to `__dirname`. Starting the server from
  a different folder means the key file lands elsewhere — the VS Code
  extension fallback (`nutshell.apiKey` setting) exists specifically for
  this scenario.

## Wire-change procedure

Changing any endpoint shape, event payload, or crypto format requires
coordinated updates:

1. Update server code + [`docs/api.md`](docs/api.md) changelog.
2. Update `even/src/client/` (phone).
3. Update `nutshell-vscode/lib/` (extension — usually only `server-client.js`).
4. Update `nutshell-browser/` (browser extension).
5. Bump the server's `package.json` version appropriately.

Do not ship a wire change in one repo without the matching client updates.

## Memory

`memory/` is your private scratch (gitignored). The project's public
knowledge lives in `AGENTS.md` and `docs/` — never copy memory content into
project docs.

## Style

- Logs: terse, lowercase, action-first. No emojis.
- CommonJS only.
- Keep dependencies minimal (`ws`, `chokidar`, nothing else). Justify any
  additions in the commit message.
