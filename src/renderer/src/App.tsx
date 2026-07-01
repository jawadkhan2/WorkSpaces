import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AgentPreset,
  DEFAULT_SETTINGS,
  LayoutMode,
  Settings,
  Workspace
} from '../../shared/types'
import { RuntimeTerminal } from './types'
import { Sidebar } from './components/Sidebar'
import { ArrangeMenu } from './components/ArrangeMenu'
import { NewTerminalMenu } from './components/NewTerminalMenu'
import { TerminalGrid } from './components/TerminalGrid'
import { SettingsModal } from './components/SettingsModal'

const uuid = (): string =>
  typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)

export default function App(): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS)
  const [terminals, setTerminals] = useState<Record<string, RuntimeTerminal[]>>({})
  const [focused, setFocused] = useState<Record<string, string | null>>({})
  const [showSettings, setShowSettings] = useState(false)
  const [arrangeOpen, setArrangeOpen] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)

  const started = useRef<Set<string>>(new Set())
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const seedShell = (wsId: string): RuntimeTerminal => ({
    id: uuid(),
    workspaceId: wsId,
    title: 'Terminal',
    kind: 'shell',
    command: '',
    admin: false,
    status: 'idle'
  })

  // Initial load.
  useEffect(() => {
    Promise.all([window.api.listWorkspaces(), window.api.getSettings()]).then(
      ([ws, st]) => {
        setWorkspaces(ws)
        setSettingsState(st)
        if (ws.length) setActiveId(ws[0].id)
        if (st.autoStartShells) {
          const seeded: Record<string, RuntimeTerminal[]> = {}
          for (const w of ws) seeded[w.id] = [seedShell(w.id)]
          setTerminals(seeded)
          setFocused(Object.fromEntries(ws.map((w) => [w.id, seeded[w.id][0].id])))
        }
      }
    )
  }, [])

  // Status stream.
  useEffect(() => {
    return window.api.onStatus(({ id, status }) => {
      setTerminals((prev) => {
        const next: Record<string, RuntimeTerminal[]> = {}
        for (const [wsId, list] of Object.entries(prev)) {
          next[wsId] = list.map((t) => (t.id === id ? { ...t, status } : t))
        }
        return next
      })
    })
  }, [])

  const active = workspaces.find((w) => w.id === activeId) || null
  const liveIds = useMemo(() => {
    const s = new Set<string>()
    for (const [wsId, list] of Object.entries(terminals)) {
      if (list.some((t) => t.status === 'running' || t.status === 'waiting')) s.add(wsId)
    }
    return s
  }, [terminals])

  const addWorkspace = async (): Promise<void> => {
    const path = await window.api.pickFolder()
    if (!path) return
    const ws = await window.api.addWorkspace(path)
    setWorkspaces((prev) => [...prev, ws])
    setActiveId(ws.id)
    if (settingsRef.current.autoStartShells) {
      const shell = seedShell(ws.id)
      setTerminals((prev) => ({ ...prev, [ws.id]: [shell] }))
      setFocused((prev) => ({ ...prev, [ws.id]: shell.id }))
    }
  }

  const renameWorkspace = (id: string, name: string): void => {
    window.api.renameWorkspace(id, name)
    setWorkspaces((prev) => prev.map((w) => (w.id === id ? { ...w, name } : w)))
  }

  const setLayout = (layout: LayoutMode): void => {
    if (!active) return
    window.api.setLayout(active.id, layout)
    setWorkspaces((prev) => prev.map((w) => (w.id === active.id ? { ...w, layout } : w)))
    setArrangeOpen(false)
  }

  const addTerminal = (preset: AgentPreset): void => {
    if (!active) return
    const term: RuntimeTerminal = {
      id: uuid(),
      workspaceId: active.id,
      title: preset.title,
      kind: preset.kind,
      command: preset.command,
      admin: false,
      status: 'idle'
    }
    setTerminals((prev) => ({ ...prev, [active.id]: [...(prev[active.id] || []), term] }))
    setFocused((prev) => ({ ...prev, [active.id]: term.id }))
    setNewMenuOpen(false)
  }

  const closeTerminal = (id: string): void => {
    window.api.killPty(id)
    started.current.delete(id)
    setTerminals((prev) => {
      const next: Record<string, RuntimeTerminal[]> = {}
      for (const [wsId, list] of Object.entries(prev)) {
        next[wsId] = list.filter((t) => t.id !== id)
      }
      return next
    })
  }

  const toggleAdmin = (id: string): void => {
    setTerminals((prev) => {
      const next: Record<string, RuntimeTerminal[]> = {}
      for (const [wsId, list] of Object.entries(prev)) {
        next[wsId] = list.map((t) => {
          if (t.id !== id) return t
          if (!t.admin) {
            const ok = window.confirm(
              'Run this terminal as Administrator?\nThe agent will have full access to your system.'
            )
            if (!ok) return t
          }
          return { ...t, admin: !t.admin }
        })
      }
      return next
    })
    // NOTE: true OS elevation (UAC broker) is Phase 4 — this toggles the marker only.
  }

  const setFocusedId = (id: string): void => {
    if (!active) return
    setFocused((prev) => ({ ...prev, [active.id]: id }))
  }

  const changeSettings = (partial: Partial<Settings>): void => {
    window.api.setSettings(partial).then(setSettingsState)
  }

  return (
    <div className="app" onClick={() => { setArrangeOpen(false); setNewMenuOpen(false) }}>
      <div className="titlebar">
        <div className="app-name">
          Work<span>Spaces</span>
        </div>
      </div>

      <div className="layout">
        <Sidebar
          workspaces={workspaces}
          activeId={activeId}
          liveIds={liveIds}
          onSelect={setActiveId}
          onAdd={addWorkspace}
          onRename={renameWorkspace}
          onOpenSettings={() => setShowSettings(true)}
        />

        <section className="main">
          {!active ? (
            <div className="empty-main">
              <h3>Welcome to WorkSpaces</h3>
              <p>
                Add a project folder to get started. Each workspace gives you a grid of
                terminals to run your shells and AI agents.
              </p>
              <button onClick={addWorkspace}>+ Add workspace</button>
            </div>
          ) : (
            <>
              <div className="ws-bar">
                <div>
                  <div className="title">{active.name}</div>
                  <div className="sub mono">{active.path}</div>
                </div>
                <div className="spacer" />
                <div className="pop-wrap">
                  <button
                    className="ghost"
                    onClick={(e) => {
                      e.stopPropagation()
                      setArrangeOpen((v) => !v)
                      setNewMenuOpen(false)
                    }}
                  >
                    ⊞ Arrange
                  </button>
                  {arrangeOpen && (
                    <ArrangeMenu current={active.layout} onPick={setLayout} />
                  )}
                </div>
                <div className="pop-wrap">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setNewMenuOpen((v) => !v)
                      setArrangeOpen(false)
                    }}
                  >
                    + New terminal
                  </button>
                  {newMenuOpen && <NewTerminalMenu onPick={addTerminal} />}
                </div>
              </div>

              <div className="term-area">
                {workspaces.map((ws) => (
                  <TerminalGrid
                    key={ws.id}
                    visible={ws.id === activeId}
                    cwd={ws.path}
                    layout={ws.layout}
                    terminals={terminals[ws.id] || []}
                    focusedId={focused[ws.id] ?? (terminals[ws.id]?.[0]?.id || null)}
                    started={started}
                    onAddClick={() => {
                      setNewMenuOpen(true)
                    }}
                    onFocus={setFocusedId}
                    onClose={closeTerminal}
                    onToggleAdmin={toggleAdmin}
                    onExpand={(id) => {
                      setFocusedId(id)
                      setLayout(active.layout === 'single' ? 'auto' : 'single')
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={changeSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}
