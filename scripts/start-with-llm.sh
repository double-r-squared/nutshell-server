#!/usr/bin/env bash
# Starts nutshell-server with the Ollama proxy enabled. Handles the boring
# parts: checks Ollama is installed, starts the daemon if it isn't running,
# pulls the model if it isn't already on disk, then starts the server.
#
# Usage:
#   bash scripts/start-with-llm.sh                     # defaults
#   bash scripts/start-with-llm.sh --install           # also install Ollama if missing
#   bash scripts/start-with-llm.sh --port 4245         # extra args pass through
#   OLLAMA_MODEL=qwen2.5:7b bash scripts/start-with-llm.sh
#
# Respects env vars:
#   OLLAMA_MODEL     default llama3.2:3b
#   OLLAMA_URL       default http://localhost:11434

set -euo pipefail

MODEL="${OLLAMA_MODEL:-llama3.2:3b}"
URL="${OLLAMA_URL:-http://localhost:11434}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="${SCRIPT_DIR}/../.ollama.log"

# Strip --install from passthrough args but remember whether it was set.
WANT_INSTALL=0
PASSTHROUGH_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--install" ]; then
    WANT_INSTALL=1
  else
    PASSTHROUGH_ARGS+=("$arg")
  fi
done

say() { printf '\033[36m[nutshell]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[nutshell]\033[0m %s\n' "$*" >&2; exit 1; }

install_ollama() {
  local os
  os="$(uname -s)"
  case "$os" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        say "Installing Ollama via Homebrew"
        brew install ollama
      else
        die "Homebrew not found. Install from https://brew.sh or install Ollama manually from https://ollama.com/download"
      fi
      ;;
    Linux)
      say "Installing Ollama via the official install script"
      curl -fsSL https://ollama.com/install.sh | sh
      ;;
    *)
      die "Automatic install not supported on $os. Install Ollama manually from https://ollama.com/download"
      ;;
  esac
  command -v ollama >/dev/null 2>&1 || die "Ollama install finished but 'ollama' is still not on PATH. Try opening a new terminal."
}

# ── 1. Is Ollama installed? ───────────────────────────────────────────────────

if ! command -v ollama >/dev/null 2>&1; then
  if [ "$WANT_INSTALL" = "1" ]; then
    install_ollama
  else
    cat <<EOF >&2

Ollama is not installed.

Install options:
  --install flag    bash scripts/start-with-llm.sh --install
  macOS manual      brew install ollama
  Linux manual      curl -fsSL https://ollama.com/install.sh | sh
  Download page     https://ollama.com/download

Re-run this script after installation, or pass --install to install automatically.

EOF
    exit 1
  fi
fi

# ── 2. Is the Ollama daemon reachable? ────────────────────────────────────────

probe_ollama() {
  curl -sf --max-time 2 "${URL}/api/tags" >/dev/null 2>&1
}

if probe_ollama; then
  say "Ollama already running at ${URL}"
else
  say "Starting Ollama daemon (logs: ${LOG_FILE})"
  # nohup so it survives the script exiting; redirect logs to a known file.
  nohup ollama serve >"${LOG_FILE}" 2>&1 &
  # Give it up to 15s to come up.
  for i in $(seq 1 15); do
    sleep 1
    if probe_ollama; then break; fi
  done
  if ! probe_ollama; then
    die "Ollama did not start within 15s. Check ${LOG_FILE}"
  fi
  say "Ollama is up"
fi

# ── 3. Is the model already pulled? ───────────────────────────────────────────

if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "${MODEL}"; then
  say "Model ${MODEL} already pulled"
else
  say "Pulling ${MODEL} (one-time download, can take a few minutes)"
  ollama pull "${MODEL}"
fi

# ── 4. Start nutshell-server ──────────────────────────────────────────────────

say "Starting nutshell-server with --ollama --ollama-model ${MODEL}"
# --no-docs: don't register a default project pointing at ./docs (the API docs folder).
# Projects are registered by VS Code extension clients via POST /projects/register.
# ${PASSTHROUGH_ARGS[@]+"${PASSTHROUGH_ARGS[@]}"} expands to the array when set,
# to nothing when empty — avoids `unbound variable` under macOS bash 3.2 + set -u.
exec node "${SCRIPT_DIR}/../bin/cli.js" \
  --no-docs \
  --ollama \
  --ollama-model "${MODEL}" \
  --ollama-url "${URL}" \
  ${PASSTHROUGH_ARGS[@]+"${PASSTHROUGH_ARGS[@]}"}
