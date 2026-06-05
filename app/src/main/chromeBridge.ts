import type { Browser, Page } from 'puppeteer-core'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'

// ─── Localização do Chrome no Windows ────────────────────────────────────────

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env['PROGRAMFILES'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
]

export function findChrome(): string | null {
  for (const p of CHROME_PATHS) {
    if (existsSync(p)) return p
  }
  return null
}

// ─── Remove ícones do Chrome da taskbar (ITaskbarList::DeleteTab + WS_EX_TOOLWINDOW) ──
// Usa retry loop interno de até 9s — assim não depende de timing externo.
// ITaskbarList::DeleteTab é a mesma API que o Electron usa para skipTaskbar.
export function hideChromeFromTaskbar(pid: number): void {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITaskbarList {
    [PreserveSig] int HrInit();
    [PreserveSig] int AddTab(IntPtr hwnd);
    [PreserveSig] int DeleteTab(IntPtr hwnd);
    [PreserveSig] int ActivateTab(IntPtr hwnd);
    [PreserveSig] int SetActiveAlt(IntPtr hwnd);
}

public class WinHide {
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc fn, IntPtr lp);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int n);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int n, int v);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr ins, int x, int y, int cx, int cy, uint f);
    delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);

    public static int Hide(int targetPid) {
        Type t = Type.GetTypeFromCLSID(new Guid("56FDF344-FD6D-11d0-958A-006097C9A090"));
        ITaskbarList tbl = (ITaskbarList)Activator.CreateInstance(t);
        tbl.HrInit();
        int count = 0;
        for (int attempt = 0; attempt < 30; attempt++) {
            Thread.Sleep(300);
            EnumWindows((h, lp) => {
                uint wp; GetWindowThreadProcessId(h, out wp);
                if ((int)wp == targetPid) {
                    tbl.DeleteTab(h);
                    int s = GetWindowLong(h, -20);
                    s = (s & ~0x00040000) | 0x00000080;
                    SetWindowLong(h, -20, s);
                    SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x0027);
                    count++;
                }
                return true;
            }, IntPtr.Zero);
            if (count > 0) break;
        }
        return count;
    }
}
"@
[WinHide]::Hide(${pid})
`
  const scriptPath = join(tmpdir(), `radarbet-hide-${pid}.ps1`)
  writeFileSync(scriptPath, script, 'utf8')
  const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    windowsHide: true,
  })
  let out = ''
  proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
  proc.stderr.on('data', (d: Buffer) => { out += d.toString() })
  proc.on('close', (code: number) => {
    console.log(`[chromeBridge] hideChromeFromTaskbar PID ${pid} — exit ${code} — output: "${out.trim()}"`)
  })
}

async function getPuppeteer() {
  const mod = await import('puppeteer-core')
  return mod.default
}

// ─── Região / domínio da bet365 ──────────────────────────────────────────────

const BET365_DOMAINS: Record<'uk' | 'br', string> = {
  uk: 'https://www.bet365.com',
  br: 'https://www.bet365.bet.br',
}
let activeBet365BaseUrl = BET365_DOMAINS.uk

export function setBet365Region(region: 'uk' | 'br'): void {
  activeBet365BaseUrl = BET365_DOMAINS[region] ?? BET365_DOMAINS.uk
}

// ─── Estado do browser ────────────────────────────────────────────────────────

let browser:    Browser | null = null
let listPage:   Page | null = null
let chromePid:  number | null = null
const gamePages  = new Map<string, Page>()
const gameUrlCache = new Map<string, string>() // key: `${team1}|${team2}` → URL do evento bet365

// Mantém a página "ativa" mesmo com a janela minimizada/off-screen.
// A bet365 pausa o push de odds quando document.hidden = true (visibilityState
// 'hidden'). setFocusEmulationEnabled força a página a ser tratada como visível
// e focada; setWebLifecycleState 'active' impede o congelamento do renderer.
export async function keepPageActive(page: Page): Promise<void> {
  try {
    const client = await page.createCDPSession()
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await client.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
  } catch (e) {
    console.warn('[chromeBridge] keepPageActive falhou:', (e as Error).message)
  }
}

// Força a página a reportar SEMPRE visível/focada e bloqueia os eventos de pausa.
// A bet365/RF param o push de odds/lances ao detetar document.hidden=true (janela
// minimizada). Tem de ser injetado ANTES do goto (evaluateOnNewDocument) para
// apanhar os scripts iniciais da página.
export async function forcePageVisible(page: Page): Promise<void> {
  try {
    await page.evaluateOnNewDocument(() => {
      const def = (name: string, val: unknown): void => {
        try { Object.defineProperty(Document.prototype, name, { configurable: true, get: () => val }) } catch { /* noop */ }
        try { Object.defineProperty(document, name, { configurable: true, get: () => val }) } catch { /* noop */ }
      }
      def('visibilityState', 'visible')
      def('webkitVisibilityState', 'visible')
      def('hidden', false)
      def('webkitHidden', false)
      try { document.hasFocus = () => true } catch { /* noop */ }
      const block = (e: Event): void => { e.stopImmediatePropagation() }
      for (const evt of ['visibilitychange', 'webkitvisibilitychange', 'freeze', 'pagehide']) {
        window.addEventListener(evt, block, true)
        document.addEventListener(evt, block, true)
      }
    })
  } catch (e) {
    console.warn('[chromeBridge] forcePageVisible falhou:', (e as Error).message)
  }
}

export async function launchChrome(): Promise<void> {
  const executablePath = findChrome()
  if (!executablePath) throw new Error('Chrome não encontrado no sistema')

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
      // Janela off-screen com TAMANHO REAL (não 1×1 nem minimizada): uma janela
      // de área ~zero é estrangulada pelo Chrome (o compositor pára e a bet365
      // deixa de empurrar odds). 1280×900 em -3300,-3300 fica fora do ecrã mas
      // "visível" para o Chrome, mantendo o feed de odds vivo.
      '--window-size=1280,900',
      '--window-position=-3300,-3300',
      // Anti-throttling: impede o Chrome de "adormecer" a janela em background
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
    defaultViewport: { width: 800, height: 600 },
  })

  chromePid = browser.process()?.pid ?? null

  const pages = await browser.pages()
  listPage = pages[0] ?? await browser.newPage()
  await forcePageVisible(listPage)
  await listPage.goto(`${activeBet365BaseUrl}/#/IP/B1`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await keepPageActive(listPage)

  if (chromePid) hideChromeFromTaskbar(chromePid)
}

export function getListPage(): Page | null { return listPage }
export function getBet365GamePage(pageKey: string): Page | null { return gamePages.get(pageKey) ?? null }

export async function closeBrowser(): Promise<void> {
  await browser?.close()
  browser = null
  listPage = null
  gamePages.clear()
  gameUrlCache.clear()
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
          if (!/gols?|golo|goal/i.test(text)) continue
          const pod = el.closest('.gl-MarketGroupPod, .sip-MarketGroup')
          if (!pod) continue
          if (/parte|half/i.test(text)) halfContainers.push({ pod, label: text })
          else if (/encontro|match|game|partida/i.test(text)) matchContainers.push({ pod, label: text })
        }

        const targets = halfContainers.length > 0 ? halfContainers : matchContainers
        if (targets.length === 0) return null

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
        const labelEls = document.querySelectorAll('.sip-MarketGroupButton_Text, .gl-MarketGroupButton_Text')
        for (const el of Array.from(labelEls)) {
          const text = el.textContent?.trim() ?? ''
          if (!/gols?|golo|goal/i.test(text)) continue
          if (!/encontro|match|game|partida|parte|half/i.test(text)) continue
          const pod = el.closest('.gl-MarketGroupPod, .sip-MarketGroup')
          if (!pod) continue
          if (
            pod.querySelector('.gl-ParticipantOddsOnly_Suspended') ||
            pod.querySelector('.gl-ParticipantBorderless_Suspended') ||
            pod.querySelector('.srb-ParticipantLabelCentered_Suspended')
          ) return true
        }
        return false
      }

      function readNextGoalOdds(): unknown {
        for (const el of Array.from(document.querySelectorAll('.sip-MarketGroupButton_Text, .gl-MarketGroupButton_Text'))) {
          const text = el.textContent?.toLowerCase() ?? ''
          if (!/golo|próximo gol|next goal|1[°º]\s*gol/i.test(text)) continue
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

export async function navigateBet365GamePage(
  team1: string,
  team2: string,
  pageKey: string,
): Promise<boolean> {
  if (!browser) { console.error('[chromeBridge] browser não iniciado'); return false }

  const existing = gamePages.get(pageKey)
  if (existing && !existing.isClosed()) {
    console.log('[chromeBridge] Reutilizando página para:', pageKey)
    return true
  }

  if (!listPage) return false

  const cacheKey = `${team1}|${team2}`
  let gameUrl = gameUrlCache.get(cacheKey) ?? null

  if (!gameUrl) {
    // Primeira vez: captura URL via click na listPage

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

    let cdpSession: Awaited<ReturnType<Page['createCDPSession']>> | null = null
    let windowId: number | null = null
    try {
      cdpSession = await listPage.createCDPSession()
      const winInfo = await cdpSession.send('Browser.getWindowForTarget') as { windowId: number; bounds: { windowState: string } }
      windowId = winInfo.windowId
      await cdpSession.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal', width: 1280, height: 900, left: -3300, top: -3300 },
      })
      await listPage.bringToFront()
      await new Promise(r => setTimeout(r, 300))
    } catch (e) {
      console.warn('[chromeBridge] CDP focus falhou (continuando):', e)
    }

    const reMinimize = async () => {
      if (cdpSession && windowId !== null) {
        // Mantém a janela off-screen mas com tamanho REAL (não 1×1) para o Chrome
        // não estrangular o render — senão a bet365 pára de empurrar odds.
        await cdpSession.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'normal', width: 1280, height: 900, left: -3300, top: -3300 },
        }).catch(() => {})
      }
      await cdpSession?.detach().catch(() => {})
    }

    const beforeUrl = listPage.url()
    let capturedUrl: string | null = null

    // URL de jogo válida contém /EV{id} — ex: #/IP/EV151343427462C1
    // #/HO/ e #/IP/B1 não contêm /EV → rejeitados
    const isValidGameUrl = (url: string) =>
      url !== beforeUrl && /\/EV[A-Z0-9]+/.test(url)

    const navHandler = () => {
      const url = listPage!.url()
      if (isValidGameUrl(url)) capturedUrl = url
    }
    listPage.on('framenavigated', navHandler)

    // Captura URL se bet365 abrir o jogo em nova aba
    let newTabUrl: string | null = null
    let newTabSettled = false
    const targetCreatedHandler = async (target: { type(): string; page(): Promise<Page | null> }) => {
      if (target.type() !== 'page') return
      const tp = await target.page()
      if (!tp) { newTabSettled = true; return }
      await new Promise(r => setTimeout(r, 1000))
      const url = tp.url()
      if (isValidGameUrl(url)) newTabUrl = url
      newTabSettled = true
      await tp.close().catch(() => {})
    }
    browser.on('targetcreated', targetCreatedHandler)

    // Scroll ao centro do viewport para evitar header/overlay fixo no topo
    await listPage.evaluate(() => {
      (document.querySelector('[data-rb-nav]') as HTMLElement | null)
        ?.scrollIntoView({ block: 'center', behavior: 'instant' })
    }).catch(() => {})
    await new Promise(r => setTimeout(r, 200))

    // Diagnóstico: posição do elemento pós-scroll e URL antes do click
    const preClickInfo = await listPage.evaluate(() => {
      const el = document.querySelector('[data-rb-nav]') as HTMLElement | null
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top), height: Math.round(r.height), tag: el.tagName, cls: el.className.slice(0, 80) }
    }).catch(() => null)
    console.log('[chromeBridge] pré-click:', preClickInfo, '| URL:', listPage.url())

    // page.click() envia eventos com isTrusted=true via CDP (exigido pelo SPA da bet365)
    await listPage.click('[data-rb-nav]')
    await listPage.evaluate(() => {
      document.querySelector('[data-rb-nav]')?.removeAttribute('data-rb-nav')
    }).catch(() => {})

    await new Promise(r => setTimeout(r, 300))
    console.log('[chromeBridge] URL 300ms pós-click:', listPage.url())

    for (let i = 0; i < 50 && capturedUrl === null && !newTabSettled; i++) {
      await new Promise(r => setTimeout(r, 100))
      const currentUrl = listPage!.url()
      if (isValidGameUrl(currentUrl)) capturedUrl = currentUrl
    }
    listPage.off('framenavigated', navHandler)
    browser.off('targetcreated', targetCreatedHandler)

    gameUrl = capturedUrl ?? newTabUrl ?? null
    if (!gameUrl) {
      console.error('[chromeBridge] Nenhuma URL de jogo válida capturada para:', team1, 'x', team2)
      await listPage.evaluate(() => { window.location.hash = '/IP/B1' }).catch(() => {})
      await reMinimize()
      return false
    }
    console.log('[chromeBridge] URL capturada:', gameUrl)
    gameUrlCache.set(cacheKey, gameUrl)
    console.log('[chromeBridge] URL cacheada para:', cacheKey)

    await listPage.evaluate(() => { window.location.hash = '/IP/B1' })
    await reMinimize()
    if (chromePid) hideChromeFromTaskbar(chromePid)
  } else {
    console.log('[chromeBridge] Usando URL cacheada para:', cacheKey, '→', gameUrl)
  }

  const page = await browser.newPage()
  await forcePageVisible(page)  // injeta override de visibilidade ANTES do goto
  await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await keepPageActive(page)   // impede o congelamento do push de odds em background
  console.log('[chromeBridge] Nova página para:', pageKey, '→', gameUrl)
  if (chromePid) hideChromeFromTaskbar(chromePid)

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
