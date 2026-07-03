import { app, dialog, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours

// OTA updates via GitHub Releases (publish config in electron-builder.yml).
// Downloads in the background; installs on quit, or immediately if the user
// accepts the restart prompt. No-op in dev where there is no app-update.yml.
export function initUpdater(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => {
    console.error('[updater]', err.message)
  })

  autoUpdater.on('update-downloaded', (info) => {
    const win = getWindow()
    if (!win) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `WorkSpaces ${info.version} has been downloaded.`,
      detail: 'Restart to apply the update, or it will be installed when you quit.'
    })
    if (choice === 0) autoUpdater.quitAndInstall()
  })

  autoUpdater.checkForUpdates().catch(() => {})
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), CHECK_INTERVAL_MS)
}
