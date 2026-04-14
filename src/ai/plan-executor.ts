import type { WorkspaceAction, WorkspaceActionResult } from '../workspace/WorkspaceActions';

export interface PendingActionBatch {
  id: string;
  title: string;
  preview: string;
  actions: WorkspaceAction[];
  execute(): Promise<WorkspaceActionResult[]>;
}

type PlanLogFn = (text: string, cls?: string) => void;

let logFn: PlanLogFn | null = null;

export function setPlanLogFn(fn: PlanLogFn) {
  logFn = fn;
}

class PlanExecutor {
  private queue: PendingActionBatch[] = [];
  private nextId = 1;

  enqueue(batch: PendingActionBatch) {
    this.queue.push(batch);
  }

  /** Confirm a single arbitrary action without a multi-step plan. */
  setPending(preview: string, fn: () => Promise<string>, actions: WorkspaceAction[] = []) {
    const id = `pending-${this.nextId++}`;
    this.enqueue({
      id,
      title: 'Pending action',
      preview,
      actions,
      execute: async () => [{
        ok: true,
        message: await fn(),
        action: actions[0] ?? { type: 'focus', target: '' },
      }],
    });
  }

  getPlanPreview(): string {
    const current = this.queue[0];
    if (!current) return '';

    const lines: string[] = [];
    if (current.title !== 'Pending action') {
      lines.push(`${this.queue.length > 1 ? `Plan 1/${this.queue.length}:` : 'Plan:'} ${current.title}`, '');
    } else if (this.queue.length > 1) {
      lines.push(`Plan 1/${this.queue.length}: ${current.title}`, '');
    }
    lines.push(current.preview.trim(), '', 'Confirm? (y/n)');
    return lines.join('\n');
  }

  isWaitingForConfirm(): boolean {
    return this.queue.length > 0;
  }

  pendingCount(): number {
    return this.queue.length;
  }

  clearAll() {
    this.queue = [];
  }

  async handleConfirm(input: string): Promise<string> {
    const current = this.queue[0];
    if (!current) return '';

    if (input.trim().toLowerCase() === 'y') {
      this.queue.shift();
      const results = await current.execute();
      for (const result of results) {
        if (logFn) logFn(`  ${result.message}`, result.ok ? 'plan-step' : 'error');
      }
      const summary = results.length > 0
        ? results.map(result => result.message).join('\n')
        : 'Done.';
      return this.queue.length > 0
        ? `${summary}\n\n${this.getPlanPreview()}`
        : summary;
    }

    this.queue.shift();
    return this.queue.length > 0
      ? `Cancelled.\n\n${this.getPlanPreview()}`
      : 'Cancelled.';
  }
}

export const planExecutor = new PlanExecutor();
