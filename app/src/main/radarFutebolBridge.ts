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

function fuzzy(hay: string, needle: string): boolean {
  const norm = (s: string) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
  const h = norm(hay), n = norm(needle)
  if (h === n || h.includes(n) || n.includes(h)) return true
  return n.split(' ').filter(w => w.length >= 3).some(w => h.includes(w))
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
      '--window-size=1,1',
      '--window-position=-3200,-3200',  // fora do ecrã — invisível para o utilizador
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

export async function navigateToRfGame(
  team1: string,
  team2: string,
  pageKey = 'legacy:lances',
): Promise<RfNavResult> {
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

  // Fuzzy match no cache SSE para obter idWilliamhill
  let matched: SseEvento | null = null
  for (const ev of sseGames.values()) {
    if ((fuzzy(ev.timeCasa, team1) || fuzzy(ev.timeCasa, team2)) &&
        (fuzzy(ev.timeFora, team1) || fuzzy(ev.timeFora, team2))) {
      matched = ev
      break
    }
  }

  if (!matched) {
    console.warn('[rfBridge] Jogo não encontrado no SSE:', team1, 'x', team2)
    return { ok: false, reason: 'not-found' }
  }

  const whId = matched.idWilliamhill
  if (!whId) {
    console.warn('[rfBridge] idWilliamhill ausente:', team1, 'x', team2)
    return { ok: false, reason: 'no-radar' }
  }

  if (!rfBrowser) return { ok: false, reason: 'not-found' }

  // Navega direto para o scoreboard (sem passar pela lista RF)
  const scoreboardUrl = `https://radarfutebol.xyz/scoreboards/app/football/index.html?eventId=${whId}&sport=football&locale=pt-pt&theme=dark`
  console.log('[rfBridge] Abrindo scoreboard:', pageKey, '| whId:', whId)

  const newPage = await rfBrowser.newPage()

  await newPage.goto(scoreboardUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await newPage.waitForSelector('#scoreboard:not(.loading-animation)', { timeout: 15_000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 1000))

  // Clica aba "Comentários"
  await newPage.evaluate((): void => {
    const li = document.querySelector('li[data-action="commentaries"]') as HTMLElement | null
    if (!li) return
    ;(['mousedown', 'mouseup', 'click'] as const).forEach(type =>
      li.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    )
    li.click()
  }).catch(() => {})

  await newPage.waitForSelector('#box_commentaries li', { timeout: 12_000 })
    .then(() => console.log('[rfBridge] Comentários carregados:', pageKey))
    .catch(() => console.warn('[rfBridge] Timeout comentários:', pageKey))

  rfGamePages.set(pageKey, newPage)
  console.log('[rfBridge] Scoreboard registado:', pageKey)
  return { ok: true, pageKey }
}

export async function scrapeRfMatchState(pageKey: string): Promise<RfMatchState | null> {
  const page = rfGamePages.get(pageKey)
  if (!page || page.isClosed()) return null
  try {
    return await page.evaluate((): RfMatchState => {
      const score    = (document.querySelector('[data-push="score"]')    as HTMLElement | null)?.textContent?.trim() ?? ''
      const homeTeam = (document.querySelector('[data-push="homeName"]') as HTMLElement | null)?.textContent?.trim() ?? ''
      const awayTeam = (document.querySelector('[data-push="awayName"]') as HTMLElement | null)?.textContent?.trim() ?? ''
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
      return { events, score, homeTeam, awayTeam }
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
