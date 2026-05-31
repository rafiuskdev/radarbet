import type { Browser, Page } from 'puppeteer-core'
import { findChrome } from './chromeBridge'

const RF_URL = 'https://www.radarfutebol.com/'

async function getPuppeteer() {
  const mod = await import('puppeteer-core')
  return mod.default
}

// ── Estado ────────────────────────────────────────────────────────────────────
// rfListPage  → sempre na lista RF (como listPage da bet365)
// rfGamePages → Map<pageKey, Page>  onde pageKey = `${gameWinId}:lances`
//               Cada painel de lances tem a sua própria página de scoreboard

let rfBrowser:  Browser | null = null
let rfListPage: Page    | null = null
const rfGamePages = new Map<string, Page>()  // pageKey → scoreboard Page

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

// ── Utilitários ───────────────────────────────────────────────────────────────

export function makeGameKey(team1: string, team2: string): string {
  const norm = (s: string) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
     .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  return `${norm(team1)}-vs-${norm(team2)}`
}

// ── Launch ────────────────────────────────────────────────────────────────────

export async function launchRfChrome(): Promise<void> {
  if (rfBrowser) return
  const executablePath = findChrome()
  if (!executablePath) throw new Error('Chrome não encontrado')

  const puppeteer = await getPuppeteer()
  rfBrowser = await puppeteer.launch({
    executablePath,
    headless: false,
    args: ['--incognito', '--disable-blink-features=AutomationControlled',
           '--no-first-run', '--no-default-browser-check',
           '--window-size=800,600', '--start-minimized'],
    defaultViewport: { width: 800, height: 600 },
  })

  const pages = await rfBrowser.pages()
  rfListPage = pages[0] ?? await rfBrowser.newPage()
  console.log('[rfBridge] Navegando para radarfutebol...')
  await rfListPage.goto(RF_URL, { waitUntil: 'networkidle2', timeout: 30_000 })
  console.log('[rfBridge] radarfutebol carregado')
}

// ── Scraping: lista de jogos ──────────────────────────────────────────────────

export async function scrapeRfGames(): Promise<RfGame[]> {
  if (!rfListPage) return []
  try {
    return await rfListPage.evaluate((): RfGame[] => {
      const results: RfGame[] = []
      for (const table of Array.from(document.querySelectorAll('table')) as HTMLTableElement[]) {
        const countryImg = table.querySelector('thead img[alt]') as HTMLImageElement | null
        const country    = countryImg?.alt ?? ''
        const leagueEl   = table.querySelector('thead strong') as HTMLElement | null
        const full       = leagueEl?.textContent?.trim() ?? ''
        const ci         = full.indexOf(': ')
        const league     = ci >= 0 ? full.slice(ci + 2) : full

        for (const row of Array.from(table.querySelectorAll('tbody tr')) as HTMLTableRowElement[]) {
          const teamEls = row.querySelectorAll('p.text-left')
          if (teamEls.length < 2) continue
          const team1 = teamEls[0].textContent?.trim() ?? ''
          const team2 = teamEls[1].textContent?.trim() ?? ''
          if (!team1 || !team2) continue
          const time  = (row.querySelector('p.text-red-600') as HTMLElement | null)?.textContent?.trim() ?? ''
          const sEls  = row.querySelectorAll('strong.mx-1')
          const score = sEls.length >= 2
            ? `${sEls[0].textContent?.trim()}-${sEls[1].textContent?.trim()}`
            : '0-0'
          results.push({ team1, team2, time, score, league, country })
        }
      }
      return results
    })
  } catch (e) {
    console.error('[rfBridge] Erro em scrapeRfGames:', e)
    return []
  }
}

// ── Navegação para jogo específico ────────────────────────────────────────────
// pageKey = chave composta do painel de lances (ex: `42:lances`)
// Cada painel tem a sua própria página de scoreboard.

export async function navigateToRfGame(
  team1: string,
  team2: string,
  pageKey: string,
): Promise<RfNavResult> {
  if (!rfListPage) return { ok: false, reason: 'not-found' }

  // Reutiliza página existente para este painel
  const existing = rfGamePages.get(pageKey)
  if (existing && !existing.isClosed()) {
    console.log('[rfBridge] Reutilizando página RF para:', pageKey)
    return { ok: true, pageKey }
  }

  // Garante que rfListPage está na lista
  if (!rfListPage.url().includes('radarfutebol.com/')) {
    await rfListPage.goto(RF_URL, { waitUntil: 'networkidle2', timeout: 20_000 })
  }

  await rfListPage.waitForSelector('tbody tr', { timeout: 10_000 }).catch(() => {})

  // Activa filtro AO VIVO
  await rfListPage.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]
    const lb   = btns.find(b => b.textContent?.toLowerCase().includes('ao vivo'))
    if (lb && !lb.classList.contains('bg-red-100')) lb.click()
  }).catch(() => {})
  await new Promise(r => setTimeout(r, 1000))

  // Fuzzy match e marca botão Radar
  const result = await rfListPage.evaluate((t1: string, t2: string) => {
    function norm(s: string) {
      return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
    }
    function fuzzy(hay: string, needle: string): boolean {
      const h = norm(hay), n = norm(needle)
      if (h === n || h.includes(n) || n.includes(h)) return true
      return n.split(' ').filter(w => w.length >= 3).some(w => h.includes(w))
    }
    for (const row of Array.from(document.querySelectorAll('tbody tr')) as HTMLTableRowElement[]) {
      const els = row.querySelectorAll('p.text-left')
      if (els.length < 2) continue
      const f1 = els[0].textContent?.trim() ?? ''
      const f2 = els[1].textContent?.trim() ?? ''
      if (!(fuzzy(f1, t1) || fuzzy(f1, t2))) continue
      if (!(fuzzy(f2, t1) || fuzzy(f2, t2))) continue
      const btn = row.querySelector('.radar[title="Radar"]') as HTMLElement | null
      if (btn) { btn.setAttribute('data-rb-lances', 'true'); return { ok: true, found: true } }
      return { ok: false, found: true }
    }
    return { ok: false, found: false }
  }, team1, team2)

  console.log('[rfBridge] Busca RF:', result, '|', team1, 'x', team2)

  if (!result.ok) {
    return { ok: false, reason: result.found ? 'no-radar' : 'not-found' }
  }

  // Listener ANTES do clique
  const newPagePromise = new Promise<Page | null>(resolve => {
    const t = setTimeout(() => resolve(null), 10_000)
    rfBrowser?.once('targetcreated', async target => {
      clearTimeout(t)
      resolve(await target.page().catch(() => null))
    })
  })

  await rfListPage.click('[data-rb-lances]')
  await rfListPage.evaluate(() => {
    document.querySelector('[data-rb-lances]')?.removeAttribute('data-rb-lances')
  }).catch(() => {})

  const newPage = await newPagePromise
  if (!newPage) {
    console.warn('[rfBridge] Nova janela não detectada')
    return { ok: false, reason: 'not-found' }
  }

  // Extrai idWilliamhill e navega para o scoreboard
  await newPage.waitForSelector('[wire\\:snapshot]', { timeout: 10_000 }).catch(() => {})
  const whId = await newPage.evaluate(() => {
    const el = document.querySelector('[wire\\:snapshot]')
    if (!el) return null
    try { return JSON.parse(el.getAttribute('wire:snapshot') ?? '{}')?.data?.idWilliamhill ?? null }
    catch { return null }
  }).catch(() => null)

  if (whId) {
    await newPage.goto(
      `https://radarfutebol.xyz/scoreboards/app/football/index.html?eventId=${whId}&sport=football&locale=pt-pt&theme=dark`,
      { waitUntil: 'domcontentloaded', timeout: 20_000 }
    )
  }

  await newPage.waitForSelector('#scoreboard:not(.loading-animation)', { timeout: 15_000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 1000))

  await newPage.evaluate((): void => {
    const li = document.querySelector('li[data-action="commentaries"]') as HTMLElement | null
    if (!li) return
    li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
    li.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }))
    li.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window }))
    li.click()
  }).catch(() => {})

  await newPage.waitForSelector('#box_commentaries li', { timeout: 12_000 })
    .then(() => console.log('[rfBridge] Comentários carregados para:', pageKey))
    .catch(() => console.warn('[rfBridge] Timeout comentários para:', pageKey))

  rfGamePages.set(pageKey, newPage)
  console.log('[rfBridge] rfGamePages registado:', pageKey)
  return { ok: true, pageKey }
}

// ── Scraping: estado do jogo ──────────────────────────────────────────────────

export async function scrapeRfMatchState(pageKey: string): Promise<RfMatchState | null> {
  const page = rfGamePages.get(pageKey)
  if (!page || page.isClosed()) return null
  try {
    return await page.evaluate((): RfMatchState => {
      const score    = (document.querySelector('[data-push="score"]')    as HTMLElement | null)?.textContent?.trim() ?? ''
      const homeTeam = (document.querySelector('[data-push="homeName"]') as HTMLElement | null)?.textContent?.trim() ?? ''
      const awayTeam = (document.querySelector('[data-push="awayName"]') as HTMLElement | null)?.textContent?.trim() ?? ''
      const events: LanceEvent[] = []
      for (const li of Array.from(document.querySelectorAll('#box_commentaries li')) as HTMLLIElement[]) {
        const minute   = li.querySelector('.minute')?.textContent?.trim() ?? ''
        const seconds  = li.querySelector('.seconds')?.textContent?.trim() ?? ''
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

// ── Fechar página de um painel específico ─────────────────────────────────────

export async function closeRfGamePage(pageKey: string): Promise<void> {
  const page = rfGamePages.get(pageKey)
  if (page && !page.isClosed()) {
    await page.close().catch(() => {})
  }
  rfGamePages.delete(pageKey)
  console.log('[rfBridge] Página fechada:', pageKey)
}

// ── Cleanup total ─────────────────────────────────────────────────────────────

export async function closeRfBrowser(): Promise<void> {
  await rfBrowser?.close()
  rfBrowser  = null
  rfListPage = null
  rfGamePages.clear()
}
