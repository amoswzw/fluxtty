# fluxtty

<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" height="128" alt="fluxtty" />
</p>

<p align="center">
  <strong>A vim-modal terminal for AI development.</strong>
</p>

<p align="center">
  A keyboard-driven terminal workspace with vim-modal input — built for developers supervising many concurrent AI agents.<br />
  Navigate panes with <code>hjkl</code>, send commands in Insert mode, dispatch to your workspace AI — all without touching the mouse.
</p>

<p align="center">
  <a href="https://github.com/wangzewang/fluxtty/actions/workflows/ci.yml"><img src="https://github.com/wangzewang/fluxtty/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/wangzewang/fluxtty/actions/workflows/codeql.yml"><img src="https://github.com/wangzewang/fluxtty/actions/workflows/codeql.yml/badge.svg" alt="CodeQL" /></a>
  <a href="https://github.com/wangzewang/fluxtty/releases"><img src="https://img.shields.io/github/v/release/wangzewang/fluxtty" alt="Release" /></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="Platform" />
  <img src="https://img.shields.io/badge/Tauri-2.x-orange" alt="Tauri" />
  <img src="https://img.shields.io/badge/Rust-1.77%2B-orange" alt="Rust" />
</p>

<p align="center">
  <a href="https://wangzewang.github.io/fluxtty/"><strong>Live demo and landing page →</strong></a>
</p>

<video src="https://github.com/user-attachments/assets/6b9ba19d-14c2-43d3-8e6a-6d3353674bb6" controls autoplay loop muted width="100%"></video>

---

## Table of Contents

- [Installation](#installation)
- [The Problem](#the-problem)
- [Features](#features)
- [Configuration](#configuration)
- [Keybindings](#keybindings)
- [Contributing](#contributing)

---

## Installation

### Homebrew (macOS)

```bash
brew tap wangzewang/tap
brew install --cask fluxtty
```

### Download

**[→ Download latest release](https://github.com/wangzewang/fluxtty/releases/latest)**

| Platform | File |
|---|---|
| 🍎 macOS (Apple Silicon) | `fluxtty_*_aarch64.dmg` |
| 🍎 macOS (Intel) | `fluxtty_*_x64.dmg` |
| 🐧 Linux | `fluxtty_*_amd64.deb` · `.rpm` · `.AppImage` |
| 🪟 Windows | `fluxtty_*_x64-setup.exe` |

### Build from source

**Prerequisites:** [Rust](https://rustup.rs/) 1.77+, [Node.js](https://nodejs.org/) 18+, [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/)

```bash
git clone https://github.com/wangzewang/fluxtty
cd fluxtty
npm install
npm run tauri build
```

Built app is in `src-tauri/target/release/bundle/`.

```bash
npm run tauri dev   # development
```

---

## The Problem

Modern AI-assisted development looks different from traditional coding. You have multiple `claude` sessions running in parallel, dev servers, test runners, database shells, and CI watchers all running at once. Your job is to supervise them — review outputs, redirect agents, intervene when things go wrong.

The usual terminal workflow breaks down here. Alt-tabbing between windows is disorienting at scale. tmux panes get too small to be useful. The mouse is slow.

fluxtty applies vim's modal philosophy to this problem: a persistent view of all your terminals, and a modal input bar that knows the difference between navigating (`hjkl`), typing into a shell (`i`), and talking to your workspace AI (`a`). One window. Keyboard-first.

---

## Features

### 🗂️ Waterfall layout

Terminal rows stack vertically; each row fills the viewport. Horizontal splits live within a row. Row heights recalculate on resize and sidebar toggle — always fills the screen.

### ⌨️ Modal input bar

The input bar sits at the bottom, always visible. Four modes modeled after vim:

| Mode | Key | What keystrokes do |
|---|---|---|
| **Normal** | default | Navigate panes with `hjkl`, scroll output, open commands |
| **Insert** | `i` | Send keystrokes directly to the active shell |
| **AI** | `a` | Dispatch to the Workspace AI in natural language |
| **Terminal** | `Ctrl+\` | Raw PTY — xterm owns the keyboard (TUI apps, vim, etc.) |
| **Pane Selector** | `/` | Fuzzy-search over all open panes |

### ✨ Workspace AI

Press `a` to enter AI mode. Supports Claude, GPT, Gemini, Ollama, or a built-in regex parser with no model at all.

```
run <cmd> in <session>        new [name] [in <group>]
<cmd> in all sessions         rename <session> to <name>
run X then Y in <session>     close <session> | close idle
```

Multi-step and broadcast actions show a plan preview and wait for `y` before executing.

### 👁️ Agent detection & auto-naming

Panes detect running agents (`claude`, `codex`, `aider`) from PTY output and show an agent badge. Tab in Insert mode completes that agent's slash commands.

Pane names auto-update from `cwd` on spawn, then change to reflect what's running — `claude`, `cargo test`, `psql`, `ssh: prod`. Manual renames are pinned.

### 🗃️ Session sidebar

`Ctrl+B` opens a grouped session tree with running/idle/error indicators. Click to jump to any pane.

### ⚙️ Settings & config

`Ctrl+,` opens a settings panel (font, colors, keybindings, AI provider, terminal behaviour). All settings live in `~/.config/fluxtty/config.yaml` and hot-reload on save — no restart needed.

---

## Configuration

```yaml
# ~/.config/fluxtty/config.yaml

font:
  family: "JetBrains Mono"
  size: 13.0

colors:
  primary:
    background: "#0d1117"
    foreground: "#e6edf3"
  normal:
    black: "#484f58"  red: "#ff7b72"  green: "#3fb950"  yellow: "#d29922"
    blue:  "#388bfd"  magenta: "#bc8cff"  cyan: "#39c5cf"  white: "#b1bac4"
  # theme: catppuccin-mocha | gruvbox-dark | solarized-dark

cursor:
  style: Block      # Block | Underline | Bar
  blinking: true

input:
  live_typing: false   # true: each keystroke forwarded immediately

workspace_ai:
  model: none          # none | claude-sonnet-4-6 | gpt-4o | gemini-2.0-flash | ollama/llama3
                       # claude-cli: uses your Claude Code login, no API key needed
  api_key_env: ANTHROPIC_API_KEY
  always_confirm_broadcast: true
  always_confirm_multi_step: true

waterfall:
  row_height_mode: viewport   # viewport | fixed
  new_pane_focus: true
```

---

## Keybindings

All bindings are configurable in `config.yaml`.

### Essential — Normal mode

| Key | Action |
|---|---|
| `i` | Insert mode — type into the active shell |
| `a` | AI mode — dispatch to Workspace AI |
| `h` `j` `k` `l` | Navigate panes and rows |
| `n` / `s` | New terminal / split row |
| `q` | Close active pane |
| `/` | Fuzzy pane search |
| `r` | Rename pane |
| `b` | Toggle sidebar |
| `gg` / `G` | Scroll to top / bottom |
| `Ctrl+D` / `Ctrl+U` | Scroll half page |

### Global

| Key | Action |
|---|---|
| `Ctrl+\` | Toggle Normal ↔ Terminal (raw PTY) |
| `Ctrl+N` | New terminal |
| `Ctrl+H` | Split row |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+,` | Settings |
| `Ctrl+Shift+C` / `V` | Copy / Paste |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | Font size |
| `Ctrl+Q` | Quit |

---

## Contributing

Read [`CLAUDE.md`](./CLAUDE.md) before opening a pull request — it covers the core design decisions (layout model, modal input system, Workspace AI scope) that should be understood before making significant changes.

Built with: [Tauri 2](https://tauri.app/) · [xterm.js 5](https://xtermjs.org/) · [portable-pty](https://github.com/wez/wezterm/tree/main/pty) · Rust + Tokio · Vanilla TypeScript + Vite

---

## Inspiration

The waterfall layout idea — terminals stacking vertically, each filling the viewport as you scroll — was shamelessly stolen from [`infinite-scroll`](https://github.com/gaojude/infinite-scroll). I prefer the word "inspired."

---


## License

MIT

