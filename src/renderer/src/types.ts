import { DetectedApp, TerminalKind, TerminalStatus } from '../../shared/types'

export interface RuntimeTerminal {
  id: string
  workspaceId: string
  title: string
  kind: TerminalKind
  command: string
  admin: boolean
  status: TerminalStatus
  /** App detected running inside the shell (overrides the displayed title). */
  app?: DetectedApp
  /** Tile is playing its exit animation and will be removed shortly. */
  closing?: boolean
}
