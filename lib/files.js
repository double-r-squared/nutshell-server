'use strict'

const fs = require('fs')
const path = require('path')

// First path segment of a POSIX relative path; '' for root-level files.
function folderId(fileId) {
  const slash = fileId.indexOf('/')
  return slash === -1 ? '' : fileId.slice(0, slash)
}

// Extract the H1 title from the first ~2 KB of markdown text. Returns null
// when no H1 is present. Used by both the fs scan path and the in-memory
// push-mode path so titles render the same way regardless of source.
function extractTitleFromText(text) {
  if (!text) return null
  const head = text.slice(0, 2048)
  for (const line of head.split('\n')) {
    const m = line.match(/^#\s+(.+)/)
    if (m) return m[1].trim()
  }
  return null
}

// Read only the first 2 KB to extract the H1 title without loading large files.
function extractTitle(filePath) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(2048)
    const bytesRead = fs.readSync(fd, buf, 0, 2048, 0)
    return extractTitleFromText(buf.slice(0, bytesRead).toString('utf8'))
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

// Recursively scan docsPath and return a FileEntry for every .md file found.
// Returns an empty array if docsPath doesn't exist.
async function scanFiles(docsPath) {
  if (!docsPath) return []
  const entries = []

  async function walk(dir) {
    let items
    try {
      items = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const fullPath = path.join(dir, item.name)
      if (item.isDirectory()) {
        await walk(fullPath)
      } else if (item.isFile() && item.name.endsWith('.md')) {
        const stat = await fs.promises.stat(fullPath)
        const rel = path.relative(docsPath, fullPath).split(path.sep).join('/')
        const name = item.name.slice(0, -3)
        entries.push({
          id: rel,
          name,
          title: extractTitle(fullPath) || name,
          folder: folderId(rel),
          path: rel,
          modifiedAt: Math.round(stat.mtimeMs),
          size: stat.size,
        })
      }
    }
  }

  await walk(docsPath)
  return entries
}

// Read file content. Returns null if the file doesn't exist or would escape docsPath.
async function readFile(docsPath, fileId) {
  if (!docsPath) return null
  const resolvedBase = path.resolve(docsPath)
  const resolvedFile = path.resolve(docsPath, fileId)
  const rel = path.relative(resolvedBase, resolvedFile)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  try {
    return await fs.promises.readFile(resolvedFile, 'utf8')
  } catch {
    return null
  }
}

module.exports = { scanFiles, readFile, folderId, extractTitleFromText }
