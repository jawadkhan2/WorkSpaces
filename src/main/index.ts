import { app, shell, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { getStore } from './store'
import { PtyManager } from './pty-manager'
import { registerIpc } from './ipc'

let mainWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let isQuitting = false

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Exit-confirmation flow (§7 of PLAN.md).
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    const { confirmOnExit } = getStore().getSettings()
    const hasLive = ptyManager?.hasAny()
    if (!confirmOnExit || !hasLive) {
      isQuitting = true
      ptyManager?.killAll()
      return
    }
    e.preventDefault()
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Quit WorkSpaces?',
      message: 'Quit WorkSpaces?',
      detail: 'All running terminals and agents will be stopped.'
    })
    if (choice === 0) {
      isQuitting = true
      ptyManager?.killAll()
      mainWindow?.close()
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ptyManager = new PtyManager(() => mainWindow)
  registerIpc(ptyManager, () => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
  ptyManager?.killAll()
})

app.on('window-all-closed', () => {
  ptyManager?.killAll()
  if (process.platform !== 'darwin') app.quit()
})
