import * as os from 'os'

/** Resolve the shell + args for a terminal command ("" => default shell). */
export function resolveSpawn(command: string): { shell: string; args: string[] } {
  if (command && command.trim()) {
    // A command (e.g. "claude") launches inside the shell so PATH resolves it.
    if (process.platform === 'win32') {
      return { shell: process.env.COMSPEC || 'cmd.exe', args: ['/c', command] }
    }
    const sh = process.env.SHELL || '/bin/bash'
    return { shell: sh, args: ['-lc', `${command}; exec ${sh}`] }
  }
  if (process.platform === 'win32') {
    return { shell: process.env.COMSPEC || 'powershell.exe', args: [] }
  }
  return { shell: process.env.SHELL || '/bin/bash', args: [] }
}

export function fallbackCwd(cwd: string): string {
  return cwd || process.env.USERPROFILE || os.homedir()
}
