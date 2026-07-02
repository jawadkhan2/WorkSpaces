import * as net from 'net'
import * as pty from 'node-pty'
import { fallbackCwd, resolveSpawn } from './spawn'

// Elevated PTY broker (PLAN.md §6). This module runs inside a SECOND instance
// of the app launched with the `runas` verb (real UAC prompt). It hosts the
// node-pty for an elevated terminal and speaks NDJSON to the main process
// over a named pipe. It never creates a window.

interface SpawnMsg {
  t: 'spawn'
  id: string
  command: string
  cwd: string
  cols: number
  rows: number
}
type InMsg =
  | SpawnMsg
  | { t: 'input'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'kill'; id: string }
  | { t: 'shutdown' }

function argValue(name: string): string | null {
  const prefix = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : null
}

export function runBroker(): void {
  const pipeName = argValue('pipe')
  const token = argValue('token')
  if (!pipeName || !token) process.exit(2)

  const ptys = new Map<string, pty.IPty>()
  const sock = net.connect(`\\\\.\\pipe\\${pipeName}`)
  const send = (msg: object): void => {
    sock.write(JSON.stringify(msg) + '\n')
  }

  sock.on('connect', () => send({ t: 'hello', token }))

  let buf = ''
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf-8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        handle(JSON.parse(line) as InMsg)
      } catch {
        /* ignore malformed frame */
      }
    }
  })

  const die = (code: number): void => {
    for (const p of ptys.values()) {
      try {
        p.kill()
      } catch {
        /* already gone */
      }
    }
    process.exit(code)
  }
  sock.on('close', () => die(0))
  sock.on('error', () => die(1))

  function handle(msg: InMsg): void {
    switch (msg.t) {
      case 'spawn': {
        try {
          const { shell, args } = resolveSpawn(msg.command)
          const proc = pty.spawn(shell, args, {
            name: 'xterm-256color',
            cols: msg.cols || 80,
            rows: msg.rows || 24,
            cwd: fallbackCwd(msg.cwd),
            env: process.env as { [key: string]: string }
          })
          ptys.set(msg.id, proc)
          proc.onData((data) => send({ t: 'data', id: msg.id, data }))
          proc.onExit(({ exitCode }) => {
            ptys.delete(msg.id)
            send({ t: 'exit', id: msg.id, code: exitCode })
            // One broker per elevation: exit once our pty is done.
            if (ptys.size === 0) setTimeout(() => process.exit(0), 100)
          })
          send({ t: 'spawned', id: msg.id, pid: proc.pid })
        } catch (err) {
          send({ t: 'error', id: msg.id, message: String(err) })
        }
        break
      }
      case 'input':
        ptys.get(msg.id)?.write(msg.data)
        break
      case 'resize':
        try {
          ptys.get(msg.id)?.resize(msg.cols, msg.rows)
        } catch {
          /* resize race */
        }
        break
      case 'kill': {
        const p = ptys.get(msg.id)
        ptys.delete(msg.id)
        try {
          p?.kill()
        } catch {
          /* already gone */
        }
        if (ptys.size === 0) setTimeout(() => process.exit(0), 100)
        break
      }
      case 'shutdown':
        die(0)
    }
  }
}
