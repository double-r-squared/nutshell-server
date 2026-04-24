# CLI reference

```text
nutshell-server [options]
```

## Flags

| Flag | Env var | Default | Description |
| --- | --- | --- | --- |
| `-p, --port <port>` | `NUTSHELL_PORT` | `4242` | TCP port to listen on |
| `-d, --docs <path>` | `NUTSHELL_DOCS` | `./docs` | Folder to serve (relative to `cwd`) |
| `--no-docs` | — | — | URL-relay-only mode; skip file serving |
| `-n, --name <name>` | `NUTSHELL_NAME` | `"Nutshell Server"` | Display name shown on the phone |
| `--key-file <path>` | — | `./.nutshell-api-key` | API key storage location |
| `--ollama` | `NUTSHELL_OLLAMA` | off | Enable the local LLM proxy |
| `--ollama-model <m>` | `NUTSHELL_OLLAMA_MODEL` | `llama3.2:3b` | Model to use when `--ollama` is on |
| `--ollama-url <url>` | `NUTSHELL_OLLAMA_URL` | `http://localhost:11434` | Ollama daemon address |
| `-h, --help` | — | — | Print help and exit |
| `-v, --version` | — | — | Print version and exit |

CLI flags take precedence over env vars.

## Common recipes

### Bare minimum

```bash
nutshell-server
```

Serves `./docs` at `localhost:4242`, generates an API key on first run.

### URL relay only (no docs)

```bash
nutshell-server --no-docs
```

Use this when running the server purely to catch URLs from the browser
extension.

### Custom doc folder + name

```bash
nutshell-server --docs ./my-notes --name "My Notes"
```

Name shows up on the phone's home screen as `My Notes (N)`.

### With local LLM

```bash
nutshell-server --ollama
# or let the convenience script set everything up:
npm run start:llm
```

### LLM on a different machine over Tailscale

```bash
# on the beefy box
nutshell-server --ollama --ollama-model qwen2.5:7b --port 4242

# on the laptop, no LLM locally
nutshell-server --docs ./project-notes
# phone configures BOTH server entries — one for docs, one for LLM
```

(For Phase 2 when the phone can pick which server to route LLM calls through.)

### Behind a different port for dev

```bash
nutshell-server --port 4245
```

Handy when you want to run two servers in parallel for testing.

### Rotate the key

```bash
rm .nutshell-api-key
nutshell-server
```

First run regenerates it. Re-paste into the phone and extension.

## Startup banner

Example output with everything enabled:

```text
  My Project — Nutshell Server
  Serving:  /Users/you/project/docs
  LLM:      llama3.2:3b via Ollama at http://localhost:11434
  Encrypted with AES-256-GCM · key is never transmitted

  Tailscale: 100.123.147.70:4242
  LAN:       your-mac.local:4242
  LAN:       192.168.1.100:4242
  Local:     localhost:4242   ← for the browser extension
  Key:       abc12345-6789-4def-abcd-fedcba987654
```

### Banner sections

- **Serving** — absolute path to the docs folder, or `(URL relay only)` if
  none is configured
- **LLM** — shows `<model> via Ollama at <url>` when enabled and ready, or
  `disabled — <reason>` when the startup probe failed
- **Tailscale** — shown only when a CGNAT IP (100.64.0.0/10) is detected on
  any network interface
- **LAN** — both the `hostname.local` mDNS form and the raw IPv4. Either
  works for same-network clients; `.local` survives DHCP changes
- **Local** — loopback address for the browser extension (extensions can
  only reach `localhost`)

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Clean shutdown (SIGINT/SIGTERM) |
| `1` | Startup error — port in use, bad CLI flag, etc. |

## Convenience script

```bash
scripts/start-with-llm.sh
# or
npm run start:llm
```

Wraps the CLI with Ollama setup: checks for Ollama, starts the daemon if it
isn't running, pulls the model if missing, then starts the server with
`--ollama` and `--no-docs`.

**Why `--no-docs`?** The script is designed for the multi-tenant workflow:
clients (VS Code extension) register their own projects over HTTP at runtime,
so the server itself shouldn't be serving the directory it was launched from
as a "default" project.

If you want the server to also serve a default docs folder at startup
(legacy single-tenant style), run the CLI directly instead — `--no-docs` always
wins over `--docs`, so it's not enough to just pass `--docs` as a passthrough:

```bash
nutshell-server --docs ./my-notes --name "My Notes" --ollama
```
