#!/usr/bin/env bash
# Remove the nutshell-server auto-updater. Stops the server, deregisters
# the schedule on whichever platform installed it, and deletes the live
# state directory at ~/.nutshell/.
#
# Usage:
#   bash scripts/uninstall-updater.sh           # interactive output
#   bash scripts/uninstall-updater.sh --quiet   # called by --reinstall

set -euo pipefail

NUTSHELL_HOME="${NUTSHELL_HOME:-$HOME/.nutshell}"
PLIST_PATH="$HOME/Library/LaunchAgents/com.nutshell.updater.plist"
SYSTEMD_DIR="$HOME/.config/systemd/user"
SYSTEMD_SERVICE="$SYSTEMD_DIR/nutshell-updater.service"
SYSTEMD_TIMER="$SYSTEMD_DIR/nutshell-updater.timer"
CRON_MARKER='# nutshell-updater'

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

say() { [ "$QUIET" -eq 1 ] || printf '\033[36m[uninstall-updater]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[uninstall-updater]\033[0m %s\n' "$*" >&2; }

# ── Stop the server (best-effort) ──────────────────────────────────────────

if [ -f "$NUTSHELL_HOME/server.pid" ]; then
  pid="$(cat "$NUTSHELL_HOME/server.pid" 2>/dev/null || echo '')"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    say "Stopping running server pid=$pid"
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
      warn "SIGTERM ignored, sending SIGKILL"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
fi

# ── Deregister the schedule on whichever platform we're on ─────────────────

case "$(uname -s)" in
  Darwin)
    if [ -f "$PLIST_PATH" ]; then
      say "Unloading launchd job"
      launchctl unload -w "$PLIST_PATH" 2>/dev/null || true
      rm -f "$PLIST_PATH"
    fi
    ;;
  Linux)
    if [ -f "$SYSTEMD_TIMER" ]; then
      say "Disabling systemd user timer"
      systemctl --user disable --now nutshell-updater.timer 2>/dev/null || true
      rm -f "$SYSTEMD_TIMER" "$SYSTEMD_SERVICE"
      systemctl --user daemon-reload 2>/dev/null || true
    fi
    if command -v crontab >/dev/null 2>&1; then
      existing="$(crontab -l 2>/dev/null || true)"
      if printf '%s\n' "$existing" | grep -q "$CRON_MARKER"; then
        say "Removing cron entry"
        printf '%s\n' "$existing" | grep -v "$CRON_MARKER" | crontab -
      fi
    fi
    ;;
esac

# ── Wipe the state dir last ────────────────────────────────────────────────

if [ -d "$NUTSHELL_HOME" ]; then
  say "Removing $NUTSHELL_HOME"
  rm -rf "$NUTSHELL_HOME"
fi

[ "$QUIET" -eq 1 ] || say "Done. The server itself (notes, key file, repo) was left untouched."
