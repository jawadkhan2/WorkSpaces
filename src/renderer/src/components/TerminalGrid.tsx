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
  onExpand
}) => {
  // In "single" layout only the focused (or first) terminal shows.
  const showAddTile = layout !== 'single'
  const tileCount = terminals.length + (showAddTile ? 1 : 0)
  const style = gridStyle(layout, Math.max(1, tileCount))

  const visibleTerminals =
    layout === 'single'
      ? terminals.filter((t) => t.id === (focusedId ?? terminals[0]?.id)).slice(0, 1)
      : terminals

  return (
    <div
      className="grid"
      style={{ display: visible ? 'grid' : 'none', ...style }}
    >
      {visibleTerminals.map((t) => (
        <TerminalTile
          key={t.id}
          term={t}
          cwd={cwd}
          focused={t.id === focusedId}
          started={started}
          onFocus={() => onFocus(t.id)}
          onClose={() => onClose(t.id)}
          onToggleAdmin={() => onToggleAdmin(t.id)}
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
