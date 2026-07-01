import { contextBridge, ipcRenderer } from 'electron'
import { LayoutMode, Settings, TerminalSpec, TerminalStatus, Workspace } from '../shared/types'

const api = {
  // Workspaces
  listWorkspaces: (): Promise<Workspace[]> => ipcRenderer.invoke('workspaces:list'),
  addWorkspace: (path: string): Promise<Workspace> =>
    ipcRenderer.invoke('workspaces:add', path),
  renameWorkspace: (id: string, name: string): Promise<void> =>
    ipcRenderer.invoke('workspaces:rename', id, name),
  removeWorkspace: (id: string): Promise<void> =>
    ipcRenderer.invoke('workspaces:remove', id),
  setLayout: (id: string, layout: LayoutMode): Promise<void> =>
    ipcRenderer.invoke('workspaces:setLayout', id, layout),

  // Settings
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (partial: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', partial),

  // Dialog
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),

  // PTY
  createPty: (spec: TerminalSpec, cwd: string): Promise<{ id: string; pid: number }> =>
    ipcRenderer.invoke('pty:create', spec, cwd),
  writePty: (id: string, data: string): void => ipcRenderer.send('pty:input', id, data),
  resizePty: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('pty:resize', id, cols, rows),
  killPty: (id: string): void => ipcRenderer.send('pty:kill', id),

  onPtyData: (id: string, cb: (data: string) => void): (() => void) => {
    const ch = `pty:data:${id}`
    const listener = (_e: unknown, data: string): void => cb(data)
    ipcRenderer.on(ch, listener)
    return () => ipcRenderer.removeListener(ch, listener)
  },
  onPtyExit: (id: string, cb: () => void): (() => void) => {
    const ch = `pty:exit:${id}`
    const listener = (): void => cb()
    ipcRenderer.on(ch, listener)
    return () => ipcRenderer.removeListener(ch, listener)
  },
  onStatus: (cb: (p: { id: string; status: TerminalStatus }) => void): (() => void) => {
    const listener = (_e: unknown, p: { id: string; status: TerminalStatus }): void => cb(p)
    ipcRenderer.on('pty:status', listener)
    return () => ipcRenderer.removeListener('pty:status', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
