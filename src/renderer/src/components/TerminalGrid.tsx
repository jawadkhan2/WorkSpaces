import React from 'react'
import { LayoutMode } from '../../../shared/types'
import { RuntimeTerminal } from '../types'
import { gridStyle } from '../lib/layout'
import { TerminalTile } from './TerminalTile'

interface Props {
  visible: boolean
  cwd: string
  layout: LayoutMode
  terminals: RuntimeTerminal[]
  focusedId: string | null
  started: React.MutableRefObject<Set<string>>
  onAddClick: () => void
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onToggleAdmin: (id: string) => void
  onRename: (id: string, title: string) => void
  onSpawnError: (id: string, msg: string) => void
  onExpand: (id: string) => void
}

export const TerminalGrid: React.FC<Props> = ({
  visible,
  cwd,
  layout,
  terminals,
  focusedId,
  started,
  onAddClick,
  onFocus,
  onClose,
  onToggleAdmin,
  onRename,
  onSpawnError,
  onExpand
}) => {
  // In "single" layout only the focused (or first) terminal shows, but every
  // tile stays mounted (hidden via CSS) so xterm scrollback survives.
  const single = layout === 'single'
  const showAddTile = !single
  const tileCount = terminals.length + (showAddTile ? 1 : 0)
  const style = gridStyle(layout, Math.max(1, tileCount))
  const shownId = focusedId ?? terminals[0]?.id ?? null

  return (
    <div
      className="grid"
      style={{ display: visible ? 'grid' : 'none', ...style }}
    >
      {terminals.map((t) => (
        <TerminalTile
          key={t.id}
          term={t}
          cwd={cwd}
          focused={t.id === focusedId}
          hidden={single && t.id !== shownId}
          started={started}
          onFocus={() => onFocus(t.id)}
          onClose={() => onClose(t.id)}
          onToggleAdmin={() => onToggleAdmin(t.id)}
          onRename={(title) => onRename(t.id, title)}
          onSpawnError={(msg) => onSpawnError(t.id, msg)}
          onExpand={() => onExpand(t.id)}
        />
      ))}
      {showAddTile && (
        <div className="term add" onClick={onAddClick}>
          <div className="plus">+</div>
          <div className="lbl">New terminal</div>
        </div>
      )}
    </div>
  )
}
