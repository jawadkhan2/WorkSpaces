import React, { useRef, useState } from 'react'
import { Workspace } from '../../../shared/types'
import { FolderIcon, GearIcon } from './icons'

interface Props {
  workspaces: Workspace[]
  activeId: string | null
  liveStatus: Map<string, 'running' | 'waiting'>
  collapsed: boolean
  onToggleCollapse: () => void
  onSelect: (id: string) => void
  onAdd: () => void
  onRename: (id: string, name: string) => void
  onRemove: (id: string) => void
  onOpenSettings: () => void
}

export const Sidebar: React.FC<Props> = ({
  workspaces,
  activeId,
  liveStatus,
  collapsed,
  onToggleCollapse,
  onSelect,
  onAdd,
  onRename,
  onRemove,
  onOpenSettings
}) => {
  const [editingId, setEditingId] = useState<string | null>(null)
  const cancelRename = useRef(false)

  const commitRename = (id: string, el: HTMLDivElement): void => {
    if (cancelRename.current) {
      cancelRename.current = false
      setEditingId(null)
      return
    }
    const name = el.textContent?.trim() || ''
    setEditingId(null)
    if (name) onRename(id, name)
  }

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-head">
        {!collapsed && <h2>Workspaces</h2>}
        {!collapsed && (
          <button className="add-btn" title="Add workspace" onClick={onAdd}>
            +
          </button>
        )}
        <button
          className="add-btn collapse-btn"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggleCollapse}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      {collapsed && (
        <div className="sidebar-rail-add">
          <button className="add-btn" title="Add workspace" onClick={onAdd}>
            +
          </button>
        </div>
      )}

      <div className="ws-list">
        {workspaces.length === 0 && !collapsed && (
          <div className="sidebar-empty">
            No workspaces yet. Click + to add a project folder.
          </div>
        )}
        {workspaces.map((ws) => {
          const status = liveStatus.get(ws.id)
          const liveTitle = status === 'waiting' ? 'Waiting for you' : 'Agents running'
          return (
          <div
            key={ws.id}
            className={`ws${ws.id === activeId ? ' active' : ''}`}
            title={collapsed ? ws.name : undefined}
            onClick={() => onSelect(ws.id)}
          >
            <FolderIcon className="folder" />
            {collapsed ? (
              status && (
                <div
                  className={`live rail-live${status === 'waiting' ? ' waiting' : ''}`}
                  title={liveTitle}
                />
              )
            ) : (
              <>
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
                      cancelRename.current = true
                      e.currentTarget.textContent = ws.name
                      ;(e.currentTarget as HTMLDivElement).blur()
                    }
                  }}
                >
                  {ws.name}
                </div>
                {status && (
                  <div className={`live${status === 'waiting' ? ' waiting' : ''}`} title={liveTitle} />
                )}
                <button
                  className="rename"
                  title="Rename"
                  onClick={(e) => {
                    e.stopPropagation()
                    cancelRename.current = false
                    setEditingId(ws.id)
                    // Capture now — e.currentTarget is nulled once the handler
                    // returns, so reading it inside the timeout throws and the
                    // name field never gets focus/selection.
                    const parent = e.currentTarget.parentElement
                    setTimeout(() => {
                      const el = parent?.querySelector('.name') as HTMLDivElement | null
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
                <button
                  className="rename remove"
                  title="Remove workspace"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove(ws.id)
                  }}
                >
                  ✕
                </button>
              </>
            )}
          </div>
          )
        })}
      </div>

      <div className="sidebar-foot">
        <button
          className="gear-btn"
          title={collapsed ? 'Settings' : undefined}
          onClick={onOpenSettings}
        >
          <GearIcon />
          {!collapsed && 'Settings'}
        </button>
      </div>
    </aside>
  )
}
