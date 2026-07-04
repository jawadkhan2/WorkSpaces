import { app } from 'electron'
import { spawn as cpSpawn } from 'child_process'
import { randomUUID } from 'crypto'
import * as net from 'net'

// Main-process side of the elevated PTY broker (PLAN.md §6).
// spawnElevatedPty():
//   1. opens a named-pipe server with a random name,
//   2. launches a second instance of this app elevated (`runas` verb -> real
//      UAC prompt) pointing at that pipe with a random auth token,
//   3. waits for the token handshake, sends the spawn request, and
//   4. returns a handle that looks like a local pty to PtyManager.
// One broker process per elevation — UAC is re-prompted every time.

export interface ElevatedPtyHandle {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number) => void): void
}

interface BrokerMsg {
  t: 'hello' | 'spawned' | 'data' | 'exit' | 'error'
  id?: string
  token?: string
  pid?: number
  data?: string
  code?: number
  message?: string
}

const UAC_TIMEOUT_MS = 120_000 // Windows UAC prompt itself times out around 2min

export function spawnElevatedPty(opts: {
  id: string
  command: string
  cwd: string
  cols: number
  rows: number
}): Promise<ElevatedPtyHandle> {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Elevated terminals are only supported on Windows'))
  }

  return new Promise((resolve, reject) => {
    const pipeName = `workspaces-elev-${randomUUID()}`
    const token = randomUUID()

    let sock: net.Socket | null = null
    let settled = false
    let authed = false
    let dataCb: ((data: string) => void) | null = null
    let exitCb: ((code: number) => void) | null = null
    const pendingData: string[] = []
    let pendingExit: number | null = null
    let exited = false

    const cleanup = (): void => {
      clearTimeout(timer)
      try {
        sock?.destroy()
      } catch {
        /* ignore */
      }
      server.close()
    }
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }
    const finishExit = (code: number): void => {
      if (exited) return
      exited = true
      cleanup()
      if (exitCb) exitCb(code)
      else pendingExit = code
    }
    const deliverData = (data: string): void => {
      if (dataCb) dataCb(data)
      else pendingData.push(data)
    }

    const timer = setTimeout(
      () => fail(new Error('Timed out waiting for the elevated helper (UAC)')),
      UAC_TIMEOUT_MS
    )

    const server = net.createServer((conn) => {
      let buf = ''
      conn.on('data', (chunk) => {
        buf += chunk.toString('utf-8')
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line.trim()) continue
          let msg: BrokerMsg
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          handle(conn, msg)
        }
      })
      conn.on('close', () => {
        if (!settled) fail(new Error('Elevated helper disconnected before starting'))
        else finishExit(-1)
      })
      conn.on('error', () => {
        /* close handler covers it */
      })
    })

    const send = (msg: object): void => {
      sock?.write(JSON.stringify(msg) + '\n')
    }

    const handle = (conn: net.Socket, msg: BrokerMsg): void => {
      if (!authed) {
        // First frame must be the token handshake.
        if (msg.t !== 'hello' || msg.token !== token) {
          conn.destroy()
          return
        }
        authed = true
        sock = conn
        send({
          t: 'spawn',
          id: opts.id,
          command: opts.command,
          cwd: opts.cwd,
          cols: opts.cols,
          rows: opts.rows
        })
        return
      }
      if (conn !== sock) {
        conn.destroy()
        return
      }
      switch (msg.t) {
        case 'spawned':
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve({
              pid: msg.pid || -1,
              write: (data) => send({ t: 'input', id: opts.id, data }),
              resize: (cols, rows) => send({ t: 'resize', id: opts.id, cols, rows }),
              kill: () => {
                send({ t: 'kill', id: opts.id })
                setTimeout(() => finishExit(-1), 500)
              },
              onData: (cb) => {
                dataCb = cb
                while (pendingData.length) cb(pendingData.shift()!)
              },
              onExit: (cb) => {
                exitCb = cb
                if (pendingExit !== null) cb(pendingExit)
              }
            })
          }
          break
        case 'data':
          deliverData(msg.data || '')
          break
        case 'exit':
          finishExit(msg.code ?? 0)
          break
        case 'error':
          fail(new Error(msg.message || 'Elevated helper failed to start the terminal'))
      }
    }

    server.on('error', (err) => fail(err))
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => {
      // Launch the elevated helper. `-Verb RunAs` triggers the real UAC prompt;
      // Start-Process throws (exit != 0) if the user declines.
      const exe = process.execPath
      const helperArgs = app.isPackaged ? [] : [app.getAppPath()]
      helperArgs.push('--pty-broker', `--pipe=${pipeName}`, `--token=${token}`)
      // Each element is single-quoted for PowerShell with embedded double
      // quotes so paths with spaces survive Start-Process's arg join.
      const argList = helperArgs
        .map((a) => `'"${a.replace(/'/g, "''")}"'`)
        .join(',')
      const ps = cpSpawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList ${argList} -Verb RunAs`
        ],
        { windowsHide: true, stdio: 'ignore' }
      )
      ps.on('error', (err) => fail(new Error(`Failed to launch elevation helper: ${err.message}`)))
      ps.on('exit', (code) => {
        if (code !== 0) fail(new Error('Elevation was declined (UAC prompt canceled)'))
      })
    })
  })
}
