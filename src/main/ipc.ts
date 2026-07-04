import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { basename, isAbsolute, resolve } from 'path'
import { randomUUID } from 'crypto'
import { getStore } from './store'
import { PtyManager } from './pty-manager'
import { LayoutMode, Settings, TerminalSpec, Workspace } from '../shared/types'

export function registerIpc(pty: PtyManager, getWindow: () => BrowserWindow | null): void {
  const store = getStore()

  // ---- Workspaces ----
  ipcMain.handle('workspaces:list', () => store.getWorkspaces())

  ipcMain.handle('workspaces:add', (_e, path: string): Workspace => {
    const ws: Workspace = {
      id: randomUUID(),
      name: basename(path) || path,
      path,
      layout: 'auto'
    }
    store.setWorkspaces([...store.getWorkspaces(), ws])
    return ws
  })

  ipcMain.handle('workspaces:rename', (_e, id: string, name: string) => {
    store.setWorkspaces(
      store.getWorkspaces().map((w) => (w.id === id ? { ...w, name } : w))
    )
  })

  ipcMain.handle('workspaces:remove', (_e, id: string) => {
    store.setWorkspaces(store.getWorkspaces().filter((w) => w.id !== id))
  })

  ipcMain.handle('workspaces:setLayout', (_e, id: string, layout: LayoutMode) => {
    store.setWorkspaces(
      store.getWorkspaces().map((w) => (w.id === id ? { ...w, layout } : w))
    )
  })

  // ---- Settings ----
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_e, partial: Partial<Settings>) =>
    store.setSettings(partial)
  )

  // ---- Dialog ----
  ipcMain.handle('dialog:pickFolder', async () => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win!, {
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
  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(text))

  // ---- Links (ctrl+click in terminals) ----
  ipcMain.handle('link:open', async (_e, target: string, cwd: string) => {
    if (/^https?:\/\//i.test(target)) {
      await shell.openExternal(target)
      return true
    }
    // File path, possibly suffixed with :line[:col] (greedy .+ keeps the
    // drive-letter colon in the path and peels line/col off the end).
    const m = /^(.+):(\d+)(?::(\d+))?$/.exec(target)
    const rawPath = m ? m[1] : target
    const line = m ? m[2] : null
    const col = m?.[3]
    const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)
    if (!existsSync(abs)) return false
    if (line) {
      // Jump to the line in VS Code when its CLI exists; else fall back below.
      const opened = await new Promise<boolean>((res) => {
        const p = spawn('cmd.exe', ['/c', 'code', '-g', `${abs}:${line}${col ? `:${col}` : ''}`], {
          windowsHide: true,
          stdio: 'ignore'
        })
        p.on('error', () => res(false))
        p.on('exit', (code) => res(code === 0))
      })
      if (opened) return true
    }
    const err = await shell.openPath(abs)
    return err === ''
  })

  // ---- PTY ----
  ipcMain.handle('pty:create', (_e, spec: TerminalSpec, cwd: string) =>
    pty.create(spec, cwd)
  )
  ipcMain.on('pty:input', (_e, id: string, data: string) => pty.input(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) =>
    pty.resize(id, cols, rows)
  )
  ipcMain.on('pty:kill', (_e, id: string) => pty.kill(id))
}
