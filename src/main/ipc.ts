import { BrowserWindow, dialog, ipcMain } from 'electron'
import { basename } from 'path'
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
