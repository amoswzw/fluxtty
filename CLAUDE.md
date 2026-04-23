# fluxtty — Codebase Instructions

## What This Is

A multi-session developer workspace terminal for programmers running many concurrent tasks
(multiple `claude` sessions, dev servers, test runners, database shells, etc.).

**Not** a general-purpose terminal. **Not** an AI coding assistant.
The Workspace AI manages the *workspace itself* — session naming, grouping, dispatch.
What runs inside each shell is entirely the programmer's choice.

---

## Core Design Decisions (do not reverse without strong reason)

### 1. Terminal area is primary, everything else is overlay
- Terminals fill 100% of screen by default
- Session Sidebar (Ctrl+B or `b` in Normal mode) is hidden by default
- Input Bar is always visible at the bottom
- When sidebar toggled, it compresses terminal space — never owns it permanently

### 2. Waterfall layout
- Row height adapts: when few rows, divide height equally; when many rows, each row = full viewport height (waterfall paging)
- Threshold: rows below `28px header + 18 lines × font-line-height` collapse into waterfall scroll mode
- Rows stack downward; horizontal splits live within a row
- Row height recalculates on viewport resize and on sidebar toggle

### 3. Session identity is first-class
Every pane has: `name`, `group`, `note`, `status` (idle/running/error), `cwd`
- Default name auto-derived from `cwd` on spawn; updates when `cwd` changes
- On significant commands (claude, vim, psql, etc.) name updates to reflect what's running
- User-renamed panes are pinned and not auto-renamed
- Groups are free-form strings (e.g. `proj-alpha`, `infra`)
- Status drives sidebar indicators and AI context

### 4. Modal Input Bar — the primary interaction surface

The Input Bar sits at the bottom of the screen, always visible.
It operates in four modes modeled after Vim's modal philosophy.

#### Modes

| Mode | Input Bar Shows | Keystrokes Go To |
|---|---|---|
| **Normal** | `NORMAL` indicator, read-only hint | Workspace navigation (hjkl, gg/G, scroll) |
| **Insert** | `INSERT [row/total] [agent]` + pane prompt | Active pane's shell stdin |
| **Terminal** | `TERMINAL [pane-name]` | Active pane's xterm (raw keyboard, xterm owns input) |
| **Pane Search** | `SEARCH /` + query | Search active pane's terminal buffer (xterm SearchAddon) |

#### Mode Transitions

```
Normal  ──i or a──────────────→ Insert (line editor → PTY)
        ──/ or Ctrl+F────────→ Pane Search (in-terminal content find)
        ──: ──────────────────→ Inline command (workspace AI / Workspace commands)
        ──hjkl/arrows─────────→ Navigate rows/panes (no mode change)

Insert  ──Esc─────────────────→ Normal
        ──Ctrl+\──────────────→ Terminal (xterm takes raw keyboard)
        ──Enter───────────────→ Submit line to active PTY
        ──Tab─────────────────→ Shell/agent autocomplete

Terminal ──Ctrl+\─────────────→ Normal
         (all other keys go to xterm; only Ctrl+\ is intercepted)

Pane Search   ──Enter─────────→ commit query → Normal (n/N repeat)
              ──Shift+Enter────→ commit going backward → Normal
              ──Esc────────────→ Normal (clears match decorations)
```

#### Normal Mode Navigation (vi-style)
- `h`/`←` `l`/`→` — focus prev/next pane in current row
- `j`/`↓` `k`/`↑` — focus next/prev row
- `w` / `W` — focus next/prev pane (alias)
- `G` — scroll active pane to bottom
- `gg` (double) — scroll active pane to top
- `Ctrl+D` / `Ctrl+U` — scroll half-page down/up
- `Ctrl+F` / `Ctrl+B` — scroll full page down/up
- `n` — new terminal
- `s` — split current row
- `q` — close active pane
- `b` — toggle sidebar
- `r` — rename active pane
- `m` — open pane note editor

#### Inline Command (`:` in Normal mode)
- Pressing `:` activates a command sub-state in Normal mode
- Input bar prompt changes to `:` — user types a workspace AI command
- `Enter` submits to workspace AI; `Esc` cancels and returns to navigation

#### Insert Mode
- All keystrokes forwarded to the active pane's PTY
- `live_typing: true` in config — each keystroke sent immediately (including backspace, arrows, Ctrl combos)
- `live_typing: false` (default) — buffered mode; Enter submits the whole line
- ArrowUp/Down browse local command history (buffered mode)
- Tab triggers shell completion (file/command) or agent slash-command completion if agent detected
- Ctrl+C sends SIGINT; Ctrl+D sends EOF

#### Pane Search (`/` or `Ctrl+F` / `Cmd+F`)
- `/` in Normal mode — searches content in the **active terminal pane** (xterm buffer, scrollback included)
- `Ctrl+F` / `Cmd+F` — global shortcut, opens search from any mode
- Incremental: typing jumps to the next match as you type
- Enter commits the query and returns to Normal (decorations stay); Shift+Enter commits going backwards
- In Normal mode after a commit: `n` repeats search forward, `N` backward (vim-style). `n` falls back to NewTerminal when no search is pending.
- Esc while in Pane Search clears decorations, drops the query, and returns to Normal
- Esc in Normal mode cancels an active search (clears decorations and drops the saved query so `n`/`N` no longer repeat); if no search is pending, Esc keeps its existing behavior
- Implementation: `@xterm/addon-search` loaded per `TerminalPane`; `InputBar` dispatches `pane-search` events routed by `WaterfallArea`

#### Pane Selector (fuzzy session find)
- The `PaneSelector` overlay still exists (name/group/cwd fuzzy search) but has no keyboard shortcut after `/` was repurposed for in-terminal search. Accessible via sidebar click.

#### Terminal Mode (Ctrl+\)
- xterm.js owns the keyboard completely
- `Ctrl+\` is the only intercepted key (returns to Normal)
- Pane header brightens to indicate terminal mode

#### Agent-aware Insert Mode
- When the active pane is detected as running an AI agent (claude, codex, aider),
  Insert mode shows `INSERT · claude` in the mode indicator
- Tab shows that agent's native slash commands for autocomplete
- Keystrokes still go to PTY as-is — no wrapping

### 5. Workspace AI interaction model

Commands entered via `:` in Normal mode go to the workspace AI.

| Scenario | Behavior |
|---|---|
| `run <cmd> in <session>` | Auto-execute, no confirm |
| `<cmd> in all sessions` | Show plan → y/n confirm → execute |
| `run X then run Y in Z` | Show plan → y/n confirm → execute sequentially |
| `new [name] [in <group>]` | Create new session |
| `rename <session> to <name>` | Rename session |
| `close <session>` / `close idle` | Close session(s) |
| `split` | Split current row |
| `list` / `status` | List all sessions |
| `!agent <claude\|codex\|aider\|none>` | Manually mark active pane's agent type |
| LLM model configured | All natural language input routes through the model |

**The plan-confirm step exists for any action with broad or irreversible scope.**
Single-session, single-command dispatch skips confirmation.

When `workspace_ai.model` is set to a real model name (not `none`), the AI handler
sends workspace context (sessions, status, cwd) plus the user's message to the LLM,
then parses `action` fenced code blocks in the response and executes them.

### 6. Config is YAML, Alacritty-style
Config lives at `~/.config/fluxtty/config.yaml`.
All visual and behavioral properties are configurable.
Hot-reload on file save. Schema is strict with sensible defaults.

---

## Tech Stack

**Runtime:** Tauri (Rust backend) + xterm.js (WebView frontend)

- **Rust backend (src-tauri/):** PTY management, config loading/watching, session state, shell completion, IPC
- **WebView frontend (src/):** xterm.js terminal rendering, layout, input bar UI — vanilla TypeScript
- **xterm.js:** industry-standard terminal emulator (VSCode, Hyper). Handles ANSI, colors, fonts natively.
- No Electron. No heavy JS frameworks. The terminal rendering is xterm.js; UI chrome is minimal TypeScript.

**Key Rust dependencies (`src-tauri/Cargo.toml`):**
```
portable-pty          — cross-platform PTY (macOS/Linux/Windows ConPTY)
serde_yaml            — YAML config parsing
serde / serde_json    — serialization
notify                — file system watcher for config hot-reload
strip-ansi-escapes    — ANSI stripping for disk persistence
tokio                 — async runtime
tauri                 — app framework, WebView, IPC
dirs                  — platform home/config dir resolution
uuid                  — unique IDs
parking_lot           — faster Mutex/RwLock
crossbeam-channel     — multi-producer PTY I/O channels
```

**Key JS dependencies (`package.json`):**
```
@xterm/xterm           — terminal emulator widget
@xterm/addon-fit       — resize PTY to match DOM element
@xterm/addon-web-links — clickable URLs
@xterm/addon-search    — vi-mode search
@tauri-apps/api        — Tauri IPC bindings
```

---

## Project Structure

```
fluxtty/
├── CLAUDE.md
├── plan.md
├── package.json              — frontend build (Vite + TypeScript)
├── docs/                     — GitHub Pages landing site
│   └── index.html
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs           — Tauri app entry, window setup
│       ├── lib.rs            — Tauri plugin registration, state init
│       ├── pty.rs            — PTY lifecycle: spawn, resize, kill, I/O (portable-pty)
│       ├── config.rs         — YAML load/validate/watch, emit config:changed to frontend
│       ├── session.rs        — PaneInfo state, session events, layout management
│       └── ipc.rs            — Tauri commands + events (frontend ↔ backend)
├── src/
│   ├── main.ts               — Entry point
│   ├── app.ts                — Root: layout orchestration, mode manager init, header
│   ├── style.css             — Global CSS (CSS custom properties for theming)
│   ├── waterfall/
│   │   ├── WaterfallArea.ts  — Scrollable container, row height calculation, pane spawn
│   │   └── TerminalPane.ts   — xterm.js instance + pane chrome (header, status, note)
│   ├── sidebar/
│   │   └── SessionSidebar.ts — Grouped session tree, status dots, click-to-navigate
│   ├── input/
│   │   ├── InputBar.ts       — Bottom bar component, mode-aware rendering, all key handling
│   │   ├── ModeManager.ts    — Mode state machine (Normal / Insert / Terminal / Pane-selector)
│   │   ├── PaneSelector.ts   — Fuzzy finder overlay for pane selection
│   │   └── AgentDetector.ts  — Detect agent type from PTY output (claude/codex/aider)
│   ├── ai/
│   │   ├── ai-handler.ts     — Intent parsing, action execution, LLM response parsing
│   │   ├── llm-client.ts     — Multi-provider LLM client (Anthropic/OpenAI/Google/Ollama/claude-cli)
│   │   └── plan-executor.ts  — Multi-step plan confirmation and sequential execution
│   ├── session/
│   │   ├── SessionManager.ts — Source of truth for all PaneInfo, emits change events
│   │   ├── AutoNamer.ts      — Auto-name panes from cwd and significant commands
│   │   └── types.ts          — PaneInfo, SessionStatus, AgentType, InputMode types
│   ├── settings/
│   │   └── SettingsPanel.ts  — In-app settings panel (Ctrl+,), live preview, save to disk
│   ├── config/
│   │   └── ConfigContext.ts  — Config loading, hot-reload listener, CSS var application
│   └── keybindings/
│       └── KeybindingManager.ts — Map config keybindings → actions, dispatch
├── themes/
│   ├── default-dark.yaml
│   ├── catppuccin-mocha.yaml
│   ├── gruvbox-dark.yaml
│   └── solarized-dark.yaml
├── demo/
│   └── fluxtty-demo.gif      — Demo recording
└── prototype/
    └── main.py               — Python/Textual prototype (reference only)
```

**Note:** `TerminalRow.ts` does not exist as a separate file — rows are plain `<div class="terminal-row">` elements managed directly by `WaterfallArea.ts`. `persistence.rs`, `config/schema.ts`, and `config/defaults.ts` from the original plan are not yet implemented.

---

## Key Abstractions

### PaneInfo
```typescript
interface PaneInfo {
  id: number;
  name: string;          // user-given or auto-named from cwd/command
  group: string;         // free-form, e.g. "proj-alpha"
  note: string;          // user annotation shown in pane header
  status: 'idle' | 'running' | 'error';
  cwd: string;
  pty_pid: number;       // PTY process ID
  agent_type: AgentType; // 'none' | 'claude' | 'codex' | 'aider' | 'unknown'
  row_index: number;     // which waterfall row (sparse — do not use as array index)
  pane_index: number;    // position within the row
}

type AgentType = 'none' | 'claude' | 'codex' | 'aider' | 'unknown';
```

### InputMode (state machine)
```typescript
type InputMode =
  | { type: 'normal' }                       // vi normal — navigation + : cmd + / selector
  | { type: 'insert' }                       // i/a: line editor → active pane PTY
  | { type: 'terminal'; paneId: number }     // Ctrl+\: xterm owns raw keyboard
  | { type: 'pane-selector'; query: string }   // fuzzy pane find overlay (no default key)
  | { type: 'pane-search'; paneId: number; query: string }; // /: content search in active pane
```

### AutoNamer
- On pane spawn: name = `basename(cwd)` if still default
- On cwd change (detected via session:changed events): update name if pane is auto-named
- On significant command (claude, vim, psql, ssh, etc.): name = `"dir · command"`
- User-renamed panes (`unmarkAutoNamed`) are never touched again

### LLM Client (multi-provider)
`src/ai/llm-client.ts` supports:
- `anthropic` — Anthropic API (claude-* models)
- `openai` — OpenAI API (gpt-*, o1-*, o3-*, o4-*)
- `google` — Google Gemini API (gemini-*)
- `ollama` — Local Ollama (ollama/* or ollama:* prefix)
- `claude-cli` — Runs `claude -p <prompt>` as a subprocess via Rust IPC

Provider is auto-inferred from the model name when not explicitly set.
API keys are read from env vars via Rust IPC (`get_env_var`) — not accessible to JS directly.

### Shell Completion
`shell_complete` IPC command runs `bash compgen` in the pane's cwd:
- First word: completes commands, aliases, functions
- Subsequent words: completes file/directory paths
- Tab in Insert mode shows a dropdown; second Tab cycles items; longest common prefix is auto-inserted

### TerminalRow
A row is a `<div class="terminal-row">` holding 1–N pane elements.
Row height is computed by `WaterfallArea.recalcRowHeights()`:
- Phase 1 (few rows): `floor((containerH - overhead) / rowCount)` — all rows fit, no scrolling
- Phase 2 (many rows): `threshold = 28 + ceil(18 × font.size × 1.2)` — rows scroll waterfall-style

### Persistence Architecture

**Core principle: PTYs are owned by the Rust backend, not the WebView.**

```
┌─────────────────────────────────────────────────────────┐
│  Rust Backend (src-tauri/)                              │
│                                                         │
│  PtyManager   — PTY processes (portable-pty)            │
│  SessionManager — layout, names, groups, status         │
│  Config        — YAML load + notify watcher             │
└────────────────────┬────────────────────────────────────┘
                     │ Tauri IPC (invoke / events)
          ┌──────────┴───────────┐
          │  WebView (window)    │
          │  xterm.js instances  │
          └──────────────────────┘
```

**Note:** Full tmux-style session persistence (reattach after window close) is not yet implemented. PTYs are currently tied to the window lifecycle.

### WorkspaceAI
Not an LLM by default — regex intent parser + dispatcher. Wired to real model via
`workspace_ai.model` config. Core value is the dispatch model and the modal
input surface, not the intelligence of the parser.

When an LLM model is configured, the AI handler:
1. Builds a system prompt with current session context
2. Sends to the configured LLM provider
3. Parses ` ```action ``` ` JSON blocks from the response
4. Executes single actions immediately; broadcasts/multi-step require confirmation

### Config (YAML schema)
```yaml
# ~/.config/fluxtty/config.yaml

window:
  opacity: 1.0
  padding: { x: 8, y: 6 }
  decorations: full
  startup_mode: windowed

font:
  normal:  { family: "JetBrains Mono", style: Regular }
  bold:    { family: "JetBrains Mono", style: Bold }
  italic:  { family: "JetBrains Mono", style: Italic }
  size: 13.0
  builtin_box_drawing: true

colors:
  primary:
    background: "#0d1117"
    foreground: "#e6edf3"
  cursor:
    text:   "#0d1117"
    cursor: "#e6edf3"
  normal:
    black:   "#484f58"
    red:     "#ff7b72"
    green:   "#3fb950"
    yellow:  "#d29922"
    blue:    "#388bfd"
    magenta: "#bc8cff"
    cyan:    "#39c5cf"
    white:   "#b1bac4"
  bright:
    black:   "#6e7681"
    red:     "#ffa198"
    green:   "#56d364"
    yellow:  "#e3b341"
    blue:    "#79c0ff"
    magenta: "#d2a8ff"
    cyan:    "#56d4dd"
    white:   "#f0f6fc"

cursor:
  style: Block
  blinking: true
  blink_interval: 750

scrolling:
  history: 10000
  multiplier: 3

shell:
  program: /bin/zsh
  args: []

input:
  live_typing: false      # true: each keystroke forwarded immediately (no buffering)

keybindings:
  - { key: N,         mods: Control,       action: NewTerminal }
  - { key: H,         mods: Control,       action: SplitHorizontal }
  - { key: B,         mods: Control,       action: ToggleSidebar }
  - { key: Up,        mods: Control,       action: FocusPrevRow }
  - { key: Down,      mods: Control,       action: FocusNextRow }
  - { key: Tab,       mods: Control,       action: FocusNextPane }
  - { key: R,         mods: Control,       action: RenameCurrentSession }
  - { key: G,         mods: Control,       action: GroupCurrentSession }
  - { key: Return,    mods: Control|Shift, action: NewTerminalInGroup }
  - { key: Q,         mods: Control,       action: Quit }
  - { key: C,         mods: Control|Shift, action: Copy }
  - { key: V,         mods: Control|Shift, action: Paste }
  - { key: Plus,      mods: Control,       action: IncreaseFontSize }
  - { key: Minus,     mods: Control,       action: DecreaseFontSize }
  - { key: Key0,      mods: Control,       action: ResetFontSize }
  - { key: Comma,     mods: Control,       action: OpenSettings }

workspace_ai:
  always_confirm_broadcast: true
  always_confirm_multi_step: true
  model: none                          # none | claude-sonnet-4-6 | gpt-4o | gemini-2.0-flash | ollama/llama3 | claude-cli
  provider: null                       # auto-inferred from model if null
  api_key_env: ANTHROPIC_API_KEY       # env var name; key read by Rust, never exposed to JS
  base_url: null                       # override for Ollama or OpenAI-compatible endpoints

waterfall:
  row_height_mode: viewport            # viewport | fixed
  fixed_row_height: 40                 # used only when row_height_mode: fixed (in rem)
  scroll_snap: false
  new_pane_focus: true

persistence:
  keep_alive: true
  scrollback_lines: 5000

session_defaults:
  group: default
  shell: null                          # null = use shell.program
```

---

## Agent Detection

`AgentDetector` watches PTY output for patterns to classify what agent (if any) is running.

| Agent | Detection heuristics |
|---|---|
| `claude` | Prompt patterns: `Claude ❯`, `Human:`, tool-use JSON blocks |
| `codex` | Prompt patterns: `codex>`, `/diff` output format |
| `aider` | `aider>` prompt, diff output |
| `unknown` | User can manually mark via `!agent` command |

When `agent_type != 'none'`, Insert mode shows agent name in the mode indicator
and Tab autocompletes that agent's known slash commands.

---

## What NOT to Do

- **Do not** make the Workspace AI a coding assistant. It manages sessions.
- **Do not** auto-submit to AI agent sessions. Always route via Insert mode (raw stdin, user-controlled).
- **Do not** add a persistent AI panel that takes vertical space. The Input Bar is the only persistent UI at the bottom.
- **Do not** couple xterm.js rendering logic with session management. Keep them separate via SessionManager events.
- **Do not** store config in Tauri's store or localStorage. Config lives in `~/.config/fluxtty/config.yaml` only.
- **Do not** skip the plan-confirm step for broadcast or multi-step dispatch.
- **Do not** hardcode colors, font sizes, or keybindings anywhere in source. Always read from config.
- **Do not** reuse the Python/Textual prototype code in production. It is reference only.
- **Do not** intercept or wrap agent input/output. Insert mode sends raw bytes; the agent sees exactly what the user typed.
- **Do not** use `row_index` from `PaneInfo` as a direct array index — it is sparse. Use `sessionManager.getPanesByRow()` which returns a compacted array.
