# WorkSpaces — Implementation Plan

A desktop terminal manager. Left sidebar lists workspaces (project folders); the
right pane runs a grid of live terminals per workspace, each able to host an AI
agent (Claude Code, etc.) or a plain shell. Target: pixel-match `mockup.html`,
polished for a non-technical user, Windows-first.

---

## 1. Stack decision

| Concern | Choice | Why |
| --- | --- | --- |
| Shell | **Electron** (not Tauri) | Needs real PTYs. `node-pty` + `xterm.js` is the proven, only-mature path for embedded terminals. Tauri's Rust PTY story is rougher and buys nothing here. |
| Build | **electron-vite** + **electron-builder** | Fast HMR, clean main/preload/renderer split. electron-builder handles Windows NSIS installer + code signing later. |
| UI | **React + TypeScript** | Mockup is component-shaped (workspace list, terminal tiles, arrange menu). TS for IPC safety. |
| Terminal render | **@xterm/xterm** + **@xterm/addon-fit** + **@xterm/addon-webgl** | WebGL renderer for smooth multi-terminal output; fit addon reflows to tile size. |
| PTY | **node-pty** | Uses Windows ConPTY (Win10 1809+) automatically. Native module → must `electron-rebuild`. |
| State/store | **Zustand** + **electron-store** (JSON on disk) | Zustand for UI state; electron-store persists workspaces + layout across restarts. |
| Styling | Plain CSS / CSS Modules, tokens copied from mockup `:root` vars | Mockup already defines the whole design system. No framework needed. |

### Hard requirements pulled from research
- node-pty requires **Electron 19+** and **Windows 10 build 1809+** (ConPTY). winpty is gone.
- node-pty is a **native module** — rebuild against Electron's ABI via `electron-rebuild` (postinstall). Skipping this is the #1 "works locally, breaks packaged" bug.
- xterm addons: `@xterm/addon-fit` ~0.11, `@xterm/addon-webgl` ~0.19.

---

## 2. Process architecture

```
┌─────────────────────────────────────────────────────────┐
│ Main process (Node)                                       │
│  • Window mgmt, app menu                                  │
│  • WorkspaceStore  (electron-store JSON)                  │
│  • PtyManager: spawns node-pty per terminal, owns the     │
│    process table, pipes data <-> renderer over IPC        │
│  • ElevatedPtyBroker: for "admin" terminals (see §6)      │
└───────────────▲───────────────────────┬──────────────────┘
                │ contextBridge IPC       │ pty data/resize
┌───────────────┴───────────────────────▼──────────────────┐
│ Preload (contextIsolation ON, nodeIntegration OFF)         │
│  • Exposes a typed `window.api` surface only               │
└───────────────▲───────────────────────────────────────────┘
                │
┌───────────────┴───────────────────────────────────────────┐
│ Renderer (React)                                           │
│  Sidebar · WorkspaceHeader · ArrangeMenu · TerminalGrid    │
│  Each Terminal tile mounts an xterm.js instance            │
└───────────────────────────────────────────────────────────┘
```

**Security:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
where possible. Renderer never touches node-pty directly — only via IPC channels.
PTY bytes flow main→renderer; keystrokes + resize flow renderer→main.

---

## 3. Data model

```ts
type Workspace = {
  id: string;
  name: string;          // editable inline; defaults to folder basename
  path: string;          // absolute project dir
  color?: string;        // reserved; UI currently monochrome folder icon
  layout: 'auto' | 'single' | 'cols' | 'rows' | 'grid';  // default 'auto'
  terminals: TerminalSpec[];
};

type Settings = {
  autoStartShells: boolean;   // default TRUE — open a plain shell in each
                              // workspace's tiles on launch/first-open
  confirmOnExit: boolean;     // default TRUE — show exit confirmation modal
};

type TerminalSpec = {
  id: string;
  title: string;         // "Claude Code", "Terminal", user-editable
  kind: 'claude' | 'shell' | 'custom';
  command: string;       // e.g. "claude", or "" for default shell
  cwd: string;           // usually workspace.path
  admin: boolean;        // elevated
  // runtime-only (not persisted): pid, status, scrollback
};
```

Persisted to `%APPDATA%/WorkSpaces/config.json`. Terminal *processes* are not
persisted (see §7); their specs are, so tiles can be re-offered on relaunch.

---

## 4. IPC surface (`window.api`)

```
workspaces:list                       -> Workspace[]
workspaces:add(path)                  -> Workspace       // native folder dialog upstream
workspaces:rename(id, name)
workspaces:remove(id)
workspaces:setLayout(id, layout)

pty:create(termSpec)                  -> { id, pid }
pty:input(id, data)                   // keystrokes
pty:resize(id, cols, rows)
pty:kill(id)
pty:onData(id, cb)                    // stream out
pty:onExit(id, cb)
pty:onStatus(id, cb)                  // running | waiting | idle  (see §5)

settings:get()                        -> Settings
settings:set(partial)                 -> Settings

dialog:pickFolder()                   -> path | null
app:requestQuit()                     // triggers exit-confirm flow (§7)
```

---

## 5. Feature mapping (mockup → implementation)

| Mockup element | Implementation |
| --- | --- |
| Sidebar workspace list | React list from `workspaces:list`. Uniform outline folder SVG, dim; active = blue folder + left accent bar. |
| Inline rename (pencil) | contentEditable-style input; Enter commits → `workspaces:rename`. |
| Green "live" dot | Shown when any terminal in that workspace has status `running`. |
| "+ New terminal" (logo-blue) | Opens a small picker: Claude Code / plain shell / custom command. Creates `TerminalSpec`, calls `pty:create`. |
| Terminal tile | xterm.js mounted in a `<div>`; header shows agent glyph, title, status pill, shield + expand + close. |
| Status pill (running/needs you/idle) | Heuristic from PTY output — see below. |
| Arrange menu | Popover with layout options. Default = **Auto** (see below); Single/Cols/Rows/Grid override. |
| Shield / Admin | Toggle elevation; §6. Confirm dialog + red styling + badge. |
| Expand (⤢) | Toggle single-terminal focus (maps to `layout: single` pinned to that tile). |
| **Settings** (new) | Gear icon in sidebar footer opens a settings modal/panel: **Auto-start shells** (default on), **Confirm before quit** (default on). Reads/writes via `settings:*`. Design tokens match mockup. |

**Auto layout rule (default):** balanced near-square grid.
`cols = ceil(sqrt(n))`, `rows = ceil(n / cols)`.

| n | grid |
| --- | --- |
| 1 | 1×1 |
| 2 | 2×1 (side by side) |
| 3–4 | 2×2 (n=3 fills 3 tiles + the "New terminal" tile) |
| 5–6 | 3×2 |
| 7–9 | 3×3 |

Auto re-flows as terminals are added/removed. Picking any explicit layout in the
Arrange menu pins it until the user chooses Auto again. `layout` type gains `'auto'`
(the persisted default).

**Status heuristic (`running` / `needs you` / `idle`):**
- `running`: PTY produced output within last ~1.5s.
- `idle`: no output and shell prompt detected / child exited to shell.
- `needs you` (`waiting`): output stream stalled while last lines match known
  agent prompt patterns (`[y/n]`, `❯`, "Do you want", Claude Code's approval box).
  Start with regex patterns per agent; refine later. This is best-effort UI sugar,
  not correctness-critical.

---

## 6. Admin / elevated terminals (Windows) — the hard part

Research confirms you **cannot** simply `spawn` an elevated child from a
non-elevated Node process and keep a live PTY pipe (UAC blocks it; `runas`
tricks lose the stdio handle). Correct design:

- Build a tiny **elevated PTY broker** helper (a second entry point of the same
  app, or a small bundled exe). When the user elevates a terminal:
  1. Launch the broker via `ShellExecuteEx` with the **`runas`** verb → triggers
     the real Windows UAC prompt (not just our in-app confirm).
  2. Broker hosts that terminal's node-pty **inside the elevated process** and
     talks to the main process over a **named pipe** (auth'd with a random token).
  3. Main process bridges that pipe to the renderer exactly like a local PTY, so
     the UI is identical.
- Elevated terminals stay **visually marked** (red border/badge) the whole time.
- Re-prompt UAC each elevation; never silently persist elevation across restart.

**Phasing:** ship non-admin terminals first (Phase 2). Admin broker is Phase 4 —
it's isolated and the UI already accounts for it.

---

## 7. Persistence & lifecycle
- Persisted to disk: **workspaces** (name, path, layout) + **settings**. That's it.
- **No session restore.** Terminal processes and scrollback are never restored.
  On relaunch a workspace opens fresh:
  - if `autoStartShells` (default **true**) → each workspace opens with a plain
    shell terminal ready to go;
  - else → opens with just the empty "New terminal" tile.
- Switching workspace keeps other workspaces' PTYs **alive in background** so the
  green live dot stays truthful (matches mockup). Cap concurrent PTYs; warn past N.

### Exit flow (confirmation + cleanup)
- On window-close / app-quit, if `confirmOnExit` (default **true**): intercept
  `before-quit` / `window.on('close')`, show a modal — "Quit WorkSpaces? All
  running terminals and agents will be stopped." Buttons: **Quit** / Cancel.
- On confirmed quit:
  1. `PtyManager.killAll()` — kill every node-pty child (and its process tree, so
     agents/subprocesses don't orphan).
  2. Tear down the elevated broker (§6) and its named pipe.
  3. Flush settings/workspaces to disk, remove temp/socket files.
  4. Then allow quit. Nothing is restored next launch.
- Guard against double-modal (quit already in progress).

---

## 8. Build phases

**Phase 0 — Scaffold**
- `electron-vite` React+TS template. Wire `electron-rebuild` postinstall for node-pty. Confirm a single hard-coded PTY renders in xterm.js on Windows.

**Phase 1 — Shell & design system**
- Port mockup markup to React components. Copy CSS tokens. Static sidebar + grid, no live terminals yet. Pixel-match pass against `mockup.html`.

**Phase 2 — Live terminals**
- PtyManager + IPC. Real shells in tiles. Fit + WebGL addons, resize on tile
  resize/layout change. New-terminal picker. Close/kill.

**Phase 3 — Workspaces, persistence, settings, exit**
- Add-workspace folder dialog, inline rename, remove. electron-store persistence.
  Arrange menu wired to real layout (incl. Auto rule). Live/status dots.
- Settings panel (auto-start shells, confirm-on-exit). Auto-start shells on launch.
- Exit-confirmation modal + `killAll()` cleanup (§7).

**Phase 4 — Agents & admin**
- Agent launch presets (Claude Code, custom command). Status heuristic. Elevated
  PTY broker + UAC + red marking.

**Phase 5 — Polish & package**
- Empty states, keyboard shortcuts, error toasts, app icon. electron-builder NSIS
  installer, code signing, auto-update (optional).

---

## 9. Risks / open questions
1. **node-pty native rebuild** on target machines — pin Electron version, ship
   prebuilt or verify installer runs rebuild. Highest-risk item.
2. **Elevation broker** complexity — biggest unknown; prototype early even if
   shipped late.
3. **Layout scaling** — mockup shows fixed 2×2; decide auto-flow rules for 1,3,5,6+ terminals.
4. **Agent detection** — status heuristics are per-agent and brittle; keep them cosmetic.
5. Multi-monitor / DPI scaling for xterm fit — test early.

---

## 10. First concrete steps
1. `npm create electron-vite@latest workspaces -- --template react-ts`
2. Add `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`, `zustand`, `electron-store`.
3. Add `electron-rebuild` postinstall; verify node-pty loads in Electron on Windows.
4. Prove one live shell in one xterm tile end-to-end (renderer ⇄ IPC ⇄ node-pty).
5. Then Phase 1 UI port.
