import React from 'react'
import { AGENT_PRESETS, AgentPreset, LayoutMode } from '../../../shared/types'
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
  onAdd: (preset: AgentPreset) => void
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onToggleAdmin: (id: string) => void
  onRename: (id: string, title: string) => void
  onSpawnError: (id: string, msg: string) => void
  onExpand: (id: string) => void
  onShowAll: () => void
}

const DOT_LABEL: Record<string, string> = {
  running: 'running',
  waiting: 'needs you',
  idle: 'idle',
  exited: 'stopped'
}

// Memoized: with App's stable callbacks and identity-preserving terminal
// updates, only the grid whose workspace actually changed re-renders.
export const TerminalGrid: React.FC<Props> = React.memo(function TerminalGrid({
  visible,
  cwd,
  layout,
  terminals,
  focusedId,
  started,
  onAdd,
  onFocus,
  onClose,
  onToggleAdmin,
  onRename,
  onSpawnError,
  onExpand,
  onShowAll
}) {
  // In "single" layout only the focused (or first) terminal shows, but every
  // tile stays mounted (hidden via CSS) so xterm scrollback survives.
  const single = layout === 'single'
  // Terminals fill the whole grid; the add tile only appears when the
  // workspace has no terminals at all (otherwise the ws-bar button is used).
  const showAddTile = terminals.length === 0
  const tileCount = terminals.length + (showAddTile ? 1 : 0)
  const style = gridStyle(layout, Math.max(1, tileCount))
  const shownId = focusedId ?? terminals[0]?.id ?? null
  // Terminals hidden behind the maximized one (single layout) — surfaced via
  // a subtle pill so the user never forgets agents are still working.
  const background = single ? terminals.filter((t) => t.id !== shownId && !t.closing) : []

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
          visible={visible}
          hidden={single && t.id !== shownId}
          started={started}
          onFocus={onFocus}
          onClose={onClose}
          onToggleAdmin={onToggleAdmin}
          onRename={onRename}
          onSpawnError={onSpawnError}
          onExpand={onExpand}
        />
      ))}
      {background.length > 0 && (
        <div className="bg-hint" title="Terminals running in the background">
          {background.map((t) => (
            <button
              key={t.id}
              className={`bg-dot ${t.status}`}
              title={`${t.title} — ${DOT_LABEL[t.status] ?? t.status} (click to view)`}
              onClick={() => onFocus(t.id)}
            />
          ))}
          <button className="bg-label" onClick={onShowAll}>
            {background.length} in background
          </button>
        </div>
      )}
      {showAddTile && (
        <div className="term add">
          <div className="plus">+</div>
          <div className="lbl">No terminals yet — start one:</div>
          <div className="add-actions">
            {AGENT_PRESETS.map((p) => (
              <button key={p.kind} onClick={() => onAdd(p)}>
                <span className="glyph" style={{ background: p.color }}>
                  {p.glyph}
                </span>
                {p.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
})
