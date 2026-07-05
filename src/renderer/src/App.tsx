import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AGENT_PRESETS,
  AgentPreset,
  DEFAULT_SETTINGS,
  LayoutMode,
  Settings,
  UpdateState,
  Workspace
} from '../../shared/types'
import { RuntimeTerminal } from './types'
import { Sidebar } from './components/Sidebar'
import { ArrangeMenu } from './components/ArrangeMenu'
import { NewTerminalMenu } from './components/NewTerminalMenu'
import { TerminalGrid } from './components/TerminalGrid'
import { SettingsModal } from './components/SettingsModal'
import { useConfirm } from './hooks/useConfirm'
import appIconUrl from './assets/app-icon.svg'

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('sidebarCollapsed') === '1'
  )
  const [toasts, setToasts] = useState<{ id: string; msg: string }[]>([])
  const [appVersion, setAppVersion] = useState('')
  const [updateState, setUpdateState] = useState<UpdateState>({ phase: 'idle' })
  const { confirm, confirmNode } = useConfirm()

  const started = useRef<Set<string>>(new Set())
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const confirmRef = useRef(confirm)
  confirmRef.current = confirm

  const pushToast = (msg: string): void => {
    const id = uuid()
    setToasts((prev) => [...prev, { id, msg }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000)
  }

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

  // Update state: initial snapshot + live stream from main.
  useEffect(() => {
    window.api.getVersion().then(setAppVersion)
    window.api.getUpdateState().then(setUpdateState)
    return window.api.onUpdateState(setUpdateState)
  }, [])

  // Someone tried to launch a second WorkSpaces — main blocked it and
  // focused this window; let the user know why the new one didn't appear.
  useEffect(() => {
    return window.api.onSecondInstance(() =>
      pushToast('WorkSpaces is already running — the second launch was blocked.')
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The main process (quit, restart-to-update, external links) asks the
  // renderer to show its custom modal instead of a native OS dialog.
  useEffect(() => {
    return window.api.onConfirmRequest((id, opts) => {
      confirmRef.current(opts).then((ok) => window.api.respondConfirm(id, ok))
    })
  }, [])

  // Status stream.
  useEffect(() => {
    return window.api.onStatus(({ id, status }) => {
      setTerminals((prev) => {
        const next: Record<string, RuntimeTerminal[]> = {}
        for (const [wsId, list] of Object.entries(prev)) {
          next[wsId] = list.map((t) =>
            t.id === id ? { ...t, status, app: status === 'exited' ? null : t.app } : t
          )
        }
        return next
      })
    })
  }, [])

  // Detected-app stream (e.g. Claude Code running inside a shell).
  useEffect(() => {
    return window.api.onApp(({ id, app }) => {
      setTerminals((prev) => {
        const next: Record<string, RuntimeTerminal[]> = {}
        for (const [wsId, list] of Object.entries(prev)) {
          next[wsId] = list.map((t) => (t.id === id ? { ...t, app } : t))
        }
        return next
      })
    })
  }, [])

  const active = workspaces.find((w) => w.id === activeId) || null
  // Per-workspace summary for the sidebar dot: "waiting" (an agent needs the
  // user) always outranks "running", since it's the more actionable state.
  const liveStatus = useMemo(() => {
    const s = new Map<string, 'running' | 'waiting'>()
    for (const [wsId, list] of Object.entries(terminals)) {
      if (list.some((t) => t.status === 'waiting')) s.set(wsId, 'waiting')
      else if (list.some((t) => t.status === 'running')) s.set(wsId, 'running')
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

  const removeWorkspace = async (id: string): Promise<void> => {
    const ws = workspaces.find((w) => w.id === id)
    if (!ws) return
    const live = terminals[id]?.length || 0
    const ok = await confirm({
      title: `Remove workspace “${ws.name}”?`,
      message:
        (live ? 'Its terminals will be stopped.\n' : '') +
        'The folder on disk is not touched.',
      confirmLabel: 'Remove',
      cancelLabel: 'Cancel',
      danger: true,
      icon: '🗑'
    })
    if (!ok) return
    for (const t of terminals[id] || []) {
      window.api.killPty(t.id)
      started.current.delete(t.id)
    }
    window.api.removeWorkspace(id)
    setTerminals((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setFocused((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setWorkspaces((prev) => prev.filter((w) => w.id !== id))
    if (activeId === id) {
      // Fall to the neighbour (previous, else next) rather than always the
      // first workspace, so removal keeps focus near where the user was.
      const idx = workspaces.findIndex((w) => w.id === id)
      const neighbour = workspaces[idx - 1] ?? workspaces[idx + 1]
      setActiveId(neighbour?.id ?? null)
    }
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

  // Two-phase close: mark the tile as closing so it can play its exit
  // animation, then actually unmount it.
  const closeTerminal = (id: string): void => {
    window.api.killPty(id)
    started.current.delete(id)
    setTerminals((prev) => {
      const next: Record<string, RuntimeTerminal[]> = {}
      for (const [wsId, list] of Object.entries(prev)) {
        next[wsId] = list.map((t) => (t.id === id ? { ...t, closing: true } : t))
      }
      return next
    })
    // Move focus off the closing tile immediately.
    setFocused((prev) => {
      const next = { ...prev }
      for (const [wsId, focusedId] of Object.entries(prev)) {
        if (focusedId === id) {
          next[wsId] =
            (terminals[wsId] || []).find((t) => t.id !== id && !t.closing)?.id ?? null
        }
      }
      return next
    })
    setTimeout(() => {
      setTerminals((prev) => {
        const next: Record<string, RuntimeTerminal[]> = {}
        for (const [wsId, list] of Object.entries(prev)) {
          next[wsId] = list.filter((t) => t.id !== id)
        }
        return next
      })
    }, 200)
  }

  // Real elevation can't be applied to a running process — the terminal is
  // restarted through the UAC broker (or back to a normal shell).
  const toggleAdmin = async (id: string): Promise<void> => {
    if (!active) return
    const t = (terminals[active.id] || []).find((x) => x.id === id)
    if (!t) return
    const ok = await confirm(
      t.admin
        ? {
            title: 'Drop administrator rights?',
            message:
              'This terminal will restart without admin rights. The current session will be replaced.',
            confirmLabel: 'Restart',
            cancelLabel: 'Cancel',
            icon: '🛡'
          }
        : {
            title: 'Run terminal as Administrator?',
            message:
              'Windows will show a UAC prompt, and the current session will be replaced.',
            confirmLabel: 'Restart as admin',
            cancelLabel: 'Cancel',
            danger: true,
            icon: '🛡'
          }
    )
    if (!ok) return
    window.api.killPty(id)
    started.current.delete(id)
    const fresh: RuntimeTerminal = { ...t, id: uuid(), admin: !t.admin, status: 'idle', app: null }
    setTerminals((prev) => ({
      ...prev,
      [active.id]: (prev[active.id] || []).map((x) => (x.id === id ? fresh : x))
    }))
    setFocused((prev) => ({ ...prev, [active.id]: fresh.id }))
  }

  const renameTerminal = (id: string, title: string): void => {
    setTerminals((prev) => {
      const next: Record<string, RuntimeTerminal[]> = {}
      for (const [wsId, list] of Object.entries(prev)) {
        next[wsId] = list.map((t) => (t.id === id ? { ...t, title } : t))
      }
      return next
    })
  }

  // A terminal whose PTY failed to start (e.g. UAC declined): mark stopped + toast.
  const onSpawnError = (id: string, msg: string): void => {
    pushToast(msg)
    setTerminals((prev) => {
      const next: Record<string, RuntimeTerminal[]> = {}
      for (const [wsId, list] of Object.entries(prev)) {
        next[wsId] = list.map((t) => (t.id === id ? { ...t, status: 'exited' } : t))
      }
      return next
    })
  }

  const setFocusedId = (id: string): void => {
    if (!active) return
    setFocused((prev) => ({ ...prev, [active.id]: id }))
  }

  const changeSettings = (partial: Partial<Settings>): void => {
    window.api.setSettings(partial).then(setSettingsState)
  }

  const toggleSidebar = (): void => {
    setSidebarCollapsed((v) => {
      localStorage.setItem('sidebarCollapsed', v ? '0' : '1')
      return !v
    })
  }

  // Keyboard shortcuts: Ctrl+Shift+T new shell, Ctrl+Shift+W close focused, Ctrl+, settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') {
        e.preventDefault()
        const shell = AGENT_PRESETS.find((p) => p.kind === 'shell')
        if (shell) addTerminal(shell)
      } else if (e.ctrlKey && e.shiftKey && e.code === 'KeyW') {
        e.preventDefault()
        if (!active) return
        const focusedTerm = focused[active.id] ?? terminals[active.id]?.[0]?.id
        if (focusedTerm) closeTerminal(focusedTerm)
      } else if (e.ctrlKey && !e.shiftKey && e.key === ',') {
        e.preventDefault()
        setShowSettings(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // Re-bind only when the state the handler reads actually changes, instead
    // of re-registering the global listener on every render.
  }, [active, focused, terminals])

  return (
    <div className="app" onClick={() => { setArrangeOpen(false); setNewMenuOpen(false) }}>
      <div className="titlebar">
        <img className="titlebar-icon" src={appIconUrl} alt="" aria-hidden="true" />
        <div className="app-name">
          Work<span>Spaces</span>
        </div>
      </div>

      <div className="layout">
        <Sidebar
          workspaces={workspaces}
          activeId={activeId}
          liveStatus={liveStatus}
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebar}
          onSelect={setActiveId}
          onAdd={addWorkspace}
          onRename={renameWorkspace}
          onRemove={removeWorkspace}
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
                    onAdd={addTerminal}
                    onFocus={setFocusedId}
                    onClose={closeTerminal}
                    onToggleAdmin={toggleAdmin}
                    onRename={renameTerminal}
                    onSpawnError={onSpawnError}
                    onExpand={(id) => {
                      setFocusedId(id)
                      setLayout(active.layout === 'single' ? 'auto' : 'single')
                    }}
                    onShowAll={() => setLayout('auto')}
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
          appVersion={appVersion}
          updateState={updateState}
          onCheckForUpdates={() => window.api.checkForUpdates()}
          onInstallUpdate={() => window.api.installUpdate()}
          onChange={changeSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {confirmNode}

      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              {t.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
