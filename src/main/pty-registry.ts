import { app } from 'electron'
import { basename, join } from 'path'
import { execFileSync } from 'child_process'
import * as fs from 'fs'

// Crash-safe registry of live PTY OS pids. On a clean quit killAll() reaps
// every terminal and the registry empties itself (forgetPty on each exit). But
// a *force* kill — Task Manager "End Task", a main-process crash, an OS
// shutdown — skips killAll entirely, and Windows does not cascade-kill child
// processes, so the shells (and their npm/agent descendants) are left
// orphaned. This file survives that death: next launch reads it and reaps any
// survivor before opening the window.

interface Entry {
  pid: number
  // Expected image name (lowercased basename of the shell exe). Guards against
  // pid reuse: between the crash and this launch the OS may have handed the
  // recorded pid to an unrelated process — we only kill if the live pid is
  // still the same kind of shell.
  name: string
}

let filePath: string | null = null
function file(): string {
  if (!filePath) filePath = join(app.getPath('userData'), 'live-ptys.json')
  return filePath
}

function read(): Entry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf-8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e) => e && Number.isFinite(e.pid) && typeof e.name === 'string')
  } catch {
    return []
  }
}

function write(entries: Entry[]): void {
  try {
    // Write-then-rename so a crash mid-write can't leave a truncated file that
    // read() would drop, stranding real orphans.
    const tmp = `${file()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(entries), 'utf-8')
    fs.renameSync(tmp, file())
  } catch {
    /* registry is best-effort — never let it break PTY lifecycle */
  }
}

/** Expected image name for a spawned shell path, for the pid-reuse guard. */
export function nameFor(shellPath: string): string {
  return basename(shellPath).toLowerCase()
}

export function recordPty(pid: number, name: string): void {
  if (!Number.isFinite(pid) || pid <= 0) return
  const entries = read()
  if (entries.some((e) => e.pid === pid)) return
  entries.push({ pid, name })
  write(entries)
}

export function forgetPty(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) return
  const entries = read()
  const next = entries.filter((e) => e.pid !== pid)
  if (next.length !== entries.length) write(next)
}

function isLiveMatch(e: Entry): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${e.pid}`, '/FO', 'CSV', '/NH'], {
        windowsHide: true,
        encoding: 'utf-8'
      })
      // A hit is a CSV row starting with the quoted image name; a miss prints
      // "INFO: No tasks are running..." with no leading quote.
      const m = /^"([^"]+)"/.exec(out.trim())
      return !!m && m[1].toLowerCase() === e.name
    }
    // POSIX: signal 0 only probes existence (no name check — best-effort).
    process.kill(e.pid, 0)
    return true
  } catch {
    return false
  }
}

function killTree(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      // /T takes the whole tree (npm run dev, agents, conhost); /F is forceful.
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
    } else {
      process.kill(pid, 'SIGKILL')
    }
    return true
  } catch {
    // Already gone, or elevated pid we lack rights to kill without UAC.
    return false
  }
}

/**
 * Kill PTY processes recorded by a previous run that outlived it. Clears the
 * registry first (this run installs its own fresh entries, and a pid we cannot
 * kill must not be retried every launch), then reaps each live-and-matching
 * survivor. Returns how many were killed. Synchronous — runs once at startup.
 */
export function sweepOrphans(): number {
  const entries = read()
  write([])
  let killed = 0
  for (const e of entries) {
    if (isLiveMatch(e) && killTree(e.pid)) killed++
  }
  return killed
}
