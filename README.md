# fluxtty

vim, but for AI development.

A modal terminal workspace for developers running many concurrent AI agent sessions. Navigate panes with `hjkl`, send commands in Insert mode, chat with your workspace AI in AI mode — all without touching the mouse.

![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-2.x-orange)
![Rust](https://img.shields.io/badge/Rust-1.77%2B-orange)

**[Live demo and landing page →](https://wangzewang.github.io/fluxtty/)**

---

## Why

Modern AI-assisted development looks different from traditional coding. You are no longer just in one editor. You have multiple `claude` sessions running in parallel, each working on a different part of the codebase. You have dev servers, test runners, database shells, and CI watchers all running at once. Your job is to supervise them — review outputs, redirect agents, intervene when things go wrong, and dispatch new instructions.

The usual terminal workflow breaks down here. Alt-tabbing between windows is disorienting at scale. tmux panes get too small to be useful. The mouse is slow.

fluxtty applies vim's modal philosophy to this problem. You have a persistent view of all your terminals, and a modal input bar that knows the difference between "I want to type into a shell" (`i`), "I want to talk to my workspace AI" (`a`), and "I want to navigate" (Normal mode with `hjkl`). One window. Keyboard-first. Designed for the way AI development actually works.

---

## What it is

fluxtty is not a general-purpose terminal emulator. It is a workspace — designed specifically for developers running many shells simultaneously who need to navigate across them, dispatch commands, and observe output without constantly mousing around.

The layout is a **waterfall**: terminal rows stack vertically and fill the viewport, horizontal splits live within a row, and a modal input bar at the bottom handles navigation, shell input, and workspace AI commands.

---

## Features

### Waterfall layout

- Terminal rows stack vertically; each row fills the viewport height
- Horizontal splits (multiple panes) live within a row
- New terminals spawn immediately after the active row, not at the end
- Row heights recalculate on resize and sidebar toggle — always fills the screen

### Modal input bar

The input bar sits at the bottom of the screen, always visible. It has five modes:

| Mode | Indicator | What keystrokes do |
|---|---|---|
| **Normal** | `NORMAL` | Navigate panes (hjkl / arrows), open commands |
| **Insert** | `[pane-name] ❯` | Send to the active pane's shell |
| **AI** | `AI ❯` | Free-form chat with the Workspace AI |
| **Terminal** | `[pane-name] ❯` | Raw PTY input — for TUI apps (vim, htop, etc.) |
| **Pane Selector** | `/` | Fuzzy-search over all open panes |

**The vim analogy:**

| vim | fluxtty |
|---|---|
| Normal mode — navigate, don't type | Normal mode — navigate panes, run workspace commands |
| Insert mode — type into the buffer | Insert mode — type into the active shell |
| Command mode (`:`) — editor commands | AI mode — direct the Workspace AI |
| Visual mode — select text | Pane Selector — select which terminal to focus |

**Mode transitions:**
- `i` in Normal — enter Insert mode (type a command, `Enter` to send to shell)
- `a` in Normal — enter AI mode (chat with Workspace AI, `Enter` to submit)
- `Escape` in Insert or AI — return to Normal
- `Ctrl+\` — toggle between Normal and Terminal (raw PTY for TUI apps)
- `/` in Normal — open Pane Selector
- Clicking a pane — enters Terminal mode on that pane
- TUI apps (vim, htop, lazygit, etc.) are detected automatically via alternate screen sequences (`\x1b[?1049h`) and switch to Terminal mode; returning to the shell switches back to Insert

**Insert mode** has two sub-modes, controlled by `input.live_typing` in config:
- `live_typing: false` (default) — buffered: type a full command, `Enter` to send
- `live_typing: true` — every keystroke forwarded to the PTY immediately, including arrows, Tab, `Ctrl+C/D`

### Session identity

Every pane carries:
- **Name** — auto-derived from cwd on creation, updated when a significant command runs (see Auto-naming)
- **Group** — free-form string (e.g. `frontend`, `infra`), shown in the sidebar
- **Status** — `idle` / `running` / `error`, shown as a live dot in the header and sidebar
- **Note** — inline freeform annotation, opened with `m` and stored per-pane

### Auto-naming

Panes are named automatically and updated as you work. On creation the name comes from the current working directory. When you run a command, the name updates to reflect what's running — examples:

| Command | Name |
|---|---|
| `cd ~/projects/api` | `api` |
| `vim src/main.ts` | `main` |
| `npm run dev` | `dev` |
| `cargo test` | `cargo test` |
| `psql mydb` | `postgres` |
| `ssh user@prod` | `ssh: prod` |
| `claude` | `claude` |

Rules cover editors, AI agents, package managers (npm/yarn/pnpm/bun/cargo/gradle/mvn), databases, Docker/Kubernetes, and more. Once a user renames a pane manually, auto-naming stops for that pane.

### Workspace AI

Press `a` in Normal mode to enter AI mode. Type naturally; `Enter` submits to the Workspace AI. If `workspace_ai.model` is set, input is sent to an LLM; otherwise a built-in regex intent parser handles structured commands.

**Supported providers** (inferred from model name, or set explicitly via `workspace_ai.provider`):

| Model prefix | Provider |
|---|---|
| `claude-*` | Anthropic API |
| `gpt-*`, `o1-*`, `o3-*`, `o4-*` | OpenAI API |
| `gemini-*` | Google Gemini API |
| `ollama/*` | Ollama (local, default `http://localhost:11434`) |
| `claude-cli` | `claude -p` subprocess |
| `none` | Built-in regex parser only |

Built-in commands (available without a model):

```
run <cmd> in <session>
<cmd> in all sessions
run X then run Y in <session>
new [name] [in <group>]
rename <session> to <name>
close <session> | close idle
split
list | status
!agent <claude|codex|aider|none>
```

Multi-step and broadcast actions always show a plan preview and wait for `y` before executing.

### Agent detection

`AgentDetector` watches PTY output for signatures and classifies panes automatically:

| Agent | Detection signals |
|---|---|
| `claude` | Box-drawing UI (`╭─╮`), `✻ Welcome to Claude`, `esc to interrupt` |
| `codex` | `codex>` prompt, `[codex]` markers |
| `aider` | `aider>` prompt, version string |

When an agent is detected, the input bar shows that agent's native slash command completions (Tab to cycle). Detection clears when a plain shell prompt reappears. You can also set an agent manually with `!agent <type>`.

### Session sidebar

`Ctrl+B` opens a grouped session tree. Each entry shows the status dot, pane name, and agent badge. Clicking a pane scrolls the waterfall to it and makes it active.

### Settings

`Ctrl+,` opens a settings panel with five tabs:

- **General** — window padding, decorations, startup mode, input behaviour (`live_typing`)
- **Appearance** — color palette (live preview), font family/size/style, cursor style/blink
- **Terminal** — scrollback history, scroll multiplier, shell program and args
- **Keybindings** — table of all bindings, editable in-place, add/remove rows
- **AI** — provider, model, API key env var, base URL, confirmation behaviour

Changes are written to `~/.config/fluxtty/config.yaml` and applied live without restart.

---

## Installation

### Prerequisites

- [Rust](https://rustup.rs/) 1.77+
- [Node.js](https://nodejs.org/) 18+
- [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/) for your platform (WebKit on Linux, Xcode CLI on macOS)

### Build from source

```bash
git clone https://github.com/your-org/fluxtty
cd fluxtty
npm install
npm run tauri build
```

Built app is in `src-tauri/target/release/bundle/`.

### Development

```bash
npm run tauri dev
```

---

## Configuration

Config file: `~/.config/fluxtty/config.yaml`. Hot-reloaded on save.

```yaml
window:
  padding: { x: 8, y: 6 }
  decorations: full           # full | none | transparent | buttonless
  startup_mode: windowed      # windowed | maximized | fullscreen

font:
  normal: { family: "JetBrains Mono", style: Regular }
  bold:   { family: "JetBrains Mono", style: Bold }
  size: 13.0

colors:
  primary:
    background: "#0d1117"
    foreground: "#e6edf3"
  cursor:
    text:   "#0d1117"
    cursor: "#e6edf3"
  normal:
    black: "#484f58"  red: "#ff7b72"  green: "#3fb950"  yellow: "#d29922"
    blue:  "#388bfd"  magenta: "#bc8cff"  cyan: "#39c5cf"  white: "#b1bac4"
  # theme: catppuccin-mocha | gruvbox-dark | solarized-dark

cursor:
  style: Block      # Block | Underline | Bar
  blinking: true

scrolling:
  history: 10000
  multiplier: 3

shell:
  program: /bin/zsh
  args: []

input:
  live_typing: false   # true = every keystroke forwarded immediately

workspace_ai:
  model: none          # none | claude-sonnet-4-6 | gpt-4o | gemini-2.0-flash | ollama/llama3 | claude-cli
  api_key_env: ANTHROPIC_API_KEY
  base_url: null       # override for Ollama or OpenAI-compatible endpoints
  always_confirm_broadcast: true
  always_confirm_multi_step: true

waterfall:
  row_height_mode: viewport   # viewport | fixed
  fixed_row_height: 40        # rem units, only used when mode is fixed
  new_pane_focus: true

persistence:
  keep_alive: true
  scrollback_lines: 5000
  save_scrollback_on_exit: true
```

---

## Keybindings

### Global

| Key | Action |
|---|---|
| `Ctrl+\` | Toggle Normal ↔ Terminal (raw xterm) |
| `Ctrl+N` | New terminal (inserts after active row) |
| `Ctrl+H` | Split current row horizontally |
| `Ctrl+W` | Close active pane |
| `Ctrl+B` | Toggle session sidebar |
| `Ctrl+R` | Rename current session |
| `Ctrl+G` | Set session group |
| `Ctrl+,` | Open settings |
| `Ctrl+↑` / `Ctrl+↓` | Focus previous / next row |
| `Ctrl+Tab` | Focus next pane in row |
| `Ctrl+Shift+C` | Copy selection |
| `Ctrl+Shift+V` | Paste |
| `Ctrl++` / `Ctrl+-` | Increase / decrease font size |
| `Ctrl+0` | Reset font size |
| `Ctrl+Q` | Quit |

### Normal mode

| Key | Action |
|---|---|
| `i` | Enter Insert mode (type to shell) |
| `a` | Enter AI mode (chat with Workspace AI) |
| `h` / `←` | Focus previous pane in row |
| `j` / `↓` | Focus next row |
| `k` / `↑` | Focus previous row |
| `l` / `→` | Focus next pane in row |
| `w` / `W` | Focus next / previous pane |
| `n` | New terminal |
| `s` | Split current row |
| `q` | Close active pane |
| `r` | Rename current session |
| `b` | Toggle sidebar |
| `m` | Open / edit pane note |
| `:` | Workspace command prompt |
| `/` | Open pane selector (fuzzy search) |
| `G` | Scroll active pane to bottom |
| `gg` | Scroll active pane to top |
| `Ctrl+D` / `Ctrl+U` | Scroll half page down / up |
| `Ctrl+F` / `Ctrl+B` | Scroll full page down / up |

### Insert mode

| Key | Action |
|---|---|
| `Escape` | Return to Normal mode |
| `Enter` | Send command to shell |
| `↑` / `↓` | Navigate command history |
| `Tab` | Agent slash completions or shell completion |
| `Ctrl+C` | Send SIGINT |
| `Ctrl+D` | Send EOF |

### AI mode

| Key | Action |
|---|---|
| `Escape` | Return to Normal mode |
| `Enter` | Submit to Workspace AI |
| `↑` / `↓` | Navigate AI command history |
| `Tab` | Cycle built-in command completions |

---

## Tech stack

| Layer | Technology |
|---|---|
| App framework | [Tauri 2](https://tauri.app/) |
| Terminal emulator | [xterm.js 5](https://xtermjs.org/) (`@xterm/xterm`, `addon-fit`, `addon-web-links`, `addon-search`) |
| PTY management | [portable-pty](https://github.com/wez/wezterm/tree/main/pty) |
| Config | YAML via `serde_yaml`, file watching via `notify` |
| Frontend | Vanilla TypeScript + Vite — no UI framework |
| Backend | Rust + Tokio |

---

## Project structure

```
fluxtty/
├── src/                        # Frontend (TypeScript)
│   ├── app.ts                  # Root layout, init sequence
│   ├── waterfall/
│   │   ├── WaterfallArea.ts    # Row layout, height calculation, pane container
│   │   └── TerminalPane.ts     # xterm.js instance, pane header, note strip
│   ├── input/
│   │   ├── InputBar.ts         # Modal input bar: all five modes
│   │   ├── ModeManager.ts      # Mode state machine
│   │   ├── PaneSelector.ts     # Fuzzy pane search overlay
│   │   └── AgentDetector.ts    # PTY output → agent type classification
│   ├── sidebar/
│   │   └── SessionSidebar.ts   # Grouped session tree
│   ├── session/
│   │   ├── SessionManager.ts   # Pane state, change events
│   │   ├── AutoNamer.ts        # cwd + command → pane name rules
│   │   └── types.ts            # PaneInfo, InputMode, AgentType
│   ├── ai/
│   │   ├── ai-handler.ts       # Workspace command dispatch (LLM + regex)
│   │   ├── llm-client.ts       # Anthropic / OpenAI / Google / Ollama / claude-cli
│   │   └── plan-executor.ts    # Multi-step plan confirmation + execution
│   ├── config/
│   │   └── ConfigContext.ts    # Config load, hot-reload, xterm theme derivation
│   ├── keybindings/
│   │   └── KeybindingManager.ts
│   └── settings/
│       └── SettingsPanel.ts    # 5-tab settings UI
├── src-tauri/
│   └── src/
│       ├── pty.rs              # PTY spawn, resize, kill, I/O forwarding
│       ├── session.rs          # PaneInfo state, layout
│       ├── config.rs           # YAML load, validation, file watcher
│       ├── persistence.rs      # Workspace snapshots, scrollback
│       └── ipc.rs              # Tauri commands and events
└── CLAUDE.md                   # Architecture decisions and constraints
```

---

## Contributing

Read `CLAUDE.md` before opening a pull request. It documents the core design decisions — the layout model, modal input system, and the scope of the Workspace AI — that should be understood before making significant changes.

---

## License

MIT
