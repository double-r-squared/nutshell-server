# Deploy dance

End-to-end procedure for getting `nutshell-server` running on a fresh box
with auto-updates enabled. By the end of this you push to `main` and the
deploy machine pulls + restarts within ~60 seconds, no further manual
work.

The mental model: this box is **deploy-only**. Development happens
elsewhere. The box's job is to host the server, run Ollama, and stay
current with `origin/main`. If you also want to edit the server in place,
read [`auto-update.md`](auto-update.md) first — the dirty-tree guard will
quietly stop updates while you have local edits.

## Prerequisites

- Linux or macOS. Windows isn't supported.
- **Node.js 18 or newer** on PATH. Either system-installed
  (`apt install nodejs npm` / `brew install node`) or via
  [`nvm`](https://github.com/nvm-sh/nvm). Both work; the launch script
  auto-sources nvm if it's installed.
- **git** on PATH.
- **Ollama** if you want local LLM support (`brew install ollama` or
  `curl -fsSL https://ollama.com/install.sh | sh`). Skip if you're going
  OpenRouter-only.

If anything is missing, `scripts/start-with-llm.sh --install` will
bootstrap node + Ollama for you on first run, but installing them up
front via your package manager is cleaner.

## Step 1 — Get the code onto the box

Pick whichever path fits where you're starting from.

### Path A: fresh clone (recommended)

```bash
cd ~/Documents
git clone https://github.com/double-r-squared/nutshell-server.git
cd nutshell-server
```

### Path B: retrofit a ZIP download

GitHub's "Download ZIP" strips `.git/`, so the auto-updater can't pull
into it. Convert it back to a real git checkout in place — preserves
any notes or `.nutshell-api-key` you've already accumulated:

```bash
# Optional but cheap insurance: back up notes before retrofitting
cp -r ~/Documents/nutshell-server-main/notes /tmp/notes-backup

# If you want a cleaner directory name, rename now (do this BEFORE git
# init so install-updater.sh records the right REPO_DIR on first install)
mv ~/Documents/nutshell-server-main ~/Documents/nutshell-server
cd ~/Documents/nutshell-server

git init
git remote add origin https://github.com/double-r-squared/nutshell-server.git
git fetch origin main
git reset --hard origin/main

# Verify nothing important was overwritten
diff -r notes /tmp/notes-backup     # should report only your own (untracked) files
rm -rf /tmp/notes-backup
```

`notes/` is gitignored (with one exception: there are 4 sample notes
that were committed before the gitignore rule existed; if you've edited
those four files, the reset will overwrite them — but your own notes
have random suffixes and stay untracked).

`.nutshell-api-key` is never tracked; it survives the reset cleanly.

### Path C: existing clone

Already have `nutshell-server` cloned somewhere? `cd` into it and skip
to step 2.

## Step 2 — Stop any manually-running server

If you've been running `start-with-llm.sh` by hand in another terminal,
stop it now. The auto-updater will spawn its own server, and two
processes can't bind port 4242.

```bash
sudo lsof -i :4242
# note the PID, then:
kill <pid>
# verify:
lsof -i :4242                 # silent = good
```

If `kill` says "Operation not permitted", use `sudo kill <pid>`.

If `lsof` reports the port is held by something else (an Ollama proxy,
some other service), either move that service off 4242 or pass
`--port <other>` to step 3.

## Step 3 — Install the auto-updater

```bash
bash scripts/install-updater.sh --ollama
```

Anything you'd normally pass to `start-with-llm.sh` goes after the
script name and gets baked into the launch:

```bash
bash scripts/install-updater.sh --ollama --port 4242 --ollama-model qwen2.5:7b
```

The installer:

- Lays down `~/.nutshell/{updater.sh, config.sh, server.log,
  updater.log}`.
- Registers a 60-second schedule with the platform's native scheduler
  (launchd on macOS, systemd-user on Linux with systemd, cron as
  fallback).
- Runs the first cycle immediately so the server starts without waiting
  60 seconds.

## Step 4 — Verify

Three commands; all three should return positive output:

```bash
tail -1 ~/.nutshell/updater.log
# expected: started server pid=NNNNN

systemctl --user list-timers | grep nutshell      # Linux/systemd
# OR:
launchctl list | grep nutshell                    # macOS
# OR:
crontab -l | grep nutshell                        # cron fallback
# expected: a line referencing nutshell-updater

curl -i http://localhost:4242/health
# expected: HTTP/1.1 200 OK followed by {"ok":true,...}
```

If `/health` doesn't respond, `tail -50 ~/.nutshell/server.log` will
have the reason. Most-likely-culprits are in [Common gotchas](#common-gotchas)
below.

You can also tail the updater live to watch it tick:

```bash
tail -f ~/.nutshell/updater.log
```

Idle cycles are silent — only updates and recovery actions log.

## Step 5 — Pair clients

The server prints a connect URL + QR code on every start. To see it:

```bash
tail -100 ~/.nutshell/server.log | grep -A1 'http://.*key='
```

(Or wait for a banner-printing restart to scroll by.) Hand the URL or
QR to:

- **Phone app** — scan QR or paste URL into Settings → Nutshell server.
- **Browser extension** — paste into the popup, or import via the QR.
- **VS Code extension** — auto-reads `.nutshell-api-key` from the
  workspace root if it's the same machine; otherwise paste the key into
  the extension settings.

## Day-2 ops

### Change launch args

Re-run the installer with `--reinstall`:

```bash
bash scripts/install-updater.sh --reinstall --ollama --ollama-model llama3.2:3b
```

…or edit `~/.nutshell/config.sh` directly. The next cycle picks it up.

### Rotate the API key

The key lives at `<REPO_DIR>/.nutshell-api-key`. To rotate:

```bash
kill $(cat ~/.nutshell/server.pid)
rm $(grep '^REPO_DIR=' ~/.nutshell/config.sh | cut -d'"' -f2)/.nutshell-api-key
# next updater cycle (≤60s) starts a fresh server with a new key
tail -50 ~/.nutshell/server.log     # find the new key in the banner
```

Re-pair clients with the new key.

### Pause auto-updates without uninstalling

Useful for hotfix sessions:

```bash
# Linux (systemd)
systemctl --user stop nutshell-updater.timer
# Linux (cron)
crontab -e          # comment out the line tagged "# nutshell-updater"
# macOS
launchctl unload -w ~/Library/LaunchAgents/com.nutshell.updater.plist
```

The currently running server keeps going. Resume by reversing.

### Uninstall

```bash
bash scripts/uninstall-updater.sh
```

Stops the server, removes the schedule, deletes `~/.nutshell/`. Leaves
the repo, notes, and key file alone.

### Inspect logs

```bash
tail -f ~/.nutshell/updater.log     # one line per cycle
tail -f ~/.nutshell/server.log      # server stdout/stderr (auto-truncated past 10 MB)
journalctl --user -u nutshell-updater.service -n 50    # systemd's view (Linux)
```

## Common gotchas

### Server exits immediately after spawn

Symptom: `updater.log` has `WARN: server pid=NNN exited within 1s of
spawn`. Tail `~/.nutshell/server.log` for the reason.

- **`Error: listen EADDRINUSE`** — a stranger has port 4242. Find and
  kill it (Step 2), or pass `--port` to `--reinstall` to move yours.
- **`Node.js / npm not found`** — your shell has node but the schedule
  doesn't. The launch script auto-sources `~/.nvm/nvm.sh` and adds
  `/opt/homebrew/bin` + `/usr/local/bin` to PATH for the
  Homebrew-on-Apple-Silicon case. If your node lives somewhere weirder
  (snap, asdf, manually-built), prepend its bin dir to `PATH` at the
  top of `scripts/start-with-llm.sh` and `scripts/_updater.sh`, then
  `bash scripts/install-updater.sh --reinstall`.

### Updater fires but never updates

`updater.log` shows cycles ticking but `WARN: dirty working tree;
skipping update` instead of pulls. The repo has uncommitted local
changes. `cd $REPO_DIR && git status` to see them. Either:

- `git stash` to park them (next cycle proceeds).
- `git checkout -- .` to discard them.
- `git commit` and `git push` if they're real.

This guard exists on purpose — see [`auto-update.md`](auto-update.md#dirty-tree-guard).

### Phone says "Local LLM unreachable"

Server-side check first:

```bash
tail -f ~/.nutshell/server.log | grep -E '\[llm-ping\]|\[llm '
```

You should see `[llm-ping] <addr> → ready (model X)` lines as the phone
pings every URL ingest. If you see nothing when the phone is
attempting, the request isn't reaching the server (firewall, wrong IP,
auth mismatch). If you see `→ not-ready (LLM not enabled)`, the server
wasn't started with `--ollama`.

More LLM-specific troubleshooting in [`ollama.md`](ollama.md#troubleshooting).

### `git fetch` keeps failing

Network is fine but fetches fail? Check the remote URL:

```bash
cd $REPO_DIR
git remote -v
```

If the repo went private after you cloned, swap to SSH:

```bash
git remote set-url origin git@github.com:double-r-squared/nutshell-server.git
# add ~/.ssh/id_<…>.pub to your GitHub deploy keys first
```

## See also

- [`auto-update.md`](auto-update.md) — the auto-updater's architecture,
  files, and design rationale.
- [`ollama.md`](ollama.md) — local LLM setup + troubleshooting.
- [`api.md`](api.md) — endpoint reference.
- [`cli.md`](cli.md) — `bin/cli.js` flags.
