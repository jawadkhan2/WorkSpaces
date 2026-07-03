import { BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import * as pty from 'node-pty'
import { DetectedApp, TerminalSpec, TerminalStatus } from '../shared/types'
import { fallbackCwd, resolveSpawn } from './spawn'
import { spawnElevatedPty, ElevatedPtyHandle } from './elevated'

// Uniform backend shape so local node-pty and elevated broker ptys are
// indistinguishable to the rest of the app.
interface PtyBackend {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

interface ManagedPty {
  spec: TerminalSpec
  backend: PtyBackend
  status: TerminalStatus
  app: DetectedApp
  lastData: number
  waitTimer?: NodeJS.Timeout
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
      // where `claude` hides when installed via npm.
      const script =
        "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f " +
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

// Prompt patterns that suggest an agent is waiting for the user.
const WAIT_PATTERNS = [
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /do you want/i,
  /press enter/i,
  /continue\?/i,
  /❯\s*$/
]

/** Owns every live PTY (local + elevated). Streams data to the renderer and tracks status. */
export class PtyManager {
  private ptys = new Map<string, ManagedPty>()
  private appTimer: NodeJS.Timeout | null = null
  private appPollBusy = false

  constructor(private getWindow: () => BrowserWindow | null) {}

  async create(spec: TerminalSpec, cwd: string): Promise<{ id: string; pid: number }> {
    const backend = spec.admin
      ? await this.createElevated(spec, cwd)
      : this.createLocal(spec, cwd)

    const managed: ManagedPty = {
      spec,
      backend,
      status: 'idle',
      app: null,
      lastData: Date.now()
    }
    this.ptys.set(spec.id, managed)
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
    proc.onData((data) => this.onData(spec.id, data))
    proc.onExit(() => this.onExit(spec.id))
    return {
      pid: proc.pid,
      write: (d) => proc.write(d),
      resize: (c, r) => proc.resize(c, r),
      kill: () => proc.kill()
    }
  }

  private async createElevated(spec: TerminalSpec, cwd: string): Promise<PtyBackend> {
    const handle: ElevatedPtyHandle = await spawnElevatedPty({
      id: spec.id,
      command: spec.command,
      cwd: fallbackCwd(cwd),
      cols: 80,
      rows: 24
    })
    handle.onData((data) => this.onData(spec.id, data))
    handle.onExit(() => this.onExit(spec.id))
    return handle
  }

  private onData(id: string, data: string): void {
    const managed = this.ptys.get(id)
    if (!managed) return
    managed.lastData = Date.now()
    this.setStatus(managed, 'running')
    this.getWindow()?.webContents.send(`pty:data:${id}`, data)

    // Fast path for app detection: programs that set the terminal title via
    // OSC 0/2 (Claude Code does) reveal themselves before the next poll.
    // Only sets — clearing is left to the process-tree poll, since shells
    // don't reliably reset the title after a program exits.
    const title = /\x1b\][02];([^\x07\x1b]*)/.exec(data)?.[1]
    if (title && /claude/i.test(title)) this.setApp(managed, 'claude')

    // Detect an "awaiting input" prompt shortly after output settles.
    if (managed.waitTimer) clearTimeout(managed.waitTimer)
    const tail = data.slice(-200)
    if (WAIT_PATTERNS.some((re) => re.test(tail))) {
      managed.waitTimer = setTimeout(() => this.setStatus(managed, 'waiting'), 400)
    } else {
      managed.waitTimer = setTimeout(() => this.setStatus(managed, 'idle'), 1500)
    }
  }

  private onExit(id: string): void {
    const managed = this.ptys.get(id)
    if (!managed) return
    if (managed.waitTimer) clearTimeout(managed.waitTimer)
    this.setStatus(managed, 'exited')
    this.setApp(managed, null)
    this.getWindow()?.webContents.send(`pty:exit:${id}`)
    this.ptys.delete(id)
    this.stopAppPollingIfIdle()
  }

  private setStatus(m: ManagedPty, status: TerminalStatus): void {
    if (m.status === status) return
    m.status = status
    this.getWindow()?.webContents.send('pty:status', { id: m.spec.id, status })
  }

  private setApp(m: ManagedPty, app: DetectedApp): void {
    if (m.app === app) return
    m.app = app
    this.getWindow()?.webContents.send('pty:app', { id: m.spec.id, app })
  }

  // ---- App detection (which program is running inside each shell) ----

  private ensureAppPolling(): void {
    if (this.appTimer) return
    this.appTimer = setInterval(() => this.pollApps(), 2500)
  }

  private stopAppPollingIfIdle(): void {
    if (this.ptys.size === 0 && this.appTimer) {
      clearInterval(this.appTimer)
      this.appTimer = null
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
        const detect = (rootPid: number): DetectedApp => {
          const queue = [...(children.get(rootPid) ?? [])]
          let guard = 0
          while (queue.length && guard++ < 256) {
            const p = queue.shift()!
            if (/^claude/i.test(p.name) || /claude/i.test(p.cmd)) return 'claude'
            queue.push(...(children.get(p.pid) ?? []))
          }
          return null
        }
        for (const m of this.ptys.values()) this.setApp(m, detect(m.backend.pid))
      })
      .catch(() => {
        /* process listing unavailable — keep last known state */
      })
      .finally(() => {
        this.appPollBusy = false
      })
  }

  input(id: string, data: string): void {
    this.ptys.get(id)?.backend.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.ptys.get(id)?.backend.resize(cols, rows)
    } catch {
      /* ignore resize race during teardown */
    }
  }

  kill(id: string): void {
    const m = this.ptys.get(id)
    if (!m) return
    if (m.waitTimer) clearTimeout(m.waitTimer)
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
