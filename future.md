# Future Architecture

## Direction

Fluxtty should be built as a terminal-first workspace that can grow into an
AI-native workspace over time.

The order matters:

1. Build a strong terminal and workspace foundation first.
2. Expose structured state and explicit workspace actions.
3. Add AI as a layer on top of that foundation.
4. Add orchestration and child-AI capabilities later, without rewriting the
   terminal core.

The product goal is not "an AI that types into terminals".
The product goal is "a workspace operating layer where terminal sessions are one
kind of execution surface, and AI can gradually become the main control plane".

## Core Principles

- Terminal usability must stand on its own even if AI is disabled.
- AI should read structured workspace state, not rely on screen scraping or DOM
  inspection as the primary source of truth.
- Workspace operations should be explicit actions, not ad hoc UI side effects.
- New AI features should be additive layers, not force rewrites of the
  terminal/workspace foundation.
- Persistence and lifecycle design should leave room for a future detached
  runtime or daemon model.

## What Already Exists (Do Not Rebuild)

Before planning new work, recognize what the codebase already provides.

### The action protocol is already in embryonic form

`ai-handler.ts` contains `ParsedAction` and a unified `executeAction()` function
that both the LLM path and the regex parser path go through. This is already a
workspace action bus — it just lives inside the AI handler instead of being a
standalone module. The work is extraction and formalization, not a greenfield
build.

### Shell integration is already implemented

`pty.rs` injects shell hooks into zsh, bash, and fish at spawn time, and already
uses OSC 7 for CWD tracking. The infrastructure for OSC 133 command lifecycle
markers (command start, command end, exit code) is a small addition to the
existing hook injection — not a new project. This makes the "AI-ready terminal
context" phase much closer than it appears.

## Known Technical Debt (Address Early)

### The IPC layer has no transport abstraction — this is the highest-priority debt

Every frontend-to-backend call uses Tauri's `invoke()` directly, scattered
across `ai-handler.ts`, `SessionManager.ts`, `InputBar.ts`, `WaterfallArea.ts`,
and elsewhere:

```typescript
await invoke('pty_write', ...)
await invoke('session_rename', ...)
await invoke('pty_spawn', ...)
```

Tauri's `invoke` is window-bound. It only works when the Tauri WebView is alive.
The daemon/runtime split described in the Persistence Strategy requires replacing
this transport with something that can survive a window close — a Unix socket,
WebSocket, or similar. By the time that work begins, there will be dozens of
`invoke` call sites spread across every file in the codebase.

The fix costs almost nothing now: a thin `src/transport.ts` module that today
wraps Tauri invoke, but exposes a transport-agnostic interface. Every other file
calls `transport.send()` instead of `invoke()` directly. When the daemon split
happens, only `transport.ts` changes — not every call site.

This is the one decision that compounds silently over time. Every new feature
added before this abstraction exists is one more file to update later. Expensive
enough means it never gets done, and the daemon model stays a permanent "long-
term goal" instead of a realistic target.

### `PaneInfo.pty_pid` couples session identity to process lifecycle

`PaneInfo` in `session.rs` carries `pty_pid: u32`. This makes sense today, but
it means session state and PTY process lifetime are fused into the same struct.
When a PTY dies, this field becomes a stale reference. Any future work toward
session persistence or a detached runtime will be blocked by this coupling.

The fix: move `pty_pid` out of `PaneInfo` and into `PtyManager`'s own internal
mapping. `PaneInfo` should represent pure session identity, not runtime process
state.

### `plan-executor` only holds one pending plan

`planExecutor.setPlan()` and `setPending()` silently overwrite any existing
pending plan. If the workspace AI produces a second plan while a first is
waiting for confirmation, the first is dropped without notice. This needs a
queue before the AI mode becomes more capable.

## Target Layers

### 1. Terminal Core

Owns:

- PTY lifecycle
- pane and row layout
- scrollback
- focus and active-pane behavior
- close/reopen behavior
- resize behavior
- session creation and destruction

This layer should remain useful without any AI feature.

### 2. Workspace State

Owns the structured model that both UI and AI can consume.

Examples of state that should live here:

- pane id, name, group, role
- cwd
- active pane
- row and layout structure
- note content
- session status
- ownership metadata
- recent command metadata
- last exit code
- foreground process metadata

The key rule is that important workspace state should not exist only as pixels
or terminal text. `PaneInfo` in `session.rs` is already this model — it just
needs to be kept clean of runtime process fields (see `pty_pid` above).

### 3. Workspace Actions

All workspace mutations should go through explicit actions.

Examples:

- create pane
- split row
- focus pane
- rename pane
- move pane/group
- run command
- clear output
- interrupt process
- close pane
- apply workspace template

This gives a single control surface for keyboard shortcuts, UI buttons, AI
mode, and future automation. The `executeAction()` function in `ai-handler.ts`
is the seed of this layer — it needs to be extracted, not rebuilt.

### 4. AI Interface

AI mode should be the human-to-workspace interface, not just a smarter shell.

Its responsibilities should be:

- understand the user's goal
- inspect workspace state
- choose the right workspace actions
- present plans and confirmations
- summarize results

It should not be tightly coupled to xterm internals or `WaterfallArea`.

### 5. Orchestration Layer

This is a later layer, not the starting point.

It can eventually own:

- child AI workers
- task decomposition
- plan execution
- workspace templates/specs
- multi-session coordination
- detached runtime or daemon-backed persistence

## Execution Model

Fluxtty should not force every AI operation through an interactive PTY.

Long term there should be multiple execution backends:

### Task Runtime

For one-shot, structured commands where exit code and complete output matter.

Examples:

- git status
- npm test
- cargo check
- file inspection tasks

### PTY Runtime

For long-lived interactive work.

Examples:

- shell sessions
- dev servers
- REPLs
- vim / lazygit / htop / other TUI apps

### Child AI Runtime

For future delegated workers with bounded ownership and isolated context.

Examples:

- coder worker
- reviewer worker
- researcher worker
- ops worker

## AI Product Model

The intended AI-first model is:

- one top-level orchestrator AI exposed through AI mode
- multiple execution targets underneath it
- child AIs added later as specialized workers

This means AI mode should become the main human control plane for the
workspace, but not the only runtime in the system.

AI mode should eventually manage:

- workspace creation
- workspace structure
- pane roles
- task routing
- status summaries
- child AI assignment

But the first version should stay much smaller and simpler.

## Recommended Roadmap

### Phase 1: Fix the Structural Coupling

Address the architectural problems that will block every later phase.

Priority areas:

- extract `executeAction()` from `ai-handler.ts` into a standalone
  `WorkspaceActions` module
- route keyboard shortcuts through the same action module
- move `pty_pid` out of `PaneInfo` into `PtyManager`'s internal mapping
- replace the single-pending-plan model in `plan-executor` with a queue
- move CWD auto-rename logic out of `WaterfallArea` into the session layer

Goal: the workspace action layer exists as a real module; `ai-handler` no longer
depends on `WaterfallArea`; session state can outlive a PTY process.

### Phase 2: Enrich Workspace State

Make workspace state complete enough for AI to reason over without depending on
raw terminal text.

Priority areas:

- pane role metadata
- command lifecycle metadata via OSC 133 (build on existing shell hook
  infrastructure in `pty.rs`)
- recent output summaries
- idle/running state
- foreground process metadata
- AI-friendly pane context APIs

Goal: AI can inspect terminal context without screen scraping. OSC 133 gives
command start, output boundaries, and exit codes through the existing shell
integration path — this is a small extension, not new infrastructure.

### Phase 3: Minimal Useful AI Mode

Add one orchestrator AI, but keep scope narrow.

Priority areas:

- AI mode reads structured workspace state (not manually assembled text)
- AI mode calls workspace actions (through the module from Phase 1)
- AI mode proposes plans with a proper confirmation queue
- AI mode summarizes command and workspace results

Goal: AI mode is clearly useful without requiring a heavy multi-agent
architecture. The action queue and structured state from phases 1–2 make this
clean.

### Phase 4: Child AI and Workspace Orchestration

Expand from AI-assisted workspace control into AI-managed workspace execution.

Priority areas:

- child AI workers
- role-specific worker types
- task routing
- workspace spec/template support
- richer planning and execution
- detached runtime / daemon model

Goal: the workspace becomes a true AI control plane.

## Persistence Strategy

There are two different persistence goals and they should stay separate.

### A. Close/Reopen App Without Losing Live Work

Long-term best solution:

- split UI from runtime
- keep PTYs and workspace runtime alive outside the UI process
- allow the UI to detach and reattach

This points toward a future daemon/runtime split. The prerequisite is that
`PaneInfo` does not carry PTY process state (see the `pty_pid` issue above).
Fixing that coupling should happen in Phase 1, before the daemon work begins.

### B. Recover After Full System Shutdown

This cannot preserve the same live PTYs and processes.

After full shutdown/reboot, the best realistic outcome is:

- restore workspace structure
- restore metadata and notes
- restore enough context to rebuild work

It is not the same as preserving a live interactive process tree.

## Explicit Non-Goals For Now

- Do not make the product depend on AI availability to feel usable.
- Do not make terminal screen scraping the primary architecture.
- Do not force every action through interactive PTY sessions.
- Do not make tmux/zellij the primary product abstraction.
- Do not start with a heavy multi-agent system before the terminal core is
  stable.

## Design Check

Any future change should satisfy most of these checks:

- If AI is disabled, does the workspace still make sense?
- Is the source of truth structured state rather than UI rendering?
- Can keyboard/UI/AI all use the same action path?
- Does this make future detached runtime support easier, not harder?
- Is this additive, or does it secretly rewrite the foundation?
- Does `PaneInfo` stay clean of PTY runtime fields?
- Can the pending action queue handle more than one plan at a time?
- Does this add another `invoke()` call site, or does it go through `transport.ts`?
