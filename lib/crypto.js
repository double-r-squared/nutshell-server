'use strict'

const crypto = require('crypto')

// Pre-shared-key authenticated encryption.
//
// The API key is a shared secret known to both parties out-of-band (user copies
// it from the server's startup banner into the extension and phone app). We
// SHA-256 hash it to derive a 32-byte AES-256 key. The key itself is never
// transmitted; authentication is implicit — if decryption produces a valid
// GCM auth tag, the sender proved they know the key.
//
// Wire format is a JSON envelope:
//   { "iv": "<base64 12 bytes>", "data": "<base64 ciphertext+16-byte GCM tag>" }
//
// The GCM auth tag is appended to the ciphertext before base64 encoding to
// match the WebCrypto convention used by the browser extension and phone.

function deriveKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest()
}

function encrypt(plaintext, apiKey) {
  const key = deriveKey(apiKey)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    iv: iv.toString('base64'),
    data: Buffer.concat([ct, tag]).toString('base64'),
  }
}

function decrypt(envelope, apiKey) {
  if (!envelope || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string') {
    throw new Error('Malformed envelope')
  }
  const key = deriveKey(apiKey)
  const iv = Buffer.from(envelope.iv, 'base64')
  const combined = Buffer.from(envelope.data, 'base64')
  if (iv.length !== 12 || combined.length < 16) throw new Error('Malformed envelope')
  const ct = combined.slice(0, combined.length - 16)
  const tag = combined.slice(combined.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ct), decipher.final()])
  return plain.toString('utf8')
}

module.exports = { encrypt, decrypt }
