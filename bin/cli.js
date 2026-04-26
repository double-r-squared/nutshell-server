#!/usr/bin/env node
'use strict'

const path = require('path')
const { createServer } = require('../index')
const { resolveAddresses, composeBanner } = require('../lib/banner')

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
    else if (a === '--no-qr') out.noQr = true
    else if (a === '--tailscale') out.tailscale = true
    else if (a === '--lan') out.lan = true
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
      --tailscale         Display only the Tailscale address; error if absent
      --lan               Display only the LAN address; error if absent
      --no-qr             Suppress the connection QR block (used when the
                          VS Code extension spawns the server)
      --ollama            Enable local LLM proxy via Ollama
      --ollama-model <m>  Ollama model (default llama3.2:3b)
      --ollama-url <url>  Ollama address (default http://localhost:11434)
  -h, --help              Show this help
  -v, --version           Show version

The API key is generated on first run and saved to the key file.
Scan the QR code from the phone app, or paste the printed URL into the
browser extension. Localhost is intentionally not displayed — every
client connects from a different network namespace.
`)
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

  const mode = args.tailscale ? 'tailscale' : args.lan ? 'lan' : 'auto'
  let addresses
  try {
    addresses = resolveAddresses({ mode })
  } catch (err) {
    console.error(`\n  ${err.message}\n`)
    process.exit(2)
  }

  const pkg = require('../package.json')
  const banner = await composeBanner({
    name,
    version: pkg.version,
    port,
    apiKey: server.apiKey,
    cwd: process.cwd(),
    addresses,
    showQr: !args.noQr,
    llmModel: server.llmModel,
    llmReady: server.llmReady,
    llmUrl: server.llmUrl,
    llmProbeError: server.llmProbeError,
    isFirstRun: server.isFirstRun,
  })
  process.stdout.write(`\n${banner}`)

  if (server.projectCount > 0) {
    console.log(`Projects: ${server.projectCount} registered`)
    for (const p of server.projects) {
      console.log(`  · ${p.name}  (${p.docsPath || `push, ${p.fileCount} files`})`)
    }
    console.log('')
  }

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
