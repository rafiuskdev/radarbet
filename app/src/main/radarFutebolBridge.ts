/**
 * radarFutebolBridge.ts — Híbrido SSE + Scoreboard
 *
 * SSE /sse/home → lista de jogos ao vivo + idWilliamhill (sem scraping DOM da lista RF)
 * Puppeteer     → scoreboard por jogo (lances com segundos precisos e histórico completo)
 *
 * Vantagem vs bridge antigo:
 *   - Sem rfListPage nem navegação RF → clicar Radar → aguardar popup
 *   - idWilliamhill vem direto do SSE; navegamos direto para o scoreboard
 *   - onGamesUpdate push: lista de jogos atualiza sem polling
 */

import { existsSync } from 'fs'
import type { Browser, Page } from 'puppeteer-core'
import { hideChromeFromTaskbar, keepPageActive, forcePageVisible } from './chromeBridge'

const RF_HOME = 'https://www.radarfutebol.com/'

const SSE_URL = (() => {
  const u = new URL('/sse/home', RF_HOME)
  u.searchParams.set('campoBusca',                  '')
  u.searchParams.set('somLigado',                   'false')
  u.searchParams.set('mostrarApenasJogosLive',       'true')
  u.searchParams.set('mostrarApenasJogosFavoritos',  'false')
  u.searchParams.set('countJogosMostrar',            '100')
  u.searchParams.set('mostrarFiltroAcrescimo',       'false')
  u.searchParams.set('filtroAlertas',                'false')
  u.searchParams.set('ordemInicio',                  'false')
  return u.href
})()

// ── Chrome path ───────────────────────────────────────────────────────────────

export function findChrome(): string | null {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`,
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

// ── Tipo interno SSE ──────────────────────────────────────────────────────────

interface SseEvento {
  idEvento:       number
  idWilliamhill:  string
  timeCasa:       string
  timeFora:       string
  golTimeCasaFt:  number
  golTimeForaFt:  number
  tempoAtual:     string
  status:         string
  nomeCampeonato: string
  nomeCategoria:  string
  flag:           string
}

// ── Tipos públicos ────────────────────────────────────────────────────────────

export interface RfGame {
  team1:   string
  team2:   string
  time:    string
  score:   string
  league:  string
  country: string
}

export interface LanceEvent {
  minute:   string
  seconds:  string
  iconType: string
  text:     string
}

export interface RfMatchState {
  events:   LanceEvent[]
  score:    string
  homeTeam: string
  awayTeam: string
  clock:    string
}

export type RfNavResult =
  | { ok: true;  pageKey: string }
  | { ok: false; reason: 'not-found' | 'no-radar' }

// ── Estado SSE ────────────────────────────────────────────────────────────────

let sseCookies = ''
let sseActive  = false
let sseAbort:  AbortController | null = null
const sseGames = new Map<number, SseEvento>()

// ── Estado Puppeteer (scoreboard) ─────────────────────────────────────────────

let rfBrowser: Browser | null = null
const rfGamePages = new Map<string, Page>()  // pageKey → scoreboard Page

// ── Callback push para game list ──────────────────────────────────────────────

type GamesCb = (games: RfGame[]) => void
let gamesCb: GamesCb | null = null
export function onGamesUpdate(cb: GamesCb): void { gamesCb = cb }

// ── Utilitários ───────────────────────────────────────────────────────────────

export function makeGameKey(team1: string, team2: string): string {
  const norm = (s: string) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
     .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  return `${norm(team1)}-vs-${norm(team2)}`
}

// ── Matching de nomes robusto ──────────────────────────────────────────────────
// Problema central: com muitos jogos ao vivo (ex.: 10+ Sub-20 brasileiros todos
// 0-0 no minuto 41), placar e tempo NÃO distinguem nada — só os nomes distinguem.
// O matcher exige que AMBOS os times batam por tokens significativos (ignorando
// ruído como "U20"/"FC"); placar/tempo/liga apenas confirmam e desempatam.

// Siglas e conectores que não distinguem clubes
const NOISE_TOKENS = new Set([
  'fc', 'sc', 'ac', 'cf', 'afc', 'ec', 'se', 'sad', 'aa', 'as', 'sd', 'ad', 'cd',
  'fk', 'if', 'bk', 'sk', 'sv', 'club', 'clube', 'de', 'do', 'da', 'dos', 'das',
  'del', 'the', 'el', 'la', 'und', 'am', 'reserve', 'reserves', 'reservas', 'res',
  'team', 'ii', 'iii',
])

// Categoria do JOGO (faixa etária / género / reservas) — tem de coincidir,
// senão é outro jogo (ex.: "Corinthians U20" ≠ "Corinthians" sénior)
function gameCategory(a: string, b: string): string {
  const s = `${a} ${b}`
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  let cat = ''
  const age = s.match(/\b(?:u|sub)\s?-?\s?(1[5-9]|2[0-3])\b/)
  if (age) cat += 'u' + age[1]
  if (/\b(women|fem|feminin[oa]|girls|ladies|wsl|\(w\)|\bw\b)\b/.test(s)) cat += 'w'
  if (/\b(reserve|reserves|reservas)\b/.test(s)) cat += 'r'
  return cat
}

// Tradução PT/EN → token canónico. bet365 manda nomes em PT ("Hungria"),
// o RadarFutebol manda em EN ("Hungary") — sobretudo seleções e jogos
// internacionais. Mapeamos ambos ao mesmo token canónico para baterem.
// Frases multi-palavra (resolvidas ANTES de tokenizar):
const PHRASE_ALIASES: [string, string][] = [
  ['estados unidos', 'usa'], ['united states', 'usa'], ['ee uu', 'usa'],
  ['paises baixos', 'netherlands'], ['holanda', 'netherlands'], ['holland', 'netherlands'],
  ['coreia do sul', 'southkorea'], ['south korea', 'southkorea'], ['korea republic', 'southkorea'], ['republic of korea', 'southkorea'],
  ['coreia do norte', 'northkorea'], ['north korea', 'northkorea'],
  ['arabia saudita', 'saudiarabia'], ['saudi arabia', 'saudiarabia'],
  ['emirados arabes unidos', 'uae'], ['united arab emirates', 'uae'],
  ['costa do marfim', 'ivorycoast'], ['ivory coast', 'ivorycoast'], ['cote divoire', 'ivorycoast'],
  ['republica checa', 'czechia'], ['czech republic', 'czechia'], ['chequia', 'czechia'], ['czech', 'czechia'],
  ['republica dominicana', 'dominicanrepublic'], ['dominican republic', 'dominicanrepublic'],
  ['bosnia e herzegovina', 'bosnia'], ['bosnia and herzegovina', 'bosnia'], ['bosnia herzegovina', 'bosnia'],
  ['africa do sul', 'southafrica'], ['south africa', 'southafrica'],
  ['nova zelandia', 'newzealand'], ['new zealand', 'newzealand'],
  ['macedonia do norte', 'northmacedonia'], ['north macedonia', 'northmacedonia'], ['macedonia', 'northmacedonia'],
  ['irlanda do norte', 'northernireland'], ['northern ireland', 'northernireland'],
  ['pais de gales', 'wales'], ['costa rica', 'costarica'], ['cabo verde', 'capeverde'], ['cape verde', 'capeverde'],
  ['el salvador', 'elsalvador'], ['hong kong', 'hongkong'], ['arabia saudi', 'saudiarabia'],
  ['trinidad e tobago', 'trinidad'], ['trinidad and tobago', 'trinidad'],
  ['sri lanka', 'srilanka'], ['porto rico', 'puertorico'], ['puerto rico', 'puertorico'],
  ['guine equatorial', 'equatorialguinea'], ['equatorial guinea', 'equatorialguinea'],
]
// Tokens simples (1 palavra):
const TOKEN_ALIASES: Record<string, string> = {
  alemanha: 'germany', afeganistao: 'afghanistan', albania: 'albania', argelia: 'algeria',
  azerbaijao: 'azerbaijan', belgica: 'belgium', bielorrussia: 'belarus', belarus: 'belarus',
  brasil: 'brazil', bulgaria: 'bulgaria', camaroes: 'cameroon', cazaquistao: 'kazakhstan',
  catar: 'qatar', qatar: 'qatar', chipre: 'cyprus', colombia: 'colombia', coreia: 'southkorea',
  croacia: 'croatia', dinamarca: 'denmark', egito: 'egypt', equador: 'ecuador',
  escocia: 'scotland', eslovaquia: 'slovakia', eslovenia: 'slovenia', espanha: 'spain',
  estonia: 'estonia', etiopia: 'ethiopia', filipinas: 'philippines', finlandia: 'finland',
  franca: 'france', gabao: 'gabon', gana: 'ghana', gales: 'wales', grecia: 'greece',
  hungria: 'hungary', iemen: 'yemen', inglaterra: 'england', ira: 'iran', irã: 'iran',
  iran: 'iran', iraque: 'iraq', irlanda: 'ireland', islandia: 'iceland', italia: 'italy',
  japao: 'japan', jordania: 'jordan', letonia: 'latvia', libano: 'lebanon', libia: 'libya',
  lituania: 'lithuania', luxemburgo: 'luxembourg', malasia: 'malaysia', marrocos: 'morocco',
  mexico: 'mexico', moldavia: 'moldova', moldova: 'moldova', mocambique: 'mozambique',
  noruega: 'norway', oma: 'oman', oman: 'oman', paraguai: 'paraguay', polonia: 'poland',
  quenia: 'kenya', romenia: 'romania', russia: 'russia', servia: 'serbia', siria: 'syria',
  singapura: 'singapore', suecia: 'sweden', suica: 'switzerland', tailandia: 'thailand',
  tunisia: 'tunisia', turquia: 'turkey', turkiye: 'turkey', ucrania: 'ukraine',
  uruguai: 'uruguay', uzbequistao: 'uzbekistan', vietna: 'vietnam', vietname: 'vietnam',
  // formas EN que precisam canonizar
  holland: 'netherlands', usa: 'usa', wales: 'wales',
}

function applyPhraseAliases(s: string): string {
  let out = ` ${s} `
  for (const [from, to] of PHRASE_ALIASES) out = out.split(` ${from} `).join(` ${to} `)
  return out.trim()
}

function toTokens(name: string): string[] {
  const norm = applyPhraseAliases(
    name.normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ').trim(),
  )
  return norm
    .split(' ')
    .filter(t =>
      t.length >= 2 &&
      !NOISE_TOKENS.has(t) &&
      !/^(?:u|sub)\d{1,2}$/.test(t) &&   // u20, sub20
      !/^\d{1,2}$/.test(t),               // números curtos isolados (divisão/idade)
    )
    .map(t => TOKEN_ALIASES[t] ?? t)
}

// Distância de edição limitada — tolera grafias leves ("brazil"/"brasil")
function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

function tokenMatch(t: string, u: string): boolean {
  if (t === u) return true
  if (t.length >= 4 && u.length >= 4 && (u.includes(t) || t.includes(u))) return true
  if (Math.max(t.length, u.length) >= 5 && lev(t, u) <= 1) return true
  return false
}

// Similaridade 0..1 entre dois nomes (fração dos tokens do menor que casam)
function teamSim(aTok: string[], bTok: string[]): number {
  if (!aTok.length || !bTok.length) return 0
  const [short, long] = aTok.length <= bTok.length ? [aTok, bTok] : [bTok, aTok]
  let matched = 0
  for (const t of short) if (long.some(u => tokenMatch(t, u))) matched++
  return matched / short.length
}

// Score de nomes 0..1 — usa o MÍNIMO das duas equipas (ambas têm de bater),
// testando as duas orientações casa/fora
function nameMatchScore(ev: SseEvento, t1: string, t2: string): number {
  const a1 = toTokens(t1), a2 = toTokens(t2)
  const c1 = toTokens(ev.timeCasa), c2 = toTokens(ev.timeFora)
  const direct = Math.min(teamSim(a1, c1), teamSim(a2, c2))
  const swap   = Math.min(teamSim(a1, c2), teamSim(a2, c1))
  return Math.max(direct, swap)
}

// Abaixo deste valor de similaridade de nomes, o evento é descartado (não é o jogo)
const NAME_GATE = 0.5

// Pontuação de compatibilidade RF × bet365 (maior = melhor; -1 = descartado):
//   nomes (obrigatório, gate 0.5) → 5..10 pts (sinal dominante)
//   +3 placar idêntico  / -1 placar diferente
//   +1.5 tempo próximo (±5 min)
//   +1 liga compatível  / +0.5 país compatível
function scoreRfMatch(
  ev: SseEvento,
  t1: string,
  t2: string,
  bet365Score?: string,
  bet365Time?: string,
  bet365League?: string,
  bet365Country?: string,
): number {
  // Categoria (Sub-20 / feminino / reservas) tem de coincidir
  if (gameCategory(t1, t2) !== gameCategory(ev.timeCasa, ev.timeFora)) return -1

  const ns = nameMatchScore(ev, t1, t2)
  if (ns < NAME_GATE) return -1

  let pts = ns * 10

  if (bet365Score) {
    const rfScore = `${ev.golTimeCasaFt ?? 0}-${ev.golTimeForaFt ?? 0}`
    pts += rfScore === bet365Score ? 3 : -1   // placar diferente pode ser só atraso → penaliza, não descarta
  }
  if (bet365Time) {
    const rfMin = parseInt(ev.tempoAtual, 10), b365 = parseInt(bet365Time, 10)
    if (!isNaN(rfMin) && !isNaN(b365) && Math.abs(rfMin - b365) <= 5) pts += 1.5
  }
  if (bet365League && teamSim(toTokens(bet365League), toTokens(ev.nomeCampeonato ?? '')) >= 0.5) pts += 1
  if (bet365Country && teamSim(toTokens(bet365Country), toTokens(ev.nomeCategoria ?? '')) >= 0.5) pts += 0.5

  return pts
}

function sseToRfGame(ev: SseEvento): RfGame {
  return {
    team1:   ev.timeCasa,
    team2:   ev.timeFora,
    time:    ev.tempoAtual,
    score:   `${ev.golTimeCasaFt ?? 0}-${ev.golTimeForaFt ?? 0}`,
    league:  ev.nomeCampeonato ?? '',
    country: ev.nomeCategoria  ?? '',
  }
}

// ── SSE: processamento de update ──────────────────────────────────────────────

function processUpdate(payload: { campeonatos?: unknown[] }): void {
  const allGames: RfGame[] = []
  for (const camp of (payload.campeonatos ?? []) as { eventos?: Record<string, unknown> }[]) {
    for (const raw of Object.values(camp.eventos ?? {})) {
      const ev = raw as SseEvento
      sseGames.set(ev.idEvento, ev)
      allGames.push(sseToRfGame(ev))
    }
  }
  if (gamesCb) gamesCb(allGames)
}

// ── SSE: conexão ──────────────────────────────────────────────────────────────

async function connectSse(): Promise<void> {
  if (sseActive) return
  sseActive = true
  sseAbort  = new AbortController()

  const run = async (): Promise<void> => {
    try {
      console.log('[rfBridge] Conectando ao SSE...')
      const res = await fetch(SSE_URL, {
        signal: sseAbort!.signal,
        headers: {
          'accept':          'text/event-stream',
          'accept-language': 'pt-BR,pt;q=0.9',
          'cache-control':   'no-cache',
          'cookie':          sseCookies,
          'referer':         RF_HOME,
          'user-agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      })

      if (!res.ok || !res.body) {
        console.warn(`[rfBridge] SSE HTTP ${res.status} — renovando cookies...`)
        await refreshCookies()
        throw new Error(`HTTP ${res.status}`)
      }

      console.log('[rfBridge] SSE conectado ✔')
      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = '', eventType = '', dataLine = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        buffer  = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if      (line.startsWith('event: ')) eventType = line.slice(7).trim()
          else if (line.startsWith('data: '))  dataLine  = line.slice(6).trim()
          else if (line.trim() === '') {
            if (dataLine) {
              try { processUpdate(JSON.parse(dataLine)) }
              catch { /* JSON inválido — ignorar */ }
              eventType = ''
              dataLine  = ''
            }
          }
        }
      }
      console.warn('[rfBridge] SSE encerrado pelo servidor')
    } catch (e: unknown) {
      if ((e as { name?: string }).name === 'AbortError') { sseActive = false; return }
      console.warn('[rfBridge] SSE erro:', (e as Error).message, '— reconectando em 5s')
    }
    await new Promise(r => setTimeout(r, 5000))
    if (sseActive) await run()
  }

  run().catch(e => console.error('[rfBridge] Erro fatal SSE:', e))
}

// ── Cookie refresh via Puppeteer headless ─────────────────────────────────────

async function refreshCookies(): Promise<void> {
  const executablePath = findChrome()
  if (!executablePath) { console.error('[rfBridge] Chrome não encontrado'); return }
  try {
    const puppeteer = (await import('puppeteer-core')).default
    const browser   = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--incognito', '--no-sandbox', '--disable-blink-features=AutomationControlled',
             '--no-first-run', '--no-default-browser-check'],
      defaultViewport: { width: 800, height: 600 },
    })
    const page = (await browser.pages())[0] ?? await browser.newPage()
    await page.goto(RF_HOME, { waitUntil: 'networkidle2', timeout: 30_000 })
    sseCookies = (await page.cookies()).map(c => `${c.name}=${c.value}`).join('; ')
    await browser.close()
    console.log('[rfBridge] Cookies renovados ✔')
  } catch (e) {
    console.error('[rfBridge] Erro ao renovar cookies:', (e as Error).message)
  }
}

// ── Puppeteer: browser para scoreboards ───────────────────────────────────────

async function getPuppeteer() {
  return (await import('puppeteer-core')).default
}

async function ensureRfBrowser(): Promise<boolean> {
  if (rfBrowser) return true
  const executablePath = findChrome()
  if (!executablePath) return false
  const puppeteer = await getPuppeteer()
  rfBrowser = await puppeteer.launch({
    executablePath,
    headless: false,
    args: [
      '--incognito',
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',          // tamanho REAL off-screen (1×1 é estrangulado pelo Chrome)
      '--window-position=-3300,-3300',   // fora do ecrã — invisível para o utilizador
      // Anti-throttling: mantém o push de lances vivo com a janela em background
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
    defaultViewport: { width: 1280, height: 800 },
  })
  // A aba em branco inicial é mantida como keepalive —
  // fechar todas as abas faz o Chrome incógnito encerrar sozinho.
  rfBrowser.on('disconnected', () => {
    console.warn('[rfBridge] Browser de scoreboard desconectado — resetando')
    rfBrowser = null
    rfGamePages.clear()
  })
  console.log('[rfBridge] Browser de scoreboard lançado')
  const rfPid = rfBrowser.process()?.pid
  if (rfPid) hideChromeFromTaskbar(rfPid)
  return true
}

// ── API pública ───────────────────────────────────────────────────────────────

export async function launchRfChrome(): Promise<void> {
  // SSE (headless cookie fetch → conexão permanente)
  if (!sseActive) {
    await refreshCookies()
    connectSse()
  }
  // Browser para scoreboards
  await ensureRfBrowser()
}

export async function scrapeRfGames(): Promise<RfGame[]> {
  return [...sseGames.values()].map(sseToRfGame)
}

// Abre o scoreboard de um whId numa nova página (sem clicar Comentários ainda)
async function openScoreboard(whId: string): Promise<Page | null> {
  if (!rfBrowser) return null
  const url = `https://radarfutebol.xyz/scoreboards/app/football/index.html?eventId=${whId}&sport=football&locale=pt-pt&theme=dark`
  const page = await rfBrowser.newPage()
  await forcePageVisible(page)   // override de visibilidade ANTES do goto
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  } catch {
    await page.close().catch(() => {})
    return null
  }
  await keepPageActive(page)   // impede o congelamento do push de lances em background
  const rfPid = rfBrowser.process()?.pid
  if (rfPid) hideChromeFromTaskbar(rfPid)
  await page.waitForSelector('#scoreboard:not(.loading-animation)', { timeout: 15_000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 1000))
  return page
}

// Confirma que o scoreboard aberto corresponde mesmo ao evento esperado
// (guarda contra whId obsoleto / carregamento de evento errado)
async function verifyScoreboard(page: Page, expectCasa: string, expectFora: string): Promise<boolean> {
  const names = await page.evaluate(() => ({
    home: (document.querySelector('[data-push="homeName"]') as HTMLElement | null)?.textContent?.trim() ?? '',
    away: (document.querySelector('[data-push="awayName"]') as HTMLElement | null)?.textContent?.trim() ?? '',
  })).catch(() => null)
  if (!names || (!names.home && !names.away)) return true   // sem nomes p/ verificar → não bloquear
  const asEv = { timeCasa: names.home, timeFora: names.away } as SseEvento
  return nameMatchScore(asEv, expectCasa, expectFora) >= NAME_GATE
}

async function activateCommentaries(page: Page, pageKey: string): Promise<void> {
  await page.evaluate((): void => {
    const li = document.querySelector('li[data-action="commentaries"]') as HTMLElement | null
    if (!li) return
    ;(['mousedown', 'mouseup', 'click'] as const).forEach(type =>
      li.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })),
    )
    li.click()
  }).catch(() => {})
  await page.waitForSelector('#box_commentaries li', { timeout: 12_000 })
    .then(() => console.log('[rfBridge] Comentários carregados:', pageKey))
    .catch(() => console.warn('[rfBridge] Timeout comentários:', pageKey))
}

export async function navigateToRfGame(
  team1: string,
  team2: string,
  pageKey = 'legacy:lances',
  bet365Score?: string,
  bet365Time?: string,
  bet365League?: string,
  bet365Country?: string,
): Promise<RfNavResult> {
  // Log do termo de busca exato vindo da bet365 (para depurar matches)
  console.log('[rfBridge] 🔎 BUSCANDO bet365 → casa="%s" | fora="%s" | placar=%s | tempo=%s | liga=%s | país=%s',
    team1, team2, bet365Score ?? '-', bet365Time ?? '-', bet365League ?? '-', bet365Country ?? '-')
  console.log('[rfBridge]    tokens → casa=[%s] fora=[%s]', toTokens(team1).join(','), toTokens(team2).join(','))

  // Reutiliza página existente para este painel
  const existing = rfGamePages.get(pageKey)
  if (existing && !existing.isClosed()) {
    console.log('[rfBridge] Reutilizando scoreboard:', pageKey)
    return { ok: true, pageKey }
  }

  // Aguarda SSE ter dados (até 8s)
  const deadline = Date.now() + 8000
  while (sseGames.size === 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300))
  }

  // Ranqueia TODOS os candidatos. Os nomes são o sinal dominante e obrigatório
  // (gate em scoreRfMatch); placar/tempo/liga apenas confirmam e desempatam.
  const ranked = [...sseGames.values()]
    .map(ev => ({ ev, pts: scoreRfMatch(ev, team1, team2, bet365Score, bet365Time, bet365League, bet365Country) }))
    .filter(c => c.pts > 0 && c.ev.idWilliamhill)
    .sort((a, b) => b.pts - a.pts)

  if (ranked.length === 0) {
    console.warn('[rfBridge] ❌ Nenhum candidato com nomes compatíveis para: "%s" x "%s"', team1, team2)
    // Mostra os jogos RF mais parecidos (mesmo abaixo do gate) p/ comparar grafias
    const nearest = [...sseGames.values()]
      .map(ev => ({ ev, sim: nameMatchScore(ev, team1, team2) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 5)
    console.warn('[rfBridge]    Jogos RF mais próximos (sim 0..1):')
    for (const n of nearest) {
      console.warn('[rfBridge]      sim=%s → "%s" x "%s"  [%s, min %s]',
        n.sim.toFixed(2), n.ev.timeCasa, n.ev.timeFora,
        `${n.ev.golTimeCasaFt ?? 0}-${n.ev.golTimeForaFt ?? 0}`, n.ev.tempoAtual)
    }
    return { ok: false, reason: 'not-found' }
  }

  console.log('[rfBridge] Candidatos para %s x %s →', team1, team2,
    ranked.slice(0, 3).map(c => `[${c.ev.timeCasa}/${c.ev.timeFora}=${c.pts.toFixed(1)}]`).join(' '))

  if (!rfBrowser) return { ok: false, reason: 'not-found' }

  // Tenta do melhor para o pior, verificando os nomes do scoreboard após abrir.
  // Assim nunca ficamos presos a um evento errado: se a verificação falha,
  // descarta e passa ao próximo candidato.
  for (const cand of ranked.slice(0, 3)) {
    const whId = cand.ev.idWilliamhill
    console.log('[rfBridge] Abrindo scoreboard:', pageKey, '| whId:', whId,
      '|', cand.ev.timeCasa, 'x', cand.ev.timeFora, `(pts=${cand.pts.toFixed(1)})`)
    const page = await openScoreboard(whId)
    if (!page) continue

    if (!(await verifyScoreboard(page, cand.ev.timeCasa, cand.ev.timeFora))) {
      console.warn('[rfBridge] Verificação falhou — descartando candidato:', cand.ev.timeCasa, 'x', cand.ev.timeFora)
      await page.close().catch(() => {})
      continue
    }

    await activateCommentaries(page, pageKey)
    rfGamePages.set(pageKey, page)
    console.log('[rfBridge] Scoreboard confirmado e registado:', pageKey, '→', cand.ev.timeCasa, 'x', cand.ev.timeFora)
    return { ok: true, pageKey }
  }

  console.warn('[rfBridge] Todos os candidatos falharam verificação:', team1, 'x', team2)
  return { ok: false, reason: 'not-found' }
}

export async function scrapeRfMatchState(pageKey: string): Promise<RfMatchState | null> {
  const page = rfGamePages.get(pageKey)
  if (!page || page.isClosed()) return null
  try {
    return await page.evaluate((): RfMatchState => {
      const score    = (document.querySelector('[data-push="score"]')    as HTMLElement | null)?.textContent?.trim() ?? ''
      const homeTeam = (document.querySelector('[data-push="homeName"]') as HTMLElement | null)?.textContent?.trim() ?? ''
      const awayTeam = (document.querySelector('[data-push="awayName"]') as HTMLElement | null)?.textContent?.trim() ?? ''
      const clock    = (document.querySelector('[data-push="clock"]')    as HTMLElement | null)?.textContent?.trim() ?? ''
      const events: Array<{ minute: string; seconds: string; iconType: string; text: string }> = []
      for (const li of Array.from(document.querySelectorAll('#box_commentaries li')) as HTMLLIElement[]) {
        const minute   = li.querySelector('.minute')?.textContent?.trim()   ?? ''
        const seconds  = li.querySelector('.seconds')?.textContent?.trim()  ?? ''
        const bgImg    = (li.querySelector('.comment_icon') as HTMLElement | null)?.style?.backgroundImage ?? ''
        const m        = bgImg.match(/msg_([^.]+)\.svg/)
        const iconType = m ? m[1] : 'commentary'
        const text     = li.querySelector('.comment_data')?.textContent?.trim() ?? ''
        if (!text) continue
        events.push({ minute, seconds, iconType, text })
      }
      return { events, score, homeTeam, awayTeam, clock }
    })
  } catch (e) {
    console.error('[rfBridge] Erro em scrapeRfMatchState:', pageKey, e)
    return null
  }
}

export async function closeRfGamePage(pageKey: string): Promise<void> {
  const page = rfGamePages.get(pageKey)
  if (page && !page.isClosed()) await page.close().catch(() => {})
  rfGamePages.delete(pageKey)
  console.log('[rfBridge] Scoreboard fechado:', pageKey)
}

export async function closeRfBrowser(): Promise<void> {
  // Para SSE
  sseAbort?.abort()
  sseAbort   = null
  sseActive  = false
  sseGames.clear()
  // Fecha browser de scoreboards
  await rfBrowser?.close().catch(() => {})
  rfBrowser = null
  rfGamePages.clear()
  console.log('[rfBridge] Bridge encerrado')
}
