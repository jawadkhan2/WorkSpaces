import { contextBridge, ipcRenderer } from 'electron'
import {
  ConfirmOptions,
  DetectedApp,
  LayoutMode,
  Settings,
  TerminalSpec,
  TerminalStatus,
  UpdateState,
  Workspace
} from '../shared/types'

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

  // Clipboard (main-process — reliable regardless of window focus)
  clipboardRead: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),

  // Left-click links: web URLs or file paths (resolved against cwd)
  openLink: (target: string, cwd: string): Promise<boolean> =>
    ipcRenderer.invoke('link:open', target, cwd),

  // Updates
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke('updater:getState'),
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('updater:check'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('updater:install'),
  onUpdateState: (cb: (state: UpdateState) => void): (() => void) => {
    const listener = (_e: unknown, state: UpdateState): void => cb(state)
    ipcRenderer.on('updater:state', listener)
    return () => ipcRenderer.removeListener('updater:state', listener)
  },

  // Custom confirmation modal requested by the main process (quit, restart to
  // update, external links). The renderer shows its in-app dialog and replies
  // with the user's choice — no native OS dialogs.
  onConfirmRequest: (
    cb: (id: string, opts: ConfirmOptions) => void
  ): (() => void) => {
    const listener = (_e: unknown, id: string, opts: ConfirmOptions): void => cb(id, opts)
    ipcRenderer.on('confirm:request', listener)
    return () => ipcRenderer.removeListener('confirm:request', listener)
  },
  respondConfirm: (id: string, ok: boolean): void =>
    ipcRenderer.send('confirm:respond', id, ok),

  // Fired in the surviving instance when a second app launch was blocked.
  onSecondInstance: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('app:second-instance', listener)
    return () => ipcRenderer.removeListener('app:second-instance', listener)
  },

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
  },
  onApp: (cb: (p: { id: string; app: DetectedApp }) => void): (() => void) => {
    const listener = (_e: unknown, p: { id: string; app: DetectedApp }): void => cb(p)
    ipcRenderer.on('pty:app', listener)
    return () => ipcRenderer.removeListener('pty:app', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
