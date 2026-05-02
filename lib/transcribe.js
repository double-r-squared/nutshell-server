'use strict'

// Server-side speech-to-text. Wraps a long-running Python daemon
// (faster-whisper) so the Node server can stream audio in and stream
// transcripts back without paying subprocess startup cost per
// utterance. v1 ships the wire scaffolding only — the Python daemon
// integration lands in batch A2. Until then, isAvailable() returns
// false and startStream() throws so the WS handler can emit a clear
// "not configured" error to the phone.
//
// Public surface:
//
//   isAvailable()             — does the local install have everything
//                               we need to actually transcribe?
//   startStream(opts)         — start a streaming transcription session.
//                               Returns a TranscriptionStream with
//                               sendAudio / end / abort + onPartial /
//                               onFinal / onError callbacks.
//
// The stream contract mirrors the toolkit's STTProvider interface so
// the phone-side provider stays a thin adapter.

const READY = false  // flips to true when A2 lands the Python daemon

function isAvailable() {
  return READY
}

class TranscriptionStream {
  constructor() {
    this._partialCbs = []
    this._finalCbs = []
    this._errorCbs = []
    this._closed = false
  }
  onPartial(cb) { this._partialCbs.push(cb); return () => {
    this._partialCbs = this._partialCbs.filter((c) => c !== cb)
  } }
  onFinal(cb) { this._finalCbs.push(cb); return () => {
    this._finalCbs = this._finalCbs.filter((c) => c !== cb)
  } }
  onError(cb) { this._errorCbs.push(cb); return () => {
    this._errorCbs = this._errorCbs.filter((c) => c !== cb)
  } }
  _emitPartial(text) {
    for (const cb of this._partialCbs) try { cb(text) } catch {}
  }
  _emitFinal(text) {
    for (const cb of this._finalCbs) try { cb(text) } catch {}
  }
  _emitError(message) {
    for (const cb of this._errorCbs) try { cb(message) } catch {}
  }
  // Phone calls this with each PCM chunk. v1 expects 16-bit signed
  // PCM at the sample rate declared at startStream time.
  sendAudio(_pcm) {
    if (this._closed) return
    // Wired in A2 — ships chunk to the Python daemon.
  }
  // Phone calls this when the user paused. Daemon runs the final
  // pass and emits onFinal with the locked transcript.
  end() {
    if (this._closed) return
    this._closed = true
    // Wired in A2.
  }
  // User cancelled — drop all buffered audio without emitting a
  // final transcript. WS-close path also calls this.
  abort() {
    if (this._closed) return
    this._closed = true
  }
}

function startStream(_opts) {
  // Stub for v1 (batch A1). Throws so the caller surfaces a clear
  // "transcription provider not configured" error to the phone
  // instead of opening a stream that never produces results.
  throw new Error('transcription provider not configured (faster-whisper not yet wired)')
}

module.exports = {
  isAvailable,
  startStream,
}
