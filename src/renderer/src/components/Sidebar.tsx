import React, { useState } from 'react'
import { Workspace } from '../../../shared/types'
import { FolderIcon, GearIcon } from './icons'

interface Props {
  workspaces: Workspace[]
  activeId: string | null
  liveIds: Set<string>
  onSelect: (id: string) => void
  onAdd: () => void
  onRename: (id: string, name: string) => void
  onOpenSettings: () => void
}

export const Sidebar: React.FC<Props> = ({
  workspaces,
  activeId,
  liveIds,
  onSelect,
  onAdd,
  onRename,
  onOpenSettings
}) => {
  const [editingId, setEditingId] = useState<string | null>(null)

  const commitRename = (id: string, el: HTMLDivElement): void => {
    const name = el.textContent?.trim() || ''
    setEditingId(null)
    if (name) onRename(id, name)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <h2>Workspaces</h2>
        <button className="add-btn" title="Add workspace" onClick={onAdd}>
          +
        </button>
      </div>

      <div className="ws-list">
        {workspaces.length === 0 && (
          <div className="sidebar-empty">
            No workspaces yet. Click + to add a project folder.
          </div>
        )}
        {workspaces.map((ws) => (
          <div
            key={ws.id}
            className={`ws${ws.id === activeId ? ' active' : ''}`}
            onClick={() => onSelect(ws.id)}
          >
            <FolderIcon className="folder" />
            <div
              className={`name${editingId === ws.id ? ' editing' : ''}`}
              contentEditable={editingId === ws.id}
              suppressContentEditableWarning
              onBlur={(e) => editingId === ws.id && commitRename(ws.id, e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  ;(e.currentTarget as HTMLDivElement).blur()
                }
                if (e.key === 'Escape') {
                  setEditingId(null)
                  ;(e.currentTarget as HTMLDivElement).blur()
                }
              }}
            >
              {ws.name}
            </div>
            {liveIds.has(ws.id) && <div className="live" title="Agents running" />}
            <button
              className="rename"
              title="Rename"
              onClick={(e) => {
                e.stopPropagation()
                setEditingId(ws.id)
                setTimeout(() => {
                  const el = e.currentTarget.parentElement?.querySelector(
                    '.name'
                  ) as HTMLDivElement | null
                  el?.focus()
                  const range = document.createRange()
                  if (el) {
                    range.selectNodeContents(el)
                    const sel = window.getSelection()
                    sel?.removeAllRanges()
                    sel?.addRange(range)
                  }
                }, 0)
              }}
            >
              ✎
            </button>
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <button className="gear-btn" onClick={onOpenSettings}>
          <GearIcon />
          Settings
        </button>
      </div>
    </aside>
  )
}
