#!/usr/bin/env bash
# Nutshell auto-updater — pulls the latest commit from whichever branch
# is currently checked out (release for production, main for dev),
# then restarts the server.
#
# This file is the *template* — `install-updater.sh` copies it to
# `~/.nutshell/updater.sh` and the live copy is what actually runs (via
# launchd/systemd/cron, every minute). Editing this file in the repo does
# not affect the live updater until the user runs
# `bash scripts/install-updater.sh --reinstall`. Keeping the live copy
# detached from the repo is intentional — `git reset --hard` cannot break
# the updater itself.
#
# Behaviour per cycle:
#   1. git fetch origin <tracked-branch>; if no new commits AND the
#      server is running, exit silently (no log noise on idle cycles).
#      <tracked-branch> = whatever HEAD is currently on (release / main).
#   2. If the server is not running but we're up to date, start it.
#      Recovers from manual kills, reboots, post-reinstall first run.
#   3. If there are new commits AND the working tree is clean: stop the
#      server, hard-reset to origin/<tracked-branch>, npm install if
#      package-lock changed, relaunch.
#   4. If there are new commits but the working tree is DIRTY: stash
#      the local edits with a timestamped marker, run the update, then
#      try to pop the stash back. If the pop conflicts (upstream and
#      local touched the same lines), the stash stays in the list for
#      manual resolution and subsequent cycles refuse to add another
#      auto-stash on top — preventing an infinite "stash → fail to pop
#      → stash again" loop. The dirty file list is always logged so
#      the user can see what got stashed.

set -euo pipefail

# Source nvm so `npm install` (run when package-lock.json changes) can
# find npm. Non-login shells (launchd / systemd-user / cron) don't read
# ~/.bashrc, so an nvm-managed npm is invisible without this. We source
# unconditionally rather than gating on `command -v npm` because a stale
# system node (e.g., apt's `nodejs` without `npm`) can mask the check.
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck source=/dev/null
  \. "$NVM_DIR/nvm.sh"
fi

NUTSHELL_HOME="${NUTSHELL_HOME:-$HOME/.nutshell}"

# Config — written by install-updater.sh, sourced here on every cycle.
# REPO_DIR=...                # absolute path to the server repo checkout
# LAUNCH_ARGS=(--ollama ...)  # passed through to start-with-llm.sh
# shellcheck source=/dev/null
. "$NUTSHELL_HOME/config.sh"

PID_FILE="$NUTSHELL_HOME/server.pid"
SERVER_LOG="$NUTSHELL_HOME/server.log"
UPDATER_LOG="$NUTSHELL_HOME/updater.log"
LOCK_FILE="$NUTSHELL_HOME/updater.lock"
SERVER_LOG_MAX_BYTES=$((10 * 1024 * 1024))

log() {
  printf '%s [updater] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >>"$UPDATER_LOG"
}

# Single-instance guard. Two cycles racing — install-updater's first
# cycle plus the systemd timer firing in the same second, e.g. — caused
# kill+respawn churn because they'd both read a stale PID file, both
# spawn, the loser would EADDRINUSE, and the survivor's PID file would
# get clobbered by the loser's cleanup. flock with a non-blocking lock
# means at most one cycle runs at a time. Subsequent firings exit
# silently rather than queueing up.
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  exit 0
fi

# ── Server lifecycle ────────────────────────────────────────────────────────

# Returns 0 if the server is running. Two checks, in order:
#
#   1. PID file points to a live process.
#   2. The configured port is bound by a process whose cmdline matches
#      our launcher (bin/cli.js, nutshell-server, start-with-llm).
#
# The second check exists so a stale-or-missing PID file (the race we
# just fixed wrote one of these often enough) doesn't trick us into
# thinking the server is dead and spawning a duplicate. When (1) fails
# but (2) succeeds, we heal the PID file to the discovered pid so future
# stop_server calls work.
is_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null || echo '')
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  # Fall back to port lookup. Defined later in the file (server_port,
  # find_nutshell_pid_on_port). Tolerates missing helpers — return
  # false rather than erroring out — so this works even on the first
  # cycle before everything's set up.
  if ! command -v server_port >/dev/null 2>&1; then return 1; fi
  local port
  port=$(server_port)
  local found
  found=$(find_nutshell_pid_on_port "$port")
  if [ -n "$found" ]; then
    log "is_running: pid file out of sync; healing to running pid=$found"
    echo "$found" >"$PID_FILE"
    return 0
  fi
  return 1
}

# SIGTERM, wait up to 5 s, then SIGKILL. Removes the PID file regardless.
stop_server() {
  if ! is_running; then
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid=$(cat "$PID_FILE")
  log "stopping server pid=$pid"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    log "SIGTERM ignored, sending SIGKILL to $pid"
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
}

# Detect the configured server port from LAUNCH_ARGS, defaulting to 4242
# when no `--port N` is present. Used by free_port_if_ours below.
server_port() {
  local i
  for ((i = 0; i < ${#LAUNCH_ARGS[@]}; i++)); do
    if [ "${LAUNCH_ARGS[$i]}" = "--port" ] && [ -n "${LAUNCH_ARGS[$((i + 1))]:-}" ]; then
      echo "${LAUNCH_ARGS[$((i + 1))]}"
      return
    fi
  done
  echo 4242
}

# Find the pid of any process listening on `port`, or empty if none.
# Tolerates missing tools (lsof, fuser) — returns empty rather than
# erroring out. Used by both is_running (heal-from-port) and
# free_port_if_ours (kill stale).
pid_on_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1
  elif command -v fuser >/dev/null 2>&1; then
    fuser "$port"/tcp 2>/dev/null | tr -d ' ' | head -1
  fi
}

# Returns the pid on `port` ONLY if its cmdline looks like a Nutshell
# server. Empty otherwise. Used by is_running (don't claim a stranger
# is "us").
find_nutshell_pid_on_port() {
  local port="$1"
  local pid
  pid=$(pid_on_port "$port")
  [ -z "$pid" ] && return 0
  local cmdline=""
  cmdline=$(tr '\0' ' ' </proc/"$pid"/cmdline 2>/dev/null || true)
  if echo "$cmdline" | grep -qE 'bin/cli\.js|nutshell-server|start-with-llm'; then
    echo "$pid"
  fi
}

# If the configured port is currently bound, identify the holder. Only
# kills if the cmdline matches our own server (bin/cli.js,
# nutshell-server, or start-with-llm). If a stranger holds the port,
# log loudly and skip the spawn — never randomly nuke an unrelated
# service. Catches the "manual server still running" and "lost PID
# file" cases that otherwise produce EADDRINUSE every cycle.
free_port_if_ours() {
  local port="$1"
  local pid
  pid=$(pid_on_port "$port")
  [ -z "$pid" ] && return 0
  local cmdline=""
  cmdline=$(tr '\0' ' ' </proc/"$pid"/cmdline 2>/dev/null || true)
  if echo "$cmdline" | grep -qE 'bin/cli\.js|nutshell-server|start-with-llm'; then
    log "port $port held by stale nutshell pid=$pid; killing"
    kill "$pid" 2>/dev/null || true
    local _i
    for _i in $(seq 1 10); do
      if command -v lsof >/dev/null 2>&1; then
        if ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
      else
        break
      fi
      sleep 0.5
    done
    log "WARN: stale pid=$pid did not release $port; sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
    sleep 1
    return 0
  fi
  log "WARN: port $port held by non-nutshell pid=$pid (cmdline: $cmdline); skipping spawn"
  return 1
}

# Spawns start-with-llm.sh detached. The script exec-replaces itself with
# `node bin/cli.js`, so $! is the eventual node PID — kill works on it.
start_server() {
  truncate_server_log
  local launcher="${REPO_DIR}/scripts/start-with-llm.sh"
  if [ ! -x "$launcher" ]; then
    log "ERROR: launcher not found or not executable: $launcher"
    return 1
  fi
  # Free the port if a stale Nutshell process is holding it.
  if ! free_port_if_ours "$(server_port)"; then
    return 1
  fi
  # Close the lockfile FD before forking. Without this, the server we
  # spawn (start-with-llm.sh → node bin/cli.js) inherits FD 200 and
  # keeps the lock indefinitely — every subsequent updater cycle then
  # fails to acquire and exits silently. Closing the FD here releases
  # our lock too, which is fine: from this point we're past the
  # critical section and just verifying the spawn succeeded.
  exec 200>&-
  # nohup + & so the server outlives this updater process. Logs go to
  # SERVER_LOG; the updater's own activity stays in UPDATER_LOG.
  nohup bash "$launcher" "${LAUNCH_ARGS[@]}" >>"$SERVER_LOG" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"
  # Brief settle so we can detect bind-failure right away rather than
  # leaving a phantom PID for the next cycle to find.
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    log "WARN: server pid=$pid exited within 1s of spawn. Tail $SERVER_LOG."
    rm -f "$PID_FILE"
    return 1
  fi
  log "started server pid=$pid"
}

truncate_server_log() {
  [ -f "$SERVER_LOG" ] || return 0
  local size
  size=$(stat -f%z "$SERVER_LOG" 2>/dev/null || stat -c%s "$SERVER_LOG" 2>/dev/null || echo 0)
  if [ "$size" -gt "$SERVER_LOG_MAX_BYTES" ]; then
    : >"$SERVER_LOG"
    log "truncated $SERVER_LOG (was $size bytes)"
  fi
}

# ── Main cycle ──────────────────────────────────────────────────────────────

cd "$REPO_DIR" || {
  log "ERROR: REPO_DIR=$REPO_DIR does not exist"
  exit 1
}

# Track the currently checked-out branch — `release` for production
# deploys, `main` for dev installs. Self-configuring: switching branches
# in the repo (git checkout release / main) is the entire UX for
# changing what the updater follows. Detached HEAD has no upstream;
# refuse to update in that state.
TRACKED_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo '')
if [ -z "$TRACKED_BRANCH" ]; then
  log "detached HEAD; auto-update disabled until a branch is checked out"
  exit 0
fi

# Network or auth failure here is normal (laptop closed, wifi off). Don't
# treat it as fatal — try again in 60 s. Before giving up though, check
# whether the locally-checked-out branch even exists on origin —
# common foot-gun: deploy host stuck on `master` while the repo tracks
# `main` / `release` upstream. The catch-all "fetch failed" message
# was too vague to diagnose without SSH'ing in.
if ! git fetch origin "$TRACKED_BRANCH" --quiet 2>/dev/null; then
  remote_has_branch=""
  if git ls-remote --heads --exit-code origin "$TRACKED_BRANCH" >/dev/null 2>&1; then
    remote_has_branch="yes"
  fi
  if [ -z "$remote_has_branch" ]; then
    log "ERROR: local branch '$TRACKED_BRANCH' does not exist on origin. Run 'git checkout main' (or 'release') in $REPO_DIR; the next cycle will follow that branch."
  else
    log "git fetch failed for branch $TRACKED_BRANCH; will retry next cycle"
  fi
  exit 0
fi

local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse "origin/$TRACKED_BRANCH")

if [ "$local_sha" = "$remote_sha" ]; then
  # Up to date. Only act if the server died and needs reviving.
  if ! is_running; then
    log "up to date but server not running; starting"
    start_server || true
  fi
  exit 0
fi

# Auto-overridden tracked files: anything in this list gets reset to HEAD
# before the dirty-tree check. These are repo-source-of-truth files that
# we want to refresh on every server push regardless of local edits —
# accidental writes should not block updates. notes/item-welcome.json is
# the demo welcome note; if a user edits it via the phone or by hand,
# the next push wins.
AUTO_OVERRIDE=(
  notes/item-welcome.json
)
for path in "${AUTO_OVERRIDE[@]}"; do
  # Only attempt the checkout if git tracks the file in current HEAD.
  # Quiet-fails when the file isn't tracked, untouched, or non-existent.
  git checkout -- "$path" 2>/dev/null || true
done

# There ARE new commits. Auto-stash any dirty working tree so a stray
# local edit doesn't permanently block updates. We always log what
# was dirty and what we did so the user can audit.
auto_stashed=0
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  log "dirty working tree before update ${local_sha:0:7} → ${remote_sha:0:7}:"
  while IFS= read -r line; do
    log "  $line"
  done <<<"$DIRTY"
  # Loop guard: if a previous auto-stash is still parked (because
  # `git stash pop` conflicted), don't pile another one on top. User
  # has to resolve the parked stash before updates resume.
  if git stash list 2>/dev/null | grep -q 'updater-autostash'; then
    log "WARN: prior auto-stash is still parked (git stash list); refusing to auto-stash again. Resolve it manually, then the next cycle will resume."
    is_running || start_server || true
    exit 0
  fi
  STASH_TAG="updater-autostash-$(date '+%Y%m%dT%H%M%S')"
  if git stash push -u --quiet --message "$STASH_TAG" >/dev/null 2>&1; then
    auto_stashed=1
    log "auto-stashed local changes as '$STASH_TAG'"
  else
    log "WARN: git stash push failed; skipping update. Check repo state manually."
    is_running || start_server || true
    exit 0
  fi
fi

log "update ${local_sha:0:7} → ${remote_sha:0:7}"

# Capture which files moved before the reset so we can decide whether to
# reinstall deps. After `git reset --hard` the diff is empty.
changed=$(git diff --name-only "$local_sha" "$remote_sha")

# Pre-shutdown signal: tell still-connected clients that we're about to
# restart, BEFORE we kill the running server. The phone reads this from
# the WS broadcast and shows its update banner immediately, instead of
# inferring it from the eventual WS disconnect (which arrives a beat
# later). Best-effort — if /broadcast-status fails (server already
# unhealthy, network blip), we proceed with the update anyway and the
# phone falls back to its WS-disconnect heuristic.
announce_update() {
  local from="$1"
  local to="$2"
  local port
  port=$(server_port)
  local key_file="${REPO_DIR}/.nutshell-api-key"
  if [ ! -f "$key_file" ]; then
    log "announce_update: no key file — skipping pre-signal"
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    log "announce_update: curl unavailable — skipping pre-signal"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    log "announce_update: node unavailable — skipping pre-signal"
    return 0
  fi
  # Encrypt {kind:'updating', source:'phone', label:'<from>→<to>'} via
  # node's lib/crypto. The CLI shape: stdin = plaintext JSON, env
  # NUTSHELL_KEY = PSK, stdout = JSON envelope. We construct that
  # inline here — the encryption logic is small and we don't want to
  # ship a separate helper script. NB: source:'phone' is an
  # intentional placeholder; the broadcast-status validator only
  # accepts 'phone' or 'extension', and 'phone' is the closest fit
  # for "the server itself is announcing" until we widen the enum.
  local key
  key=$(cat "$key_file" 2>/dev/null)
  [ -z "$key" ] && return 0
  local plaintext
  plaintext=$(printf '{"kind":"server-updating","source":"server","label":"%s → %s"}' "$from" "$to")
  local envelope
  envelope=$(NUTSHELL_KEY="$key" NUTSHELL_PLAIN="$plaintext" node -e '
    const { encrypt } = require(process.env.NUTSHELL_REPO + "/lib/crypto");
    process.stdout.write(JSON.stringify(encrypt(process.env.NUTSHELL_PLAIN, process.env.NUTSHELL_KEY)));
  ' 2>/dev/null) || return 0
  [ -z "$envelope" ] && return 0
  curl -fsS --max-time 3 \
    -H "Content-Type: application/json" \
    -X POST \
    -d "$envelope" \
    "http://localhost:${port}/broadcast-status" >/dev/null 2>&1 || true
  log "announced pre-update to clients on :$port"
}
NUTSHELL_REPO="$REPO_DIR" announce_update "${local_sha:0:7}" "${remote_sha:0:7}"

stop_server
git reset --hard "origin/$TRACKED_BRANCH" --quiet

if echo "$changed" | grep -qx 'package-lock.json'; then
  log "package-lock.json changed; running npm install --omit=dev"
  if ! npm install --omit=dev --no-audit --no-fund --loglevel=error >>"$UPDATER_LOG" 2>&1; then
    log "WARN: npm install failed; starting server with whatever node_modules is on disk"
  fi
fi

# If we stashed local changes before the reset, try to put them back.
# Conflicts leave the stash in place for manual resolution and the
# loop guard above will hold off auto-stashes on subsequent cycles
# until the user clears it.
if [ "$auto_stashed" = "1" ]; then
  if git stash pop --quiet >/dev/null 2>&1; then
    log "restored auto-stashed local changes"
  else
    log "WARN: stash pop conflicted with upstream changes; left stash for manual resolution. Inspect with 'git stash list', resolve via 'git stash pop' / 'git stash drop'."
  fi
fi

start_server || log "ERROR: failed to start server after update"
log "update complete"
