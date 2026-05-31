/**
 * test-rf-sse.mjs
 *
 * Testa a leitura do endpoint SSE de /sse/home do radarfutebol.com
 * como substituto ao scraping Puppeteer da lista de jogos.
 *
 * O endpoint retorna um evento SSE "update" com JSON contendo:
 *   campeonatos[].eventos[idEvento] = {
 *     idEvento, idWilliamhill, idBetfair,
 *     timeCasa, timeFora,
 *     golTimeCasaFt, golTimeForaFt, tempoAtual, status,
 *     oddTimeCasa, oddEmpate, oddTimeFora,
 *     oddUnder15FT, oddOver15FT, oddUnder25FT, oddOver25FT,
 *     ataquesPerigososTimeCasa, ataquesPerigososTimeFora,
 *     iconeComentarioTimeCasa, iconeComentarioTimeFora,
 *     pressaoTimeCasa, pressaoTimeFora,
 *     scoreLances10MinTimeCasa, scoreLances10MinTimeFora,
 *     ...
 *   }
 *
 * Estratégia:
 *   1. Lança Chrome (Puppeteer) apenas para obter cookies de sessão RF
 *   2. Fecha Chrome — sem scraping de DOM
 *   3. Conecta ao SSE via fetch nativo do Node.js
 *   4. Exibe lista de jogos e monitoriza atualizações por MONITOR_SEC segundos
 *
 * Uso: node test-rf-sse.mjs [MONITOR_SEC]
 *      node test-rf-sse.mjs 60
 */

import { existsSync } from 'fs'

const MONITOR_SEC = parseInt(process.argv[2] ?? '30', 10)
const RF_URL = 'https://www.radarfutebol.com/'
const SSE_URL = new URL('/sse/home', RF_URL)
SSE_URL.searchParams.set('campoBusca', '')
SSE_URL.searchParams.set('somLigado', 'false')
SSE_URL.searchParams.set('mostrarApenasJogosLive', 'true')
SSE_URL.searchParams.set('mostrarApenasJogosFavoritos', 'false')
SSE_URL.searchParams.set('countJogosMostrar', '25')
SSE_URL.searchParams.set('mostrarFiltroAcrescimo', 'false')
SSE_URL.searchParams.set('filtroAlertas', 'false')
SSE_URL.searchParams.set('ordemInicio', 'false')

// ── Utilitários ───────────────────────────────────────────────────────────────

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

function formatGame(ev) {
  const score = `${ev.golTimeCasaFt ?? 0}-${ev.golTimeForaFt ?? 0}`
  const casa  = (ev.timeCasa ?? '?').padEnd(22)
  const fora  = (ev.timeFora ?? '?').padEnd(22)
  const tempo = (ev.tempoAtual ?? '?').padStart(4)
  const ap    = `AP ${ev.ataquesPerigososTimeCasa ?? 0}/${ev.ataquesPerigososTimeFora ?? 0}`
  const icon  = [ev.iconeComentarioTimeCasa, ev.iconeComentarioTimeFora].filter(Boolean).join(' | ')
  return `${tempo}  ${casa} ${score}  ${fora}  ${ap.padEnd(10)}  ${icon || '-'}`
}

// ── 1. Obter cookies de sessão via Puppeteer ──────────────────────────────────

console.log('[sse-test] Lançando Chrome para obter cookies de sessão...')
const { default: puppeteer } = await import('puppeteer-core')

const executablePath = findChrome()
if (!executablePath) { console.error('Chrome não encontrado'); process.exit(1) }

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--incognito', '--no-sandbox', '--disable-blink-features=AutomationControlled',
         '--no-first-run', '--no-default-browser-check'],
  defaultViewport: { width: 800, height: 600 },
})

const page = (await browser.pages())[0] ?? await browser.newPage()

try {
  console.log('[sse-test] Navegando para radarfutebol.com...')
  await page.goto(RF_URL, { waitUntil: 'networkidle2', timeout: 30_000 })
  console.log('[sse-test] Página carregada — extraindo cookies...')
} catch (e) {
  console.error('[sse-test] Erro ao carregar RF:', e.message)
  await browser.close()
  process.exit(1)
}

const cookies = await page.cookies()
await browser.close()
console.log(`[sse-test] ${cookies.length} cookies extraídos. Fechando Chrome.\n`)

const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ')

// ── 2. Conectar ao SSE via fetch ──────────────────────────────────────────────

console.log('[sse-test] Conectando ao SSE:', SSE_URL.href.slice(0, 80) + '...')

const response = await fetch(SSE_URL.href, {
  headers: {
    'accept': 'text/event-stream',
    'accept-language': 'pt-BR,pt;q=0.9',
    'cache-control': 'no-cache',
    'referer': RF_URL,
    'cookie': cookieHeader,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  },
})

if (!response.ok) {
  console.error(`[sse-test] HTTP ${response.status} ${response.statusText}`)
  process.exit(1)
}

console.log(`[sse-test] Conectado! Content-Type: ${response.headers.get('content-type')}`)
console.log(`[sse-test] Monitorizando por ${MONITOR_SEC}s...\n`)

// ── 3. Ler e parsear o stream SSE ─────────────────────────────────────────────

const reader = response.body.getReader()
const decoder = new TextDecoder()

let buffer = ''
let updateCount = 0
let lastGames = []        // último snapshot de jogos
const lancesLog = new Map() // idEvento → lista de ícones acumulados

const deadline = Date.now() + MONITOR_SEC * 1000

async function readSSE() {
  while (Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) { console.log('[sse-test] Stream encerrado.'); break }

    buffer += decoder.decode(value, { stream: true })
    // Normaliza CRLF → LF para simplificar parsing
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    let eventType = ''
    let dataLine  = ''

    for (const line of lines) {
      if (line.startsWith('event: '))      eventType = line.slice(7).trim()
      else if (line.startsWith('data: '))  dataLine  = line.slice(6).trim()
      else if (line.startsWith('retry: ')) { /* ignorar */ }
      else if (line.trim() === '') {
        // Linha vazia = fim de um evento SSE
        if (dataLine) {
          // RF envia "event: update" na primeira msg e depois omite — tratar ambos como update
          processEvent(eventType || 'update', dataLine)
          eventType = ''
          dataLine  = ''
        }
      }
    }
  }
}

function processEvent(type, data) {
  if (type !== 'update') {
    console.log(`[sse] evento "${type}" — ${data.slice(0, 60)}`)
    return
  }

  let payload
  try { payload = JSON.parse(data) }
  catch { console.warn('[sse] JSON inválido'); return }

  updateCount++

  // Flatten eventos de todos os campeonatos
  const games = []
  for (const camp of (payload.campeonatos ?? [])) {
    const evObj = camp.eventos ?? {}
    for (const ev of Object.values(evObj)) {
      games.push(ev)
    }
  }

  // Acumular lances (iconeComentario pode mudar a cada update)
  for (const ev of games) {
    const id = ev.idEvento
    if (!lancesLog.has(id)) lancesLog.set(id, [])
    const log = lancesLog.get(id)
    const iconCasa = ev.iconeComentarioTimeCasa
    const iconFora = ev.iconeComentarioTimeFora
    const last = log[log.length - 1]
    const newEntry = { t: new Date().toISOString().slice(11, 19), iconCasa, iconFora }
    // Só regista se algo mudou
    if (!last || last.iconCasa !== iconCasa || last.iconFora !== iconFora) {
      log.push(newEntry)
      if (log.length > 50) log.shift() // janela deslizante de 50 entradas
    }
  }

  if (updateCount === 1) {
    // Primeiro update: mostrar lista completa
    console.log(`════ UPDATE #${updateCount} — ${games.length} jogos ao vivo ════\n`)
    console.log('  MIN  CASA                   SCORE  FORA                   AP          ÍCONE ATUAL')
    console.log('  ─────────────────────────────────────────────────────────────────────────────────')
    for (const g of games) {
      console.log(' ', formatGame(g))
    }
    console.log()

    // Mostrar exemplo de dados completos do primeiro jogo
    if (games.length > 0) {
      const g0 = games[0]
      console.log(`\n── Dados completos: ${g0.timeCasa} × ${g0.timeFora} ──`)
      const fields = [
        ['idEvento', g0.idEvento],
        ['idWilliamhill', g0.idWilliamhill],
        ['idBetfair', g0.idBetfair],
        ['status', g0.status],
        ['tempoAtual', g0.tempoAtual],
        ['placar', `${g0.golTimeCasaFt}-${g0.golTimeForaFt}`],
        ['campeonato', g0.nomeCampeonato],
        ['categoria', g0.nomeCategoria],
        ['oddCasa', g0.oddTimeCasa],
        ['oddEmpate', g0.oddEmpate],
        ['oddFora', g0.oddTimeFora],
        ['oddUnder25', g0.oddUnder25FT],
        ['oddOver25', g0.oddOver25FT],
        ['oddBttsSim', g0.oddBttsSim],
        ['ataquesPerigosos', `${g0.ataquesPerigososTimeCasa ?? '-'} / ${g0.ataquesPerigososTimeFora ?? '-'}`],
        ['escanteios', `${g0.escanteiosTimeCasa ?? '-'} / ${g0.escanteiosTimeFora ?? '-'}`],
        ['chutesGol', `${g0.chutesGolTimeCasa ?? '-'} / ${g0.chutesGolTimeFora ?? '-'}`],
        ['posseBola', `${g0.posseBolaTimeCasa ?? '-'}% / ${g0.posseBolaTimeFora ?? '-'}%`],
        ['pressao', `${g0.pressaoTimeCasa ?? '-'} / ${g0.pressaoTimeFora ?? '-'}`],
        ['scoreLances10min', `${g0.scoreLances10MinTimeCasa ?? '-'} / ${g0.scoreLances10MinTimeFora ?? '-'}`],
        ['iconeAtual', `${g0.iconeComentarioTimeCasa || '-'} | ${g0.iconeComentarioTimeFora || '-'}`],
        ['urlScoreboard', `https://radarfutebol.xyz/scoreboards/app/football/index.html?eventId=${g0.idWilliamhill}&sport=football&locale=pt-pt&theme=dark`],
      ]
      for (const [k, v] of fields) console.log(`  ${k.padEnd(18)}: ${v}`)
    }
    console.log()
    lastGames = games
  } else {
    // Updates seguintes: mostrar só o que mudou
    console.log(`── UPDATE #${updateCount} ──`)
    for (const g of games) {
      const prev = lastGames.find(p => p.idEvento === g.idEvento)
      if (!prev) continue
      const diffs = []
      if (prev.golTimeCasaFt !== g.golTimeCasaFt || prev.golTimeForaFt !== g.golTimeForaFt)
        diffs.push(`GOLO! ${g.golTimeCasaFt}-${g.golTimeForaFt}`)
      if (prev.iconeComentarioTimeCasa !== g.iconeComentarioTimeCasa)
        diffs.push(`iconeCasa: ${prev.iconeComentarioTimeCasa || '-'} → ${g.iconeComentarioTimeCasa || '-'}`)
      if (prev.iconeComentarioTimeFora !== g.iconeComentarioTimeFora)
        diffs.push(`iconeFora: ${prev.iconeComentarioTimeFora || '-'} → ${g.iconeComentarioTimeFora || '-'}`)
      if (diffs.length > 0)
        console.log(`  ${g.timeCasa} × ${g.timeFora} [${g.tempoAtual}]: ${diffs.join(' | ')}`)
    }
    lastGames = games
  }
}

await readSSE()
reader.cancel().catch(() => {})

// ── 4. Resumo ─────────────────────────────────────────────────────────────────

console.log('\n════════════════════════════════════════════════════════════')
console.log(` RESUMO — ${MONITOR_SEC}s de monitorização`)
console.log('════════════════════════════════════════════════════════════')
console.log(`Updates SSE recebidos: ${updateCount}`)
console.log(`Jogos monitorados    : ${lancesLog.size}`)

// Mostrar histórico de ícones de lances por jogo
const withHistory = [...lancesLog.entries()].filter(([, log]) => log.length > 1)
if (withHistory.length > 0) {
  console.log('\nHistórico de ícones (lances capturados via SSE):')
  for (const [id, log] of withHistory) {
    const g = lastGames.find(e => e.idEvento === id)
    const label = g ? `${g.timeCasa} × ${g.timeFora}` : `id=${id}`
    console.log(`\n  ${label}`)
    for (const entry of log) {
      const casa = entry.iconCasa || '-'
      const fora = entry.iconFora || '-'
      console.log(`    ${entry.t}  casa: ${casa.padEnd(15)} fora: ${fora}`)
    }
  }
}

console.log('\n✔ Análise da viabilidade:')
console.log('  • Lista de jogos com idWilliamhill → pode substituir scrapeRfGames() + Puppeteer')
console.log('  • iconeComentario atualiza em tempo real → histórico acumulável sem scoreboard')
console.log('  • Odds, AP, escanteios, pressão → dados ricos sem DOM scraping')
console.log('  • Sessão obtida via Puppeteer uma vez → Chrome fecha após auth')
console.log('════════════════════════════════════════════════════════════')
