// Puppeteer-core é ESM puro — usar import dinâmico para compatibilidade com CommonJS do Electron
import type { Browser, Page } from 'puppeteer-core'
import { existsSync } from 'fs'
import { join } from 'path'

async function getPuppeteer() {
  const mod = await import('puppeteer-core')
  return mod.default
}

// ─── Localização do Chrome no Windows ────────────────────────────────────────

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env['PROGRAMFILES'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
]

export function findChrome(): string | null {
  for (const p of CHROME_PATHS) {
    if (existsSync(p)) {
      console.log('[chromeBridge] Chrome encontrado em:', p)
      return p
    }
  }
  console.error('[chromeBridge] Chrome não encontrado. Caminhos testados:', CHROME_PATHS)
  return null
}

// ─── Estado do browser ────────────────────────────────────────────────────────

let browser:   Browser | null = null
let listPage:  Page | null = null                        // sempre na /IP/B1
const gamePages = new Map<string, Page>()                   // pageKey → Page (um por RadarPanel)

export async function launchChrome(): Promise<void> {
  const executablePath = findChrome()
  if (!executablePath) throw new Error('Chrome não encontrado no sistema')

  console.log('[chromeBridge] Lançando Chrome incognito...')

  const puppeteer = await getPuppeteer()
  browser = await puppeteer.launch({
    executablePath,
    headless: false,
    args: [
      '--incognito',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=800,600',
      '--start-minimized',
    ],
    defaultViewport: { width: 800, height: 600 },
  })

  // Aba 1: lista de jogos ao vivo (nunca navega para fora de /IP/B1)
  const pages = await browser.pages()
  listPage = pages[0] ?? await browser.newPage()
  console.log('[chromeBridge] Aba 1 (lista): navegando para /IP/B1...')
  await listPage.goto('https://www.bet365.com/#/IP/B1', { waitUntil: 'domcontentloaded', timeout: 30_000 })

}

export function getListPage(): Page | null { return listPage }
export function getBet365GamePage(pageKey: string): Page | null { return gamePages.get(pageKey) ?? null }

export async function closeBrowser(): Promise<void> {
  await browser?.close()
  browser = null
  listPage = null
  gamePages.clear()
}

// ─── Scraping: lista de jogos ao vivo (/IP/B1) ───────────────────────────────

export async function scrapeLiveGames(page: Page): Promise<unknown[]> {
  try {
    const games = await page.evaluate(() => {
      const results: unknown[] = []

      for (const competition of Array.from(document.querySelectorAll('.ovm-Competition'))) {
        const leagueEl = competition.querySelector('.ovm-CompetitionHeader_NameText')
        if (!leagueEl) continue

        const fullLeague = (leagueEl.textContent ?? '').trim()
        const dashIdx    = fullLeague.indexOf(' - ')
        const country    = dashIdx >= 0 ? fullLeague.slice(0, dashIdx).trim() : fullLeague
        const league     = dashIdx >= 0 ? fullLeague.slice(dashIdx + 3).trim() : fullLeague

        for (const fixture of Array.from(competition.querySelectorAll('.ovm-Fixture'))) {
          const teamEls = fixture.querySelectorAll('.ovm-FixtureDetailsTwoWay_TeamName')
          if (teamEls.length < 2) continue

          const team1 = (teamEls[0].textContent ?? '').trim()
          const team2 = (teamEls[1].textContent ?? '').trim()
          if (!team1 || !team2) continue

          const scorePills = fixture.querySelectorAll('.ovm-ScorePill')
          const score = scorePills.length >= 2
            ? `${scorePills[0].textContent?.trim()}-${scorePills[1].textContent?.trim()}`
            : '0-0'

          const timeEl  = fixture.querySelector('.ovm-InPlayTimer, .ovm-FixtureFooter_Timer')
          const timeRaw = (timeEl?.textContent ?? '').trim()
          const time    = timeRaw.includes(':') ? timeRaw.split(':')[0] : timeRaw || '--'

          const oddsEls = fixture.querySelectorAll('.ovm-ParticipantOddsOnly_Odds')
          const odds = {
            home: oddsEls[0] ? parseFloat(oddsEls[0].textContent ?? '') || null : null,
            draw: oddsEls[1] ? parseFloat(oddsEls[1].textContent ?? '') || null : null,
            away: oddsEls[2] ? parseFloat(oddsEls[2].textContent ?? '') || null : null,
          }

          const hasStream = !!fixture.querySelector('.ovm-VideoIconLabel, [class*="VideoIcon"]')

          results.push({ team1, team2, score, time, league, country, odds, hasStream })
        }
      }

      return results
    })

    console.log('[chromeBridge] scrapeLiveGames:', games.length, 'jogos')
    return games
  } catch (e) {
    console.error('[chromeBridge] Erro em scrapeLiveGames:', e)
    return []
  }
}

// ─── Scraping: odds do jogo individual (radar) ────────────────────────────────

export async function scrapeGameData(page: Page): Promise<unknown> {
  try {
    return await page.evaluate(() => {
      function readGameTime(): string | null {
        const sels = ['.ml1-SoccerClock_Clock', '.lv-ScoreBasedClockPart', '.lv-ClockBasedTime_Clocks', '[class*="lv-ClockBased"]', '[class*="ScoreClock"]']
        for (const s of sels) {
          const el = document.querySelector(s)
          if (el?.textContent?.trim()) return el.textContent.trim()
        }
        return null
      }

      function readExtraTime(): string | null {
        const el = document.querySelector('.ml1-SoccerClock_InjuryTime')
        const text = el?.textContent?.trim() ?? ''
        if (!text) return null
        // "+7 Min." → "+7"
        return text.replace(/\s*Min\.?/i, '').trim() || null
      }

      function readTotalGoals(): number | null {
        const combined = ['.lv-ScoreBasedScore', '[class*="ScoreBasedScore"]', '[class*="InPlayScore"]']
        for (const s of combined) {
          for (const el of Array.from(document.querySelectorAll(s))) {
            const m = el.textContent?.trim().match(/^(\d+)\s*[-:]\s*(\d+)$/)
            if (m) return parseInt(m[1]) + parseInt(m[2])
          }
        }
        return null
      }

      function parseGoalsPod(pod: Element, label: string): unknown {
        const lineEls = pod.querySelectorAll('.srb-ParticipantLabelCentered_Name')
        const lines   = Array.from(lineEls).map(el => parseFloat(el.textContent ?? ''))
        let overOdds: number[] = [], underOdds: number[] = []

        for (const col of Array.from(pod.querySelectorAll('.gl-Market_General-columnheader'))) {
          const header = col.querySelector('.gl-MarketColumnHeader')
          if (!header) continue
          const h = header.textContent?.trim().toLowerCase() ?? ''
          const odds = Array.from(col.querySelectorAll('.gl-ParticipantOddsOnly_Odds')).map(el => parseFloat(el.textContent ?? ''))
          if (/mais|over/i.test(h)) overOdds = odds
          if (/menos|under/i.test(h)) underOdds = odds
        }

        if (!lines.length || !overOdds.length) return null
        return {
          label, isHalf: /parte|half/i.test(label),
          lines: lines
            .map((line, i) => ({ line, over: overOdds[i] ?? null, under: underOdds[i] ?? null }))
            .filter(l => l.over !== null && !isNaN(l.line))
            .sort((a, b) => a.line - b.line),
        }
      }

      function readGoalsMarket(): unknown {
        const labelEls = document.querySelectorAll('.sip-MarketGroupButton_Text, .gl-MarketGroupButton_Text')
        const halfContainers: { pod: Element; label: string }[] = []
        const matchContainers: { pod: Element; label: string }[] = []

        for (const el of Array.from(labelEls)) {
          const text = el.textContent?.trim() ?? ''
          if (!/gol[os]|goal/i.test(text)) continue
          const pod = el.closest('.gl-MarketGroupPod, .sip-MarketGroup')
          if (!pod) continue
          if (/parte|half/i.test(text)) halfContainers.push({ pod, label: text })
          // Inclui TODOS os pods de "Encontro - Golos" (incluindo "Mais Opções")
          else if (/encontro|match|game/i.test(text)) matchContainers.push({ pod, label: text })
        }

        const targets = halfContainers.length > 0 ? halfContainers : matchContainers
        if (targets.length === 0) return null

        // Merge linhas de todos os pods (principal + Mais Opções)
        const firstResult = parseGoalsPod(targets[0].pod, targets[0].label) as { label: string; isHalf: boolean; lines: { line: number; over: number | null; under: number | null }[] } | null
        if (!firstResult) return null

        const seen = new Set<number>(firstResult.lines.map(l => l.line))
        const allLines = [...firstResult.lines]

        for (let i = 1; i < targets.length; i++) {
          const extra = parseGoalsPod(targets[i].pod, targets[i].label) as typeof firstResult
          if (extra?.lines) {
            for (const l of extra.lines) {
              if (!seen.has(l.line)) { seen.add(l.line); allLines.push(l) }
            }
          }
        }

        allLines.sort((a, b) => a.line - b.line)
        return { ...firstResult, lines: allLines }
      }

      function readSuspended(): boolean {
        return !!(
          document.querySelector('.gl-ParticipantOddsOnly_Suspended') ||
          document.querySelector('.gl-ParticipantBorderless_Suspended') ||
          document.querySelector('.srb-ParticipantLabelCentered_Suspended')
        )
      }

      function readNextGoalOdds(): unknown {
        for (const el of Array.from(document.querySelectorAll('.sip-MarketGroupButton_Text, .gl-MarketGroupButton_Text'))) {
          const text = el.textContent?.toLowerCase() ?? ''
          if (!text.includes('golo') && !text.includes('próximo gol') && !text.includes('next goal')) continue
          const pod = el.closest('.gl-MarketGroupPod, .sip-MarketGroup')
          if (!pod) continue
          const names = pod.querySelectorAll('.gl-ParticipantBorderless_Name')
          const odds  = pod.querySelectorAll('.gl-ParticipantBorderless_Odds')
          if (names.length >= 3 && odds.length >= 3) {
            return {
              team1:  { name: names[0].textContent?.trim(), odd: parseFloat(odds[0].textContent ?? '') },
              noGoal: { name: names[1].textContent?.trim(), odd: parseFloat(odds[1].textContent ?? '') },
              team2:  { name: names[2].textContent?.trim(), odd: parseFloat(odds[2].textContent ?? '') },
            }
          }
        }
        return null
      }

      return { time: readGameTime(), extraTime: readExtraTime(), suspended: readSuspended(), score: readTotalGoals(), goals: readGoalsMarket(), nextGoal: readNextGoalOdds(), updatedAt: Date.now() }
    })
  } catch (e) {
    console.error('[chromeBridge] Erro em scrapeGameData:', e)
    return null
  }
}

// ─── Navegação para jogo específico ──────────────────────────────────────────


// ── API pública: navega uma página bet365 dedicada para o jogo ────────────────

export async function navigateBet365GamePage(
  team1: string,
  team2: string,
  pageKey: string,
): Promise<boolean> {
  if (!browser) { console.error('[chromeBridge] browser não iniciado'); return false }

  // Reutiliza página existente se o jogo já está carregado
  const existing = gamePages.get(pageKey)
  if (existing && !existing.isClosed()) {
    console.log('[chromeBridge] Reutilizando página para:', pageKey)
    return true
  }

  if (!listPage) return false

  // Usa listPage (já tem todos os jogos carregados) como router:
  // 1. Encontra o jogo e clica → listPage navega para o URL do jogo
  // 2. Captura o URL do jogo
  // 3. Volta listPage para /IP/B1
  // 4. Nova página navega directamente para o URL capturado

  const marked = await listPage.evaluate((t1: string, t2: string): boolean => {
    function normalize(s: string) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase() }
    function fuzzy(hay: string, needle: string) {
      const h = normalize(hay), n = normalize(needle)
      if (h.includes(n)) return true
      return n.split(/\s+/).some(w => w.length >= 4 && h.includes(w))
    }
    for (const fixture of Array.from(document.querySelectorAll('.ovm-Fixture'))) {
      const teamEls = fixture.querySelectorAll('.ovm-FixtureDetailsTwoWay_TeamName')
      if (teamEls.length < 2) continue
      const ft1 = (teamEls[0].textContent ?? '').trim()
      const ft2 = (teamEls[1].textContent ?? '').trim()
      if (!fuzzy(ft1, t1) && !fuzzy(ft1, t2)) continue
      if (!fuzzy(ft2, t1) && !fuzzy(ft2, t2)) continue
      const target = fixture.querySelector('.ovm-FixtureDetailsTwoWay_Wrapper') ?? fixture
      ;(target as HTMLElement).setAttribute('data-rb-nav', 'true')
      return true
    }
    return false
  }, team1, team2)

  if (!marked) {
    console.warn('[chromeBridge] Jogo não encontrado na listPage:', team1, 'x', team2)
    return false
  }

  // Restaura/foca a janela antes de clicar — a SPA da bet365 requer foco no documento
  let cdpSession: Awaited<ReturnType<Page['createCDPSession']>> | null = null
  let windowId: number | null = null
  let wasMinimized = false
  try {
    cdpSession = await listPage.createCDPSession()
    const winInfo = await cdpSession.send('Browser.getWindowForTarget') as { windowId: number; bounds: { windowState: string } }
    windowId = winInfo.windowId
    wasMinimized = winInfo.bounds.windowState === 'minimized'
    if (wasMinimized) {
      await cdpSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    }
    await listPage.bringToFront()
    await new Promise(r => setTimeout(r, 300))
  } catch (e) {
    console.warn('[chromeBridge] CDP focus falhou (continuando):', e)
  }

  // Clica no elemento marcado (Puppeteer page.click — requer janela ativa)
  const beforeUrl = listPage.url()
  await listPage.click('[data-rb-nav]')
  await listPage.evaluate(() => {
    document.querySelector('[data-rb-nav]')?.removeAttribute('data-rb-nav')
  }).catch(() => {})

  // Polling pela mudança de URL (até 3s)
  let gameUrl = listPage.url()
  for (let i = 0; i < 30; i++) {
    if (gameUrl !== beforeUrl) break
    await new Promise(r => setTimeout(r, 100))
    gameUrl = listPage.url()
  }
  console.log('[chromeBridge] URL capturada:', gameUrl)

  // Re-minimiza antes de qualquer return
  const reMinimize = async () => {
    if (wasMinimized && cdpSession && windowId !== null) {
      await cdpSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }).catch(() => {})
    }
    await cdpSession?.detach().catch(() => {})
  }

  if (gameUrl === beforeUrl) {
    console.error('[chromeBridge] Navegação falhou — URL não mudou para:', team1, 'x', team2)
    await reMinimize()
    return false
  }

  // Volta listPage para a lista
  await listPage.goto('https://www.bet365.com/#/IP/B1', { waitUntil: 'domcontentloaded', timeout: 10_000 })
  await reMinimize()

  // Cria nova página e navega directamente para o URL do jogo
  const page = await browser.newPage()
  await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  console.log('[chromeBridge] Nova página para:', pageKey, '→', gameUrl)

  // Ativa a view ML1 (stats/odds/clock) — a página abre por padrão na view de vídeo
  await page.waitForSelector('[data-mbl-variant="ML1"]', { timeout: 8_000 })
    .then(() =>
      page.evaluate(() => {
        const btn = document.querySelector('[data-mbl-variant="ML1"]') as HTMLElement | null
        btn?.click()
      })
    )
    .catch(() => console.warn('[chromeBridge] ML1 button não encontrado:', pageKey))

  gamePages.set(pageKey, page)
  return true
}

export async function closeBet365GamePage(pageKey: string): Promise<void> {
  const page = gamePages.get(pageKey)
  if (page && !page.isClosed()) await page.close().catch(() => {})
  gamePages.delete(pageKey)
  console.log('[chromeBridge] Página fechada:', pageKey)
}
