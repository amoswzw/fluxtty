import type { WaterfallArea } from '../waterfall/WaterfallArea';

interface PlanStep {
  paneId: number;
  cmd: string;
  paneName: string;
}

type PlanLogFn = (text: string, cls?: string) => void;

let waterfallArea: WaterfallArea | null = null;
let logFn: PlanLogFn | null = null;

export function setPlanWaterfallArea(area: WaterfallArea) {
  waterfallArea = area;
}

export function setPlanLogFn(fn: PlanLogFn) {
  logFn = fn;
}

class PlanExecutor {
  private plan: PlanStep[] | null = null;
  private planTitle = '';
  // Generic single-action confirmation: stores preview text + executor callback
  private pendingPreview: string | null = null;
  private pendingFn: (() => Promise<string>) | null = null;

  setPlan(steps: PlanStep[], title: string) {
    this.plan = steps;
    this.planTitle = title;
    this.pendingPreview = null;
    this.pendingFn = null;
  }

  /** Confirm a single arbitrary action without a multi-step plan. */
  setPending(preview: string, fn: () => Promise<string>) {
    this.plan = null;
    this.planTitle = '';
    this.pendingPreview = preview;
    this.pendingFn = fn;
  }

  getPlanPreview(): string {
    if (this.plan) {
      const lines = [`Plan: ${this.planTitle}`, ''];
      for (const step of this.plan) {
        const display = step.cmd === '__close__' ? '[close session]' : `❯ ${step.cmd}`;
        lines.push(`  ${step.paneName} ${display}`);
      }
      lines.push('', 'Confirm? (y/n)');
      return lines.join('\n');
    }
    if (this.pendingPreview) {
      return this.pendingPreview + '\n\nConfirm? (y/n)';
    }
    return '';
  }

  isWaitingForConfirm(): boolean {
    return this.plan !== null || this.pendingFn !== null;
  }

  async handleConfirm(input: string): Promise<string> {
    if (!this.isWaitingForConfirm()) return '';

    if (input.trim().toLowerCase() === 'y') {
      if (this.plan) {
        const plan = this.plan;
        this.plan = null;
        await this.executePlan(plan);
        return 'Done.';
      }
      if (this.pendingFn) {
        const fn = this.pendingFn;
        this.pendingFn = null;
        this.pendingPreview = null;
        return fn();
      }
    }

    this.plan = null;
    this.pendingFn = null;
    this.pendingPreview = null;
    return 'Cancelled.';
  }

  private async executePlan(steps: PlanStep[]) {
    for (const step of steps) {
      const display = step.cmd === '__close__' ? '[close]' : `❯ ${step.cmd}`;
      if (logFn) logFn(`  ${step.paneName} ${display}`, 'plan-step');
      const tp = waterfallArea?.getPane(step.paneId);
      if (tp) {
        if (step.cmd === '__close__') {
          await tp.destroy();
        } else {
          await tp.writeCommand(step.cmd);
        }
      }
      await delay(300);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const planExecutor = new PlanExecutor();
