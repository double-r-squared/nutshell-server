'use strict'

const os = require('os')
const path = require('path')
const qrcode = require('qrcode-terminal')

// ── Network detection ─────────────────────────────────────────────────────────

// Tailscale CGNAT range is 100.64.0.0/10 (so first octet 100, second 64–127).
// Tailscale IPv4 addresses are always non-internal and assigned to the
// `utun*` (macOS) / `tailscale0` (Linux) interface, but we identify by
// address range alone — interface naming varies per OS.
function isTailscaleAddr(addr) {
  if (!addr) return false
  const parts = addr.split('.').map(Number)
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

// Private RFC 1918 ranges plus link-local (169.254) is treated as LAN.
// Public addresses are also returned as LAN (rare, e.g. some VPS setups);
// we only filter out internal / loopback / Tailscale.
function isLanAddr(addr) {
  if (!addr) return false
  if (isTailscaleAddr(addr)) return false
  return true
}

function getTailscaleIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      if (isTailscaleAddr(iface.address)) return iface.address
    }
  }
  return null
}

function getLanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      if (isLanAddr(iface.address)) return iface.address
    }
  }
  return null
}

// Resolve the network display set per the user-facing hierarchy.
//
//   mode: 'auto'      — show Tailscale (if present) AND LAN (if present)
//   mode: 'tailscale' — show only Tailscale; throw if not detected
//   mode: 'lan'       — show only LAN; throw if not detected
//
// `primary` is the address the QR/connection URL encodes — Tailscale
// when present, else LAN. Localhost is intentionally not part of the
// returned set; the phone connects from a different device and the
// browser extension uses its own `localhost:4242` default that doesn't
// flow through this banner.
function resolveAddresses({ mode = 'auto' } = {}) {
  const tailscale = getTailscaleIp()
  const lan = getLanIp()

  if (mode === 'tailscale') {
    if (!tailscale) {
      throw new Error(
        '--tailscale was set but no Tailscale interface was found. ' +
          'Install/start Tailscale, or omit the flag to fall back to LAN.',
      )
    }
    return { tailscale, lan: null, primary: tailscale }
  }

  if (mode === 'lan') {
    if (!lan) {
      throw new Error('--lan was set but no LAN interface was found.')
    }
    return { tailscale: null, lan, primary: lan }
  }

  if (!tailscale && !lan) {
    throw new Error(
      'No reachable network interface found (no Tailscale, no LAN). ' +
        'The phone, browser extension, and VS Code extension all connect ' +
        'over the network — localhost-only is not supported.',
    )
  }
  return {
    tailscale,
    lan,
    primary: tailscale || lan,
  }
}

// ── URL / QR ──────────────────────────────────────────────────────────────────

function connectUrl(host, port, apiKey) {
  return `http://${host}:${port}?key=${apiKey}`
}

function renderQr(text) {
  return new Promise((resolve) => {
    qrcode.generate(text, { small: true }, (rendered) => resolve(rendered))
  })
}

// ── Logo + banner layout ──────────────────────────────────────────────────────
//
// "Nutshell" in blocked ASCII (ANSI Shadow style). Six rows pair cleanly
// with the right-hand column (name + Tailscale + LAN + Key + CWD + blank).
// Rendered in green when stdout is a TTY.

const LOGO_LINES = [
  '███╗   ██╗██╗   ██╗████████╗███████╗██╗  ██╗███████╗██╗     ██╗     ',
  '████╗  ██║██║   ██║╚══██╔══╝██╔════╝██║  ██║██╔════╝██║     ██║     ',
  '██╔██╗ ██║██║   ██║   ██║   ███████╗███████║█████╗  ██║     ██║     ',
  '██║╚██╗██║██║   ██║   ██║   ╚════██║██╔══██║██╔══╝  ██║     ██║     ',
  '██║ ╚████║╚██████╔╝   ██║   ███████║██║  ██║███████╗███████╗███████╗',
  '╚═╝  ╚═══╝ ╚═════╝    ╚═╝   ╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝',
]

const ANSI_GREEN = '\x1b[32m'
const ANSI_DIM = '\x1b[2m'
const ANSI_BOLD = '\x1b[1m'
const ANSI_RESET = '\x1b[0m'

function color(text, ansi) {
  if (!process.stdout.isTTY) return text
  return `${ansi}${text}${ANSI_RESET}`
}

function truncKey(key) {
  if (!key || key.length < 12) return key
  return `${key.slice(0, 8)}...${key.slice(-4)}`
}

function pairs({ name, version, tailscale, lan, apiKey, cwd, port }) {
  const out = []
  out.push(`${color(`${name} v${version}`, ANSI_BOLD)}`)
  if (tailscale) out.push(`Tailscale: http://${tailscale}:${port}`)
  if (lan) out.push(`LAN:       http://${lan}:${port}`)
  out.push(`Key:       ${truncKey(apiKey)}`)
  out.push(`CWD:       ${cwd}`)
  return out
}

// Compose the full banner, including the QR (unless suppressed).
//
// Returns a single string ready for stdout.
async function composeBanner({
  name,
  version,
  port,
  apiKey,
  cwd,
  addresses,
  showQr,
  llmModel,
  llmReady,
  llmUrl,
  llmProbeError,
  isFirstRun,
}) {
  const lines = []

  // Top: logo on the left, key/value column on the right.
  const right = pairs({
    name,
    version,
    tailscale: addresses.tailscale,
    lan: addresses.lan,
    apiKey,
    cwd,
    port,
  })
  const rows = Math.max(LOGO_LINES.length, right.length)
  for (let i = 0; i < rows; i++) {
    const logo = i < LOGO_LINES.length
      ? color(LOGO_LINES[i], ANSI_GREEN)
      : ' '.repeat(LOGO_LINES[0].length)
    const value = right[i] || ''
    lines.push(`${logo}  ${value}`)
  }

  // Optional LLM line below — only if Ollama was enabled.
  if (llmModel) {
    lines.push('')
    if (llmReady) {
      lines.push(color(`           LLM: ${llmModel} via Ollama at ${llmUrl}`, ANSI_DIM))
    } else {
      lines.push(color(`           LLM: disabled — ${llmProbeError}`, ANSI_DIM))
    }
  }

  lines.push('')
  lines.push(color('Made with G2 in mind  ·  Connect your phone, browser, and editor', ANSI_DIM))

  // Separator + connect URL + QR.
  if (showQr) {
    const url = connectUrl(addresses.primary, port, apiKey)
    lines.push(color('─'.repeat(64), ANSI_DIM))
    lines.push('')
    lines.push(`Full key: ${apiKey}`)
    lines.push(url)
    lines.push('')
    const qr = await renderQr(url)
    // qrcode-terminal already returns trailing newline; trim to control spacing.
    lines.push(qr.replace(/\n+$/, ''))
    lines.push('')
    lines.push(color('Scan in the phone app or paste the URL into the browser extension.', ANSI_DIM))
    lines.push(color('─'.repeat(64), ANSI_DIM))
  }

  if (isFirstRun) {
    lines.push('')
    lines.push(color(
      'First run — API key generated and saved to .nutshell-api-key.',
      ANSI_DIM,
    ))
    lines.push(color('Do not commit that file.', ANSI_DIM))
  }

  return lines.join('\n') + '\n'
}

module.exports = {
  resolveAddresses,
  connectUrl,
  composeBanner,
  // Exported for tests / introspection only:
  isTailscaleAddr,
  isLanAddr,
}
