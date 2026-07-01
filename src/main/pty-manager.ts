import { BrowserWindow } from 'electron'
import * as os from 'os'
import * as pty from 'node-pty'
import { TerminalSpec, TerminalStatus } from '../shared/types'

interface ManagedPty {
  spec: TerminalSpec
  proc: pty.IPty
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

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  return process.env.SHELL || '/bin/bash'
}

/** Owns every live PTY. Streams data to the renderer and tracks status. */
export class PtyManager {
  private ptys = new Map<string, ManagedPty>()

  constructor(private getWindow: () => BrowserWindow | null) {}

  create(spec: TerminalSpec, cwd: string): { id: string; pid: number } {
    let shell = defaultShell()
    let args: string[] = []

    // A command (e.g. "claude") launches inside the shell so PATH resolves it
    // and the user drops back to a prompt when the agent exits.
    if (spec.command && spec.command.trim()) {
      if (process.platform === 'win32') {
        shell = process.env.COMSPEC || 'cmd.exe'
        args = ['/c', spec.command]
      } else {
        shell = process.env.SHELL || '/bin/bash'
        args = ['-lc', `${spec.command}; exec ${shell}`]
      }
    }

    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || process.env.USERPROFILE || os.homedir(),
      env: process.env as { [key: string]: string }
    })

    const managed: ManagedPty = {
      spec,
      proc,
      status: 'idle',
      lastData: Date.now()
    }
    this.ptys.set(spec.id, managed)

    proc.onData((data) => {
      managed.lastData = Date.now()
      this.setStatus(managed, 'running')
      this.getWindow()?.webContents.send(`pty:data:${spec.id}`, data)

      // Detect an "awaiting input" prompt shortly after output settles.
      if (managed.waitTimer) clearTimeout(managed.waitTimer)
      const tail = data.slice(-200)
      if (WAIT_PATTERNS.some((re) => re.test(tail))) {
        managed.waitTimer = setTimeout(() => this.setStatus(managed, 'waiting'), 400)
      } else {
        managed.waitTimer = setTimeout(() => this.setStatus(managed, 'idle'), 1500)
      }
    })

    proc.onExit(() => {
      this.setStatus(managed, 'exited')
      this.getWindow()?.webContents.send(`pty:exit:${spec.id}`)
      this.ptys.delete(spec.id)
    })

    return { id: spec.id, pid: proc.pid }
  }

  private setStatus(m: ManagedPty, status: TerminalStatus): void {
    if (m.status === status) return
    m.status = status
    this.getWindow()?.webContents.send('pty:status', { id: m.spec.id, status })
  }

  input(id: string, data: string): void {
    this.ptys.get(id)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.ptys.get(id)?.proc.resize(cols, rows)
    } catch {
      /* ignore resize race during teardown */
    }
  }

  kill(id: string): void {
    const m = this.ptys.get(id)
    if (!m) return
    if (m.waitTimer) clearTimeout(m.waitTimer)
    try {
      m.proc.kill()
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
