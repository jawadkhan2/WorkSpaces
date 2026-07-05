// Types shared between main, preload, and renderer.

export type LayoutMode = 'auto' | 'single' | 'cols' | 'rows' | 'grid'

export type TerminalKind = 'claude' | 'shell' | 'custom'

export type TerminalStatus = 'running' | 'waiting' | 'idle' | 'exited'

/** App detected running inside a shell PTY (process tree / OSC title). */
export type DetectedApp = 'claude' | null

export interface TerminalSpec {
  id: string
  workspaceId: string
  title: string
  kind: TerminalKind
  command: string // "" => default shell
  admin: boolean
}

export interface Workspace {
  id: string
  name: string
  path: string
  layout: LayoutMode
}

export interface Settings {
  autoStartShells: boolean
  confirmOnExit: boolean
}

/** OTA update lifecycle, pushed from main via `updater:state`. */
export type UpdatePhase =
  | 'idle' // packaged, no check finished yet
  | 'checking'
  | 'downloading'
  | 'downloaded' // ready — restart to apply
  | 'up-to-date'
  | 'error'
  | 'unsupported' // dev build, updater inactive

export interface UpdateState {
  phase: UpdatePhase
  version?: string
  percent?: number
  error?: string
}

/**
 * Options for the app's custom confirmation modal. Shared so the main process
 * can request the same in-app dialog the renderer uses (no native popups).
 */
export interface ConfirmOptions {
  title: string
  /** Body text; '\n' renders as separate lines. */
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Red confirm button for destructive/irreversible actions. */
  danger?: boolean
  /** Emoji glyph shown beside the title (e.g. '⚠', '🔗', '🛡'). */
  icon?: string
}

export interface AgentPreset {
  kind: TerminalKind
  title: string
  command: string
  glyph: string
  color: string
}

export const AGENT_PRESETS: AgentPreset[] = [
  { kind: 'claude', title: 'Claude Code', command: 'claude', glyph: 'C', color: '#d97757' },
  { kind: 'shell', title: 'Terminal', command: '', glyph: '$', color: '#3fb950' }
]

export const DEFAULT_SETTINGS: Settings = {
  autoStartShells: true,
  confirmOnExit: true
}
