import { planExecutor } from '../ai/plan-executor';
import type { PaneInfo, AgentType, SessionStatus } from '../session/types';

export type WorkspaceAction =
  | { type: 'run'; target: string; cmd: string }
  | { type: 'broadcast'; cmd: string }
  | { type: 'run-group'; group: string; cmd: string }
  | { type: 'sequential'; target: string; cmds: string[] }
  | { type: 'new'; name?: string | null; group?: string | null }
  | { type: 'rename'; target: string; name: string }
  | { type: 'close'; target: string }
  | { type: 'close-group'; group: string }
  | { type: 'split' }
  | { type: 'focus'; target: string }
  | { type: 'group'; target: string; group: string }
  | { type: 'note'; target: string; text: string }
  | { type: 'clear'; target: string }
  | { type: 'kill'; target: string }
  | { type: 'write'; target: string; data: string }
  | { type: 'paste'; target: string; data: string }
  | { type: 'set-agent'; target: string; agentType: AgentType };

export type WorkspaceActionSource = 'keyboard' | 'ui' | 'ai' | 'system';

export interface WorkspaceActionResult {
  ok: boolean;
  message: string;
  action: WorkspaceAction;
  error?: string;
}

export interface ActionLogEntry {
  id: string;
  timestamp: number;
  source: WorkspaceActionSource;
  action: WorkspaceAction;
  result?: WorkspaceActionResult;
}

export interface SessionPort {
  getAllPanes(): PaneInfo[];
  getPane(id: number): PaneInfo | undefined;
  getActivePaneId(): number | null;
  getActivePane(): PaneInfo | undefined;
  setActivePane(id: number): Promise<void>;
  renamePane(id: number, name: string, nameSource?: 'auto' | 'manual'): Promise<void>;
  setPaneGroup(id: number, group: string): Promise<void>;
  setPaneAgent(id: number, agentType: AgentType): Promise<void>;
  setPaneStatus(id: number, status: SessionStatus): Promise<void>;
  setPaneNote(id: number, note: string): Promise<void>;
}

export interface TerminalRuntimePort {
  write(paneId: number, data: string): Promise<void>;
}

export interface SpawnPaneOptions {
  newRow: boolean;
  group?: string;
  cwd?: string;
  targetRow?: number;
  afterPaneId?: number;
}

export interface PaneRef {
  paneId: number;
}

export interface WorkspaceLayoutPort {
  spawnPane(opts: SpawnPaneOptions): Promise<PaneRef | null>;
  splitCurrentRow(): void | Promise<void>;
  closePane(paneId: number): Promise<void>;
}

export interface WorkspaceViewportPort {
  scrollToPane(paneId: number): void;
}

export interface ActionLogPort {
  log(entry: ActionLogEntry): void;
}

export interface WorkspaceActionPorts {
  session: SessionPort;
  terminal: TerminalRuntimePort;
  layout: WorkspaceLayoutPort;
  viewport: WorkspaceViewportPort;
  log?: ActionLogPort;
}

interface DispatchOptions {
  source?: WorkspaceActionSource;
}

const CONFIRMABLE_TYPES = new Set<WorkspaceAction['type']>(['broadcast', 'run-group', 'close-group', 'sequential']);
const ACTION_LOG_LIMIT = 200;

class WorkspaceActions {
  private ports: WorkspaceActionPorts | null = null;
  private logEntries: ActionLogEntry[] = [];
  private nextLogId = 1;

  configure(ports: WorkspaceActionPorts) {
    this.ports = ports;
  }

  getLog(): ActionLogEntry[] {
    return [...this.logEntries];
  }

  actionDescription(action: WorkspaceAction): string {
    switch (action.type) {
      case 'run':
        return `run "${action.cmd}" in ${action.target}`;
      case 'broadcast':
        return `run "${action.cmd}" in all sessions`;
      case 'run-group':
        return `run "${action.cmd}" in group "${action.group}"`;
      case 'sequential':
        return `run ${action.cmds.length} commands in ${action.target}`;
      case 'new':
        return `create new session${action.name ? ` "${action.name}"` : ''}${action.group ? ` in group "${action.group}"` : ''}`;
      case 'rename':
        return `rename "${action.target}" -> "${action.name}"`;
      case 'close':
        return action.target.toLowerCase() === 'idle' ? 'close all idle sessions' : `close session "${action.target}"`;
      case 'close-group':
        return `close all sessions in group "${action.group}"`;
      case 'split':
        return 'split current row';
      case 'focus':
        return `focus "${action.target}"`;
      case 'group':
        return `move "${action.target}" to group "${action.group}"`;
      case 'note':
        return `set note on "${action.target}": ${action.text}`;
      case 'clear':
        return `clear terminal output of "${action.target}"`;
      case 'kill':
        return `send Ctrl+C to "${action.target}"`;
      case 'write':
      case 'paste':
        return `write to "${action.target}"`;
      case 'set-agent':
        return `set "${action.target}" agent to ${action.agentType}`;
    }
  }

  isConfirmable(action: WorkspaceAction): boolean {
    return CONFIRMABLE_TYPES.has(action.type);
  }

  async dispatch(action: WorkspaceAction, options: DispatchOptions = {}): Promise<WorkspaceActionResult> {
    const source = options.source ?? 'ui';
    const entry = this.createLogEntry(source, action);
    try {
      const result = this.isConfirmable(action)
        ? await this.queueConfirmable(action, source)
        : await this.execute(action, source);
      entry.result = result;
      this.finishLogEntry(entry);
      return result;
    } catch (error) {
      const result: WorkspaceActionResult = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        action,
        error: error instanceof Error ? error.message : String(error),
      };
      entry.result = result;
      this.finishLogEntry(entry);
      return result;
    }
  }

  async queueActionBatch(
    title: string,
    actions: WorkspaceAction[],
    options: DispatchOptions = {},
  ): Promise<string> {
    const source = options.source ?? 'ui';
    const preview = actions.map(action => `  ${this.actionDescription(action)}`).join('\n');
    planExecutor.enqueue({
      id: this.nextId('plan'),
      title,
      preview,
      actions,
      execute: async () => this.dispatchMany(actions, source),
    });
    return planExecutor.getPlanPreview();
  }

  findPane(target: string): PaneInfo | undefined {
    const ports = this.requirePorts();
    const panes = ports.session.getAllPanes();
    const normalizedTarget = target.trim().toLowerCase();
    if (!normalizedTarget) return undefined;
    const numericTarget = Number.parseInt(normalizedTarget, 10);
    return panes.find(pane =>
      pane.name.toLowerCase() === normalizedTarget ||
      (Number.isFinite(numericTarget) && pane.id === numericTarget)
    ) || panes.find(pane => pane.name.toLowerCase().includes(normalizedTarget));
  }

  private async queueConfirmable(action: WorkspaceAction, source: WorkspaceActionSource): Promise<WorkspaceActionResult> {
    const actions = this.expandConfirmableAction(action);
    if (actions.length === 0) {
      return { ok: false, message: `No sessions matched ${this.actionDescription(action)}.`, action };
    }
    const title = this.actionDescription(action);
    const preview = await this.queueActionBatch(title, actions, { source });
    return { ok: true, message: preview, action };
  }

  private expandConfirmableAction(action: WorkspaceAction): WorkspaceAction[] {
    const ports = this.requirePorts();
    switch (action.type) {
      case 'broadcast':
        return ports.session.getAllPanes().map(pane => ({ type: 'run', target: String(pane.id), cmd: action.cmd }));
      case 'run-group': {
        const group = action.group.toLowerCase();
        return ports.session.getAllPanes()
          .filter(pane => pane.group.toLowerCase() === group)
          .map(pane => ({ type: 'run', target: String(pane.id), cmd: action.cmd }));
      }
      case 'close-group': {
        const group = action.group.toLowerCase();
        return ports.session.getAllPanes()
          .filter(pane => pane.group.toLowerCase() === group)
          .map(pane => ({ type: 'close', target: String(pane.id) }));
      }
      case 'sequential': {
        const pane = this.findPane(action.target);
        if (!pane) return [];
        return action.cmds.map(cmd => ({ type: 'run', target: String(pane.id), cmd }));
      }
      default:
        return [];
    }
  }

  private async dispatchMany(actions: WorkspaceAction[], source: WorkspaceActionSource): Promise<WorkspaceActionResult[]> {
    const results: WorkspaceActionResult[] = [];
    for (const action of actions) {
      results.push(await this.dispatch(action, { source }));
      await delay(300);
    }
    return results;
  }

  private async execute(action: WorkspaceAction, _source: WorkspaceActionSource): Promise<WorkspaceActionResult> {
    const ports = this.requirePorts();

    switch (action.type) {
      case 'run': {
        const pane = this.findPane(action.target);
        if (!pane) return this.fail(action, `Session "${action.target}" not found.`);
        await ports.terminal.write(pane.id, `${action.cmd}\r`);
        ports.viewport.scrollToPane(pane.id);
        return this.ok(action, `Ran "${action.cmd}" in ${pane.name}.`);
      }

      case 'new': {
        const pane = await ports.layout.spawnPane({ newRow: true, group: action.group ?? undefined });
        if (!pane) return this.fail(action, 'Failed to create session.');
        if (action.name) await ports.session.renamePane(pane.paneId, action.name, 'manual');
        if (action.group) await ports.session.setPaneGroup(pane.paneId, action.group);
        return this.ok(action, `Created new session${action.name ? ` "${action.name}"` : ''}.`);
      }

      case 'rename': {
        const pane = this.findPane(action.target);
        if (!pane) return this.fail(action, `Session "${action.target}" not found.`);
        await ports.session.renamePane(pane.id, action.name, 'manual');
        return this.ok(action, `Renamed ${pane.name} -> ${action.name}.`);
      }

      case 'close': {
        if (action.target.toLowerCase() === 'idle') {
          const idle = ports.session.getAllPanes().filter(pane => pane.status === 'idle');
          for (const pane of idle) await ports.layout.closePane(pane.id);
          return this.ok(action, `Closed ${idle.length} idle session(s).`);
        }
        const pane = this.findPane(action.target);
        if (!pane) return this.fail(action, `Session "${action.target}" not found.`);
        await ports.layout.closePane(pane.id);
        return this.ok(action, `Closed ${pane.name}.`);
      }

      case 'split':
        await ports.layout.splitCurrentRow();
        return this.ok(action, 'Split current row.');

      case 'focus': {
        const pane = this.findPane(action.target);
        if (!pane) return this.fail(action, `Session "${action.target}" not found.`);
        await ports.session.setActivePane(pane.id);
        ports.viewport.scrollToPane(pane.id);
        return this.ok(action, `Focused ${pane.name}.`);
      }

      case 'group': {
        const pane = this.findPane(action.target);
        if (!pane) return this.fail(action, `Session "${action.target}" not found.`);
        await ports.session.setPaneGroup(pane.id, action.group);
        return this.ok(action, `Moved ${pane.name} to group "${action.group}".`);
      }

      case 'note': {
        const pane = this.findPane(action.target);
        if (!pane) return this.fail(action, `Session "${action.target}" not found.`);
        await ports.session.setPaneNote(pane.id, action.text);
        return this.ok(action, `Set note on ${pane.name}.`);
      }

      case 'clear': {
        const pane = this.findPane(action.target);
        if (!pane) return this.fail(action, `Session "${action.target}" not found.`);
        await ports.terminal.write(pane.id, 'clear\r');
        return this.ok(action, `Cleared ${pane.name}.`);
      }

      case 'kill': {
        const pane = this.findPane(action.target);
        if (!pane) return this.fail(action, `Session "${action.target}" not found.`);
        await ports.terminal.write(pane.id, '\x03');
        return this.ok(action, `Sent Ctrl+C to ${pane.name}.`);
      }

      case 'write':
      case 'paste': {
        const pane = this.findPane(action.target);
        if (!pane) return this.fail(action, `Session "${action.target}" not found.`);
        await ports.terminal.write(pane.id, action.data);
        return this.ok(action, `Wrote to ${pane.name}.`);
      }

      case 'set-agent': {
        const pane = this.findPane(action.target);
        if (!pane) return this.fail(action, `Session "${action.target}" not found.`);
        await ports.session.setPaneAgent(pane.id, action.agentType);
        return this.ok(action, `Set ${pane.name} agent to "${action.agentType}".`);
      }

      case 'broadcast':
      case 'run-group':
      case 'close-group':
      case 'sequential':
        return this.queueConfirmable(action, _source);
    }
  }

  private requirePorts(): WorkspaceActionPorts {
    if (!this.ports) throw new Error('Workspace actions are not configured.');
    return this.ports;
  }

  private ok(action: WorkspaceAction, message: string): WorkspaceActionResult {
    return { ok: true, message, action };
  }

  private fail(action: WorkspaceAction, message: string): WorkspaceActionResult {
    return { ok: false, message, action, error: message };
  }

  private createLogEntry(source: WorkspaceActionSource, action: WorkspaceAction): ActionLogEntry {
    return {
      id: this.nextId('action'),
      timestamp: Date.now(),
      source,
      action,
    };
  }

  private finishLogEntry(entry: ActionLogEntry) {
    if (entry.action.type !== 'write' && entry.action.type !== 'paste') {
      this.logEntries.push(entry);
      if (this.logEntries.length > ACTION_LOG_LIMIT) this.logEntries.shift();
      this.ports?.log?.log(entry);
    }
  }

  private nextId(prefix: string): string {
    return `${prefix}-${this.nextLogId++}`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function actionDescription(action: WorkspaceAction): string {
  return workspaceActions.actionDescription(action);
}

export const workspaceActions = new WorkspaceActions();
