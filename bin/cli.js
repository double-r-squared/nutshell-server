#!/usr/bin/env node
'use strict'

const os = require('os')
const path = require('path')
const { createServer } = require('../index')

// ── Minimal argv parser ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--version' || a === '-v') out.version = true
    else if (a === '--port' || a === '-p') out.port = parseInt(argv[++i], 10)
    else if (a === '--docs' || a === '-d') out.docs = argv[++i]
    else if (a === '--name' || a === '-n') out.name = argv[++i]
    else if (a === '--key-file') out.keyFile = argv[++i]
    else if (a === '--no-docs') out.noDocs = true
    else if (a === '--ollama') out.ollama = true
    else if (a === '--ollama-model') out.ollamaModel = argv[++i]
    else if (a === '--ollama-url') out.ollamaUrl = argv[++i]
  }
  return out
}

function printHelp() {
  console.log(`
nutshell-server — local relay for Nutshell docs + URL ingestion

Usage:
  nutshell-server [options]

Options:
  -p, --port <port>       Port to listen on (default 4242, env NUTSHELL_PORT)
  -d, --docs <path>       Docs folder to serve (default ./docs, env NUTSHELL_DOCS)
      --no-docs           Run as URL relay only (no file serving)
  -n, --name <name>       Display name (default "Nutshell Server", env NUTSHELL_NAME)
      --key-file <path>   API key file (default ./.nutshell-api-key)
      --ollama            Enable local LLM proxy via Ollama
      --ollama-model <m>  Ollama model (default llama3.2:3b)
      --ollama-url <url>  Ollama address (default http://localhost:11434)
  -h, --help              Show this help
  -v, --version           Show version

The API key is generated on first run and saved to the key file.
Paste it into the Nutshell browser extension and the phone app settings.
`)
}

function getLanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return 'localhost'
}

function getLocalHostname() {
  const raw = os.hostname()
  const base = raw.endsWith('.local') ? raw.slice(0, -'.local'.length) : raw
  return `${base}.local`
}

function getTailscaleIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const parts = iface.address.split('.').map(Number)
        if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return iface.address
      }
    }
  }
  return null
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    printHelp()
    return
  }
  if (args.version) {
    const pkg = require('../package.json')
    console.log(pkg.version)
    return
  }

  const port = args.port || parseInt(process.env.NUTSHELL_PORT, 10) || 4242
  const name = args.name || process.env.NUTSHELL_NAME || 'Nutshell Server'
  const docsPath = args.noDocs
    ? null
    : path.resolve(process.cwd(), args.docs || process.env.NUTSHELL_DOCS || './docs')
  const keyFilePath = args.keyFile || path.join(process.cwd(), '.nutshell-api-key')

  const ollama = args.ollama || process.env.NUTSHELL_OLLAMA
    ? {
        url: args.ollamaUrl || process.env.NUTSHELL_OLLAMA_URL,
        model: args.ollamaModel || process.env.NUTSHELL_OLLAMA_MODEL,
      }
    : undefined

  const server = createServer({ port, docsPath, name, keyFilePath, ollama })
  await server.start()

  const ip = getLanIp()
  const hostname = getLocalHostname()
  const tsIp = getTailscaleIp()

  console.log('')
  console.log(`  ${name} — Nutshell Server`)
  if (server.projectCount > 0) {
    console.log(`  Projects: ${server.projectCount} registered`)
    for (const p of server.projects) {
      console.log(`            · ${p.name}  (${p.docsPath})`)
    }
  } else {
    console.log('  Projects: (none yet — register via POST /projects/register)')
  }
  if (server.llmModel) {
    if (server.llmReady) {
      console.log(`  LLM:      ${server.llmModel} via Ollama at ${server.llmUrl}`)
    } else {
      console.log(`  LLM:      disabled — ${server.llmProbeError}`)
      console.log(`            (server running without LLM; POST /llm will return 503)`)
    }
  }
  console.log('  Encrypted with AES-256-GCM · key is never transmitted')
  console.log('')
  if (server.isFirstRun) {
    console.log('  ── First run: API key generated ──────────────────────────')
  }
  if (tsIp) {
    console.log(`  Tailscale: ${tsIp}:${port}`)
  }
  console.log(`  LAN:       ${hostname}:${port}`)
  console.log(`  LAN:       ${ip}:${port}`)
  console.log(`  Local:     localhost:${port}   ← for the browser extension`)
  console.log(`  Key:       ${server.apiKey}`)
  if (server.isFirstRun) {
    console.log('')
    console.log('  Paste this key into the Nutshell browser extension')
    console.log('  and the Nutshell phone app Settings → Nutshell Server.')
    console.log('  Key is saved in .nutshell-api-key — do not commit this file.')
    console.log('  ──────────────────────────────────────────────────────────')
  }
  console.log('')

  const shutdown = async () => {
    console.log('\n  Shutting down...')
    await server.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
