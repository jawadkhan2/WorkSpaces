import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { AGENT_PRESETS, TerminalStatus } from '../../../shared/types'
import { RuntimeTerminal } from '../types'

interface Props {
  term: RuntimeTerminal
  cwd: string
  focused: boolean
  hidden?: boolean
  started: React.MutableRefObject<Set<string>>
  onFocus: () => void
  onClose: () => void
  onToggleAdmin: () => void
  onRename: (title: string) => void
  onSpawnError: (msg: string) => void
  onExpand: () => void
}

const STATUS_LABEL: Record<TerminalStatus, string> = {
  running: 'running',
  waiting: 'needs you',
  idle: 'idle',
  exited: 'stopped'
}

const XTERM_THEME = {
  background: '#0a0e14',
  foreground: '#c9d1d9',
  cursor: '#e6edf3',
  selectionBackground: '#264f78',
  black: '#0a0e14',
  brightBlack: '#8b949e'
}

export const TerminalTile: React.FC<Props> = ({
  term,
  cwd,
  focused,
  hidden,
  started,
  onFocus,
  onClose,
  onToggleAdmin,
  onRename,
  onSpawnError,
  onExpand
}) => {
  const bodyRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(term.title)
  const preset = AGENT_PRESETS.find((p) => p.kind === term.kind) || AGENT_PRESETS[1]

  // A shell running Claude Code temporarily presents as Claude Code; the
  // tile reverts to its own title/glyph the moment the process exits.
  const claudeLive = term.app === 'claude' && term.kind !== 'claude'
  const claudePreset = AGENT_PRESETS.find((p) => p.kind === 'claude') || preset
  const displayPreset = claudeLive ? claudePreset : preset
  const displayTitle = claudeLive ? 'Claude Code' : term.title

  const commitTitle = (): void => {
    setEditing(false)
    const title = draftTitle.trim()
    if (title && title !== term.title) onRename(title)
    else setDraftTitle(term.title)
  }

  // Mount xterm + spawn PTY once per terminal id.
  useEffect(() => {
    if (!bodyRef.current) return
    const xterm = new Terminal({
      fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: XTERM_THEME,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.open(bodyRef.current)
    try {
      xterm.loadAddon(new WebglAddon())
    } catch {
      /* WebGL unavailable — fall back to DOM renderer */
    }
    fit.fit()
    xtermRef.current = xterm
    fitRef.current = fit

    // Clipboard: Ctrl+C copies when text is selected (otherwise stays SIGINT),
    // Ctrl+V / Ctrl+Shift+V paste, Ctrl+Shift+C always copies.
    const copySelection = (): void => {
      const sel = xterm.getSelection()
      if (sel) navigator.clipboard.writeText(sel)
    }
    const paste = (): void => {
      navigator.clipboard.readText().then((text) => {
        if (text) xterm.paste(text)
      })
    }
    // Match on e.key as well as e.code: synthetic input (e.g. VoicePill via
    // SendInput/VK_PACKET) arrives with an empty e.code, and its keypress leg
    // carries the raw control char — both must be swallowed or the PTY gets ^V.
    xterm.attachCustomKeyEventHandler((e) => {
      const k = e.key === '\u0016' ? 'v' : e.key === '\u0003' ? 'c' : e.key.toLowerCase()
      const ctrl = e.ctrlKey || e.key === '\u0016' || e.key === '\u0003'
      if (ctrl && (k === 'v' || e.code === 'KeyV')) {
        // Swallow so xterm doesn't write \x16 to the PTY, but don't paste
        // manually: skipping xterm's preventDefault lets the browser's native
        // paste event fire, which xterm's own onPaste handler already handles.
        return false
      }
      if (ctrl && (k === 'c' || e.code === 'KeyC') && (e.shiftKey || xterm.hasSelection())) {
        if (e.type === 'keydown') {
          copySelection()
          if (!e.shiftKey) xterm.clearSelection()
        }
        return false
      }
      return true
    })

    // Right-click: copy selection if any, else paste (Windows Terminal style).
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      if (xterm.hasSelection()) {
        copySelection()
        xterm.clearSelection()
      } else {
        paste()
      }
    }
    bodyRef.current.addEventListener('contextmenu', onContextMenu)

    const disposeData = window.api.onPtyData(term.id, (data) => xterm.write(data))
    const disposeExit = window.api.onPtyExit(term.id, () => {
      xterm.writeln('\r\n\x1b[90m[process exited]\x1b[0m')
    })
    xterm.onData((data) => window.api.writePty(term.id, data))

    // Spawn the backing PTY exactly once (survives workspace switches).
    if (!started.current.has(term.id)) {
      started.current.add(term.id)
      window.api
        .createPty(
          {
            id: term.id,
            workspaceId: term.workspaceId,
            title: term.title,
            kind: term.kind,
            command: term.command,
            admin: term.admin
          },
          cwd
        )
        .then(() => {
          fit.fit()
          window.api.resizePty(term.id, xterm.cols, xterm.rows)
        })
        .catch((err: Error) => {
          // e.g. UAC declined, broker timeout, bad shell.
          const msg = String(err.message || err).replace(
            /^Error invoking remote method 'pty:create': (Error: )?/,
            ''
          )
          xterm.writeln(`\x1b[31m[terminal failed to start: ${msg}]\x1b[0m`)
          onSpawnError(msg)
        })
    }

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        window.api.resizePty(term.id, xterm.cols, xterm.rows)
      } catch {
        /* ignore */
      }
    })
    ro.observe(bodyRef.current)
    const bodyEl = bodyRef.current

    return () => {
      bodyEl.removeEventListener('contextmenu', onContextMenu)
      ro.disconnect()
      disposeData()
      disposeExit()
      xterm.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term.id])

  // Refit when this tile becomes focused/visible.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit()
        if (xtermRef.current) {
          window.api.resizePty(term.id, xtermRef.current.cols, xtermRef.current.rows)
        }
      } catch {
        /* ignore */
      }
    }, 30)
    return () => clearTimeout(t)
  }, [focused, term.id])

  return (
    <div
      className={`term${focused ? ' focused' : ''}${term.admin ? ' admin' : ''}${
        claudeLive ? ' claude-live' : ''
      }${term.closing ? ' closing' : ''}`}
      style={hidden ? { display: 'none' } : undefined}
      onMouseDown={onFocus}
    >
      <div className="term-head">
        <span className="agent">
          <span
            key={displayPreset.kind}
            className="glyph"
            style={{ background: displayPreset.color }}
          >
            {displayPreset.glyph}
          </span>
          {editing ? (
            <input
              className="title-edit"
              value={draftTitle}
              autoFocus
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle()
                if (e.key === 'Escape') {
                  setDraftTitle(term.title)
                  setEditing(false)
                }
              }}
              onMouseDown={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className="title"
              title="Double-click to rename"
              onDoubleClick={() => {
                setDraftTitle(term.title)
                setEditing(true)
              }}
            >
              {displayTitle}
            </span>
          )}
        </span>
        {term.admin ? (
          <span className="admin-badge">🛡 Admin</span>
        ) : (
          <span className={`status ${term.status}`}>{STATUS_LABEL[term.status]}</span>
        )}
        <span className="spacer" />
        <button
          className={`ctl shield${term.admin ? ' on' : ''}`}
          title={term.admin ? 'Running as admin' : 'Run as admin'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleAdmin()
          }}
        >
          🛡
        </button>
        <button className="ctl" title="Expand" onClick={(e) => { e.stopPropagation(); onExpand() }}>
          ⤢
        </button>
        <button className="ctl" title="Close" onClick={(e) => { e.stopPropagation(); onClose() }}>
          ✕
        </button>
      </div>
      <div className="term-body" ref={bodyRef} />
    </div>
  )
}
