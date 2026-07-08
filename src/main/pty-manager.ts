import { BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as pty from 'node-pty'
import { DetectedApp, TerminalSpec, TerminalStatus } from '../shared/types'
import { fallbackCwd, resolveSpawn } from './spawn'
import { spawnElevatedPty } from './elevated'
import { forgetPty, nameFor, recordPty } from './pty-registry'

// Uniform backend shape so local node-pty and elevated broker ptys are
// indistinguishable to the rest of the app.
interface PtyBackend {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number) => void): void
}

interface ManagedPty {
  spec: TerminalSpec
  backend: PtyBackend
  status: TerminalStatus
  app: DetectedApp
  lastData: number
  // Timestamps of UI-echo triggers (resize, focus/mouse escape input). Output
  // arriving shortly after these is a repaint, not real work — it must not
  // flip the status pill to "running".
  lastResize: number
  lastMetaInput: number
  // Whether the PTY's shell currently has a live descendant process (a
  // command like `npm run dev` is running inside it). Updated by the same
  // process-tree poll as app detection. While busy, silence between output
  // bursts must not demote the status to "idle". Not used for terminals with
  // a detected app (see lastAppSignal) — the agent process itself lives for
  // the whole session, so its mere presence says nothing about whether it is
  // currently working.
  busy: boolean
  waitTimer?: NodeJS.Timeout
  // Last time a real "still working" or "waiting for you" content signal was
  // seen in this app's output (as opposed to a content-free repaint like the
  // blinking cursor). Only meaningful while `app` is set.
  lastAppSignal: number
  // Tail of the previous output chunk, carried forward so a WAIT/RUNNING
  // pattern split across a chunk boundary is still matched.
  tailCarry: string
}

interface ProcInfo {
  pid: number
  ppid: number
  name: string
  cmd: string
}

/**
 * Snapshot of all processes (pid, ppid, name, and command line for script
 * hosts) so we can tell which app is running inside each PTY's shell.
 */
function listProcesses(): Promise<ProcInfo[]> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      // CommandLine is only fetched for script hosts (node/bun/deno) — that is
      // where `claude` hides when installed via npm. -Property keeps WMI from
      // serializing every property of every process on each poll.
      const script =
        'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine | ' +
        "ForEach-Object { '{0}|{1}|{2}|{3}' -f " +
        "$_.ProcessId,$_.ParentProcessId,$_.Name,($(if ($_.Name -match '^(node|bun|deno)') { $_.CommandLine } else { '' })) }"
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err) return reject(err)
          const out: ProcInfo[] = []
          for (const line of stdout.split(/\r?\n/)) {
            const parts = line.split('|')
            if (parts.length < 3) continue
            const pid = Number(parts[0])
            const ppid = Number(parts[1])
            if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
            out.push({ pid, ppid, name: parts[2] ?? '', cmd: parts.slice(3).join('|') })
          }
          resolve(out)
        }
      )
    } else {
      execFile('ps', ['-eo', 'pid=,ppid=,comm=,args='], (err, stdout) => {
        if (err) return reject(err)
        const out: ProcInfo[] = []
        for (const line of stdout.split('\n')) {
          const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
          if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3], cmd: m[4] })
        }
        resolve(out)
      })
    }
  })
}

// Input that is pure terminal chatter — focus in/out reports (CSI I / CSI O),
// SGR mouse events (including scroll wheel), and xterm's automatic replies to
// app queries (cursor position report `CSI r;cR`, device attributes
// `CSI ?…c`) — as opposed to actual keystrokes. Apps like Claude Code repaint
// in response to these; that repaint is not "running".
const META_INPUT = /^(?:\x1b\[(?:I|O|<\d+;\d+;\d+[Mm]|\d+;\d+R|\?\d+(?:;\d+)*c))+$/

// Output arriving within this window after a resize or meta input is treated
// as a repaint and does not promote the status to "running".
const REPAINT_SUPPRESS_MS = 500

// Prompt patterns that suggest an agent is waiting for the user: permission
// dialogs ("This command requires approval" / "Do you want to proceed?"),
// numbered menus (`❯ 1. Yes`), and hard limits that block progress until the
// user acts.
const WAIT_PATTERNS = [
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /\by\/n\b/i,
  /do you want/i,
  /would you like/i,
  /press enter/i,
  /continue\?/i,
  /proceed\?/i,
  /requires approval/i,
  /esc to cancel/i,
  // Numbered selection menu (Claude's permission prompts): "❯ 1. Yes". After
  // ANSI stripping the highlighted digit sits right after the arrow.
  /❯\s*\d[.)]/,
  /usage limit/i,
  /limit reached/i
]

// Claude Code's own "still working" tells. Any one of these means the agent
// is actively working — plain output arriving is not enough, because Claude
// repaints its blinking cursor (`\r●` / `\r `) roughly every 500ms even while
// sitting fully idle at its own prompt.
//   1. "esc to interrupt" — the interrupt hint printed in every frame of the
//      working status line, and absent when idle or waiting. Most stable
//      signal, so it leads. (The waiting state's hint is "esc to cancel",
//      matched by WAIT_PATTERNS, which is checked first.)
//   2. spinner glyph + whimsical verb ("✶ Musing…", "✻ Leavening…"). Verb may
//      end in a unicode ellipsis (…) or three ASCII dots (...).
//   3. the elapsed-time status line ("(12s · ⇓ 340 tokens)").
const APP_RUNNING_PATTERNS = [
  /esc to interrupt/i,
  /[✻✽✢✳✶✷·∗*]\s*\w+ing(?:…|\.\.\.)/,
  /\(\s*\d+s\b/
]

// Strip ANSI escape sequences (CSI/OSC/charset/single-char) and stray control
// bytes so text matching runs against what the user actually sees. Claude
// Code's Ink TUI interleaves SGR color codes mid-phrase — matching the raw
// stream would miss "esc to interrupt" or a "❯ 1." menu whenever a color code
// lands between the characters. Spaces/newlines are kept for phrase matching.
// eslint-disable-next-line no-control-regex
const ANSI_SEQ = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()#][0-9A-Za-z]|\x1b[=>MENOPc78]/g
// eslint-disable-next-line no-control-regex
const CTRL_CH = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_SEQ, '').replace(/\r/g, '').replace(CTRL_CH, '')
}

// Printable, non-whitespace character count of a chunk after stripping control
// codes — a proxy for "real screen activity". A working agent's status line
// (spinner + verb + token counter) clears this easily every frame; an idle or
// waiting prompt only blinks the cursor (`\r●` / `\r `), leaving ~0–1 chars.
function meaningfulLen(data: string): number {
  return stripAnsi(data).replace(/\s+/g, '').length
}

// Minimum meaningfulLen for an output chunk to count as active work (and thus
// keep a known app's status "running"). Above a bare cursor blink, below a
// real content redraw.
const APP_CONTENT_MIN = 3

// Set WS_PTY_DEBUG=1 to append raw + stripped PTY output to a log file, so the
// exact bytes behind a missed status transition can be inspected.
const DEBUG_CAPTURE = !!process.env.WS_PTY_DEBUG

// After output goes quiet for this long, a terminal with no live child
// process is considered idle again.
const OUTPUT_IDLE_MS = 1500

// Demote window for terminals with a detected app. Deliberately much wider
// than OUTPUT_IDLE_MS: while Claude Code thinks for a long stretch its frame
// updates can shrink to a cursor move + spinner glyph (below APP_CONTENT_MIN,
// and with escape codes displacing "esc to interrupt" out of the tail
// window), so qualifying signals can gap for a few seconds mid-work. A late
// idle pill beats a green dot that blinks off and on during a long task.
const APP_IDLE_MS = 4000

// How often the idle-vs-still-working sweep runs for terminals with a
// detected app. Independent of appTimer (process-tree poll) since this only
// compares timestamps and is cheap enough to run often.
const APP_IDLE_SWEEP_MS = 500

// How often the process-tree poll runs. Each tick launches powershell.exe and
// enumerates every process via Win32_Process — one of the heavier WMI classes
// — so the interval is kept conservative. App *detection* latency is covered
// by the OSC-title fast path in onData, so this poll only needs to catch
// process exits and plain-shell busy/idle transitions, which tolerate ~4s.
const APP_POLL_MS = 4000

// Descendants that exist as console plumbing, not user work.
const PLUMBING_PROCS = /^(conhost\.exe|openconsole\.exe|winpty-agent\.exe)$/i

/** Owns every live PTY (local + elevated). Streams data to the renderer and tracks status. */
export class PtyManager {
  private ptys = new Map<string, ManagedPty>()
  private appTimer: NodeJS.Timeout | null = null
  private appIdleSweepTimer: NodeJS.Timeout | null = null
  private appPollBusy = false
  // Creates still awaiting their backend (elevated ones sit at the UAC prompt
  // for seconds/minutes). A kill() arriving for one of these ids can't find a
  // map entry yet — record it so create() can abort instead of inserting an
  // orphaned (worst case: elevated) PTY that no tile owns.
  private pendingCreates = new Set<string>()
  private killedWhilePending = new Set<string>()
  // Renderer-bound output is coalesced per flush tick instead of one IPC
  // message per PTY chunk — heavy output (build logs) otherwise floods the
  // channel with thousands of tiny messages a second.
  private dataBuf = new Map<string, string[]>()
  private dataFlushTimer: NodeJS.Timeout | null = null

  constructor(private getWindow: () => BrowserWindow | null) {}

  async create(spec: TerminalSpec, cwd: string): Promise<{ id: string; pid: number }> {
    if (this.ptys.has(spec.id) || this.pendingCreates.has(spec.id)) {
      throw new Error('A terminal with this id already exists')
    }
    this.pendingCreates.add(spec.id)
    let backend: PtyBackend
    try {
      backend = spec.admin
        ? await this.createElevated(spec, cwd)
        : this.createLocal(spec, cwd)
    } finally {
      this.pendingCreates.delete(spec.id)
    }
    if (this.killedWhilePending.delete(spec.id)) {
      // Tile was closed while the UAC prompt was up — don't adopt the backend.
      try {
        backend.kill()
      } catch {
        /* already gone */
      }
      throw new Error('Terminal was closed before it finished starting')
    }

    const managed: ManagedPty = {
      spec,
      backend,
      status: 'idle',
      app: null,
      lastData: Date.now(),
      // Startup banner/prompt output is a paint, not work — suppress the
      // initial "running" flash the same way as resize repaints.
      lastResize: Date.now(),
      lastMetaInput: 0,
      busy: false,
      lastAppSignal: 0,
      tailCarry: ''
    }
    this.ptys.set(spec.id, managed)
    // Persist the OS pid so a force-kill of this app (which skips killAll)
    // leaves a trail the next launch can reap. The shell image name guards
    // against pid reuse in the meantime.
    recordPty(backend.pid, nameFor(resolveSpawn(spec.command).shell))
    // For elevated backends `create` awaited above, so these subscribe *after*
    // the broker may have already emitted output — spawnElevatedPty buffers
    // early data/exit into pendingData/pendingExit and flushes them the moment
    // these callbacks attach, so nothing is dropped. Keep that buffer if you
    // ever reorder this.
    backend.onData((data) => this.onData(spec.id, data))
    backend.onExit(() => this.onExit(spec.id))
    this.ensureAppPolling()
    return { id: spec.id, pid: backend.pid }
  }

  private createLocal(spec: TerminalSpec, cwd: string): PtyBackend {
    const { shell, args } = resolveSpawn(spec.command)
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: fallbackCwd(cwd),
      env: process.env as { [key: string]: string }
    })
    return {
      pid: proc.pid,
      write: (d) => proc.write(d),
      resize: (c, r) => proc.resize(c, r),
      kill: () => proc.kill(),
      onData: (cb) => {
        proc.onData(cb)
      },
      onExit: (cb) => {
        proc.onExit(({ exitCode }) => cb(exitCode))
      }
    }
  }

  private async createElevated(spec: TerminalSpec, cwd: string): Promise<PtyBackend> {
    return spawnElevatedPty({
      id: spec.id,
      command: spec.command,
      cwd: fallbackCwd(cwd),
      cols: 80,
      rows: 24
    })
  }

  private onData(id: string, data: string): void {
    const managed = this.ptys.get(id)
    if (!managed) return
    const now = Date.now()
    managed.lastData = now
    this.queueData(id, data)

    // Fast path for app detection: programs that set the terminal title via
    // OSC 0/2 (Claude Code does) reveal themselves before the next poll.
    // Only sets — clearing is left to the process-tree poll, since shells
    // don't reliably reset the title after a program exits.
    const title = /\x1b\][02];([^\x07\x1b]*)/.exec(data)?.[1]
    if (title && /claude/i.test(title)) this.setApp(managed, 'claude')

    // Carry the raw tail across chunks so a pattern straddling a chunk
    // boundary still matches, then strip ANSI for the actual text matching
    // (see stripAnsi). Kept wider than the visible window because escape codes
    // inflate the raw length. Match against the stripped text.
    const rawTail = (managed.tailCarry + data).slice(-400)
    managed.tailCarry = rawTail
    const tail = stripAnsi(rawTail)

    if (DEBUG_CAPTURE) this.debugCapture(id, managed, data, tail)

    const sinceRepaintTrigger = now - Math.max(managed.lastResize, managed.lastMetaInput)
    const repaintSuppressed = sinceRepaintTrigger <= REPAINT_SUPPRESS_MS

    if (managed.app !== null) {
      // Known agents (Claude Code) repaint their idle prompt's blinking cursor
      // forever, so "any output = running" would never let a busy terminal go
      // quiet. Instead:
      //   - a WAIT phrase → waiting (checked first; it outranks activity so a
      //     freshly drawn permission prompt doesn't read as "working"),
      //   - otherwise a real content redraw (spinner/token stream, or an
      //     explicit running phrase) → running. A bare cursor-blink repaint
      //     falls under APP_CONTENT_MIN and is ignored, so the sweep can
      //     demote to idle once work actually stops.
      //
      // Output inside the repaint-suppress window (scroll wheel mouse reports,
      // focus events, resizes — Claude Code tracks the mouse, so every scroll
      // tick makes it redraw the screen) is a repaint of existing content, not
      // work: it must not flip an idle terminal to running or resurrect stale
      // WAIT phrases scrolling back into view. The one exemption is "esc to
      // interrupt": it is only ever painted while the agent is genuinely
      // working, so it keeps the dot lit when the user scrolls *during* a task
      // (the suppressed repaints would otherwise starve the idle sweep). WAIT
      // still outranks it — a freshly drawn permission prompt can have the
      // previous working frame's "esc to interrupt" lingering in tailCarry.
      if (!repaintSuppressed && WAIT_PATTERNS.some((re) => re.test(tail))) {
        managed.lastAppSignal = now
        this.setStatus(managed, 'waiting')
      } else if (/esc to interrupt/i.test(tail)) {
        managed.lastAppSignal = now
        this.setStatus(managed, 'running')
      } else if (repaintSuppressed) {
        // Repaint — leave status and lastAppSignal alone.
      } else if (
        meaningfulLen(data) >= APP_CONTENT_MIN ||
        APP_RUNNING_PATTERNS.some((re) => re.test(tail))
      ) {
        managed.lastAppSignal = now
        this.setStatus(managed, 'running')
      }
      return
    }

    // Plain shells have no such protocol — fall back to "any real output
    // (not a resize/focus repaint) means running", and demote to idle once
    // output settles and no descendant process remains.
    if (sinceRepaintTrigger > REPAINT_SUPPRESS_MS) {
      this.setStatus(managed, 'running')
    }
    if (managed.waitTimer) clearTimeout(managed.waitTimer)
    // Match WAIT phrases only against the last non-empty line — the shell's
    // current prompt — not the whole 400-char tailCarry. A prompt lives on the
    // bottom line; matching the full buffer would fire on a WAIT phrase that
    // has already scrolled off (a prior `press enter`, `continue?`, etc.),
    // planting a spurious 'waiting' the user then has to type out of.
    const lastLine = tail.split('\n').reduce((acc, l) => (l.trim() ? l : acc), '')
    if (WAIT_PATTERNS.some((re) => re.test(lastLine))) {
      managed.waitTimer = setTimeout(() => this.setStatus(managed, 'waiting'), 400)
    } else {
      // Programs like dev servers emit output in bursts with long silences in
      // between — only demote to idle when nothing is running inside the
      // shell anymore (the process poll demotes later otherwise).
      managed.waitTimer = setTimeout(() => {
        if (!managed.busy) this.setStatus(managed, 'idle')
      }, OUTPUT_IDLE_MS)
    }
  }

  private onExit(id: string): void {
    const managed = this.ptys.get(id)
    if (!managed) return
    if (managed.waitTimer) clearTimeout(managed.waitTimer)
    forgetPty(managed.backend.pid)
    this.setStatus(managed, 'exited')
    this.setApp(managed, null)
    // Deliver any output still sitting in the coalescing buffer before the
    // exit event, so the terminal's final lines aren't lost.
    this.flushData()
    this.getWindow()?.webContents.send(`pty:exit:${id}`)
    this.ptys.delete(id)
    this.stopAppPollingIfIdle()
  }

  // ---- Renderer output coalescing ----

  private queueData(id: string, data: string): void {
    const buf = this.dataBuf.get(id)
    if (buf) buf.push(data)
    else this.dataBuf.set(id, [data])
    if (!this.dataFlushTimer) {
      this.dataFlushTimer = setTimeout(() => this.flushData(), 8)
    }
  }

  private flushData(): void {
    if (this.dataFlushTimer) {
      clearTimeout(this.dataFlushTimer)
      this.dataFlushTimer = null
    }
    if (this.dataBuf.size === 0) return
    const win = this.getWindow()
    if (win && !win.isDestroyed()) {
      for (const [id, chunks] of this.dataBuf) {
        win.webContents.send(`pty:data:${id}`, chunks.length === 1 ? chunks[0] : chunks.join(''))
      }
    }
    this.dataBuf.clear()
  }

  // Diagnostic only (WS_PTY_DEBUG=1): append each chunk's app, current status,
  // meaningful length, and both raw + stripped text to a log so the exact
  // bytes behind a missed running/waiting transition can be inspected.
  private debugCapture(id: string, m: ManagedPty, data: string, tail: string): void {
    try {
      const line =
        JSON.stringify({
          t: new Date().toISOString(),
          id: id.slice(0, 8),
          app: m.app,
          status: m.status,
          len: meaningfulLen(data),
          raw: data.slice(-200),
          tail: tail.slice(-200)
        }) + '\n'
      appendFileSync(join(tmpdir(), 'workspaces-pty-debug.log'), line)
    } catch {
      /* diagnostics must never break the data path */
    }
  }

  private setStatus(m: ManagedPty, status: TerminalStatus): void {
    if (m.status === status) return
    m.status = status
    this.getWindow()?.webContents.send('pty:status', { id: m.spec.id, status })
  }

  private setApp(m: ManagedPty, app: DetectedApp): void {
    if (m.app === app) return
    m.app = app
    // Grace period before the idle sweep can act, so a just-detected app
    // isn't immediately judged idle before its first real content signal.
    if (app !== null) m.lastAppSignal = Date.now()
    this.getWindow()?.webContents.send('pty:app', { id: m.spec.id, app })
  }

  // ---- App detection (which program is running inside each shell) ----

  private ensureAppPolling(): void {
    if (this.appTimer) return
    this.appTimer = setInterval(() => this.pollApps(), APP_POLL_MS)
    this.appIdleSweepTimer = setInterval(() => this.sweepAppIdle(), APP_IDLE_SWEEP_MS)
  }

  private stopAppPollingIfIdle(): void {
    if (this.ptys.size === 0 && this.appTimer) {
      clearInterval(this.appTimer)
      this.appTimer = null
      if (this.appIdleSweepTimer) clearInterval(this.appIdleSweepTimer)
      this.appIdleSweepTimer = null
    }
  }

  // Known-app terminals (Claude Code) never go quiet on their own — the
  // blinking cursor repaints every ~500ms even at rest — so idle can't be
  // driven by "no output for N ms". Instead: once a real working signal
  // hasn't reappeared for APP_IDLE_MS, the terminal has settled.
  //
  // Only 'running' is swept. 'waiting' is left sticky: a permission prompt or
  // menu matches a WAIT_PATTERN exactly once and then sits static on screen —
  // only the cursor blink repaints, which doesn't re-emit the prompt text, so
  // lastAppSignal never refreshes. Sweeping it would flip the "waiting for
  // input" pill to idle after 1.5s while the user still hasn't answered. It
  // clears on its own when real output supersedes it (running / exit).
  private sweepAppIdle(): void {
    if (this.ptys.size === 0) return
    // Nothing to sweep unless at least one terminal has a detected app.
    let hasApp = false
    for (const m of this.ptys.values()) {
      if (m.app !== null) {
        hasApp = true
        break
      }
    }
    if (!hasApp) return
    const now = Date.now()
    for (const m of this.ptys.values()) {
      if (m.app === null) continue
      if (m.status === 'running' && now - m.lastAppSignal > APP_IDLE_MS) {
        this.setStatus(m, 'idle')
      }
    }
  }

  private pollApps(): void {
    if (this.appPollBusy || this.ptys.size === 0) return
    this.appPollBusy = true
    listProcesses()
      .then((procs) => {
        const children = new Map<number, ProcInfo[]>()
        for (const p of procs) {
          const list = children.get(p.ppid)
          if (list) list.push(p)
          else children.set(p.ppid, [p])
        }
        const detect = (rootPid: number): { app: DetectedApp; busy: boolean } => {
          const queue = [...(children.get(rootPid) ?? [])]
          let app: DetectedApp = null
          let busy = false
          let guard = 0
          while (queue.length && guard++ < 256) {
            const p = queue.shift()!
            if (!PLUMBING_PROCS.test(p.name)) busy = true
            if (/^claude/i.test(p.name) || /claude/i.test(p.cmd)) {
              app = 'claude'
              break
            }
            queue.push(...(children.get(p.pid) ?? []))
          }
          return { app, busy }
        }
        for (const m of this.ptys.values()) {
          const { app, busy } = detect(m.backend.pid)
          this.setApp(m, app)
          m.busy = busy
          // Busy-based promotion/demotion only applies to plain shells (no
          // detected app): a dev server stays "running" while silent, and
          // drops to idle once its output has settled and it has exited.
          // Known apps are driven entirely by content signals (see onData /
          // sweepAppIdle) since their process is alive for the whole session.
          if (app === null) {
            if (busy && m.status === 'idle') {
              this.setStatus(m, 'running')
            } else if (
              !busy &&
              (m.status === 'running' || m.status === 'waiting') &&
              Date.now() - m.lastData > OUTPUT_IDLE_MS
            ) {
              // Plain shells have no persistent agent, so 'waiting' must be
              // demotable too. A real prompt (rm -i, npm y/n) keeps a live
              // child → busy=true → left alone. A stale-tail false match (a
              // WAIT phrase lingering in tailCarry after it scrolled off) has
              // no child → busy=false → cleared here instead of sticking until
              // the user types.
              this.setStatus(m, 'idle')
            }
          }
        }
      })
      .catch(() => {
        /* process listing unavailable — keep last known state */
      })
      .finally(() => {
        this.appPollBusy = false
      })
  }

  input(id: string, data: string): void {
    const m = this.ptys.get(id)
    if (!m) return
    if (META_INPUT.test(data)) m.lastMetaInput = Date.now()
    m.backend.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const m = this.ptys.get(id)
    if (!m) return
    m.lastResize = Date.now()
    try {
      m.backend.resize(cols, rows)
    } catch {
      /* ignore resize race during teardown */
    }
  }

  kill(id: string): void {
    const m = this.ptys.get(id)
    if (!m) {
      // The backend may still be spawning (elevated create waiting on UAC).
      // Flag it so create() kills the backend on arrival instead of adopting
      // an orphan.
      if (this.pendingCreates.has(id)) this.killedWhilePending.add(id)
      return
    }
    if (m.waitTimer) clearTimeout(m.waitTimer)
    forgetPty(m.backend.pid)
    this.dataBuf.delete(id)
    try {
      m.backend.kill()
    } catch {
      /* already gone */
    }
    this.ptys.delete(id)
    this.stopAppPollingIfIdle()
  }

  killAll(): void {
    for (const id of Array.from(this.ptys.keys())) this.kill(id)
  }

  hasAny(): boolean {
    return this.ptys.size > 0
  }
}
