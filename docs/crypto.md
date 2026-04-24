# Encryption + threat model

## TL;DR

Every payload is AES-256-GCM-encrypted with a key derived from a pre-shared
secret. The pre-shared secret (the API key) is **never transmitted**.
Authentication is implicit: a successful decryption proves the sender knew
the key.

Against a casual LAN sniffer, this is equivalent to running over TLS for the
payload body. Against a dedicated attacker with a live MITM position, it is
not a substitute for TLS — see "Threat model" below for the boundaries.

## Why PSK instead of TLS

The earlier design for doc streaming used `Authorization: Bearer <key>` over
plain HTTP. That leaks the key to anyone sniffing the network — a single
captured request is enough to read every past and future encrypted body. The
usual fix is TLS, but TLS requires cert management:

- Self-signed certs: the phone webview refuses them by default
- Local CA (Caddy, `mkcert`): user has to install the CA on both Mac and
  phone — multi-step, breaks when the CA rotates
- Tailscale: works, but assumes the user is already on Tailscale

With the PSK approach, the key is copied once from the server banner into
the phone / extension and then **only used locally** (both sides derive the
same AES key from it). It never crosses the wire in any form. No certs,
no CA install, zero setup on either end beyond the copy-paste.

## Key derivation

```text
aesKey = SHA-256(apiKey)     // 32 bytes → AES-256
```

`apiKey` is a UUID v4 generated on first server start and persisted in
`.nutshell-api-key` (gitignored by default). Rotation = delete the file and
restart the server.

The hash is deterministic, so both sides compute the same key independently.
No key exchange protocol. No handshake negotiation. Simplest primitive that
works.

## Wire format

Every encrypted body, request OR response, HTTP OR WebSocket, is:

```json
{
  "iv":   "<base64 12 bytes>",
  "data": "<base64 ciphertext + 16-byte GCM auth tag appended>"
}
```

- `iv` — 12 random bytes generated per encryption. **Never reused** with the
  same key. `crypto.randomBytes(12)` on Node; `crypto.getRandomValues` on
  WebCrypto
- `data` — the AES-256-GCM output with the 16-byte auth tag appended to the
  ciphertext. This matches the WebCrypto convention (`subtle.encrypt` returns
  ciphertext‖tag as a single ArrayBuffer), so the phone and browser don't
  have to reassemble anything

### Reference implementations

| Side | File | Primitive |
| --- | --- | --- |
| Server | `nutshell-server/lib/crypto.js` | Node `crypto` (createCipheriv/createDecipheriv, aes-256-gcm) |
| Phone | `even/src/client/crypto.ts` | WebCrypto (`subtle.encrypt/decrypt`, AES-GCM) |
| Browser | `nutshell-browser/crypto.js` | WebCrypto (same) |

Interop is tested end-to-end: Node → WebCrypto → Node round-trips produce
matching plaintext. See `nutshell-server/index.js` for the server-side
wrappers (`encrypt`, `decrypt`) used by every endpoint.

## Authentication model

There is **no** `Authorization` header. No session tokens. No nonces on the
client side.

When a request arrives at an encrypted endpoint:

1. Server parses the envelope
2. Server decrypts with its derived AES key
3. If the GCM auth tag validates → sender knew the key → request is authentic
4. If auth tag fails → `401 Unauthorized`

For WebSocket: the first frame from a client must be an encrypted
`{"type":"hello"}`. Same decrypt-to-auth flow. Socket is closed if it doesn't
arrive within 5 seconds or doesn't decrypt.

## Threat model

### What this protects against

**Passive LAN eavesdropping.** Someone on the same Wi-Fi who captures
packets. They see a bunch of `{iv, data}` JSON blobs and can't read any of
them. They can't forge requests — any body they send fails decryption.

**Accidental exposure.** If the user screenshots the server banner and
redacts the key, every message that's already been sent stays unreadable
because the key never appears in headers.

**Replays with mutation.** GCM's auth tag detects any tampering — you can't
flip bits in a captured ciphertext and have it decrypt to a different valid
plaintext.

### What this does **not** protect against

**Active MITM.** If an attacker can intercept AND modify traffic in real
time, they can still drop or reorder encrypted messages. They can't read or
forge, but they can drop. Use Tailscale for traffic that crosses untrusted
networks.

**Replay attacks.** A recorded encrypted message can be replayed at the
server later — it'll decrypt cleanly and the server will process it. For this
system's actions that's mostly harmless (re-fetching a file list or
re-analyzing a URL is idempotent-ish), but it's a boundary to know.

**Key compromise.** If the API key leaks — committed to git, posted in
chat, captured from screen — all encrypted past+future traffic is readable by
whoever has it. Rotate immediately: `rm .nutshell-api-key && restart`.

**Endpoint visibility.** HTTP paths (`/files`, `/analyze`, etc.) are in the
clear. An observer can see WHAT kind of request you're making, just not the
contents.

**Denial of service.** No rate limiting. An attacker who can hit the port
can tie up event loop time with bogus decryption attempts. Firewall the
server or bind to a non-exposed interface if you care.

## Design choices

### Why not HMAC for auth + AES for content?

We'd need two keys derived from the PSK, plus a nonce protocol to stop
replays. GCM gives us authenticated encryption in a single primitive with
one random IV per message. Less code, fewer mistakes.

### Why not rotate the PSK per session?

Would need a key-exchange handshake. Not worth the code for the threat model
we're targeting. If you want forward secrecy: tunnel over Tailscale.

### Why expose `/health` in plaintext?

Probing for liveness doesn't need to be secret — and making it plaintext
means extensions / monitoring / Caddy / load balancers can check "is
anything listening" without negotiating crypto.

### Why base64 instead of raw binary?

The envelope lives in JSON bodies, which don't support binary. Base64 is
~33% bigger but universally supported. If throughput ever matters, switch
to Protobuf or raw `application/octet-stream` — the crypto primitives stay
the same.
