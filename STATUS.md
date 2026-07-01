# Build Status — overnight session

Built the real Electron app matching `mockup.html`. Phases 0–3 of `PLAN.md` are
done and the app compiles, typechecks, and boots. Phase 4 (agents) is partially
done; the admin/elevation broker is intentionally stubbed.

## How to run

```bash
npm install        # runs postinstall -> patches + rebuilds node-pty
npm run dev        # dev with HMR
# or
npm run build && npm run start   # production preview
npm run typecheck  # tsc on main + renderer
```

If `npm install` ever fails on node-pty, run `npm run rebuild` (it re-patches and
rebuilds against Electron). See "Environment gotchas" below.

## What works (verified by build + typecheck + boot smoke test)

- **Electron + Vite + React + TS** three-process app (main / preload / renderer),
  `contextIsolation` on, `nodeIntegration` off. Typed IPC via `window.api`.
- **Live terminals**: node-pty (ConPTY) per tile, xterm.js with fit + WebGL addons.
  Keystrokes, output streaming, resize-on-tile-resize all wired.
- **Sidebar workspaces**: uniform folder icon, active accent bar, inline rename,
  green live dot when a workspace has a running/waiting agent.
- **Add workspace**: native folder picker → basename becomes the name.
- **New terminal** menu: Claude Code preset (`claude`) or plain shell.
- **Arrange menu**: Auto / Single / Side by side / Grid. Auto = balanced
  near-square grid (`cols=ceil(sqrt n)`). Layout persists per workspace.
- **Settings modal** (gear, sidebar footer): Auto-start shells (default ON),
  Confirm before quit (default ON). Persisted to `%APPDATA%/WorkSpaces/config.json`.
- **Exit flow**: native confirm dialog when quitting with live terminals; on
  confirm, `PtyManager.killAll()` then quit. Nothing restored on relaunch.
- **Persistence**: workspaces + settings only (no session restore, by design).
- Terminals stay **alive in the background** when you switch workspaces (all grids
  stay mounted, hidden via CSS) so scrollback and the live dot are truthful.

## Not done / stubbed

- **Admin / elevated terminals (Phase 4 broker)**: the shield toggle + red marker
  work visually and show the confirm dialog, but it does **not** actually elevate
  the process yet. Real elevation needs the separate UAC broker over a named pipe
  described in `PLAN.md §6`. This is the biggest remaining piece.
- **Status heuristic** is basic (output-timing + a few prompt regexes). Cosmetic.
- **Single-layout expand** unmounts sibling tiles (loses their xterm scrollback,
  though the PTY keeps running). Minor; revisit if it annoys.
- **Packaging** (electron-builder NSIS installer, icon, signing) — Phase 5, not started.
- No automated tests yet.

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

## Suggested next steps

1. You: run `npm run dev`, eyeball it against `mockup.html`, note visual deltas.
2. Implement the elevation broker (Phase 4) — the one genuinely hard piece.
3. Add close/rename affordances for terminals + terminal titles editing.
4. Phase 5 packaging when you want a distributable.

## File map

```
src/main/        index.ts (lifecycle+exit), pty-manager.ts, store.ts, ipc.ts
src/preload/     index.ts (window.api bridge), index.d.ts
src/renderer/    index.html, src/App.tsx, src/components/*, src/lib/layout.ts
src/shared/      types.ts (shared across processes)
scripts/         rebuild-pty.mjs (node-pty build fixups)
```
