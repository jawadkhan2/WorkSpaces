import { app, ipcMain, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { UpdateState } from '../shared/types'
import { requestConfirm } from './confirm'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours

interface UpdaterHooks {
  /** True when any PTY (terminal/agent) is still alive. */
  hasLiveTerminals: () => boolean
  /** Marks the app as quitting and kills all PTYs, so quitAndInstall doesn't re-trigger the exit-confirmation dialog. */
  prepareQuit: () => void
}

// OTA updates via GitHub Releases (publish config in electron-builder.yml).
// Downloads in the background and installs on quit; the renderer drives the
// UI (settings section + titlebar pill) through updater:* IPC. In dev there
// is no app-update.yml, so the state is pinned to 'unsupported'.
export function initUpdater(getWindow: () => BrowserWindow | null, hooks: UpdaterHooks): void {
  let state: UpdateState = { phase: app.isPackaged ? 'idle' : 'unsupported' }

  const setState = (next: UpdateState): void => {
    state = next
    getWindow()?.webContents.send('updater:state', state)
  }

  ipcMain.handle('updater:getState', () => state)
  ipcMain.handle('app:getVersion', () => app.getVersion())

  ipcMain.handle('updater:check', () => {
    if (!app.isPackaged) return
    autoUpdater.checkForUpdates().catch(() => {})
  })

  ipcMain.handle('updater:install', async () => {
    if (state.phase !== 'downloaded') return
    // Restarting to update tears down every terminal — if any are still
    // alive, make that explicit instead of silently killing agent sessions.
    if (hooks.hasLiveTerminals()) {
      const ok = await requestConfirm(getWindow(), {
        title: 'Restart to update?',
        message:
          'Restarting to apply the update will stop all running terminals and agents. Update now?',
        confirmLabel: 'Restart & update',
        cancelLabel: 'Not now',
        danger: true,
        icon: '⚠'
      })
      if (!ok) return
    }
    hooks.prepareQuit()
    autoUpdater.quitAndInstall()
  })

  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => setState({ phase: 'checking' }))
  autoUpdater.on('update-not-available', () => setState({ phase: 'up-to-date' }))
  autoUpdater.on('update-available', (info) =>
    setState({ phase: 'downloading', version: info.version, percent: 0 })
  )
  autoUpdater.on('download-progress', (p) =>
    setState({ phase: 'downloading', version: state.version, percent: p.percent })
  )
  autoUpdater.on('update-downloaded', (info) =>
    setState({ phase: 'downloaded', version: info.version })
  )
  autoUpdater.on('error', (err) => {
    console.error('[updater]', err.message)
    setState({ phase: 'error', error: err.message })
  })

  autoUpdater.checkForUpdates().catch(() => {})
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), CHECK_INTERVAL_MS)
}
