import React, { useEffect, useRef, useState } from 'react'
import { ILink, Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { AGENT_PRESETS, TerminalStatus } from '../../../shared/types'
import { RuntimeTerminal } from '../types'

interface Props {
  term: RuntimeTerminal
  cwd: string
  focused: boolean
  /** Whether the surrounding workspace grid is the visible one. */
  visible: boolean
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
  visible,
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
  const lastSize = useRef<{ cols: number; rows: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(term.title)
  const preset = AGENT_PRESETS.find((p) => p.kind === term.kind) || AGENT_PRESETS[1]

  // This tile is the one the user is actually looking at + typing into.
  const isActive = focused && visible && !hidden
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive

  // Refit and only tell the PTY about a resize when the size really changed —
  // a same-size resize makes ConPTY repaint, which flashed status to
  // "running" on every focus/workspace switch.
  const syncSize = (): void => {
    const xterm = xtermRef.current
    if (!xterm) return
    try {
      fitRef.current?.fit()
    } catch {
      return
    }
    const { cols, rows } = xterm
    if (lastSize.current?.cols === cols && lastSize.current?.rows === rows) return
    lastSize.current = { cols, rows }
    window.api.resizePty(term.id, cols, rows)
  }

  // Same as PowerShell's `clear`: wipe scrollback and put the current line at
  // the top of the screen. Local to xterm, so the shell prompt stays intact.
  const clearTerminal = (): void => {
    xtermRef.current?.clear()
    xtermRef.current?.focus()
  }

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
    // Goes through the main process, not navigator.clipboard — the async web
    // API silently rejects without document focus and lags under load, which
    // caused stale-clipboard pastes and double right-click pastes.
    const copySelection = (clearAfter: boolean): void => {
      const sel = xterm.getSelection()
      if (!sel) return
      window.api
        .clipboardWrite(sel)
        .then(() => {
          // Only drop the highlight once the copy actually landed, so a
          // failed copy never silently leaves stale clipboard content.
          if (clearAfter) xterm.clearSelection()
        })
        .catch(() => {})
    }
    let pasteSeq = 0
    let lastPasteAt = 0
    const paste = (): void => {
      // Debounce: a second trigger within the window (double contextmenu
      // event, user re-clicking while a slow read is in flight) is the same
      // gesture — swallow it instead of pasting twice.
      const now = Date.now()
      if (now - lastPasteAt < 300) return
      lastPasteAt = now
      const seq = ++pasteSeq
      window.api
        .clipboardRead()
        .then((text) => {
          // A newer paste superseded this one while the read was in flight.
          if (text && seq === pasteSeq) xterm.paste(text)
        })
        .catch(() => {})
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
        if (e.type === 'keydown') copySelection(!e.shiftKey)
        return false
      }
      // Ctrl+Shift+K clears the terminal (like PowerShell `clear`).
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyK') {
        if (e.type === 'keydown') xterm.clear()
        return false
      }
      return true
    })

    // Right-click: copy selection if any, else paste (Windows Terminal style).
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (xterm.hasSelection()) {
        copySelection(true)
      } else {
        // Focus first so the pasted input visibly lands in this terminal.
        xterm.focus()
        paste()
      }
    }
    bodyRef.current.addEventListener('contextmenu', onContextMenu)

    // Ctrl+click opens web links in the browser.
    xterm.loadAddon(
      new WebLinksAddon((event: MouseEvent, uri: string) => {
        if (event.ctrlKey) window.api.openLink(uri, cwd)
      })
    )

    // Ctrl+click opens file paths (absolute or cwd-relative, optional
    // :line[:col] suffix, e.g. src\main\index.ts:42) in the editor.
    const FILE_LINK_RE = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/])?[\w.-]+(?:[\\/][\w.-]+)+(?::\d+(?::\d+)?)?/g
    const linkProvider = xterm.registerLinkProvider({
      provideLinks(y, cb) {
        const line = xterm.buffer.active.getLine(y - 1)
        if (!line) return cb(undefined)
        const text = line.translateToString(true)
        const links: ILink[] = []
        let m: RegExpExecArray | null
        FILE_LINK_RE.lastIndex = 0
        while ((m = FILE_LINK_RE.exec(text))) {
          const target = m[0]
          // URLs belong to the web-links addon.
          if (target.includes('://')) continue
          links.push({
            range: {
              start: { x: m.index + 1, y },
              end: { x: m.index + target.length, y }
            },
            text: target,
            activate: (ev) => {
              if (ev.ctrlKey) window.api.openLink(target, cwd)
            }
          })
        }
        cb(links.length ? links : undefined)
      }
    })

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
          syncSize()
          // Seamless UX: a freshly created terminal that the user is looking
          // at should take keyboard focus (no extra click to start typing —
          // matters most when Claude Code finishes loading its input box).
          if (isActiveRef.current) xterm.focus()
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

    const ro = new ResizeObserver(() => syncSize())
    ro.observe(bodyRef.current)
    const bodyEl = bodyRef.current

    return () => {
      bodyEl.removeEventListener('contextmenu', onContextMenu)
      linkProvider.dispose()
      ro.disconnect()
      disposeData()
      disposeExit()
      xterm.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term.id])

  // Refit when this tile becomes focused/visible, and hand it keyboard focus
  // when it's the one the user is looking at (new tile, workspace switch,
  // clicking anywhere on the tile — not just inside the terminal body).
  useEffect(() => {
    const t = setTimeout(() => {
      syncSize()
      if (isActive) xtermRef.current?.focus()
    }, 30)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, term.id])

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
          className="ctl"
          title="Clear terminal (Ctrl+Shift+K)"
          onClick={(e) => {
            e.stopPropagation()
            clearTerminal()
          }}
        >
          ⌫
        </button>
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
