#!/usr/bin/env python3
"""
Streaming STT daemon for nutshell-server. Spawned by lib/transcribe.js
as a subprocess; reads JSON-line messages on stdin, emits JSON-line
results on stdout. faster-whisper does the actual ASR.

Wire (one JSON object per newline):

  Node -> Python:
    {"type": "start",  "sessionId": "...", "sampleRate": 16000,
     "language": "en"|null, "model": "base"|null}
    {"type": "audio",  "sessionId": "...", "pcm": "<base64 16-bit PCM>"}
    {"type": "end",    "sessionId": "..."}    -- run final pass + emit final
    {"type": "abort",  "sessionId": "..."}    -- drop buffer, emit nothing

  Python -> Node:
    {"type": "ready"}                          -- once at startup, after model load
    {"type": "partial", "sessionId": "...", "text": "..."}
    {"type": "final",   "sessionId": "...", "text": "..."}
    {"type": "error",   "sessionId": "...", "error": "..."}

Live-feel approach: a background thread runs every ~1s and
re-transcribes the accumulated buffer for each open session, emitting
a partial. The full final pass on `end` uses a higher beam_size for
quality. This is O(n^2) total compute but for ~10 second utterances
it's fine on commodity CPUs running int8 base.

Stderr is reserved for diagnostics — Node's spawn logs it tagged so
the user can debug install issues.
"""

import argparse
import base64
import json
import sys
import threading
import time

try:
    import numpy as np
except ImportError:
    sys.stderr.write("numpy import failed — pip install numpy\n")
    sys.exit(1)

try:
    from faster_whisper import WhisperModel
except ImportError:
    sys.stderr.write("faster_whisper import failed — pip install faster-whisper\n")
    sys.exit(1)


PARTIAL_INTERVAL_S = 1.0
MIN_AUDIO_S = 0.3  # don't try to transcribe under 300ms of audio


class Session:
    __slots__ = ('session_id', 'sample_rate', 'language', 'buffer',
                 'last_partial_at', 'lock', 'ended')

    def __init__(self, session_id, sample_rate, language):
        self.session_id = session_id
        self.sample_rate = sample_rate
        self.language = language
        self.buffer = bytearray()
        self.last_partial_at = 0.0
        self.lock = threading.Lock()
        self.ended = False

    def append(self, pcm_bytes):
        with self.lock:
            self.buffer.extend(pcm_bytes)

    def snapshot(self):
        with self.lock:
            return bytes(self.buffer)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


def pcm_to_float32(pcm_bytes):
    """16-bit signed PCM bytes -> Float32 [-1, 1] for faster-whisper."""
    if not pcm_bytes:
        return np.zeros(0, dtype=np.float32)
    arr = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    return arr


def transcribe_buffer(model, session, is_final):
    pcm = session.snapshot()
    needed_bytes = int(session.sample_rate * 2 * MIN_AUDIO_S)
    if len(pcm) < needed_bytes:
        return ''
    audio = pcm_to_float32(pcm)
    # vad_filter strips silences before Whisper sees them — improves
    # accuracy and speed. beam_size=1 for partials (fast), 5 for final
    # (better quality at the cost of a few hundred ms).
    segments, _ = model.transcribe(
        audio,
        language=session.language,
        vad_filter=True,
        beam_size=1 if not is_final else 5,
    )
    return ''.join(seg.text for seg in segments).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default='base',
                        help='Whisper model size: tiny / base / small / medium / large-v3')
    parser.add_argument('--compute-type', default='int8',
                        help='int8 / int8_float16 / float16 / float32')
    parser.add_argument('--device', default='cpu',
                        help='cpu / cuda / auto')
    args = parser.parse_args()

    sys.stderr.write(f"[transcribe-daemon] loading model={args.model} "
                     f"compute={args.compute_type} device={args.device}\n")
    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
        )
    except Exception as e:
        sys.stderr.write(f"[transcribe-daemon] model load failed: {e}\n")
        sys.exit(1)
    sys.stderr.write("[transcribe-daemon] model loaded\n")

    emit({'type': 'ready'})

    sessions = {}
    sessions_lock = threading.Lock()

    def partial_loop():
        while True:
            time.sleep(0.25)
            now = time.time()
            with sessions_lock:
                items = list(sessions.items())
            for sid, sess in items:
                if sess.ended:
                    continue
                if now - sess.last_partial_at < PARTIAL_INTERVAL_S:
                    continue
                sess.last_partial_at = now
                try:
                    text = transcribe_buffer(model, sess, is_final=False)
                    if text:
                        emit({'type': 'partial', 'sessionId': sid, 'text': text})
                except Exception as e:
                    emit({'type': 'error', 'sessionId': sid,
                          'error': f'partial failed: {e}'})

    threading.Thread(target=partial_loop, daemon=True).start()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            sys.stderr.write(f"[transcribe-daemon] malformed json: {line[:80]}\n")
            continue

        t = msg.get('type')
        sid = msg.get('sessionId')

        if t == 'start':
            with sessions_lock:
                sessions[sid] = Session(
                    session_id=sid,
                    sample_rate=int(msg.get('sampleRate', 16000)),
                    language=msg.get('language') or None,
                )
        elif t == 'audio':
            with sessions_lock:
                sess = sessions.get(sid)
            if sess and not sess.ended:
                try:
                    pcm = base64.b64decode(msg.get('pcm', ''))
                    sess.append(pcm)
                except Exception as e:
                    emit({'type': 'error', 'sessionId': sid,
                          'error': f'audio decode failed: {e}'})
        elif t == 'end':
            with sessions_lock:
                sess = sessions.get(sid)
            if sess:
                sess.ended = True
                try:
                    text = transcribe_buffer(model, sess, is_final=True)
                    emit({'type': 'final', 'sessionId': sid, 'text': text})
                except Exception as e:
                    emit({'type': 'error', 'sessionId': sid,
                          'error': f'final failed: {e}'})
                finally:
                    with sessions_lock:
                        sessions.pop(sid, None)
        elif t == 'abort':
            with sessions_lock:
                sessions.pop(sid, None)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
