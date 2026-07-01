import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { AGENT_PRESETS, TerminalStatus } from '../../../shared/types'
import { RuntimeTerminal } from '../types'

interface Props {
  term: RuntimeTerminal
  cwd: string
  focused: boolean
  started: React.MutableRefObject<Set<string>>
  onFocus: () => void
  onClose: () => void
  onToggleAdmin: () => void
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
  started,
  onFocus,
  onClose,
  onToggleAdmin,
  onExpand
}) => {
  const bodyRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const preset = AGENT_PRESETS.find((p) => p.kind === term.kind) || AGENT_PRESETS[1]

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

    return () => {
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
      className={`term${focused ? ' focused' : ''}${term.admin ? ' admin' : ''}`}
      onMouseDown={onFocus}
    >
      <div className="term-head">
        <span className="agent">
          <span className="glyph" style={{ background: preset.color }}>
            {preset.glyph}
          </span>
          {term.title}
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
