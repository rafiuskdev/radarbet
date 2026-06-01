/**
 * test-betfair-inplay.mjs
 *
 * Abre a página de inplay de futebol da Betfair e intercepta todas as
 * chamadas de rede para descobrir o endpoint que lista eventos/mercados.
 *
 * Uso: node test-betfair-inplay.mjs
 */

import { existsSync, writeFileSync } from 'fs'

const INPLAY_URL  = 'https://www.betfair.com/exchange/plus/football/inplay'
const MONITOR_SEC = 45
const OUT_FILE    = './betfair-inplay-capture.json'

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

const { default: puppeteer } = await import('puppeteer-core')

const executablePath = findChrome()
if (!executablePath) { console.error('Chrome não encontrado'); process.exit(1) }

console.log('[test] Abrindo página inplay do futebol Betfair...')
const browser = await puppeteer.launch({
  executablePath,
  headless: false,
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
  defaultViewport: { width: 1280, height: 900 },
})

const page = (await browser.pages())[0]
const cdp  = await page.createCDPSession()
await cdp.send('Network.enable')

const capture = {
  interesting: [],   // { url, reqBody, resBody } — chamadas com marketId/eventId/odds
  allUrls:     [],
}

const pending = new Map()

cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
  const url = request.url
  if (!url.includes('betfair') && !url.includes('cdnbf')) return
  pending.set(requestId, { url, method: request.method, post: request.postData ?? null })
  if (!capture.allUrls.includes(url.split('?')[0])) {
    capture.allUrls.push(url.split('?')[0])
  }
  // Loga tudo menos imagens/fontes/css
  if (!url.match(/\.(jpg|jpeg|png|gif|svg|woff|woff2|css|ico)(\?|$)/i)) {
    const short = url.length > 140 ? url.slice(0, 140) + '…' : url
    console.log(`[REQ] ${request.method} ${short}`)
  }
})

cdp.on('Network.responseReceived', async ({ requestId, response }) => {
  const req = pending.get(requestId)
  if (!req) return

  const mime = response.mimeType ?? ''
  if (!mime.includes('json') && !mime.includes('text/plain')) return

  try {
    const body   = await cdp.send('Network.getResponseBody', { requestId })
    const text   = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf-8') : body.body

    // Filtra respostas que mencionam mercado/evento/odds
    const isInteresting =
      text.includes('marketId') ||
      text.includes('eventId')  ||
      text.includes('eventName') ||
      text.includes('marketName') ||
      text.includes('runners')

    if (!isInteresting) return

    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = text.slice(0, 2000) }

    const entry = {
      url:      req.url,
      method:   req.method,
      reqBody:  req.post ?? null,
      resBody:  parsed,
      resBytes: text.length,
    }
    capture.interesting.push(entry)

    console.log('\n' + '═'.repeat(72))
    console.log(`[JSON] ${req.method} ${req.url.slice(0, 120)}`)
    console.log('[BODY] (primeiros 1000 chars):')
    console.log(text.slice(0, 1000))
    console.log('═'.repeat(72))
  } catch { /* getResponseBody pode falhar */ }
})

await page.goto(INPLAY_URL, { waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => {})

console.log(`\n[test] Página carregada. Monitorando por ${MONITOR_SEC}s...\n`)
await new Promise(r => setTimeout(r, MONITOR_SEC * 1000))

// Salva
const output = {
  capturedAt:        new Date().toISOString(),
  allBetfairUrlBases: capture.allUrls,
  interestingCount:  capture.interesting.length,
  // Primeiros 10 com body truncado
  samples: capture.interesting.slice(0, 10).map(e => ({
    url:     e.url,
    method:  e.method,
    reqBody: e.reqBody,
    resBytes: e.resBytes,
    resBody: JSON.stringify(e.resBody).slice(0, 3000),
  })),
}
writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), 'utf-8')

console.log('\n' + '═'.repeat(72))
console.log(' RESUMO')
console.log('═'.repeat(72))
console.log(`URLs base Betfair vistas: ${capture.allUrls.length}`)
console.log(`Respostas com dados:      ${capture.interesting.length}`)
console.log(`\nURLs base únicas:`)
for (const u of capture.allUrls) console.log(' ', u)
console.log(`\nCaptura salva em: ${OUT_FILE}`)
console.log('═'.repeat(72))

await browser.close()
