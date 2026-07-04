import { app, shell, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { getStore } from './store'
import { PtyManager } from './pty-manager'
import { registerIpc } from './ipc'
import { runBroker } from './broker'
import { initUpdater } from './updater'

// Elevated PTY broker mode (PLAN.md §6): a second, UAC-elevated instance of
// this app launched with --pty-broker. It hosts one terminal's node-pty and
// bridges it over a named pipe — no window, no IPC, no store.
const IS_BROKER = process.argv.includes('--pty-broker')

let mainWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let isQuitting = false

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function openExternalHttp(value: string): void {
  if (!isHttpUrl(value)) return
  shell.openExternal(value).catch(() => {})
}

function stopPtysForRendererRestart(): void {
  if (!isQuitting) ptyManager?.killAll()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform !== 'darwin' && {
      titleBarOverlay: { color: '#010409', symbolColor: '#8b949e', height: 36 }
    }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    openExternalHttp(details.url)
    return { action: 'deny' }
  })

  // If the renderer reloads, crashes, or navigates away, the React-held
  // terminal model is gone. Stop live PTYs instead of leaving hidden agents
  // running behind a fresh UI.
  mainWindow.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) stopPtysForRendererRestart()
  })
  mainWindow.webContents.on('render-process-gone', () => stopPtysForRendererRestart())
  mainWindow.webContents.once('did-finish-load', () => {
    const appUrl = mainWindow?.webContents.getURL()
    mainWindow?.webContents.on('will-navigate', (event, url) => {
      if (url === appUrl) return
      event.preventDefault()
      openExternalHttp(url)
    })
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

if (IS_BROKER) {
  app.disableHardwareAcceleration()
  runBroker()
} else if (!app.requestSingleInstanceLock()) {
  // Another WorkSpaces window is already open — tell the user and bail.
  // (Broker instances above never take the lock, so elevation still works.)
  dialog.showErrorBox(
    'WorkSpaces is already running',
    'Another instance of WorkSpaces is already open — switching to it.\n\nOnly one instance can run at a time.'
  )
  app.quit()
} else {
  // A second launch attempt lands here in the surviving instance: surface the
  // existing window and let the renderer show a notice.
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('app:second-instance')
  })

  app.whenReady().then(() => {
    ptyManager = new PtyManager(() => mainWindow)
    registerIpc(ptyManager, () => mainWindow)
    createWindow()
    initUpdater(() => mainWindow, {
      hasLiveTerminals: () => ptyManager?.hasAny() ?? false,
      prepareQuit: () => {
        isQuitting = true
        ptyManager?.killAll()
      }
    })

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
}
