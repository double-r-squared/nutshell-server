'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Returns the API key, generating and persisting it on first call.
// The key is a pre-shared secret — it is never transmitted. Both sides derive
// the AES-256 session key by SHA-256 hashing this value.
function ensureKey(keyFilePath) {
  const file = path.resolve(keyFilePath)
  if (fs.existsSync(file)) {
    return { key: fs.readFileSync(file, 'utf8').trim(), isFirstRun: false }
  }
  const key = crypto.randomUUID()
  fs.writeFileSync(file, key, 'utf8')
  return { key, isFirstRun: true }
}

module.exports = { ensureKey }
