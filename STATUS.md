# Build Status

All phases of `PLAN.md` (0–5) are now implemented. The app compiles, typechecks,
boots, the elevation broker protocol passes an end-to-end test, and the NSIS
installer builds.

## How to run

```bash
npm install        # runs postinstall -> patches + rebuilds node-pty
npm run dev        # dev with HMR
npm run build && npm run start   # production preview
npm run typecheck  # tsc on main + renderer
npm run dist       # NSIS installer -> dist/ (electron-builder)
```

If `npm install` ever fails on node-pty, run `npm run rebuild` (it re-patches and
rebuilds against Electron). See "Environment gotchas" below.

## What works (verified by build + typecheck + boot smoke test)

- **Electron + Vite + React + TS** three-process app (main / preload / renderer),
  `contextIsolation` on, `nodeIntegration` off. Typed IPC via `window.api`.
- **Live terminals**: node-pty (ConPTY) per tile, xterm.js with fit + WebGL addons.
  Keystrokes, output streaming, resize-on-tile-resize all wired.
- **Sidebar workspaces**: folder icon, active accent bar, inline rename, remove
  (✕ on hover, confirm, kills its terminals), green live dot.
- **Add workspace**: native folder picker → basename becomes the name.
- **New terminal** menu: Claude Code preset (`claude`) or plain shell.
- **Terminal titles**: double-click the tile title to rename (runtime-only).
- **Arrange menu**: Auto / Single / Side by side / Grid. Auto = balanced
  near-square grid. Layout persists per workspace. **Single layout keeps all
  tiles mounted** (hidden via CSS) so scrollback survives expand/collapse.
- **Admin / elevated terminals (Phase 4, real)**: shield toggle restarts the
  terminal through an **elevated PTY broker** — a second instance of the app
  launched with the `runas` verb (real Windows UAC prompt) that hosts the
  node-pty and bridges it over a token-authenticated named pipe
  (`src/main/broker.ts` broker side, `src/main/elevated.ts` main side,
  `--pty-broker` flag in `src/main/index.ts`). One broker process per
  elevation; UAC re-prompts every time; red border/badge while elevated.
  UAC decline / timeout surfaces as a toast + message in the tile.
  Protocol verified end-to-end by a pipe-driven test (spawn → echo → kill).
- **Keyboard shortcuts**: Ctrl+Shift+T new shell, Ctrl+Shift+W close focused
  terminal, Ctrl+, settings.
- **Error toasts**: bottom-right, used for PTY spawn/elevation failures.
- **Settings modal**: Auto-start shells (default ON), Confirm before quit
  (default ON). Persisted to `%APPDATA%/WorkSpaces/config.json`.
- **Exit flow**: native confirm dialog when quitting with live terminals; on
  confirm, `PtyManager.killAll()` (elevated brokers exit when their pipe closes).
- **Persistence**: workspaces + settings only (no session restore, by design).
- Terminals stay **alive in the background** when you switch workspaces.
- **Packaging (Phase 5)**: `electron-builder.yml` (NSIS, `npmRebuild: false` so
  the patched node-pty build isn't clobbered, node-pty asarUnpacked).
  `npm run dist` produces `dist/WorkSpaces Setup 0.0.1.exe`.

## Not done / known gaps

- **No custom app icon** — installer/exe use the default Electron icon. Drop a
  256px `build/icon.ico` and electron-builder picks it up.
- **No code signing / auto-update.**
- **Status heuristic** is basic (output-timing + a few prompt regexes). Cosmetic.
- No automated UI tests; the broker protocol test lives in the session
  scratchpad only (rerunnable: drives `--pty-broker` over a named pipe).
- **Elevation needs one manual QA pass**: click the shield, accept UAC, run
  `net session` (should succeed) — the UAC accept path can't be automated.
- **Installer needs one manual QA pass** on a machine without the dev toolchain.

## Environment gotchas (already handled, documented so they don't bite again)

1. **node-pty native build on Windows** needed three workarounds, all applied by
   `scripts/rebuild-pty.mjs` (wired as `postinstall` + `npm run rebuild`):
   - `NoDefaultCurrentDirectoryInExePath=1` was set in the shell, which breaks
     winpty's `cd shared && Foo.bat` gyp actions. The script clears it for the rebuild.
   - winpty's git-hash batch is replaced with a literal (`WINPTY_COMMIT_HASH=none`).
   - `SpectreMitigation` disabled (VS Build Tools lacked the Spectre CRT).
   These edit files under `node_modules/`, so the script re-applies them idempotently.
2. **Version pins**: `electron-vite@5` caps Vite at 7, so `vite@^7` +
   `@vitejs/plugin-react@^5` (plugin-react 6 requires Vite 8). Don't bump blindly.
3. Electron's binary download didn't run during install once; if `npm run start`
   says "Electron uninstall", run `node node_modules/electron/install.js`.
4. `electron-builder` must run with `npmRebuild: false` (set in
   `electron-builder.yml`) or it re-runs a stock rebuild and undoes the patches
   from gotcha #1.

## File map

```
src/main/        index.ts (lifecycle+exit+broker branch), pty-manager.ts,
                 broker.ts (elevated side), elevated.ts (UAC launch + pipe host),
                 spawn.ts (shared shell resolution), store.ts, ipc.ts
src/preload/     index.ts (window.api bridge), index.d.ts
src/renderer/    index.html, src/App.tsx, src/components/*, src/lib/layout.ts
src/shared/      types.ts (shared across processes)
scripts/         rebuild-pty.mjs (node-pty build fixups)
electron-builder.yml  NSIS packaging config
```
