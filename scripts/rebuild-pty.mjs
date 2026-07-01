// Makes node-pty buildable on this Windows setup, then rebuilds it against
// Electron's ABI. Idempotent — safe to run repeatedly (e.g. as postinstall).
//
// Two environment-specific problems it works around:
//   1. winpty.gyp calls batch files via `cd shared && Foo.bat`, which fails when
//      NoDefaultCurrentDirectoryInExePath=1 (set in some shells). We both strip
//      the git-hash batch call and clear that env var for the rebuild.
//   2. node-pty forces SpectreMitigation=Spectre; the installed VS Build Tools
//      lack the Spectre-mitigated CRT, so we disable it (fine for a dev build).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const patches = [
  {
    file: 'node_modules/node-pty/binding.gyp',
    edits: [["'SpectreMitigation': 'Spectre'", "'SpectreMitigation': 'false'"]]
  },
  {
    file: 'node_modules/node-pty/deps/winpty/src/winpty.gyp',
    edits: [
      ["'SpectreMitigation': 'Spectre'", "'SpectreMitigation': 'false'"],
      [`'WINPTY_COMMIT_HASH%': '<!(cmd /c "cd shared && GetCommitHash.bat")'`, "'WINPTY_COMMIT_HASH%': 'none'"]
    ]
  }
]

for (const { file, edits } of patches) {
  if (!existsSync(file)) {
    console.warn(`skip: ${file} not found`)
    continue
  }
  let src = readFileSync(file, 'utf8')
  for (const [from, to] of edits) {
    if (src.includes(from)) src = src.split(from).join(to)
  }
  writeFileSync(file, src)
  console.log(`patched: ${file}`)
}

// Rebuild with the offending env var removed so batch actions resolve.
const env = { ...process.env }
delete env.NoDefaultCurrentDirectoryInExePath

const bin = process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild'
const res = spawnSync(bin, ['-f', '-w', 'node-pty'], {
  stdio: 'inherit',
  env,
  shell: true
})
process.exit(res.status ?? 1)
