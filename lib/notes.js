'use strict'

// Server-backed notes store. Survives restarts, lives outside the webview
// origin so the phone app can recover its notes after a beta repackage that
// wipes localStorage.
//
// Storage model: one JSON file per note, at <cwd>/notes/<id>.json. No
// database, no migrations, no schema enforcement on read — the phone app is
// the schema authority. This module just round-trips opaque-ish JSON
// objects keyed by `id`. We do peek at a few well-known fields (`id`,
// `title`, `type`, `createdAt`, `updatedAt`, `qas`) to support the metadata-
// only listing endpoint, but nothing requires them.
//
// A note created on the phone has the shape of `Item` from the phone repo's
// `src/types.ts`. We don't import it here — the server doesn't validate.

const fs = require('fs')
const path = require('path')

// ── Filename / id sanity ──────────────────────────────────────────────────────

// Note ids come from the phone — `item-${ms}-${random6}` format. Reject any
// id that could escape the notes dir or do anything funky on disk.
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id)
}

function notePath(notesDir, id) {
  if (!isValidId(id)) throw new Error(`invalid note id: ${id}`)
  return path.join(notesDir, `${id}.json`)
}

// ── Public API ────────────────────────────────────────────────────────────────

function ensureDir(notesDir) {
  if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true })
}

// Light metadata projection used by `POST /notes` so list responses stay
// small (titles only — content fetched on demand via `POST /note`).
function summarize(item) {
  return {
    id: item.id,
    title: typeof item.title === 'string' ? item.title : '',
    type: typeof item.type === 'string' ? item.type : 'short',
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : item.createdAt || 0,
    qaCount: Array.isArray(item.qas) ? item.qas.length : 0,
  }
}

function listNotes(notesDir) {
  ensureDir(notesDir)
  const entries = fs.readdirSync(notesDir)
  const out = []
  for (const file of entries) {
    if (!file.endsWith('.json')) continue
    const id = file.slice(0, -'.json'.length)
    if (!isValidId(id)) continue
    try {
      const raw = fs.readFileSync(path.join(notesDir, file), 'utf8')
      const parsed = JSON.parse(raw)
      out.push(summarize(parsed))
    } catch {
      // Corrupt note: skip. Don't delete — operator may want to inspect.
    }
  }
  // Sort newest-first (createdAt descending) so the phone's home list comes
  // pre-sorted; phone re-sorts anyway but this matches expectations on the
  // wire.
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return out
}

function readNote(notesDir, id) {
  if (!isValidId(id)) return null
  const p = notePath(notesDir, id)
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

// Idempotent. The phone's `id` is the primary key; sending the same id with
// new fields overwrites. We don't merge — phone is authoritative.
function upsertNote(notesDir, item) {
  ensureDir(notesDir)
  if (!item || !isValidId(item.id)) {
    throw new Error('invalid note payload — missing or malformed id')
  }
  const p = notePath(notesDir, item.id)
  const existed = fs.existsSync(p)
  // Pretty-print so notes are diff-able by humans poking the storage dir.
  fs.writeFileSync(p, JSON.stringify(item, null, 2), 'utf8')
  return { id: item.id, created: !existed }
}

function deleteNote(notesDir, id) {
  if (!isValidId(id)) return { removed: false }
  const p = notePath(notesDir, id)
  if (!fs.existsSync(p)) return { removed: false }
  try {
    fs.unlinkSync(p)
    return { removed: true }
  } catch {
    return { removed: false }
  }
}

module.exports = {
  isValidId,
  ensureDir,
  listNotes,
  readNote,
  upsertNote,
  deleteNote,
  summarize,
}
