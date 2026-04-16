# fluxtty

<p align="center">
  <img src="src-tauri/icons/icon.png" width="112" height="112" alt="fluxtty" />
</p>

<h3 align="center">A vim-modal terminal workspace for AI development.</h3>

<p align="center">
  You don't just write code anymore — you supervise agents.<br/>
  fluxtty is a keyboard-driven workspace for running many AI sessions in parallel,<br/>
  with the modal efficiency that made vim indispensable.
</p>

<p align="center">
  <a href="https://github.com/amoswzw/fluxtty/actions/workflows/ci.yml"><img src="https://github.com/amoswzw/fluxtty/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/amoswzw/fluxtty/actions/workflows/codeql.yml"><img src="https://github.com/amoswzw/fluxtty/actions/workflows/codeql.yml/badge.svg" alt="CodeQL" /></a>
  <a href="https://github.com/amoswzw/fluxtty/releases/latest"><img src="https://img.shields.io/github/v/release/amoswzw/fluxtty" alt="Release" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-2f363d" alt="Platform" />
  <img src="https://img.shields.io/badge/Tauri-2.x-24b47e" alt="Tauri" />
  <img src="https://img.shields.io/badge/license-MIT-4f8cff" alt="License" />
</p>

<p align="center">
  <a href="https://amoswzw.github.io/fluxtty/"><strong>Live demo →</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="https://github.com/amoswzw/fluxtty/releases/latest"><strong>Download latest release</strong></a>
</p>

<p align="center">
  <img src="docs/fluxtty-preview.gif" width="100%" alt="fluxtty workspace preview" />
</p>

## The idea

When AI writes the code, your job shifts from typing to directing. You need a workspace built for that — not an editor with a terminal bolted on.

| Before | Now |
| --- | --- |
| Write code manually in an editor. | Agents write; you review, steer, and unblock. |
| One terminal for the occasional command. | 8–12 sessions open in parallel: agents, servers, shells. |
| Run tests yourself, read output, patch manually. | Monitor outputs, redirect agents, course-correct fast. |
| Context-switch between editor, browser, terminal. | The terminal is the entire workspace. |

fluxtty applies vim's modal philosophy to the whole terminal workspace:

| Need | fluxtty answer |
| --- | --- |
| Watch many sessions at once | Waterfall rows keep all agents visible without squeezing into a tiny grid |
| Move without touching the mouse | Normal mode: `h j k l` navigation, `/` fuzzy search, `n` new, `s` split, `q` close |
| Type safely into any shell | Insert mode routes input to the active PTY — Normal mode never leaks keys into a running agent |
| Use real terminal apps | Terminal mode gives xterm.js raw keyboard control for vim, htop, TUIs, and agent prompts |
| Coordinate the workspace | Workspace AI can run, read, create, rename, group, pipeline, and dispatch across sessions |

## Install

### Homebrew on macOS

```bash
brew tap amoswzw/tap
brew install --cask fluxtty
```

### Download

**[Latest release](https://github.com/amoswzw/fluxtty/releases/latest)** — macOS, Linux, Windows

| Platform | Package |
| --- | --- |
| macOS Apple Silicon | `fluxtty_*_aarch64.dmg` |
| macOS Intel | `fluxtty_*_x64.dmg` |
| Linux | `fluxtty_*_amd64.deb`, `.rpm`, `.AppImage` |
| Windows | `fluxtty_*_x64-setup.exe` |

### Build from source

Prerequisites: [Rust](https://rustup.rs/) 1.77+, [Node.js](https://nodejs.org/) 18+, [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/).

```bash
git clone https://github.com/amoswzw/fluxtty
cd fluxtty
npm install
npm run tauri build
```

```bash
npm run tauri dev   # development
```

## Modes

fluxtty has one persistent input bar with a small set of explicit modes:

| Mode | Enter | What happens |
| --- | --- | --- |
| **Normal** | default | Navigate panes and rows, scroll output, split, close, rename, search. No keystrokes reach the shell. |
| **Insert** | `i` | Type into the active shell through the input bar. `Esc` returns to Normal. |
| **AI** | `a` | Enter the Workspace AI prompt. Built-in parser with `model: none`; LLM-backed with any provider configured. |
| **Terminal** | `Ctrl+\` | Raw terminal input. xterm.js owns the keyboard until `Ctrl+\` returns to Normal. |
| **Find** | `/` | Fuzzy search across all panes by name, group, cwd, and status. |
| **View** | `v` | Isolate the active row for focused watching. |

`:` in Normal mode opens the same workspace command path inline.

## Workspace commands

Built-in commands available when `workspace_ai.model: none`:

```text
run <cmd> in <session>
run <cmd> in group <group>
<cmd> in all sessions
run X then run Y in <session>
new [name] [in <group>]
rename <session> to <name>
close <session> | close idle | close group <group>
split
focus <session>
group <session> as <group>
note <session> <text>
read <session>
clear <session>
kill <session>
list | status | help
!agent <claude|codex|aider|gemini|opencode|goose|cursor|qwen|amp|crush|openhands|none>
```

`list`, `status`, `help`, `read`, `focus`, and `!agent` execute immediately. All workspace-changing commands are queued through a plan confirmation step before running.

## Highlights

### Waterfall layout

Rows stack vertically; horizontal splits live inside a row. With few rows, fluxtty divides the space evenly. With many rows, each row becomes a full-height workspace slice you scroll through.

### Agent detection and completion

Detected agents: `claude`, `codex`, `aider`, `gemini`, `opencode`, `goose`, `cursor`, `qwen`, `amp`, `crush`, `openhands`. When a pane is running an agent, the mode indicator reflects it and Tab switches to that agent's slash-command completions.

### Session identity and auto-naming

Every pane tracks name, group, cwd, status, last command, exit code, tmux session, alternate-screen state, and agent type. New panes are named from cwd, then auto-renamed when significant commands take over. Manual renames stay pinned.

### Row notes

`m` opens a note pane for the active row — branch names, review reminders, agent intent. Notes are included in workspace restore snapshots.

### Hot-reload config

`~/.config/fluxtty/config.yaml` hot-reloads on save. Covers window, font, colors, cursor, shell, tmux, keybindings, input behavior, Workspace AI provider and model, waterfall sizing, persistence, and session defaults.

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

input:
  live_typing: true

workspace_ai:
  model: none                    # or: claude-sonnet-4-6, gpt-4o, gemini-2.0-flash, ollama/llama3
  always_confirm_broadcast: true
  always_confirm_multi_step: true

waterfall:
  row_height_mode: viewport
  scroll_snap: false
```

## Keybindings

| Key | Mode | Action |
| --- | --- | --- |
| `h` `j` `k` `l` | Normal | Move across panes and rows |
| `i` | Normal, View | Insert mode for the active PTY |
| `a` or `:` | Normal | Workspace AI / command prompt |
| `/` | Normal | Fuzzy pane selector |
| `v` | Normal | View mode for the active row |
| `n` | Normal | New terminal row |
| `s` | Normal | Split the active row |
| `q` | Normal | Close the active pane |
| `m` | Normal | Toggle the row note pane |
| `r` | Normal | Rename the active pane |
| `G` / `gg` | Normal | Jump to bottom / top of workspace |
| `Ctrl+\` | Any | Toggle raw Terminal mode |
| `Esc` | Insert, AI, Find, View | Return to Normal mode |
| `Tab` | Insert | Shell completion or agent slash-command completion |
| `Cmd+,` / `Ctrl+,` | Any | Open settings |

## Development

```bash
npm install
npm run tauri dev    # dev with hot reload
npm test
npm run build
npm run tauri build  # production bundle
```

## Contributing

Issues and pull requests are welcome. Keep changes focused, run the test suite, and include screenshots or recordings for UI behavior changes.

## Inspiration

The waterfall layout idea — terminals stacking vertically, each filling the viewport as you scroll — was shamelessly stolen from [`infinite-scroll`](https://github.com/gaojude/infinite-scroll). I prefer the word "inspired."

---

## License

MIT