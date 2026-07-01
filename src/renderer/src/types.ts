import { TerminalKind, TerminalStatus } from '../../shared/types'

export interface RuntimeTerminal {
  id: string
  workspaceId: string
  title: string
  kind: TerminalKind
  command: string
  admin: boolean
  status: TerminalStatus
}
