/**
 * test-rf-monitor.mjs
 *
 * Monitora atualizações SSE do radarfutebol.com para um jogo específico.
 * Mostra TODAS as mudanças entre updates: ícones, contadores, alertas.
 * Escolhe automaticamente o jogo com mais dados disponíveis
 * (ou filtra pelo nome passado como argumento).
 *
 * Uso:
 *   node test-rf-monitor.mjs              → jogo com mais dados disponíveis
 *   node test-rf-monitor.mjs "Flamengo"   → jogo que contenha "Flamengo"
 *   node test-rf-monitor.mjs list         → lista todos os jogos ao vivo
 */

import { existsSync } from 'fs'

const FILTER = process.argv[2] ?? ''
const LIST_MODE = FILTER.toLowerCase() === 'list'

const RF_HOME = 'https://www.radarfutebol.com/'
const SSE_URL = new URL('/sse/home', RF_HOME)
SSE_URL.searchParams.set('mostrarApenasJogosLive', 'true')
SSE_URL.searchParams.set('countJogosMostrar', '25')
SSE_URL.searchParams.set('somLigado', 'false')
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

function norm(s) {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

function ts() {
  return new Date().toISOString().slice(11, 23)
}

// Pontuação de "riqueza" de dados de um evento SSE
function richness(ev) {
  let score = 0
  if (ev.iconeComentarioTimeCasa) score += 10
  if (ev.iconeComentarioTimeFora) score += 10
  if (ev.ataquesPerigososTimeCasa !== '' && ev.ataquesPerigososTimeCasa != null) score += 5
  if (ev.pressaoTimeCasa !== '' && ev.pressaoTimeCasa != null) score += 5
  if (ev.scoreLances10MinTimeCasa !== '' && ev.scoreLances10MinTimeCasa != null) score += 5
  if (ev.linhaDoTempo) score += 20
  if (ev.alertaMomentoGolAtivo) score += 3
  if (ev.alertarGolTimeCasa || ev.alertarGolTimeFora) score += 3
  if (ev.cuidado) score += 3
  if (ev.oraculo) score += 2
  return score
}

// Campos a ignorar no diff (estáticos ou CSS)
const IGNORE = new Set([
  'idEvento','idWilliamhill','idBetfair','slugEvento',
  'idTimeCasa','slugTimeCasa','idTimeFora','slugTimeFora',
  'idCampeonato','idCampeonatoUnico','idTemporada','anoTemporada',
  'nomeCampeonato','nomeCampeonatoReduzido','slugCampeonato',
  'nomeCategoria','slugCategoria','flag','prioridade','temClassificacao',
  'temEscalacao','inicio','oraculo','oraculoFree','overEvento',
  'layCsEvento','problemaRadar','williamhillIvertido','favorito','campeonatoFavorito',
  'linkWilliamhill','linkBetfair','linkOddjusta','linkBolsadeaposta','linkFulltbet','linkOrbit',
  // Campos class CSS
  'classOddTimeCasa','classOddTimeFora','classOddEmpate',
  'classOddUnder15FT','classOddOver15FT','classOddUnder25FT','classOddOver25FT',
  'classOddBttsSim','classOddBttsNao','classPosseBolaTimeCasa','classPosseBolaTimeFora',
  'classChutesGolTimeCasa','classChutesGolTimeFora','classAtaquesPerigososTimeCasa',
  'classAtaquesPerigososTimeFora','classEscanteiosTimeCasa','classEscanteiosTimeFora',
  'classPressaoTimeCasa','classPressaoTimeFora','classProbabilidadesTimeCasa',
  'classProbabilidadesTimeFora','classScoreLances10MinTimeCasa','classScoreLances10MinTimeFora',
  'classScoreLances5MinTimeCasa','classScoreLances5MinTimeFora','classPontos10MinTimeCasa',
  'classPontos10MinTimeFora','classAcrescimo1Tempo','classAcrescimo2Tempo',
  'classPrevisaoAcrescimo1Tempo','classPrevisaoAcrescimo2Tempo',
])

function emojifyKey(k) {
  if (['iconeComentarioTimeCasa','iconeComentarioTimeFora'].includes(k)) return '🎯'
  if (k.startsWith('alertar') || k.startsWith('alerta') || k === 'cuidado') return '🚨'
  if (k.startsWith('golTime')) return '⚽'
  if (k === 'tempoAtual') return '⏱'
  if (k.startsWith('ataquesPerigosos')) return '💥'
  if (k.startsWith('escanteios')) return '⌒'
  if (k.startsWith('chutesGol')) return '🥅'
  if (k.startsWith('pressao') || k === 'somaPressao') return '📈'
  if (k.startsWith('scoreLances')) return '📊'
  if (k.startsWith('odd')) return '💰'
  if (k.startsWith('cartao')) return '🟨'
  if (k === 'linhaDoTempo') return '📋'
  return '  '
}

// ── 1. Cookies via Puppeteer headless ─────────────────────────────────────────

console.log('[monitor] Obtendo cookies de sessão...')
const { default: puppeteer } = await import('puppeteer-core')
const executablePath = findChrome()
if (!executablePath) { console.error('Chrome não encontrado'); process.exit(1) }

const browser = await puppeteer.launch({
  executablePath, headless: true,
  args: ['--incognito','--no-sandbox','--no-first-run','--no-default-browser-check'],
  defaultViewport: { width: 800, height: 600 },
})
const page0 = (await browser.pages())[0] ?? await browser.newPage()
await page0.goto(RF_HOME, { waitUntil: 'networkidle2', timeout: 30_000 })
const cookieHeader = (await page0.cookies()).map(c => `${c.name}=${c.value}`).join('; ')
await browser.close()
console.log('[monitor] Cookies OK. Conectando ao SSE...\n')

// ── 2. SSE ────────────────────────────────────────────────────────────────────

const res = await fetch(SSE_URL.href, {
  headers: {
    'accept': 'text/event-stream',
    'cache-control': 'no-cache',
    'cookie': cookieHeader,
    'referer': RF_HOME,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  },
})
if (!res.ok) { console.error(`SSE HTTP ${res.status}`); process.exit(1) }
console.log('[monitor] SSE conectado ✔\n')

// ── 3. Parse + monitor ────────────────────────────────────────────────────────

const reader  = res.body.getReader()
const decoder = new TextDecoder()
let buffer = '', dataLine = ''
let targetId = null
let prevFlat  = {}
let updateCount = 0

async function readLoop() {
  while (true) {
    const { done, value } = await reader.read()
    if (done) { console.log('\n[monitor] SSE encerrado'); break }

    buffer += decoder.decode(value, { stream: true })
    buffer  = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.startsWith('data: ')) dataLine = line.slice(6).trim()
      else if (line.trim() === '' && dataLine) {
        onUpdate(dataLine); dataLine = ''
      }
    }
  }
}

function flattenEv(ev) {
  const out = {}
  for (const [k, v] of Object.entries(ev)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = v2
    } else {
      out[k] = v
    }
  }
  return out
}

function allEvs(payload) {
  const out = []
  for (const camp of payload.campeonatos ?? []) {
    for (const ev of Object.values(camp.eventos ?? {})) out.push(ev)
  }
  return out
}

function onUpdate(raw) {
  let payload
  try { payload = JSON.parse(raw) } catch { return }

  const evs = allEvs(payload)
  updateCount++

  // ── Modo lista ──────────────────────────────────────────────────────────────
  if (LIST_MODE) {
    console.log(`\n[${ts()}] ${evs.length} jogos ao vivo:`)
    for (const ev of evs) {
      const r = richness(ev)
      const bar = '█'.repeat(Math.min(r, 20))
      console.log(`  [${String(r).padStart(3)}] ${ev.tempoAtual?.padStart(8)}  ${ev.timeCasa} × ${ev.timeFora}  ${bar}`)
    }
    if (updateCount >= 2) process.exit(0)
    return
  }

  // ── Seleção do jogo alvo na primeira update ─────────────────────────────────
  if (updateCount === 1) {
    const candidates = evs.filter(ev =>
      ev.status === 'inprogress' &&
      (FILTER === '' || norm(ev.timeCasa).includes(norm(FILTER)) || norm(ev.timeFora).includes(norm(FILTER)))
    )

    if (candidates.length === 0) {
      console.log('⚠  Nenhum jogo em andamento com o filtro especificado.\n')
      console.log('Jogos disponíveis:')
      evs.forEach(ev => console.log(`  ${ev.tempoAtual?.padStart(8)}  ${ev.timeCasa} × ${ev.timeFora}`))
      process.exit(0)
    }

    // Escolhe o com mais dados disponíveis
    const target = candidates.sort((a, b) => richness(b) - richness(a))[0]
    targetId = target.idEvento

    console.log('═'.repeat(72))
    console.log(`MONITORANDO : ${target.timeCasa} × ${target.timeFora}`)
    console.log(`Campeonato  : ${target.nomeCampeonato} (${target.nomeCategoria})`)
    console.log(`idWilliamhill: ${target.idWilliamhill}  |  Richness: ${richness(target)}`)
    console.log('═'.repeat(72))

    printSnapshot(target)
    prevFlat = flattenEv(target)
    return
  }

  // ── Updates seguintes ───────────────────────────────────────────────────────
  const ev = evs.find(e => e.idEvento === targetId)
  if (!ev) { console.log(`[${ts()}] ⚠ Jogo saiu da lista`); return }

  const curr = flattenEv(ev)
  const changes = []
  for (const [k, v] of Object.entries(curr)) {
    if (IGNORE.has(k)) continue
    if (JSON.stringify(prevFlat[k]) !== JSON.stringify(v)) {
      changes.push({ key: k, prev: prevFlat[k], curr: v })
    }
  }

  if (changes.length === 0) {
    process.stdout.write(`[${ts()}] #${updateCount} sem mudanças\r`)
  } else {
    console.log(`\n[${ts()}] ══ UPDATE #${updateCount} — ${changes.length} campo(s) mudaram ══`)
    for (const ch of changes) {
      const icon = emojifyKey(ch.key)
      const p = ch.prev !== undefined ? JSON.stringify(ch.prev) : '(novo)'
      const c = JSON.stringify(ch.curr)

      // linhaDoTempo: mostra diferencial de eventos
      if (ch.key === 'linhaDoTempo' && Array.isArray(ch.curr)) {
        const prevLen = Array.isArray(ch.prev) ? ch.prev.length : 0
        const novos = ch.curr.slice(0, ch.curr.length - prevLen)
        console.log(`  ${icon} linhaDoTempo: +${novos.length} evento(s)`)
        novos.forEach(e => console.log(`       ${JSON.stringify(e)}`))
      } else {
        console.log(`  ${icon} ${ch.key}: ${p} → ${c}`)
      }
    }
  }

  prevFlat = curr
}

function printSnapshot(ev) {
  const groups = [
    ['⏱  Estado',   ['tempoAtual','status','golTimeCasaFt','golTimeForaFt','golTimeCasaHt','golTimeForaHt','cartaoVermelhoTimeCasa','cartaoVermelhoTimeFora']],
    ['🎯 Ícones',   ['iconeComentarioTimeCasa','iconeComentarioTimeFora']],
    ['💥 Stats',    ['ataquesPerigososTimeCasa','ataquesPerigososTimeFora','chutesGolTimeCasa','chutesGolTimeFora','escanteiosTimeCasa','escanteiosTimeFora','posseBolaTimeCasa','posseBolaTimeFora']],
    ['📈 Pressão',  ['pressaoTimeCasa','pressaoTimeFora','somaPressao','scoreLances10MinTimeCasa','scoreLances10MinTimeFora','scoreLances5MinTimeCasa','scoreLances5MinTimeFora']],
    ['🚨 Alertas',  ['alertarGolTimeCasa','alertarGolTimeFora','alertarPenalTimeCasa','alertarPenalTimeFora','alertarSomGol','cuidado','alertaMomentoGolAtivo','alertaMomentoGolValor','alertaPressaoIndividualAtivo','alertaPressaoIndividualNome','alertaPressaoIndividualValor']],
    ['📋 Timeline', ['linhaDoTempo']],
    ['💰 Odds',     ['oddTimeCasa','oddEmpate','oddTimeFora','oddUnder25FT','oddOver25FT']],
  ]

  console.log(`\n[${ts()}] SNAPSHOT INICIAL:`)
  for (const [title, keys] of groups) {
    const parts = keys.map(k => {
      const v = ev[k]
      if (v === '' || v === null || v === undefined || v === false) return null
      if (k === 'linhaDoTempo' && Array.isArray(v)) {
        return `linhaDoTempo=[${v.length} eventos]`
      }
      return `${k}=${JSON.stringify(v)}`
    }).filter(Boolean)

    if (parts.length > 0) {
      console.log(`  ${title}: ${parts.join('  ')}`)
    }
  }
  console.log()
}

process.on('SIGINT', () => { console.log('\n[monitor] Interrompido.'); process.exit(0) })

await readLoop()
