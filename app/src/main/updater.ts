import { ipcMain, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

export function setupAutoUpdater(win: BrowserWindow): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', info => {
    win.webContents.send('update-available', { version: info.version })
  })

  autoUpdater.on('download-progress', progress => {
    win.webContents.send('update-progress', { percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', () => {
    win.webContents.send('update-ready')
  })

  autoUpdater.on('error', err => {
    console.error('[updater] erro:', err?.message ?? err)
  })

  ipcMain.handle('update:download', () => autoUpdater.downloadUpdate())
  ipcMain.handle('update:install',  () => autoUpdater.quitAndInstall())

  // Verifica 3s após o app estar pronto para não atrasar o startup
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.warn('[updater] checkForUpdates falhou:', err?.message ?? err)
    })
  }, 3000)
}
