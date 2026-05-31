import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { launchChrome, closeBrowser, scrapeLiveGames, scrapeGameData, navigateBet365GamePage, closeBet365GamePage, getBet365GamePage, getListPage } from './chromeBridge'
import { launchRfChrome, navigateToRfGame, scrapeRfMatchState, closeRfGamePage, closeRfBrowser, onGamesUpdate } from './radarFutebolBridge'

let overlayWin: BrowserWindow | null = null

// Múltiplas janelas de jogo (gameWinId → win / data)
const gameWins    = new Map<number, BrowserWindow>()
const gameWinData = new Map<number, unknown>()

// Feature windows com chave composta `${gameWinId}:${featureId}`
const featureWins = new Map<string, BrowserWindow>()

let latestGameData:  unknown   = null
let latestLiveGames: unknown[] = []
let latestRfGames:   unknown[] = []

let liveGamesInterval: ReturnType<typeof setInterval> | null = null
let radarPollInterval: ReturnType<typeof setInterval> | null = null
let rfMatchInterval:   ReturnType<typeof setInterval> | null = null
let rfNavEpoch = 0

const isDev = process.env['ELECTRON_RENDERER_URL'] !== undefined

function rendererUrl(params: Record<string, string> = {}): string {
  if (isDev) {
    const qs = new URLSearchParams(params).toString()
    return process.env['ELECTRON_RENDERER_URL']! + (qs ? `?${qs}` : '')
  }
  return ''
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Devolve o gameWinId do remetente (pode ser uma game win ou uma feature win) */
function findGameWinId(senderWin: BrowserWindow): number | null {
  if (gameWins.has(senderWin.id)) return senderWin.id
  for (const [key, fw] of featureWins) {
    if (fw.id === senderWin.id) return parseInt(key.split(':')[0])
  }
  return null
}

/** Devolve todas as janelas lances abertas */
function getLancesWins(): BrowserWindow[] {
  const result: BrowserWindow[] = []
  for (const [key, win] of featureWins) {
    if (key.endsWith(':lances') && !win.isDestroyed()) result.push(win)
  }
  return result
}

// ── Janela principal ──────────────────────────────────────────────────────────

function createOverlay(): void {
  overlayWin = new BrowserWindow({
    width: 380, height: 520, minWidth: 280, minHeight: 380,
    frame: false, transparent: true, resizable: true,
    webPreferences: { preload: join(__dirname, '../preload/overlay.js'), contextIsolation: true, sandbox: false },
  })
  isDev
    ? overlayWin.loadURL(rendererUrl())
    : overlayWin.loadFile(join(__dirname, '../renderer/index.html'))
  overlayWin.on('closed', () => { overlayWin = null })
}

// ── Janela do jogo ────────────────────────────────────────────────────────────

function createGameWindow(game: unknown): void {
  const g = game as { team1: string; team2: string }

  // Se já existe uma janela para este jogo exacto, foca-a
  for (const [winId, win] of gameWins) {
    const data = gameWinData.get(winId) as { team1: string; team2: string } | null
    if (data?.team1 === g?.team1 && data?.team2 === g?.team2 && !win.isDestroyed()) {
      win.webContents.send('gameWindowDataUpdated', game)
      win.focus()
      return
    }
  }

  // Cria nova janela de jogo
  const win = new BrowserWindow({
    width: 540, height: 440, minWidth: 280, minHeight: 380,
    frame: false, transparent: true, resizable: true, show: false,
    webPreferences: { preload: join(__dirname, '../preload/overlay.js'), contextIsolation: true, sandbox: false },
  })
  win.once('ready-to-show', () => win.show())
  isDev
    ? win.loadURL(rendererUrl({ mode: 'game' }))
    : win.loadFile(join(__dirname, '../renderer/index.html'), { query: { mode: 'game' } })

  gameWins.set(win.id, win)
  gameWinData.set(win.id, game)

  win.on('closed', () => {
    // Fecha todas as feature windows deste jogo (e as suas páginas)
    for (const [key, fw] of [...featureWins.entries()]) {
      if (!key.startsWith(`${win.id}:`)) continue
      if (key.endsWith(':radar'))  closeBet365GamePage(key).catch(() => {})
      if (key.endsWith(':lances')) closeRfGamePage(key).catch(() => {})
      if (!fw.isDestroyed()) fw.close()
      featureWins.delete(key)
    }
    gameWins.delete(win.id)
    gameWinData.delete(win.id)
  })
}

// ── Feature windows ───────────────────────────────────────────────────────────

const FEATURE_SIZES: Record<string, [number, number]> = {
  radar:         [300, 300],
  feature2:      [480, 380],
  lances:        [320, 355],
  'lances-popup': [320, 124],   // 3 rows × 34px + info bar 22px
}

function createFeatureWindow(gameWinId: number, featureId: string): void {
  const compositeKey = `${gameWinId}:${featureId}`
  const existing = featureWins.get(compositeKey)
  if (existing && !existing.isDestroyed()) {
    console.log('[main] createFeatureWindow: já existe, focando:', compositeKey)
    existing.focus()
    return
  }

  console.log('[main] createFeatureWindow: criando janela:', compositeKey)
  const [w, h] = FEATURE_SIZES[featureId] ?? [480, 380]
  const minH = featureId === 'lances-popup' ? 30 : 200
  const win = new BrowserWindow({
    width: w, height: h, minWidth: 200, minHeight: minH,
    frame: false, transparent: true, resizable: true, show: false,
    webPreferences: { preload: join(__dirname, '../preload/overlay.js'), contextIsolation: true, sandbox: false },
  })
  win.once('ready-to-show', () => {
    console.log('[main] ready-to-show para:', compositeKey)
    win.show()
    if (isDev) win.webContents.openDevTools({ mode: 'detach' })
  })
  win.webContents.on('render-process-gone', (_, details) => {
    console.error('[main] renderer crashed:', compositeKey, details.reason)
  })
  isDev
    ? win.loadURL(rendererUrl({ mode: featureId }))
    : win.loadFile(join(__dirname, '../renderer/index.html'), { query: { mode: featureId } })
  featureWins.set(compositeKey, win)
  win.on('closed', () => {
    featureWins.delete(compositeKey)
    if (featureId === 'radar') closeBet365GamePage(compositeKey).catch(() => {})
    if (featureId === 'lances') {
      closeRfGamePage(compositeKey).catch(() => {})
      // Fecha o popup se estiver aberto
      const popupWin = featureWins.get(compositeKey + '-popup')
      if (popupWin && !popupWin.isDestroyed()) popupWin.close()
    }
  })
}

// ── Chrome bet365 ─────────────────────────────────────────────────────────────

async function startChrome(): Promise<void> {
  await launchChrome()

  liveGamesInterval = setInterval(async () => {
    const page = getListPage()
    if (!page) return
    const games = await scrapeLiveGames(page)
    if (games.length > 0) {
      latestLiveGames = games
      overlayWin?.webContents.send('liveGamesUpdate', games)
      console.log('[main] liveGamesUpdate enviado:', games.length, 'jogos')
    }
  }, 4000)

  // gameDataInterval removido — polling por janela em startRadarPolling()
}

function stopChrome(): void {
  if (liveGamesInterval) { clearInterval(liveGamesInterval); liveGamesInterval = null }
  if (radarPollInterval) { clearInterval(radarPollInterval); radarPollInterval = null }
  if (rfMatchInterval)   { clearInterval(rfMatchInterval);   rfMatchInterval   = null }
  closeBrowser()
  closeRfBrowser()
}

function startRfMatchPolling(): void {
  if (rfMatchInterval) return
  rfMatchInterval = setInterval(async () => {
    let hasActive = false
    for (const [key, win] of featureWins) {
      if (!key.endsWith(':lances') || win.isDestroyed()) continue
      hasActive = true
      const state = await scrapeRfMatchState(key)
      if (state) {
        win.webContents.send('rfMatchUpdate', state)
        const popupWin = featureWins.get(key + '-popup')
        if (popupWin && !popupWin.isDestroyed()) popupWin.webContents.send('rfMatchUpdate', state)
      }
    }
    if (!hasActive && rfMatchInterval) {
      clearInterval(rfMatchInterval)
      rfMatchInterval = null
    }
  }, 1500)
}

const lastExtraTimeByGw = new Map<string, string | null>()

// Polling do radar de odds — cada janela *:radar tem a sua própria página bet365
function startRadarPolling(): void {
  if (radarPollInterval) return
  radarPollInterval = setInterval(async () => {
    let hasActive = false
    for (const [key, win] of featureWins) {
      if (!key.endsWith(':radar') || win.isDestroyed()) continue
      hasActive = true
      const page = getBet365GamePage(key)
      if (!page) continue
      const data = await scrapeGameData(page)
      if (data) {
        latestGameData = data
        win.webContents.send('gameDataUpdate', data)

        // Propaga acréscimos para as janelas de lances do mesmo jogo
        const gwId      = key.replace(':radar', '')
        const newExtra  = (data as { extraTime?: string | null }).extraTime ?? null
        const prevExtra = lastExtraTimeByGw.get(gwId) ?? null
        if (newExtra !== prevExtra) {
          lastExtraTimeByGw.set(gwId, newExtra)
          const lancesWin   = featureWins.get(`${gwId}:lances`)
          const lancesPopup = featureWins.get(`${gwId}:lances-popup`)
          if (lancesWin   && !lancesWin.isDestroyed())   lancesWin.webContents.send('rfExtraTime', newExtra)
          if (lancesPopup && !lancesPopup.isDestroyed()) lancesPopup.webContents.send('rfExtraTime', newExtra)
        }
      }
    }
    if (!hasActive && radarPollInterval) {
      clearInterval(radarPollInterval)
      radarPollInterval = null
    }
  }, 2000)
}

// ── IPC ───────────────────────────────────────────────────────────────────────
function setupIPC(): void {
  // SSE push: lista de jogos RF sem polling
  onGamesUpdate(games => {
    latestRfGames = games
    getLancesWins().forEach(w => w.webContents.send('rfGamesUpdate', games))
  })

  ipcMain.handle('getLiveGames', () => {
    console.log('[main] getLiveGames chamado, retornando', latestLiveGames.length, 'jogos')
    return latestLiveGames
  })

  ipcMain.handle('openBet365', async () => {
    if (!getListPage()) await startChrome()
    return { ok: true }
  })

  ipcMain.handle('focusBet365', () => ({ ok: true }))

  ipcMain.handle('resizeWindow', (event, width: number, height: number) => {
    BrowserWindow.fromWebContents(event.sender)
      ?.setSize(Math.max(200, Math.round(width)), Math.max(30, Math.round(height)))
  })

  ipcMain.handle('minimizeWindow', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle('openGameWindow', (_e, game: unknown) => {
    createGameWindow(game)
    return { ok: true }
  })

  ipcMain.handle('getGameWindowData', (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender)
    if (!sender) { console.warn('[main] getGameWindowData: sender null'); return null }
    const gwId = findGameWinId(sender)
    console.log('[main] getGameWindowData: sender.id=', sender.id, 'gwId=', gwId,
      'gameWins=', [...gameWins.keys()],
      'featureKeys=', [...featureWins.keys()])
    return gwId ? (gameWinData.get(gwId) ?? null) : null
  })

  ipcMain.handle('openFeatureWindow', (event, featureId: string) => {
    const sender = BrowserWindow.fromWebContents(event.sender)
    if (!sender) return { ok: false }
    const gwId = findGameWinId(sender)
    if (!gwId) return { ok: false }

    createFeatureWindow(gwId, featureId)
    const compositeKey = `${gwId}:${featureId}`

    if (featureId === 'radar') {
      const g = gameWinData.get(gwId) as { team1: string; team2: string } | null
      if (g?.team1 && g?.team2) {
        console.log('[main] Abrindo radar de odds para:', g.team1, 'x', g.team2)
        // Garante que o Chrome bet365 está a correr antes de navegar
        const ensureChrome = getListPage() ? Promise.resolve() : startChrome()
        ensureChrome
          .then(() => navigateBet365GamePage(g.team1, g.team2, compositeKey))
          .then(ok => {
            console.log('[main] navigateBet365GamePage resultado:', ok)
            if (ok) startRadarPolling()
          })
          .catch(e => console.error('[main] Erro ao navegar bet365:', e))
      }
    }

    if (featureId === 'lances') {
      const g = gameWinData.get(gwId) as { team1: string; team2: string; score?: string; time?: string } | null
      const compositeKey = `${gwId}:lances`
      if (g?.team1 && g?.team2) {
        featureWins.get(compositeKey)?.webContents.send('rfGameChanged')
        featureWins.get(compositeKey + '-popup')?.webContents.send('rfGameChanged')
        const epoch = ++rfNavEpoch
        launchRfChrome()
          .then(async () => {
            const nav = await navigateToRfGame(g.team1, g.team2, compositeKey, g.score, g.time)
            if (epoch !== rfNavEpoch) return
            if (nav.ok) {
              startRfMatchPolling()
            } else {
              featureWins.get(compositeKey)?.webContents.send('rfGameNotFound', nav.reason)
            }
          })
          .catch(e => console.error('[main] Erro ao lançar RF:', e))
      }
    }
    return { ok: true }
  })

  ipcMain.handle('openRfGame', async (_e, rfGame: { team1: string; team2: string }) => {
    const nav = await navigateToRfGame(rfGame.team1, rfGame.team2)
    if (!nav.ok) return { ok: false, error: nav.reason }
    return { ok: true }
  })

  ipcMain.handle('getRfGames', () => latestRfGames)

  ipcMain.handle('showWindow', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.show()
  })

  ipcMain.handle('showGameWindow', () => {
    // Com múltiplas janelas, não há "a" janela de jogo — no-op
  })

  ipcMain.handle('showFeatureWindow', (_e, featureId: string) => {
    // Com chaves compostas, não é possível lookup directo — no-op
    void featureId
  })

  ipcMain.handle('getBet365Games', () => {
    if (!latestGameData) return { games: [] }
    return { games: [{ winId: 0, data: latestGameData }] }
  })
}

// ── Flags Chromium (equivalentes às do Puppeteer) ─────────────────────────────
// Precisam ser aplicadas antes de qualquer renderer ser criado
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')
app.commandLine.appendSwitch('no-first-run')
app.commandLine.appendSwitch('no-default-browser-check')
app.commandLine.appendSwitch('disable-extensions')

// ── Bootstrap ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  setupIPC()
  createOverlay()
  app.on('activate', () => { if (!overlayWin) createOverlay() })
})

app.on('window-all-closed', () => {
  stopChrome()
  if (process.platform !== 'darwin') app.quit()
})
