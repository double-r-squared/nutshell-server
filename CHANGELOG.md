# Changelog

All notable changes to nutshell-server are documented here.

## 1.13.1 — Stable release

First 1.x. Production usage has been driving the server long enough that
pre-1.0 versioning no longer reflects reality.

## 0.13.1

- `/claude-code/usage` buckets now also carry `messages` (count of assistant
  records in the window). Anthropic publishes Pro / Max plan rate-limits in
  messages-per-window, not dollars; the phone's usage bars now use that
  unit so the percent math matches Anthropic's actual model.

## 0.13.0

- New endpoint: `POST /claude-code/usage`. Globs `~/.claude/projects/**/*.jsonl`,
  parses assistant records' `usage` blocks, multiplies by hardcoded model
  pricing (Haiku $1/$5, Sonnet $3/$15, Opus $5/$25 per million; cache writes
  at 1.25× input, cache reads at 0.10×), and buckets into 5h-rolling and
  7d-rolling windows. The phone's Usage page renders this directly into
  three progress bars.

## 0.12.5

- New endpoint: `POST /transcribe/restart`. SIGTERMs the running
  faster-whisper daemon (with a 2 s SIGKILL backstop) so the next
  `/transcribe/stream` connection respawns it with a freshly-picked
  model — lets the user swap models from the phone's Voice-to-text
  settings card without bouncing the whole Node server.

## 0.12.4

- Fixed: Claude Code resumed sessions silently shipped empty replies
  (`cc-prompt complete in N s` logged, no text on the phone). The Anthropic
  Agent SDK doesn't always emit `stream_event` partials on resumed
  sessions; our handler skipped the assistant message's text block on the
  assumption partials would deliver it. Now tracks per-message whether
  partials arrived and falls back to emitting the full text block when
  none did.

## 0.12.x — Local STT

- `POST /transcribe/stream` (WebSocket): per-connection live STT pipe
  backed by a long-running faster-whisper Python daemon. PCM audio frames
  in, partial / final transcripts out. `/health.features.transcribe`
  reflects whether the daemon is available.
- `bash scripts/install-updater.sh --reinstall --with-stt` installs
  faster-whisper alongside the server during setup.

See <https://github.com/double-r-squared/nutshell-server> for the source.
