import { app, shell, BrowserWindow, screen } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { getStore } from './store'
import { PtyManager } from './pty-manager'
import { registerIpc } from './ipc'
import { runBroker } from './broker'
import { initUpdater } from './updater'
import { initConfirmBridge, requestConfirm, externalLinkConfirm } from './confirm'

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

// Confirm through the in-app modal before handing an external link to the OS
// browser — never open silently, never use a native dialog.
function openExternalHttp(value: string): void {
  if (!isHttpUrl(value)) return
  requestConfirm(mainWindow, externalLinkConfirm(value)).then((ok) => {
    if (ok) shell.openExternal(value).catch(() => {})
  })
}

function stopPtysForRendererRestart(): void {
  if (!isQuitting) ptyManager?.killAll()
}

function getAppIconPath(): string | undefined {
  const candidates = [
    join(process.resourcesPath, 'icon.ico'),
    join(__dirname, '../../build/icon.ico'),
    join(process.cwd(), 'build/icon.ico')
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

// Native caption-button overlay (Windows/Linux). Height must match the CSS
// .titlebar height in styles.css.
const TITLE_BAR_OVERLAY = { color: '#010409', symbolColor: '#8b949e', height: 36 }

function createWindow(): void {
  const icon = getAppIconPath()

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    ...(icon ? { icon } : {}),
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform !== 'darwin' && { titleBarOverlay: TITLE_BAR_OVERLAY }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Moving the window between monitors with different DPI scaling (2K <-> 4K)
  // re-lays the native caption buttons at the new scale factor, but the overlay
  // geometry set at creation goes stale — the titlebar's bottom edge gets
  // clipped under the button strip. Re-apply the overlay whenever the effective
  // scale factor changes to force Chromium to recompute it.
  if (process.platform !== 'darwin') {
    let lastScale = screen.getDisplayMatching(mainWindow.getBounds()).scaleFactor
    const refitOverlay = (): void => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const scale = screen.getDisplayMatching(mainWindow.getBounds()).scaleFactor
      if (scale === lastScale) return
      lastScale = scale
      mainWindow.setTitleBarOverlay(TITLE_BAR_OVERLAY)
    }
    // 'moved' catches monitor hops; 'display-metrics-changed' catches a live
    // DPI/resolution change on the display the window already sits on.
    mainWindow.on('moved', refitOverlay)
    const onMetrics = (): void => refitOverlay()
    screen.on('display-metrics-changed', onMetrics)
    mainWindow.on('closed', () => screen.removeListener('display-metrics-changed', onMetrics))
  }

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
    requestConfirm(mainWindow, {
      title: 'Quit WorkSpaces?',
      message: 'All running terminals and agents will be stopped.',
      confirmLabel: 'Quit',
      cancelLabel: 'Cancel',
      danger: true,
      icon: '⚠'
    }).then((ok) => {
      if (!ok) return
      isQuitting = true
      ptyManager?.killAll()
      mainWindow?.close()
    })
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
  // Another WorkSpaces window is already open — bail silently. This second
  // process has no window to host our custom modal, and using a native dialog
  // is exactly what we avoid; the surviving instance surfaces itself and shows
  // an in-app toast via the 'second-instance' handler below.
  // (Broker instances above never take the lock, so elevation still works.)
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
    initConfirmBridge()
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
