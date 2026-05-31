import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  onGameDataUpdate: (cb: (data: unknown) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: unknown): void => cb(data)
    ipcRenderer.on('gameDataUpdate', listener)
    return (): void => { ipcRenderer.off('gameDataUpdate', listener) }
  },
  onGameTimeUpdate: (cb: (data: { time: string | null; extraTime: string | null }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { time: string | null; extraTime: string | null }): void => cb(data)
    ipcRenderer.on('gameTimeUpdate', listener)
    return (): void => { ipcRenderer.off('gameTimeUpdate', listener) }
  },
  onBet365Closed: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('bet365Closed', listener)
    return (): void => { ipcRenderer.off('bet365Closed', listener) }
  },
  onGameWindowDataUpdated: (cb: (game: unknown) => void) => {
    const listener = (_: Electron.IpcRendererEvent, game: unknown): void => cb(game)
    ipcRenderer.on('gameWindowDataUpdated', listener)
    return (): void => { ipcRenderer.off('gameWindowDataUpdated', listener) }
  },
  getBet365Games:    () => ipcRenderer.invoke('getBet365Games'),
  openBet365:        (teams?: { team1: string; team2: string }) => ipcRenderer.invoke('openBet365', teams),
  focusBet365:       () => ipcRenderer.invoke('focusBet365'),
  resizeWindow:      (w: number, h: number) => ipcRenderer.invoke('resizeWindow', w, h),
  openGameWindow:    (game: unknown) => ipcRenderer.invoke('openGameWindow', game),
  getGameWindowData: () => ipcRenderer.invoke('getGameWindowData'),
  openFeatureWindow: (featureId: string) => ipcRenderer.invoke('openFeatureWindow', featureId),
  getLiveGames:      () => ipcRenderer.invoke('getLiveGames'),
  minimizeWindow:    () => ipcRenderer.invoke('minimizeWindow'),
  showWindow:        () => ipcRenderer.invoke('showWindow'),
  showGameWindow:    () => ipcRenderer.invoke('showGameWindow'),
  showFeatureWindow: (featureId: string) => ipcRenderer.invoke('showFeatureWindow', featureId),
  onRfMatchUpdate: (cb: (state: unknown) => void) => {
    const listener = (_: Electron.IpcRendererEvent, state: unknown): void => cb(state)
    ipcRenderer.on('rfMatchUpdate', listener)
    return (): void => { ipcRenderer.off('rfMatchUpdate', listener) }
  },
  getRfGames:    () => ipcRenderer.invoke('getRfGames'),
  openRfGame:    (rfGame: unknown) => ipcRenderer.invoke('openRfGame', rfGame),
  onRfGamesUpdate: (cb: (games: unknown[]) => void) => {
    const listener = (_: Electron.IpcRendererEvent, games: unknown[]): void => cb(games)
    ipcRenderer.on('rfGamesUpdate', listener)
    return (): void => { ipcRenderer.off('rfGamesUpdate', listener) }
  },
  onRfGameNotFound: (cb: (reason: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, reason: string): void => cb(reason)
    ipcRenderer.on('rfGameNotFound', listener)
    return (): void => { ipcRenderer.off('rfGameNotFound', listener) }
  },
  onRfGameChanged: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('rfGameChanged', listener)
    return (): void => { ipcRenderer.off('rfGameChanged', listener) }
  },
  onRfExtraTime: (cb: (v: string | null) => void) => {
    const listener = (_: Electron.IpcRendererEvent, v: string | null): void => cb(v)
    ipcRenderer.on('rfExtraTime', listener)
    return (): void => { ipcRenderer.off('rfExtraTime', listener) }
  },
  onLiveGamesUpdate: (cb: (games: unknown[]) => void) => {
    const listener = (_: Electron.IpcRendererEvent, games: unknown[]): void => cb(games)
    ipcRenderer.on('liveGamesUpdate', listener)
    return (): void => { ipcRenderer.off('liveGamesUpdate', listener) }
  },
})
