# Future Plan

This file translates `future.md` into an execution plan.

The plan is intentionally staged so Fluxtty can keep shipping useful terminal
features while gradually becoming an AI-native workspace.

## Planning Goals

- Keep the terminal and workspace strong even before advanced AI arrives.
- Avoid a premature multi-agent architecture.
- Add AI capabilities in layers instead of rewriting the product later.
- Preserve optionality for a future detached runtime / daemon model.

## Working Rules

1. Do not block terminal quality on AI work.
2. Do not make the UI the source of truth.
3. Do not route all future automation through xterm directly.
4. Do not build the heavy orchestration layer before the lower layers are ready.
5. Do not rebuild what already exists — extract and formalize it instead.

## Current State Assessment

Before planning phases, be honest about what already exists:

- `ai-handler.ts` already has a unified `executeAction()` function that both
  the LLM and regex paths use. The workspace action layer is not missing — it
  is just embedded in the wrong module.
- `pty.rs` already injects shell hooks into zsh/bash/fish and tracks CWD via
  OSC 7. Adding OSC 133 command lifecycle markers is a small extension of
  existing code, not a new project.
- `session.rs` already has a clean `PaneInfo` model and `SessionManager` — but
  `PaneInfo` carries `pty_pid`, which couples session identity to process
  lifetime and will block future persistence work.
- `plan-executor.ts` silently overwrites any pending plan when a new one
  arrives. This is a latent bug that needs fixing before AI mode becomes more
  capable.
- Every frontend-to-backend call uses Tauri `invoke()` directly with no
  abstraction layer. There are already call sites in `ai-handler.ts`,
  `SessionManager.ts`, `InputBar.ts`, and `WaterfallArea.ts`. Each new feature
  adds more. The daemon split requires replacing this transport — without an
  abstraction, that means touching every call site across the entire codebase.

## Phase 1: Fix the Structural Coupling

### Objective

Remove the architectural problems that will block every later phase. No new
user-visible features. Current behavior preserved exactly.

### Scope

- extract the workspace action layer from `ai-handler.ts`
- decouple `ai-handler` from `WaterfallArea`
- clean `PaneInfo` of PTY process state
- fix the single-pending-plan limitation in `plan-executor`
- move auto-rename logic out of `WaterfallArea`

### Concrete Work

**Introduce a transport abstraction (`src/transport.ts`)**

Create a thin module that wraps Tauri `invoke` and `listen` behind a transport-
agnostic interface:

```typescript
// src/transport.ts
export const transport = {
  send<T>(cmd: string, args?: unknown): Promise<T>,
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>,
}
```

Today, both methods delegate to Tauri. Every existing `invoke()` and `listen()`
call across the codebase is migrated to `transport.send()` and
`transport.listen()`. When the daemon split happens, only this file changes.

This is the first item in Phase 1 because every other piece of work touches IPC
call sites — doing this first means those migrations land clean rather than
needing a second pass.

**Extract `WorkspaceActions` module (`src/workspace/WorkspaceActions.ts`)**

Move `executeAction()` and its helpers (`findPane`, `actionDescription`) out of
`ai-handler.ts` into a standalone module. This module is the single path for
all workspace mutations — AI, keyboard shortcuts, and future automation all call
it. `ai-handler.ts` becomes a thin layer that parses intent and calls actions.

**Remove the `waterfallArea` reference from `ai-handler.ts`**

`ai-handler.ts` currently holds a `WaterfallArea` reference and calls
`tp.writeCommand()`, `waterfallArea.spawnPane()`, `waterfallArea.splitCurrentRow()`,
and `tp.destroy()` directly. After extraction, `WorkspaceActions` owns these
calls. `ai-handler` no longer imports or knows about `WaterfallArea`.

**Move `pty_pid` out of `PaneInfo` (Rust)**

In `session.rs`, remove `pty_pid: u32` from `PaneInfo`. Move the pane-id to
PTY-pid mapping into `PtyManager`'s own internal `HashMap<u32, PtyHandle>`.
`SessionManager` and `PtyManager` communicate through pane IDs only — no
process handles cross the boundary.

**Replace single-pending-plan with a queue (`plan-executor.ts`)**

Replace `setPending` / `setPlan` with a proper queue. New plans are appended;
confirmation resolves the head of the queue. The input bar shows the current
head and its position in the queue if more than one is pending.

**Move auto-rename logic out of `WaterfallArea`**

The CWD-change detection and auto-rename logic currently lives inside
`WaterfallArea`'s `sessionManager.onChange()` callback (lines 39–54). Move
this into a dedicated `SessionObserver` that listens to `SessionManager` events
directly. `WaterfallArea` should only react to state changes for rendering —
it should not write back to `SessionManager`.

### Success Criteria

- no file outside `transport.ts` calls `invoke()` or `listen()` from Tauri directly
- `ai-handler.ts` does not import `WaterfallArea` or `TerminalPane`
- all workspace mutations go through `WorkspaceActions`
- `PaneInfo` in Rust contains no PTY process fields
- a second pending plan does not silently erase the first
- `WaterfallArea` does not call `sessionManager.renamePane()`

## Phase 2: Enrich Workspace State

### Objective

Make terminal and workspace state machine-readable. This is what allows AI to
reason over the workspace without depending on raw ANSI text.

### Scope

- extend the existing shell integration with command lifecycle markers
- surface structured terminal metadata through the session state model
- give AI a proper context API instead of manually assembled text

### Concrete Work

**Add OSC 133 markers to the existing shell hooks (`pty.rs`)**

`setup_zsh()`, `setup_bash()`, and `setup_fish()` already inject hooks for OSC
7 CWD tracking. Add OSC 133 A/B/C/D sequences to the same hooks:

- `133;A` — prompt start
- `133;B` — command start (captures what the user typed)
- `133;C` — command output start
- `133;D;exitcode` — command end with exit code

Parse these sequences in the PTY output reader and update `PaneInfo` fields:
`last_command`, `last_exit_code`, `foreground_process_state`.

**Extend `PaneInfo` with command metadata**

Add to `PaneInfo` in `session.rs`:

```rust
pub last_command: Option<String>,
pub last_exit_code: Option<i32>,
pub alternate_screen: bool,    // true when a TUI (vim, htop) is active
```

These are populated by the OSC 133 parser, not by the frontend.

**Replace manually assembled text in `buildSystemPrompt()`**

`ai-handler.ts` currently builds the LLM system prompt by formatting
`getAllPanes()` into a text string. Replace this with a proper
`WorkspaceState.serialize()` call that produces a structured representation.
The AI handler should not know how workspace state is formatted.

**Expose AI-friendly pane context API**

Add an IPC command `get_pane_context(pane_id)` that returns:

- cwd
- status (idle/running)
- last command and exit code
- alternate-screen state
- role and group

### Success Criteria

- `buildSystemPrompt()` calls a serializer, not `getAllPanes()` directly
- command exit codes appear in `PaneInfo` after a command completes
- AI can distinguish a pane running vim (alternate screen) from an idle shell
- no screen scraping required to get basic terminal context

## Phase 3: Normalize Workspace Actions

### Objective

Keyboard shortcuts, UI buttons, and AI mode all use the same action path. This
is mostly already done if Phase 1 is complete — this phase hardens it.

### Scope

- formalize the action schema
- make actions loggable and replayable
- ensure no direct component-to-component mutations remain

### Concrete Work

- define a formal `WorkspaceAction` TypeScript discriminated union type
  (currently `ParsedAction` is an untyped object with a string `type` field)
- add a simple action log: each dispatched action is appended to an in-memory
  ring buffer with a timestamp and result
- audit `InputBar` and `WaterfallArea` for any remaining direct mutations to
  session state that bypass `WorkspaceActions`

### Success Criteria

- `WorkspaceAction` is a typed discriminated union, not `{ type: string; [k]: unknown }`
- every workspace mutation appears in the action log
- no component directly calls `invoke('session_rename', ...)` or equivalent
  outside of `WorkspaceActions`

## Phase 4: Deliver Minimal Useful AI Mode

### Objective

Ship an orchestrator-style AI mode that uses the infrastructure from phases
1–3. Keep scope narrow — one AI, no child workers yet.

### Scope

- AI reads structured workspace state (from Phase 2)
- AI calls workspace actions (through the module from Phase 1)
- AI uses a proper confirmation queue (from Phase 1)
- AI summarizes results in workspace terms

### Concrete Work

- update the LLM system prompt to use `WorkspaceState.serialize()`
- update response handling to dispatch through `WorkspaceActions`
- update the confirmation flow to use the action queue
- add result summarization: after a plan executes, show exit codes and
  output summaries from `PaneInfo`, not just "Done."

### Success Criteria

- AI mode is clearly useful for multi-session coordination
- AI mode does not require heavy orchestration backend
- AI responses reference actual command results, not just confirmations

## Phase 5: Add Orchestration and Child AI

### Objective

Expand from AI-assisted workspace control into AI-managed workspace execution.

### Scope

- child AI workers
- bounded worker roles
- task routing
- future workspace templates/specs

### Concrete Work

- define worker roles and ownership rules
- introduce child AI execution paths
- add task decomposition and aggregation
- support workspace templates/specs

### Success Criteria

- AI mode becomes a real control plane
- worker behavior is bounded and inspectable
- the system is still layered, not entangled

## Runtime and Persistence Strategy

### Near Term

- Phase 1 fixes `PaneInfo` to not carry `pty_pid` — this is the prerequisite
  for all persistence work
- do not build persistence before the session/PTY boundary is clean

### Medium Term

- prepare the Rust backend for process separation: `SessionManager` should be
  serializable and loadable independently of `PtyManager`
- avoid new code that assumes the UI window is the permanent owner of all live
  PTYs

### Long Term

- introduce a detached runtime / daemon model: `SessionManager` and
  `PtyManager` run in a background process; the UI connects and reconnects
  without killing the PTYs

## Recommended Immediate Next Steps

In order:

1. Introduce `src/transport.ts` and migrate all `invoke`/`listen` calls to it.
   Small file, high leverage — every subsequent step lands cleaner because of it.
2. Extract `WorkspaceActions` from `ai-handler.ts`. Unblocks AI/keyboard
   convergence and removes the `WaterfallArea` dependency from AI code.
3. Move `pty_pid` out of `PaneInfo` in `session.rs`. Required before any
   persistence work.
4. Replace the single-pending-plan model in `plan-executor` with a queue.
5. Add OSC 133 markers to the existing shell hook injection in `pty.rs`. The
   infrastructure is already there — this is a small addition.
6. Move auto-rename logic out of `WaterfallArea`.

## Things to Avoid

- adding new `invoke()` call sites before `transport.ts` exists — each one
  is another file to update during the daemon split
- rebuilding what already exists (`executeAction` is the action layer seed —
  extract it, do not rewrite it)
- starting Phase 2 before `PaneInfo` is clean of process state
- treating OSC 133 as a large project (it is a small extension of existing code)
- adding new AI features while `plan-executor` can still silently drop plans
- mixing runtime design, AI design, and UI polish into one large refactor

## Review Questions

- Is the terminal/workspace foundation still improving independently of AI?
- Are we adding state and actions, or just adding more UI wiring?
- Does each phase unlock the next one cleanly?
- Is `PaneInfo` clean of PTY runtime fields?
- Are we preserving the option to move toward a detached runtime later?
- Is AI mode becoming a true control plane, not just a command relay?
- Can the action queue handle concurrent plans without silent data loss?
- Is all IPC going through `transport.ts`, or are new `invoke()` calls creeping in?
