'use strict'

const fs = require('fs')
const path = require('path')
const chokidar = require('chokidar')
const { folderId } = require('./files')

// Watch docsPath for .md file changes and call onEvent with a typed event
// object. Returns the chokidar watcher (call .close() to stop). No-ops if
// docsPath does not exist (supports "URL relay only" usage).
function createWatcher(docsPath, onEvent) {
  if (!docsPath || !fs.existsSync(docsPath)) return null

  const watcher = chokidar.watch(docsPath, {
    ignored: /(^|[/\\])\../,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  })

  function toId(filePath) {
    return path.relative(docsPath, filePath).split(path.sep).join('/')
  }

  function isMd(filePath) {
    return filePath.endsWith('.md')
  }

  watcher
    .on('add', (filePath) => {
      if (!isMd(filePath)) return
      const id = toId(filePath)
      onEvent({
        type: 'file-added',
        id,
        name: path.basename(filePath, '.md'),
        folder: folderId(id),
      })
    })
    .on('change', (filePath) => {
      if (!isMd(filePath)) return
      onEvent({ type: 'file-updated', id: toId(filePath) })
    })
    .on('unlink', (filePath) => {
      if (!isMd(filePath)) return
      onEvent({ type: 'file-removed', id: toId(filePath) })
    })

  return watcher
}

module.exports = { createWatcher }
