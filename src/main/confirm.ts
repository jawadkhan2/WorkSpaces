import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { ConfirmOptions } from '../shared/types'

// Bridges main-process confirmations to the renderer's custom modal so the app
// never shows a native OS dialog. Main sends `confirm:request` with an id + the
// modal options; the renderer replies once with `confirm:respond` id + choice.

const pending = new Map<string, (ok: boolean) => void>()

// Guards against a wedged renderer (crashed after the request, never replies)
// leaking a resolver forever and, for the quit flow, trapping the user.
const RESPONSE_TIMEOUT_MS = 60_000

let initialized = false

export function initConfirmBridge(): void {
  if (initialized) return
  initialized = true
  ipcMain.on('confirm:respond', (_e, id: unknown, ok: unknown) => {
    if (typeof id !== 'string') return
    const resolve = pending.get(id)
    if (!resolve) return
    pending.delete(id)
    resolve(ok === true)
  })
}

/**
 * Show the in-app confirmation modal and resolve to the user's choice.
 * Resolves `false` if there is no live window or the renderer never answers.
 */
export function requestConfirm(
  win: BrowserWindow | null,
  opts: ConfirmOptions
): Promise<boolean> {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    return Promise.resolve(false)
  }
  const id = randomUUID()
  return new Promise<boolean>((resolve) => {
    const settle = (ok: boolean): void => {
      if (!pending.delete(id)) return
      clearTimeout(timer)
      win.webContents.off('destroyed', onGone)
      resolve(ok)
    }
    const onGone = (): void => settle(false)
    const timer = setTimeout(() => settle(false), RESPONSE_TIMEOUT_MS)

    pending.set(id, settle)
    win.webContents.once('destroyed', onGone)
    win.webContents.send('confirm:request', id, opts)
  })
}

/** Consistent copy for "open this external link?" confirmations. */
export function externalLinkConfirm(url: string): ConfirmOptions {
  return {
    title: 'Open external link?',
    message: `This will open in your browser:\n${url}`,
    confirmLabel: 'Open link',
    cancelLabel: 'Cancel',
    icon: '🔗'
  }
}
