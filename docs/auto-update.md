# Auto-update

A small polling-based auto-updater for deploy machines: every minute, check
`origin/main`, and if it moved, restart the server on the new code.

Designed for the case where the machine running the server is **not** the
machine you develop on. If you edit the server in place, see
[Dirty-tree guard](#dirty-tree-guard) below.

## How it works

1. A scheduler (launchd on macOS, systemd-user or cron on Linux) runs
   `~/.nutshell/updater.sh` every 60 seconds.
2. The updater does `git fetch origin main`. If `HEAD == origin/main` and
   the server is alive, it exits silently.
3. If new commits exist AND the working tree is clean, it stops the
   running server, runs `git reset --hard origin/main`, runs
   `npm install --omit=dev` only when `package-lock.json` changed, then
   relaunches via `scripts/start-with-llm.sh` with the launch args you
   specified at install time.
4. If new commits exist but the working tree is dirty, it logs a warning
   and skips. The server keeps running on the old code until the tree is
   clean.

The live updater script lives at `~/.nutshell/updater.sh` — outside the
repo on purpose. `git reset --hard` cannot delete it. Re-pulling the repo
also re-pulls the updater *template* at `scripts/_updater.sh`, but the
template never executes; only `~/.nutshell/updater.sh` does. To pick up
template changes, run `--reinstall` (see below).

## Install

```bash
cd /path/to/nutshell-server
bash scripts/install-updater.sh --ollama
```

Anything you'd normally pass to `start-with-llm.sh` goes after the
script name and gets baked into the launch:

```bash
bash scripts/install-updater.sh --ollama --port 4242 --ollama-model qwen2.5:7b
```

The installer:

- Creates `~/.nutshell/` with the updater, a config file, and empty log
  files.
- Registers a 60-second schedule with the platform's native scheduler:
  - **macOS** → `~/Library/LaunchAgents/com.nutshell.updater.plist`
    (`StartInterval=60`, `RunAtLoad=true`).
  - **Linux with systemd-user** →
    `~/.config/systemd/user/nutshell-updater.{service,timer}`
    (`OnUnitActiveSec=1min`).
  - **Linux without systemd-user** → `crontab` line tagged
    `# nutshell-updater`.
- Runs the first cycle immediately so the server starts without waiting
  60 seconds.

The installer is idempotent: re-running it after a successful install
prints a hint and exits without touching anything. To overwrite, pass
`--reinstall`.

## Change launch args

Two ways:

```bash
bash scripts/install-updater.sh --reinstall --ollama-model llama3.2:3b
```

…or edit `~/.nutshell/config.sh` directly. The `LAUNCH_ARGS` array is
re-read on every cycle, so the next minute the server restarts with the
new args. (Editing the config does not by itself trigger a restart — you
either wait for the next update from `origin/main`, or `kill` the current
server PID and let the updater respawn it.)

## Uninstall

```bash
bash scripts/uninstall-updater.sh
```

Stops the running server, removes the scheduler entry (launchd / systemd
/ cron), and deletes `~/.nutshell/`. Leaves the repo, `notes/`, and
`.nutshell-api-key` untouched — those live in the repo `cwd`, not in
`~/.nutshell/`.

## Pause without uninstalling

If you need to freeze updates temporarily — e.g., to debug a problem on
the live server without the updater overwriting your work — disable the
schedule but leave everything else in place.

```bash
# macOS
launchctl unload -w ~/Library/LaunchAgents/com.nutshell.updater.plist

# Linux (systemd)
systemctl --user stop nutshell-updater.timer

# Linux (cron)
crontab -e   # comment out the line tagged "# nutshell-updater"
```

The currently running server keeps going. To resume: `launchctl load -w`
the same plist, or `systemctl --user start nutshell-updater.timer`, or
uncomment the cron line.

## File layout

```
~/.nutshell/
├── updater.sh         # the loop. Source-of-truth copy.
├── config.sh          # REPO_DIR + LAUNCH_ARGS array.
├── server.pid         # PID of the currently-running server.
├── server.log         # stdout/stderr from the server. Truncated past 10 MB.
├── updater.log        # one line per cycle: timestamp + action.
├── launchd.log        # macOS: launchd's view of the updater (rare errors).
├── systemd.log        # Linux: systemd journal mirror.
└── cron.log           # Linux: cron's view (only on the cron fallback).
```

The repo itself is left exactly where it was (`REPO_DIR`); the updater
operates on it via `git`, not by replacing the directory. This is why
`notes/` and `.nutshell-api-key` survive updates — they're untracked
files inside `REPO_DIR` and `git reset --hard` doesn't touch them.

## Dirty-tree guard

The updater refuses to run `git reset --hard` when `git status --porcelain`
reports any changes. Reasoning: this is a deploy machine. Local edits
mean someone sshed in and started debugging, and the last thing that
person wants is the next polling cycle silently `--hard`-ing their work
away.

If you're seeing `WARN: dirty working tree` lines in `updater.log`, the
fix is one of:

```bash
cd $REPO_DIR
git status                 # see what's modified
git stash                  # park changes; updater proceeds next cycle
git checkout -- .          # discard changes
git commit -am '…'         # promote them; remote will be ahead, updater
                           # will then refuse-fast-forward — push or reset.
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No log lines in `updater.log` | Schedule didn't load | macOS: `launchctl list \| grep nutshell`. Linux systemd: `systemctl --user status nutshell-updater.timer`. Cron: `crontab -l` |
| `update <a> → <b>` lines but server doesn't restart | `start-with-llm.sh` crashing | `tail -100 ~/.nutshell/server.log` |
| `WARN: dirty working tree` every minute | Local edits in `$REPO_DIR` | See [Dirty-tree guard](#dirty-tree-guard) |
| `git fetch failed` lines | Network down or auth changed | If repo went private, swap to SSH remote: `git remote set-url origin git@github.com:…` |
| Server keeps spawning then dying | Port already bound by a manual `npm start` | Stop the manual server. The updater's `is_running` check is PID-based, not port-based. |
| `launchd.log` shows "Could not find … updater.sh" | Updater script removed or moved | `bash scripts/install-updater.sh --reinstall` |

## Why polling and not a webhook

A webhook would update the moment a push lands. That requires a public
endpoint or a tunnel (ngrok / Cloudflare), plus secret management. For a
single-deploy-machine setup the simplicity-to-latency tradeoff favours
polling: 1-minute tail latency, zero exposed services, no secrets.

## See also

- [`cli.md`](cli.md) — flags accepted by `bin/cli.js`. Anything that works
  there also works as a launch-arg passed through `install-updater.sh`.
- [`ollama.md`](ollama.md) — how `start-with-llm.sh` configures Ollama.
  The updater always relaunches through that script, so the same env
  vars (`OLLAMA_MODEL`, `OLLAMA_URL`, `NODE_VERSION`) apply.
