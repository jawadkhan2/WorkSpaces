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
  // Id-based and stable (useCallback in App), so this tile can be memoized —
  // otherwise every status flip anywhere re-renders every tile.
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onToggleAdmin: (id: string) => void
  onRename: (id: string, title: string) => void
  onSpawnError: (id: string, msg: string) => void
  onExpand: (id: string) => void
}

const STATUS_LABEL: Record<TerminalStatus, string> = {
  running: 'running',
  waiting: 'waiting for input',
  idle: 'idle',
  exited: 'stopped'
}

// Mirrors MAX_CLIPBOARD_TEXT in src/main/ipc.ts — clipboard writes larger
// than this are rejected by the IPC handler, so don't send them.
const MAX_CLIPBOARD_TEXT = 2 * 1024 * 1024

const XTERM_THEME = {
  background: '#0a0e14',
  foreground: '#c9d1d9',
  cursor: '#e6edf3',
  selectionBackground: '#264f78',
  black: '#0a0e14',
  brightBlack: '#8b949e'
}

export const TerminalTile: React.FC<Props> = React.memo(function TerminalTile({
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
}) {
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
    if (title && title !== term.title) onRename(term.id, title)
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
      if (!sel || sel.length > MAX_CLIPBOARD_TEXT) return
      window.api
        .clipboardWrite(sel)
        .then(() => {
          // Only drop the highlight once the copy actually landed, so a
          // failed copy never silently leaves stale clipboard content.
          if (clearAfter) xterm.clearSelection()
        })
        .catch(() => {})
    }

    // OSC 52: honor the terminal app's clipboard *writes* (copy) — this is the
    // only path by which a selection made inside a mouse-tracking app reaches
    // the OS clipboard. Reads/queries (`c;?`) are deliberately ignored so the
    // PTY can never exfiltrate the user's clipboard back to itself.
    const oscHandler = xterm.parser.registerOscHandler(52, (payload) => {
      const b64 = payload.slice(payload.indexOf(';') + 1)
      if (!b64 || b64 === '?') return true
      // Base64 inflates ~4/3, so anything longer than MAX*1.4 can't fit the
      // clipboard cap — skip before paying for a multi-MB atob on the UI
      // thread.
      if (b64.length > MAX_CLIPBOARD_TEXT * 1.4) return true
      let text: string
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        text = new TextDecoder().decode(bytes)
      } catch {
        return true
      }
      if (text.length <= MAX_CLIPBOARD_TEXT) window.api.clipboardWrite(text).catch(() => {})
      return true
    })

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

    // Right-click: copy selection if any, else paste (Windows Terminal style) —
    // our own main-process clipboardRead + bracketed xterm.paste, which is
    // instant. A mouse-tracking app (Claude Code, vim) would otherwise receive
    // the right-button press/release as a mouse report and run its own — slow,
    // and on Windows unreliable — clipboard paste, competing with ours (double
    // paste). Swallow the right button in the capture phase so xterm never
    // forwards it to the app, then always do our fast paste below.
    const swallowRightButton = (e: MouseEvent): void => {
      if (e.button !== 2) return
      // Keep the tile's focus tracking working (the outer div's mousedown, our
      // stopped propagation would skip) and stop xterm from shipping the click
      // to the PTY as a mouse report.
      onFocus(term.id)
      e.stopImmediatePropagation()
    }
    bodyRef.current.addEventListener('mousedown', swallowRightButton, true)
    bodyRef.current.addEventListener('mouseup', swallowRightButton, true)

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

    // Left-click opens web links in the browser.
    xterm.loadAddon(
      new WebLinksAddon((_event: MouseEvent, uri: string) => {
        window.api.openLink(uri, cwd)
      })
    )

    // Left-click opens file paths (absolute or cwd-relative, optional
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
          // URLs belong to the web-links addon. The match is only the domain
          // tail (`example.com/path`), so the `://` sits just before it — check
          // the preceding text, not the match, or we'd hijack every URL.
          if (target.includes('://') || text.slice(0, m.index).endsWith('://')) continue
          // The regex matches any `word/word`, which snags prose like
          // "America/Chicago" or "and/or" — those underline but open nothing.
          // Require a real path signal: a drive/`./`/`../` prefix, a backslash
          // separator, a `:line[:col]` suffix, or a file extension.
          const bare = target.replace(/:\d+(?::\d+)?$/, '')
          const lastSeg = bare.split(/[\\/]/).pop() ?? ''
          const looksLikePath =
            /^(?:[A-Za-z]:[\\/]|\.{1,2}[\\/])/.test(target) ||
            target.includes('\\') ||
            /:\d+(?::\d+)?$/.test(target) ||
            /\.[A-Za-z0-9]{1,8}$/.test(lastSeg)
          if (!looksLikePath) continue
          links.push({
            range: {
              start: { x: m.index + 1, y },
              end: { x: m.index + target.length, y }
            },
            text: target,
            activate: () => {
              window.api.openLink(target, cwd)
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
          // Resizes sent while the PTY was still spawning (elevated creates
          // sit at the UAC prompt) were dropped in main — clear the memo so
          // the current size is re-sent, or the PTY stays at 80×24.
          lastSize.current = null
          syncSize()
          // Seamless UX: a freshly created terminal that the user is looking
          // at should take keyboard focus (no extra click to start typing —
          // matters most when Claude Code finishes loading its input box).
          if (isActiveRef.current) xterm.focus()
        })
        .catch((err: Error) => {
          // e.g. UAC declined, broker timeout, bad shell, closed during UAC.
          const msg = String(err.message || err).replace(
            /^Error invoking remote method 'pty:create': (Error: )?/,
            ''
          )
          // User closed the tile while the spawn (UAC prompt) was pending —
          // that's a deliberate action, not an error to toast about.
          if (msg.includes('closed before it finished starting')) return
          try {
            xterm.writeln(`\x1b[31m[terminal failed to start: ${msg}]\x1b[0m`)
          } catch {
            /* tile may already be unmounted (closed while spawning) */
          }
          onSpawnError(term.id, msg)
        })
    }

    const ro = new ResizeObserver(() => syncSize())
    ro.observe(bodyRef.current)
    const bodyEl = bodyRef.current

    // Moving the window to a monitor with different DPI scaling (2K ↔ 4K)
    // changes devicePixelRatio without necessarily changing the tile's CSS
    // size, so the ResizeObserver never fires — but glyphs re-rasterize and
    // cell metrics shift, leaving the bottom rows clipped until a refit.
    // A resolution media query only matches one exact DPR, so re-arm after
    // every change to catch the next monitor hop.
    let dprQuery: MediaQueryList | null = null
    const onDprChange = (): void => {
      armDprListener()
      // Re-rasterize the font at the new DPR, then refit once the renderer
      // has re-measured cells (rAF), with a late pass in case metrics settle
      // a frame or two later during the monitor transition.
      xterm.clearTextureAtlas()
      requestAnimationFrame(() => syncSize())
      setTimeout(() => syncSize(), 150)
    }
    const armDprListener = (): void => {
      dprQuery?.removeEventListener('change', onDprChange)
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      dprQuery.addEventListener('change', onDprChange)
    }
    armDprListener()

    return () => {
      bodyEl.removeEventListener('contextmenu', onContextMenu)
      bodyEl.removeEventListener('mousedown', swallowRightButton, true)
      bodyEl.removeEventListener('mouseup', swallowRightButton, true)
      dprQuery?.removeEventListener('change', onDprChange)
      oscHandler.dispose()
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
      }${term.closing ? ' closing' : ''}${term.status === 'waiting' ? ' waiting' : ''}`}
      style={hidden ? { display: 'none' } : undefined}
      onMouseDown={() => onFocus(term.id)}
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
            onToggleAdmin(term.id)
          }}
        >
          🛡
        </button>
        <button
          className="ctl"
          title="Expand"
          onClick={(e) => {
            e.stopPropagation()
            onExpand(term.id)
          }}
        >
          ⤢
        </button>
        <button
          className="ctl"
          title="Close"
          onClick={(e) => {
            e.stopPropagation()
            onClose(term.id)
          }}
        >
          ✕
        </button>
      </div>
      <div className="term-body" ref={bodyRef} />
    </div>
  )
})
