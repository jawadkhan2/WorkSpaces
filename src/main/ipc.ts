import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { statSync } from 'fs'
import { basename, isAbsolute, relative, resolve } from 'path'
import { randomUUID } from 'crypto'
import { getStore } from './store'
import { PtyManager } from './pty-manager'
import { requestConfirm, externalLinkConfirm } from './confirm'
import { LayoutMode, Settings, TerminalSpec, Workspace } from '../shared/types'

const LAYOUTS = new Set<LayoutMode>(['auto', 'single', 'cols', 'rows', 'grid'])
const TERMINAL_KINDS = new Set(['claude', 'shell', 'custom'])
const MAX_CLIPBOARD_TEXT = 2 * 1024 * 1024
const MAX_COMMAND_TEXT = 512
const MAX_LINK_TEXT = 4096
const MAX_TITLE_TEXT = 120
const MAX_ID_TEXT = 128

function fail(message: string): never {
  throw new Error(message)
}

function stringValue(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') fail(`Invalid ${label}`)
  if (value.length > maxLength) fail(`${label} is too long`)
  return value
}

function trimmedString(value: unknown, label: string, maxLength: number): string {
  const text = stringValue(value, label, maxLength).trim()
  if (!text) fail(`Invalid ${label}`)
  return text
}

function idValue(value: unknown, label = 'id'): string {
  const id = trimmedString(value, label, MAX_ID_TEXT)
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) fail(`Invalid ${label}`)
  return id
}

function directoryPath(value: unknown, label: string): string {
  const path = trimmedString(value, label, 4096)
  if (!isAbsolute(path)) fail(`${label} must be an absolute path`)
  const abs = resolve(path)
  let stat
  try {
    stat = statSync(abs)
  } catch {
    fail(`${label} does not exist`)
  }
  if (!stat.isDirectory()) fail(`${label} must be a folder`)
  return abs
}

function sanitizeLayout(value: unknown): LayoutMode {
  if (typeof value !== 'string' || !LAYOUTS.has(value as LayoutMode)) {
    fail('Invalid layout')
  }
  return value as LayoutMode
}

function sanitizeSettings(value: unknown): Partial<Settings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Invalid settings')
  }
  const raw = value as Partial<Record<keyof Settings, unknown>>
  const next: Partial<Settings> = {}
  if ('autoStartShells' in raw) {
    if (typeof raw.autoStartShells !== 'boolean') fail('Invalid autoStartShells')
    next.autoStartShells = raw.autoStartShells
  }
  if ('confirmOnExit' in raw) {
    if (typeof raw.confirmOnExit !== 'boolean') fail('Invalid confirmOnExit')
    next.confirmOnExit = raw.confirmOnExit
  }
  return next
}

function sanitizeTerminalSpec(value: unknown): TerminalSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Invalid terminal spec')
  }
  const raw = value as Record<string, unknown>
  const kind = trimmedString(raw.kind, 'terminal kind', 32)
  if (!TERMINAL_KINDS.has(kind)) fail('Invalid terminal kind')
  if (typeof raw.admin !== 'boolean') fail('Invalid terminal admin flag')
  return {
    id: idValue(raw.id, 'terminal id'),
    workspaceId: idValue(raw.workspaceId, 'workspace id'),
    title: trimmedString(raw.title, 'terminal title', MAX_TITLE_TEXT),
    kind: kind as TerminalSpec['kind'],
    command: stringValue(raw.command, 'terminal command', MAX_COMMAND_TEXT),
    admin: raw.admin
  }
}

function canonicalPath(path: string): string {
  const abs = resolve(path)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function workspaceForId(workspaces: Workspace[], id: string): Workspace {
  const ws = workspaces.find((w) => w.id === id)
  if (!ws) fail('Unknown workspace')
  return ws
}

function workspaceRootForCwd(workspaces: Workspace[], cwd: unknown): string | null {
  let cwdPath: string
  try {
    cwdPath = directoryPath(cwd, 'cwd')
  } catch {
    return null
  }
  const cwdCanon = canonicalPath(cwdPath)
  const ws = workspaces.find((w) => canonicalPath(w.path) === cwdCanon)
  return ws ? resolve(ws.path) : null
}

function existingWorkspaceTarget(rawPath: string, root: string): string | null {
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath)
  if (!isWithin(root, abs)) return null
  try {
    const stat = statSync(abs)
    if (!stat.isFile() && !stat.isDirectory()) return null
    return abs
  } catch {
    return null
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function positiveInt(value: unknown, label: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    fail(`Invalid ${label}`)
  }
  return value
}

function vscodeFileUrl(path: string, line: number, col: number | null): string {
  const normalized = path.replace(/\\/g, '/')
  const encoded = normalized
    .split('/')
    .map((part, index) =>
      index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)
    )
    .join('/')
  return `vscode://file/${encoded}:${line}${col ? `:${col}` : ''}`
}

function ignoreInvalidPtyEvent(action: () => void): void {
  try {
    action()
  } catch (err) {
    console.warn('Ignored invalid PTY IPC:', err instanceof Error ? err.message : err)
  }
}

export function registerIpc(pty: PtyManager, getWindow: () => BrowserWindow | null): void {
  const store = getStore()

  // ---- Workspaces ----
  ipcMain.handle('workspaces:list', () => store.getWorkspaces())

  ipcMain.handle('workspaces:add', (_e, path: unknown): Workspace => {
    const safePath = directoryPath(path, 'workspace path')
    const ws: Workspace = {
      id: randomUUID(),
      name: basename(safePath) || safePath,
      path: safePath,
      layout: 'auto'
    }
    store.setWorkspaces([...store.getWorkspaces(), ws])
    return ws
  })

  ipcMain.handle('workspaces:rename', (_e, id: unknown, name: unknown) => {
    const wsId = idValue(id, 'workspace id')
    const safeName = trimmedString(name, 'workspace name', MAX_TITLE_TEXT)
    store.setWorkspaces(
      store.getWorkspaces().map((w) => (w.id === wsId ? { ...w, name: safeName } : w))
    )
  })

  ipcMain.handle('workspaces:remove', (_e, id: unknown) => {
    const wsId = idValue(id, 'workspace id')
    store.setWorkspaces(store.getWorkspaces().filter((w) => w.id !== wsId))
  })

  ipcMain.handle('workspaces:setLayout', (_e, id: unknown, layout: unknown) => {
    const wsId = idValue(id, 'workspace id')
    const safeLayout = sanitizeLayout(layout)
    store.setWorkspaces(
      store.getWorkspaces().map((w) => (w.id === wsId ? { ...w, layout: safeLayout } : w))
    )
  })

  // ---- Settings ----
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_e, partial: unknown) =>
    store.setSettings(sanitizeSettings(partial))
  )

  // ---- Dialog ----
  ipcMain.handle('dialog:pickFolder', async () => {
    const win = getWindow()
    const res = win
      ? await dialog.showOpenDialog(win, {
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          properties: ['openDirectory', 'createDirectory']
        })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  // ---- Clipboard ----
  // Main-process clipboard: synchronous OS calls with no focus/permission
  // gating, unlike navigator.clipboard which silently rejects when the
  // document isn't focused and lags under load (stale/dropped copies).
  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.handle('clipboard:write', (_e, text: unknown) =>
    clipboard.writeText(stringValue(text, 'clipboard text', MAX_CLIPBOARD_TEXT))
  )

  // ---- Links (left-click in terminals) ----
  ipcMain.handle('link:open', async (_e, target: unknown, cwd: unknown) => {
    const targetText = trimmedString(target, 'link target', MAX_LINK_TEXT)
    if (isHttpUrl(targetText)) {
      // Confirm through the in-app modal before opening in the OS browser.
      const ok = await requestConfirm(getWindow(), externalLinkConfirm(targetText))
      if (!ok) return false
      await shell.openExternal(targetText)
      return true
    }
    const workspaceRoot = workspaceRootForCwd(store.getWorkspaces(), cwd)
    if (!workspaceRoot) return false
    // File path, possibly suffixed with :line[:col] (greedy .+ keeps the
    // drive-letter colon in the path and peels line/col off the end).
    const m = /^(.+):(\d+)(?::(\d+))?$/.exec(targetText)
    const rawPath = m ? m[1] : targetText
    // Clamp rather than reject: an out-of-range line/col shouldn't kill the
    // whole link — open the file at the nearest valid position instead.
    const line = m ? clampInt(Number(m[2]), 1, 1_000_000) : null
    const col = m?.[3] ? clampInt(Number(m[3]), 1, 1_000_000) : null
    const abs = existingWorkspaceTarget(rawPath, workspaceRoot)
    if (!abs) return false
    if (line) {
      try {
        await shell.openExternal(vscodeFileUrl(abs, line, col))
        return true
      } catch {
        /* VS Code protocol unavailable; fall back to opening the file below. */
      }
    }
    const err = await shell.openPath(abs)
    return err === ''
  })

  // ---- PTY ----
  ipcMain.handle('pty:create', (_e, spec: unknown) => {
    const safeSpec = sanitizeTerminalSpec(spec)
    const ws = workspaceForId(store.getWorkspaces(), safeSpec.workspaceId)
    return pty.create(safeSpec, directoryPath(ws.path, 'workspace path'))
  })
  ipcMain.on('pty:input', (_e, id: unknown, data: unknown) =>
    ignoreInvalidPtyEvent(() =>
      pty.input(idValue(id, 'terminal id'), stringValue(data, 'terminal input', MAX_CLIPBOARD_TEXT))
    )
  )
  ipcMain.on('pty:resize', (_e, id: unknown, cols: unknown, rows: unknown) =>
    ignoreInvalidPtyEvent(() =>
      pty.resize(
        idValue(id, 'terminal id'),
        positiveInt(cols, 'terminal columns', 500),
        positiveInt(rows, 'terminal rows', 300)
      )
    )
  )
  ipcMain.on('pty:kill', (_e, id: unknown) =>
    ignoreInvalidPtyEvent(() => pty.kill(idValue(id, 'terminal id')))
  )
}
