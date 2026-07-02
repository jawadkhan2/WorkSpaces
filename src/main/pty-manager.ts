import { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import { TerminalSpec, TerminalStatus } from '../shared/types'
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
  lastData: number
  waitTimer?: NodeJS.Timeout
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

  constructor(private getWindow: () => BrowserWindow | null) {}

  async create(spec: TerminalSpec, cwd: string): Promise<{ id: string; pid: number }> {
    const backend = spec.admin
      ? await this.createElevated(spec, cwd)
      : this.createLocal(spec, cwd)

    const managed: ManagedPty = {
      spec,
      backend,
      status: 'idle',
      lastData: Date.now()
    }
    this.ptys.set(spec.id, managed)
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
    this.getWindow()?.webContents.send(`pty:exit:${id}`)
    this.ptys.delete(id)
  }

  private setStatus(m: ManagedPty, status: TerminalStatus): void {
    if (m.status === status) return
    m.status = status
    this.getWindow()?.webContents.send('pty:status', { id: m.spec.id, status })
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
  }

  killAll(): void {
    for (const id of Array.from(this.ptys.keys())) this.kill(id)
  }

  hasAny(): boolean {
    return this.ptys.size > 0
  }
}
