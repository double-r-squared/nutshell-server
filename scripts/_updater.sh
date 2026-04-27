#!/usr/bin/env bash
# Nutshell auto-updater — pulls the latest origin/main, restarts the server.
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
#   1. git fetch origin main; if no new commits AND the server is running,
#      exit silently (no log noise on idle cycles).
#   2. If the server is not running but we're up to date, start it.
#      Recovers from manual kills, reboots, post-reinstall first run.
#   3. If there are new commits AND the working tree is clean: stop the
#      server, hard-reset to origin/main, npm install if package-lock
#      changed, relaunch.
#   4. If there are new commits but the working tree is DIRTY: log a
#      warning and skip. The deploy machine should never have local edits;
#      this guard catches "I sshed in to debug" mistakes and stops them
#      from deleting whatever was being debugged.

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
SERVER_LOG_MAX_BYTES=$((10 * 1024 * 1024))

log() {
  printf '%s [updater] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >>"$UPDATER_LOG"
}

# ── Server lifecycle ────────────────────────────────────────────────────────

# Returns 0 if the PID file exists and the recorded PID is alive.
is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null || echo '')
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
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

# Spawns start-with-llm.sh detached. The script exec-replaces itself with
# `node bin/cli.js`, so $! is the eventual node PID — kill works on it.
start_server() {
  truncate_server_log
  local launcher="${REPO_DIR}/scripts/start-with-llm.sh"
  if [ ! -x "$launcher" ]; then
    log "ERROR: launcher not found or not executable: $launcher"
    return 1
  fi
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

# Network or auth failure here is normal (laptop closed, wifi off). Don't
# treat it as fatal — try again in 60 s.
if ! git fetch origin main --quiet 2>/dev/null; then
  log "git fetch failed; will retry next cycle"
  exit 0
fi

local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse origin/main)

if [ "$local_sha" = "$remote_sha" ]; then
  # Up to date. Only act if the server died and needs reviving.
  if ! is_running; then
    log "up to date but server not running; starting"
    start_server || true
  fi
  exit 0
fi

# There ARE new commits. Refuse if the working tree is dirty so we don't
# clobber accidental local edits.
if [ -n "$(git status --porcelain)" ]; then
  log "WARN: dirty working tree; skipping update ${local_sha:0:7} → ${remote_sha:0:7}. Commit/stash/clean and the next cycle will pick it up."
  # Still keep the server alive if it died.
  is_running || start_server || true
  exit 0
fi

log "update ${local_sha:0:7} → ${remote_sha:0:7}"

# Capture which files moved before the reset so we can decide whether to
# reinstall deps. After `git reset --hard` the diff is empty.
changed=$(git diff --name-only "$local_sha" "$remote_sha")

stop_server
git reset --hard origin/main --quiet

if echo "$changed" | grep -qx 'package-lock.json'; then
  log "package-lock.json changed; running npm install --omit=dev"
  if ! npm install --omit=dev --no-audit --no-fund --loglevel=error >>"$UPDATER_LOG" 2>&1; then
    log "WARN: npm install failed; starting server with whatever node_modules is on disk"
  fi
fi

start_server || log "ERROR: failed to start server after update"
log "update complete"
