/**
 * test-betfair-odds.mjs
 *
 * Intercepta o tráfego de rede da Betfair Exchange via Puppeteer + CDP.
 * Objectivo: identificar endpoints, formato das odds (back/lay) e mecanismo
 * de actualização em tempo real (REST polling, SSE ou WebSocket) para o
 * mercado Under 2.5.
 *
 * Uso: node test-betfair-odds.mjs [marketId]
 *   ex: node test-betfair-odds.mjs 1.258772506
 *
 * O Chrome abre visível. Se a Betfair pedir login, faça manualmente nos
 * primeiros 30s. O script monitoriza 90s após o carregamento.
 */

import { existsSync, writeFileSync } from 'fs'

const MARKET_ID  = process.argv[2] ?? '1.258772506'
const MARKET_URL = `https://www.betfair.com/exchange/plus/football/market/${MARKET_ID}`
const MONITOR_SEC = 90
const OUT_FILE    = `./betfair-capture-${MARKET_ID.replace('.', '_')}.json`

// ── Chrome ────────────────────────────────────────────────────────────────────

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

// ── Main ──────────────────────────────────────────────────────────────────────

const { default: puppeteer } = await import('puppeteer-core')

const executablePath = findChrome()
if (!executablePath) { console.error('Chrome não encontrado'); process.exit(1) }

console.log('[test] Mercado:', MARKET_URL)
console.log('[test] Lançando Chrome...\n')

const browser = await puppeteer.launch({
  executablePath,
  headless: false,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ],
  defaultViewport: { width: 1280, height: 900 },
})

const page = (await browser.pages())[0]

// ── CDP ───────────────────────────────────────────────────────────────────────

const cdp = await page.createCDPSession()
await cdp.send('Network.enable')

const capture = {
  // Pedidos HTTP relevantes (JSON com odds)
  httpOdds:  [],   // { url, method, reqBody, resBody, ts }
  // WebSockets
  wsConns:   [],   // { url, requestId }
  wsFrames:  [],   // { requestId, dir, payload, ts }
  // Todos os pedidos (para diagnóstico)
  allUrls:   [],   // string[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function looksLikeOdds(text) {
  if (!text) return false
  return (
    text.includes('availableToBack') ||
    text.includes('availableToLay')  ||
    text.includes('lastPriceTraded') ||
    text.includes('"price"')         ||
    text.includes('"size"')          ||
    (text.includes('runner') && text.includes('price'))
  )
}

function looksLikeBetfair(url) {
  return (
    url.includes('betfair.com')    ||
    url.includes('betfair-sports') ||
    url.includes('cdnbf.net')
  )
}

// ─── Intercept HTTP responses ─────────────────────────────────────────────────

// Guarda requestId → postData para cruzar com a resposta
const pendingRequests = new Map()

cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
  if (!looksLikeBetfair(request.url)) return
  pendingRequests.set(requestId, {
    url:      request.url,
    method:   request.method,
    postData: request.postData ?? null,
    ts:       Date.now(),
  })
  // Registo de todos os URLs Betfair (para diagnóstico)
  if (!capture.allUrls.includes(request.url)) {
    capture.allUrls.push(request.url)
    const short = request.url.length > 130 ? request.url.slice(0, 130) + '…' : request.url
    console.log(`[REQ] ${request.method} ${short}`)
  }
})

cdp.on('Network.responseReceived', async ({ requestId, response }) => {
  if (!pendingRequests.has(requestId)) return
  const req = pendingRequests.get(requestId)

  // Só interessa JSON
  if (!response.mimeType?.includes('json') && !response.mimeType?.includes('text')) return

  try {
    const body = await cdp.send('Network.getResponseBody', { requestId })
    const text = body.base64Encoded
      ? Buffer.from(body.body, 'base64').toString('utf-8')
      : body.body

    if (!looksLikeOdds(text)) return

    const parsed = JSON.parse(text)
    const entry  = {
      url:     req.url,
      method:  req.method,
      reqBody: req.postData ? tryParse(req.postData) : null,
      resBody: parsed,
      ts:      req.ts,
    }
    capture.httpOdds.push(entry)

    console.log(`\n${'═'.repeat(70)}`)
    console.log(`[ODDS HTTP] ${req.method} ${req.url.slice(0, 110)}`)
    if (req.postData) {
      const bodyPreview = req.postData.length > 300 ? req.postData.slice(0, 300) + '…' : req.postData
      console.log('[REQ BODY]', bodyPreview)
    }
    console.log('[RES BODY] (primeiros 800 chars):')
    console.log(JSON.stringify(parsed, null, 2).slice(0, 800))
    console.log(`${'═'.repeat(70)}\n`)
  } catch {
    // getResponseBody pode falhar em redirects ou respostas vazias
  }
})

// ─── Intercept WebSocket ──────────────────────────────────────────────────────

cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
  console.log(`\n[WS] CRIADO: ${url}`)
  capture.wsConns.push({ requestId, url, ts: Date.now() })
})

cdp.on('Network.webSocketHandshakeResponseReceived', ({ requestId, response }) => {
  const conn = capture.wsConns.find(c => c.requestId === requestId)
  if (conn) {
    conn.status = response.status
    console.log(`[WS] Handshake OK status=${response.status} id=${requestId}`)
  }
})

cdp.on('Network.webSocketFrameReceived', ({ requestId, response, timestamp }) => {
  const payload = response.payloadData
  capture.wsFrames.push({ requestId, dir: 'recv', payload: payload.slice(0, 2000), ts: timestamp })

  const idx = capture.wsFrames.filter(f => f.requestId === requestId && f.dir === 'recv').length
  if (idx <= 8 || (idx <= 50 && looksLikeOdds(payload))) {
    const preview = payload.length > 600 ? payload.slice(0, 600) + '…' : payload
    console.log(`\n[WS ←] recv #${idx} (${payload.length} chars) req=${requestId}`)
    console.log(preview)
  }
})

cdp.on('Network.webSocketFrameSent', ({ requestId, response, timestamp }) => {
  const payload = response.payloadData
  capture.wsFrames.push({ requestId, dir: 'sent', payload: payload.slice(0, 1000), ts: timestamp })

  const idx = capture.wsFrames.filter(f => f.requestId === requestId && f.dir === 'sent').length
  if (idx <= 15) {
    const preview = payload.length > 300 ? payload.slice(0, 300) + '…' : payload
    console.log(`\n[WS →] sent #${idx} req=${requestId}`)
    console.log(preview)
  }
})

// ── Navegar ───────────────────────────────────────────────────────────────────

console.log('[test] Navegando para Betfair...')
console.log('[test] Se pedir login, faça manualmente nos primeiros 30s.\n')

try {
  await page.goto(MARKET_URL, { waitUntil: 'networkidle2', timeout: 60_000 })
} catch {
  console.log('[test] Timeout/erro na navegação — continuando...')
}

console.log(`\n[test] Página carregada. Monitorizando ${MONITOR_SEC}s...\n`)
await new Promise(r => setTimeout(r, MONITOR_SEC * 1000))

// ── Guardar captura ───────────────────────────────────────────────────────────

const output = {
  marketId:  MARKET_ID,
  capturedAt: new Date().toISOString(),

  // HTTP odds: apenas os primeiros 5 (evitar ficheiro gigante)
  httpOddsCount: capture.httpOdds.length,
  httpOddsSample: capture.httpOdds.slice(0, 5).map(e => ({
    url:     e.url,
    method:  e.method,
    reqBody: e.reqBody,
    resBody: truncateDeep(e.resBody, 3000),
  })),

  // WebSockets
  wsConns:  capture.wsConns,
  wsFramesCount: capture.wsFrames.length,
  wsFramesSample: capture.wsFrames.slice(0, 20).map(f => ({
    dir:     f.dir,
    req:     f.requestId,
    payload: f.payload.slice(0, 800),
  })),

  // Todos os URLs Betfair vistos
  allBetfairUrls: capture.allUrls,
}

writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), 'utf-8')

// ── Resumo ────────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(70))
console.log(' RESUMO — Betfair Intercept')
console.log('═'.repeat(70))
console.log(`URLs Betfair detectadas : ${capture.allUrls.length}`)
console.log(`Respostas com odds      : ${capture.httpOdds.length}`)
console.log(`WebSocket connections   : ${capture.wsConns.length}`)
for (const c of capture.wsConns) console.log('  WS:', c.url)
console.log(`WS frames total         : ${capture.wsFrames.length}`)

if (capture.httpOdds.length > 0) {
  console.log('\n✔  Endpoints HTTP com odds detectados:')
  const seen = new Set()
  for (const e of capture.httpOdds) {
    const key = `${e.method} ${e.url.split('?')[0]}`
    if (!seen.has(key)) { seen.add(key); console.log('  ', key) }
  }
}

if (capture.wsConns.length > 0) {
  console.log('\n✔  WebSockets detectados — ver wsFramesSample no JSON para o protocolo.')
}

console.log(`\nCaptura guardada em: ${OUT_FILE}`)
console.log('═'.repeat(70))

await browser.close()

// ── Utilities ─────────────────────────────────────────────────────────────────

function tryParse(str) {
  try { return JSON.parse(str) } catch { return str }
}

function truncateDeep(obj, maxChars) {
  const str = JSON.stringify(obj)
  if (str.length <= maxChars) return obj
  try { return JSON.parse(str.slice(0, maxChars) + '"…truncated"}') } catch { return str.slice(0, maxChars) }
}
