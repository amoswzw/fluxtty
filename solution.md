# Fluxtty 架构调整方案

本文基于 `future.md`、`future-plan.md` 和当前实现，整理在不改变现有功能的前提下，后续开发前应优先完成的架构调整。

## 总体判断

`future.md` 和 `future-plan.md` 的方向是正确的：Fluxtty 应先稳住终端和工作区基础，再把 AI 作为上层控制面逐步接入，而不是让 AI、xterm、UI 组件和 PTY 运行时互相耦合。

当前最需要做的不是新增 AI 功能，而是把这些职责拆清楚：

- UI 只负责渲染和交互。
- Workspace State 负责结构化工作区状态。
- Workspace Actions 负责所有工作区变更。
- Transport 负责前后端通信。
- PTY Runtime 负责进程和终端 I/O 生命周期。
- AI 只负责理解意图、生成动作、展示计划和总结结果。

目标依赖关系应调整为：

```text
UI / Keybindings / AI input
        ↓
WorkspaceActions / PlanQueue
        ↓
Workspace services / ports
        ↓
Transport
        ↓
Rust IPC / future daemon

Rust PTY events
        ↓
Session / Workspace State
        ↓
UI render + AI context serializer
```

关键原则是：先用 adapter 包住现有实现，保持用户可见行为不变；等调用路径统一以后，再逐步把状态源从 DOM/UI 迁到 workspace state。

## 当前主要耦合点

### 1. IPC 调用直接散落在前端各处

当前 `invoke()` 和 `listen()` 直接出现在多个模块里，例如：

- `src/session/SessionManager.ts`
- `src/waterfall/TerminalPane.ts`
- `src/waterfall/WaterfallArea.ts`
- `src/input/InputBar.ts`
- `src/keybindings/KeybindingManager.ts`
- `src/settings/SettingsPanel.ts`
- `src/app.ts`
- `src/ai/ai-handler.ts`
- `src/ai/llm-client.ts`
- `src/config/ConfigContext.ts`

这会让未来 daemon/runtime split 成本很高。Tauri `invoke()` 是 window-bound 的，如果以后 UI 关闭但 PTY runtime 继续存在，直接散落的 IPC 调用会成为迁移阻力。

### 2. Workspace action 已经存在，但困在 AI 模块里

`src/ai/ai-handler.ts` 中已有 `ParsedAction`、`executeAction()`、`findPane()`、`actionDescription()`。这已经是 workspace action bus 的雏形。

问题是它现在：

- 位于 AI 模块内部。
- 直接依赖 `WaterfallArea`。
- 直接调用 `TerminalPane.writeCommand()`、`TerminalPane.destroy()`。
- 直接调用 `sessionManager` 和 `invoke('pty_write')`。

同时键盘快捷键、sidebar、header 按钮等路径并没有复用这条 action path，而是各自直接操作 UI、session 或 PTY。

### 3. `WaterfallArea` 承担了过多职责

当前 `WaterfallArea` 同时负责：

- 行和 pane 的 DOM 布局。
- row height 计算。
- pane spawn。
- active pane 的滚动定位。
- row note 的 DOM 和状态。
- CWD 变化后的自动重命名。
- pane fallback focus。
- 从 DOM 反推 snapshot 布局。

这使它成为事实上的工作区控制器。后续如果 AI、键盘、持久化、daemon 都继续依赖它，UI 会继续成为 source of truth。

### 4. `PaneInfo.pty_pid` 混入了运行时进程状态

Rust `PaneInfo` 和 TypeScript `PaneInfo` 都包含 `pty_pid`。这把 session identity 和 PTY process lifecycle 绑定到一起。

问题：

- PTY 退出后 `pty_pid` 会变成陈旧引用。
- session state 难以独立序列化。
- detached runtime / daemon 模型会被阻塞。

`PaneInfo` 应只表示可持久化、可结构化消费的 workspace state。PTY pid 应属于 `PtyManager` 内部映射。

### 5. `plan-executor` 是单 pending plan

`planExecutor.setPlan()` 和 `setPending()` 会互相覆盖。AI 以后能力增强后，如果第二个计划在第一个等待确认时产生，第一个会静默丢失。

这不是功能扩展问题，而是后续 AI mode 的可靠性基础问题。

### 6. `status` 没有真实运行时来源

`PaneInfo.status` 有 `idle | running | error`，但当前缺少命令生命周期驱动。UI 和 AI 已经在使用这个字段，例如 sidebar running count、关闭确认、AI context。

需要通过 OSC 133 或等价机制，把 command start、command end、exit code 等结构化状态写入 session model。

### 7. 自动命名状态只存在前端内存里

`AutoNamer` 使用前端 `Set<number>` 标记 auto-named pane。重启、恢复 snapshot 或未来 UI detach 后，这个状态会丢。

建议把命名来源结构化进 `PaneInfo`，例如：

```typescript
name_source: 'auto' | 'manual'
```

或：

```typescript
auto_named: boolean
```

这样“用户手动重命名后锁定”才能成为可靠的 workspace state。

## 分阶段调整方案

## Phase 0：建立边界，不改变行为

目标：保持现有功能不变，只调整调用路径和模块边界。

### 0.1 新增 `src/transport.ts`

新增统一 transport abstraction：

```typescript
export const transport = {
  send<T>(cmd: string, args?: unknown): Promise<T>,
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>,
}
```

当前实现只包装 Tauri：

- `transport.send()` 内部调用 `invoke()`。
- `transport.listen()` 内部调用 `listen()`，并把 Tauri event 解包成 payload。

迁移规则：

- 前端业务模块不再直接 import `@tauri-apps/api/core` 的 `invoke`。
- 前端业务模块不再直接 import `@tauri-apps/api/event` 的 `listen`。
- 窗口 API 如 `getCurrentWindow()` 可暂时保留，后续单独封装 `windowPort`。

成功标准：

- 除 `src/transport.ts` 外，没有业务文件直接调用 `invoke()` 或 `listen()`。
- 现有 IPC command 名称和参数保持不变。

### 0.2 新增 `src/workspace/WorkspaceActions.ts`

把 `ai-handler.ts` 里的 action 执行能力抽出来，但不要简单把 `WaterfallArea` 依赖搬过去。

应定义 ports：

```typescript
interface WorkspaceActionPorts {
  session: SessionPort;
  terminal: TerminalRuntimePort;
  layout: WorkspaceLayoutPort;
  viewport: WorkspaceViewportPort;
  log?: ActionLogPort;
}
```

初期 port 可以由现有对象适配：

- `SessionPort` 由 `sessionManager` 实现。
- `TerminalRuntimePort` 由 `TerminalPane` / transport 适配。
- `WorkspaceLayoutPort` 由 `WaterfallArea` 适配。
- `WorkspaceViewportPort` 由 `WaterfallArea.scrollToPane()` 适配。

这样可以保持行为不变，同时避免新 action 层直接绑定 UI 类。

建议 action 类型先从现有 `ParsedAction` 演进：

```typescript
type WorkspaceAction =
  | { type: 'run'; target: string; cmd: string }
  | { type: 'broadcast'; cmd: string }
  | { type: 'run-group'; group: string; cmd: string }
  | { type: 'new'; name?: string | null; group?: string | null }
  | { type: 'rename'; target: string; name: string }
  | { type: 'close'; target: string }
  | { type: 'close-group'; group: string }
  | { type: 'split' }
  | { type: 'focus'; target: string }
  | { type: 'group'; target: string; group: string }
  | { type: 'note'; target: string; text: string }
  | { type: 'clear'; target: string }
  | { type: 'kill'; target: string };
```

成功标准：

- `ai-handler.ts` 不再 import `WaterfallArea` 或 `TerminalPane`。
- `executeAction()` 不再留在 `ai-handler.ts`。
- AI、键盘、UI 按钮最终都能 dispatch 同一种 workspace action。

### 0.3 收缩 `ai-handler.ts`

`ai-handler.ts` 应只负责：

- 构造 prompt。
- 调用 LLM。
- 解析 action block。
- regex fallback intent parsing。
- 把 action 交给 `WorkspaceActions`。

不应负责：

- spawn pane。
- destroy pane。
- write PTY。
- scroll pane。
- rename pane。
- 操作 `WaterfallArea`。

### 0.4 键盘、header、sidebar 逐步走 action path

以下操作应改为 workspace action：

- New terminal。
- Split row。
- Close pane。
- Focus pane / row navigation。
- Rename pane。
- Group pane。
- Paste to active pane。
- Run command in pane。
- Clear / kill。

UI 可以继续保留 `confirm()`、`prompt()`、settings panel toggle 这类交互，但真正改变 workspace state 的部分应通过 `WorkspaceActions`。

### 0.5 `PlanExecutor` 改为 `PlanQueue`

把当前单槽 plan 改成队列：

```typescript
type PendingActionBatch = {
  id: string;
  title: string;
  preview: string;
  actions: WorkspaceAction[];
  execute(): Promise<ActionResult[]>;
}
```

行为：

- 新 plan append 到队尾。
- `y/n` 只处理队首。
- preview 显示当前队首。
- 如果队列长度大于 1，提示当前位置，例如 `Plan 1/3`。

成功标准：

- 第二个 pending plan 不会覆盖第一个。
- 取消一个 plan 不会清空整个队列，除非用户明确执行 clear all。
- AI mode 和 normal `:` command 共用同一确认队列。

## Phase 1：清理状态边界

目标：让 session state 能独立于 PTY process 和 UI DOM 存在。

### 1.1 移除 `PaneInfo.pty_pid`

Rust：

- 从 `src-tauri/src/session.rs` 的 `PaneInfo` 移除 `pty_pid`。
- `SessionManager.create_pane()` 不再接收 `pty_pid`。
- `PtyManager` 内部维护 `pane_id -> PtyProcess`。
- 如果需要 pid，用 runtime-only API 查询，不放进 `PaneInfo`。

TypeScript：

- 从 `src/session/types.ts` 的 `PaneInfo` 移除 `pty_pid`。
- 删除前端 fallback info 里的 `pty_pid: 0`。

成功标准：

- `PaneInfo` 只包含 workspace/session metadata。
- session snapshot 不包含 PTY process id。
- `SessionManager` 和 `PtyManager` 只通过 pane id 协作。

### 1.2 新增 `SessionObserver` / `WorkspaceObserver`

把以下逻辑从 UI 组件中移出：

- CWD 变化后自动重命名。
- significant command 自动重命名。
- agent detection 结果同步到 session state。
- pane close 后清理 auto-namer / agent detector 内部状态。

建议新增：

```text
src/session/SessionObserver.ts
src/session/PaneNamingPolicy.ts
```

`WaterfallArea` 的 `sessionManager.onChange()` 只负责：

- 找到对应 `TerminalPane`。
- 调用 `pane.updateInfo(info)`。
- 更新 active visual state。

不应写回 `sessionManager.renamePane()`。

### 1.3 命名来源结构化

在 `PaneInfo` 添加命名来源：

```typescript
name_source: 'auto' | 'manual'
```

Rust 同步添加：

```rust
pub name_source: PaneNameSource
```

行为：

- spawn 默认 `auto`。
- auto rename 只改 `name_source === 'auto'` 的 pane。
- 用户 inline rename、AI rename、keyboard rename 都设置为 `manual`。
- 如以后需要“恢复自动命名”，再加显式 action。

### 1.4 明确布局状态源

当前 DOM visual order 是事实上的布局源。短期可以保留，但要用 port 包起来：

```typescript
interface WorkspaceLayoutPort {
  spawnPane(opts: SpawnPaneOptions): Promise<PaneRef | null>;
  splitCurrentRow(): Promise<void>;
  getRows(): WorkspaceRowSnapshot[];
}
```

后续再把 row/pane order 迁入结构化 workspace state。

建议未来引入：

```typescript
type RowId = string;

interface WorkspaceRow {
  id: RowId;
  pane_ids: number[];
  note: string;
}
```

这样 snapshot 不再需要从 DOM 反推。

## Phase 2：结构化 workspace state

目标：让 AI 和 UI 都读取同一个结构化状态，而不是依赖 DOM、xterm 文本或手工拼 prompt。

### 2.1 新增 `WorkspaceState.serialize()`

新增：

```text
src/workspace/WorkspaceState.ts
```

输出结构建议包含：

- panes。
- groups。
- active pane。
- row/order。
- cwd。
- name/group/note。
- role。
- status。
- agent type。
- last command。
- last exit code。
- alternate screen state。
- foreground process state。

`buildSystemPrompt()` 改成调用 serializer，而不是自己格式化 `sessionManager.getAllPanes()`。

成功标准：

- AI prompt 的 workspace context 由一个 serializer 统一产出。
- UI 和 AI 不再各自定义不同的 workspace state 表达。

### 2.2 加 OSC 133 command lifecycle

现有 `pty.rs` 已经有 zsh/bash/fish shell hook 和 OSC 7 CWD tracking。下一步应在同一条路径上增加 OSC 133：

- `133;A` prompt start。
- `133;B` command start。
- `133;C` command output start。
- `133;D;<exitcode>` command end。

解析后更新 `PaneInfo`：

```rust
pub last_command: Option<String>,
pub last_exit_code: Option<i32>,
pub alternate_screen: bool,
```

并补充更明确的运行时状态：

```rust
pub foreground_process_state: Option<ForegroundProcessState>
```

成功标准：

- command 完成后能在 `PaneInfo` 里看到 exit code。
- AI 能区分 idle shell、running command、alternate screen TUI。
- `status` 不再主要靠前端猜测或手动设置。

### 2.3 新增 AI-friendly pane context API

新增 IPC / workspace API：

```text
get_pane_context(pane_id)
```

返回：

- cwd。
- status。
- role/group。
- last command。
- last exit code。
- alternate screen。
- recent output summary 或有限 scrollback 摘要。

这个 API 应通过 `transport` 暴露，不直接在 AI handler 中调用 Tauri。

## Phase 3：规范 Workspace Actions

目标：让 workspace mutation 可记录、可回放、可测试。

### 3.1 使用 discriminated union

把 `{ type: string; [key: string]: unknown }` 升级为严格类型：

```typescript
export type WorkspaceAction = ...
export type WorkspaceActionResult = {
  ok: boolean;
  message: string;
  action: WorkspaceAction;
  error?: string;
}
```

### 3.2 加 action log

新增内存 ring buffer：

```typescript
type ActionLogEntry = {
  id: string;
  timestamp: number;
  source: 'keyboard' | 'ui' | 'ai' | 'system';
  action: WorkspaceAction;
  result?: WorkspaceActionResult;
}
```

用途：

- 调试 AI 行为。
- 用户可查看最近 actions。
- 后续支持 replay / workspace template。

### 3.3 审计直接 mutation

成功标准：

- 没有组件直接调用 `invoke('session_rename')` 或等价 mutation。
- 没有组件直接 `destroy()` pane 来改变 workspace，除非它只是 action adapter 内部实现。
- `InputBar` 只负责输入和 UI state，不直接承担 workspace mutation。
- `WaterfallArea` 只负责布局渲染和 adapter 实现，不是业务决策层。

## Phase 4：重新定义 persistence 边界

目标：避免“keep alive”命名和真实能力不一致。

当前 `persistence.keep_alive` 实际更像：

- app close 时保存 workspace snapshot。
- next launch 时恢复结构、metadata、cwd。

它不是：

- UI 关闭后 PTY 仍继续运行。
- tmux-style reattach。
- daemon runtime。

建议拆成两个概念：

```yaml
persistence:
  restore_workspace_on_launch: true
  save_scrollback_on_exit: true

runtime:
  detached_runtime: false
```

短期：

- 保留当前行为。
- UI 文案不要暗示 PTY 会在窗口关闭后继续运行。
- snapshot 逻辑继续存在，但不要把它当成 daemon 前置实现。

中期：

- `SessionManager` 可独立 serialize/load。
- `PtyManager` 继续管理运行时 handle。
- UI 可从 runtime 读取当前 session state。

长期：

- `SessionManager` 和 `PtyManager` 放进 daemon/runtime process。
- UI 通过 transport 连接和重连。

## Phase 5：AI 控制面

前面阶段完成后，再发展 AI mode。

AI mode 应该：

- 读取 `WorkspaceState.serialize()`。
- 生成 `WorkspaceAction[]`。
- 使用 `PlanQueue` 做确认。
- 通过 `WorkspaceActions` 执行。
- 基于 `PaneInfo` / pane context 总结结果。

AI mode 不应该：

- 直接操作 `WaterfallArea`。
- 直接写 xterm。
- 依赖 terminal screen scraping 作为主要上下文。
- 把所有任务都塞进 interactive PTY。

后续可增加多 runtime：

- PTY Runtime：长期交互 session、dev server、REPL、TUI。
- Task Runtime：一次性命令，例如 `git status`、`npm test`、`cargo check`。
- Child AI Runtime：未来多 worker / reviewer / researcher。

## 推荐执行顺序

1. 新增 `src/transport.ts`，迁移所有前端 `invoke()` / `listen()`。
2. 新增 `src/workspace/WorkspaceActions.ts`，用 ports/adapters 包住现有 `WaterfallArea`、`TerminalPane`、`SessionManager`。
3. 把 `ai-handler.ts` 收缩成 intent parser + LLM client + action dispatcher。
4. 把 `KeybindingManager`、header、sidebar、InputBar 中的 workspace mutation 逐步迁到 action path。
5. 把 `plan-executor` 改为 queue。
6. 从 Rust 和 TypeScript 的 `PaneInfo` 移除 `pty_pid`。
7. 新增 `SessionObserver`，把 auto-rename / agent sync 从 UI 组件中移出。
8. 为 pane name 增加 `name_source` 或 `auto_named`。
9. 新增 `WorkspaceState.serialize()`。
10. 在 `pty.rs` 的现有 shell hooks 上增加 OSC 133。
11. 增加 AI-friendly pane context API。
12. 重新命名和拆分 persistence/runtime 配置。
13. 最后再做 action log、layout state 正规化、daemon/runtime split。

## 不建议现在做的事

- 不要先做 child AI / 多 agent 编排。
- 不要新增更多直接 `invoke()` call site。
- 不要把 `WorkspaceActions` 直接写死依赖 `WaterfallArea`。
- 不要让 `WaterfallArea` 继续新增业务职责。
- 不要在 `PaneInfo` 中继续加入 runtime-only 字段。
- 不要把 terminal screen scraping 作为 AI 上下文主路径。
- 不要在 plan queue 修复前继续扩大 AI 自动执行能力。
- 不要把 snapshot restore 误称为真正 keep-alive runtime。

## 验收清单

- 除 `transport.ts` 外，前端没有直接 `invoke()` / `listen()`。
- `ai-handler.ts` 不 import `WaterfallArea` / `TerminalPane`。
- `executeAction()` 位于 workspace action module。
- 键盘、UI、AI 的 workspace mutation 走同一 action path。
- `PlanExecutor` 支持多个 pending plans。
- `PaneInfo` 不包含 `pty_pid`。
- `WaterfallArea` 不调用 `sessionManager.renamePane()`。
- 自动命名状态可持久化，不只存在前端内存。
- AI prompt 使用 `WorkspaceState.serialize()`。
- command lifecycle 和 exit code 能进入结构化 state。
- persistence 文案和实际能力一致。

## 最小可落地架构

短期不需要重写项目。最小可落地形态是：

```text
src/
  transport.ts
  workspace/
    WorkspaceActions.ts
    WorkspaceState.ts
    ports.ts
    adapters/
      WaterfallWorkspaceAdapter.ts
  session/
    SessionObserver.ts
    PaneNamingPolicy.ts
  ai/
    ai-handler.ts
    llm-client.ts
    plan-queue.ts
```

Rust 侧短期只需要：

```text
src-tauri/src/
  session.rs   # PaneInfo 去掉 pty_pid，增加结构化 metadata
  pty.rs       # PtyManager 内部保存 runtime handle，增加 OSC 133 parser
  ipc.rs       # 继续暴露现有 commands，后续增加 pane context API
```

这条路线能保留当前终端、waterfall、modal input、AI command、settings、snapshot 等现有能力，同时把未来开发的主要风险从“越写越耦合”转为“逐步替换 adapter 内部实现”。
