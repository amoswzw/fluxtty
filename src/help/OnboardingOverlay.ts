import { configContext } from '../config/ConfigContext';
import { modeManager } from '../input/ModeManager';
import { sessionManager } from '../session/SessionManager';
import {
  getCheatSheetSections,
  getQuickStartSteps,
  getWorkspaceModifierLabel,
  type CheatSheetSection,
  type QuickStartStep,
} from './helpContent';
import {
  markQuickStartCompleted,
  markQuickStartShown,
  shouldAutoShowQuickStart,
} from './OnboardingState';

type OverlayView = 'welcome' | 'quick-start' | 'cheat-sheet';

export class OnboardingOverlay {
  readonly el: HTMLElement;
  private spotlightEl!: HTMLElement;
  private panelEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private subtitleEl!: HTMLElement;
  private closeBtnEl!: HTMLButtonElement;
  private quickStartTabEl!: HTMLButtonElement;
  private cheatSheetTabEl!: HTMLButtonElement;
  private bodyEl!: HTMLElement;
  private footerEl!: HTMLElement;
  private view: OverlayView = 'cheat-sheet';
  private quickStartStepIdx = 0;
  private quickStartStepComplete = false;
  private quickStartPaneCountBaseline = 0;
  private quickStartMaxRowWidthBaseline = 0;
  private quickStartActivePaneBaseline: number | null = null;
  private quickStartPendingMoveAxis: 'horizontal' | 'vertical' | null = null;
  private quickStartMoveAxesSeen: Set<'horizontal' | 'vertical'> = new Set();
  private quickStartInsertSeen = false;
  private quickStartInsertCommandSeen = false;
  private quickStartInsertCommandText = '';
  private quickStartInsertCommandEnteredAt = 0;
  private quickStartTerminalSeen = false;
  private quickStartTerminalEnteredAt = 0;
  private quickStartAdvanceTimer: ReturnType<typeof setTimeout> | null = null;
  private quickStartLayoutRaf: number | null = null;
  private quickStartActivity: string[] = [];
  private currentSpotlightTarget: HTMLElement | null = null;

  constructor(private readonly isMac: boolean) {
    this.el = document.createElement('div');
    this.el.className = 'guide-overlay';
    this.el.style.display = 'none';
    this.buildChrome();
    this.bindEvents();
  }

  showWelcome() {
    this.view = 'welcome';
    document.documentElement.classList.remove('guide-quickstart-open');
    this.el.style.display = 'flex';
    this.render();
    this.panelEl.focus();
  }

  showQuickStart(stepIdx = 0) {
    this.view = 'quick-start';
    this.quickStartStepIdx = Math.max(0, stepIdx);
    markQuickStartShown();
    this.armQuickStartStep();
    document.documentElement.classList.add('guide-quickstart-open');
    this.el.style.display = 'flex';
    this.render();
    this.scheduleQuickStartLayoutSync();
    this.panelEl.focus();
  }

  showCheatSheet() {
    this.view = 'cheat-sheet';
    document.documentElement.classList.remove('guide-quickstart-open');
    this.el.style.display = 'flex';
    this.render();
    this.panelEl.focus();
  }

  showQuickStartIfNeeded(restoredWorkspace: boolean) {
    if (!shouldAutoShowQuickStart(restoredWorkspace)) return;
    this.showWelcome();
  }

  hide() {
    if (this.quickStartAdvanceTimer) {
      clearTimeout(this.quickStartAdvanceTimer);
      this.quickStartAdvanceTimer = null;
    }
    if (this.quickStartLayoutRaf != null) {
      cancelAnimationFrame(this.quickStartLayoutRaf);
      this.quickStartLayoutRaf = null;
    }
    if (this.view === 'welcome') {
      markQuickStartShown();
    }
    this.currentSpotlightTarget = null;
    this.spotlightEl.style.display = 'none';
    this.panelEl.style.removeProperty('left');
    this.panelEl.style.removeProperty('top');
    this.panelEl.style.removeProperty('transform');
    this.syncQuickStartDemoState();
    document.documentElement.classList.remove('guide-quickstart-open');
    this.el.style.display = 'none';
  }

  isOpen(): boolean {
    return this.el.style.display !== 'none';
  }

  private buildChrome() {
    this.spotlightEl = document.createElement('div');
    this.spotlightEl.className = 'guide-spotlight';
    this.spotlightEl.style.display = 'none';
    this.el.appendChild(this.spotlightEl);

    const panel = document.createElement('div');
    panel.className = 'guide-panel';
    panel.tabIndex = -1;
    this.panelEl = panel;

    const header = document.createElement('div');
    header.className = 'guide-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'guide-title-wrap';

    const badge = document.createElement('span');
    badge.className = 'guide-badge';
    badge.textContent = 'Guide';
    titleWrap.appendChild(badge);

    this.titleEl = document.createElement('h2');
    this.titleEl.className = 'guide-title';
    titleWrap.appendChild(this.titleEl);

    this.subtitleEl = document.createElement('p');
    this.subtitleEl.className = 'guide-subtitle';
    titleWrap.appendChild(this.subtitleEl);

    header.appendChild(titleWrap);

    this.closeBtnEl = document.createElement('button');
    this.closeBtnEl.className = 'guide-close';
    this.closeBtnEl.type = 'button';
    this.closeBtnEl.textContent = '✕';
    this.closeBtnEl.title = 'Close guide';
    this.closeBtnEl.addEventListener('click', () => this.hide());
    header.appendChild(this.closeBtnEl);

    const tabs = document.createElement('div');
    tabs.className = 'guide-tabs';

    this.quickStartTabEl = document.createElement('button');
    this.quickStartTabEl.className = 'guide-tab';
    this.quickStartTabEl.type = 'button';
    this.quickStartTabEl.textContent = 'Quick Start';
    this.quickStartTabEl.addEventListener('click', () => this.showQuickStart(this.quickStartStepIdx));
    tabs.appendChild(this.quickStartTabEl);

    this.cheatSheetTabEl = document.createElement('button');
    this.cheatSheetTabEl.className = 'guide-tab';
    this.cheatSheetTabEl.type = 'button';
    this.cheatSheetTabEl.textContent = 'Cheat Sheet';
    this.cheatSheetTabEl.addEventListener('click', () => this.showCheatSheet());
    tabs.appendChild(this.cheatSheetTabEl);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'guide-body';

    this.footerEl = document.createElement('div');
    this.footerEl.className = 'guide-footer';

    panel.appendChild(header);
    panel.appendChild(tabs);
    panel.appendChild(this.bodyEl);
    panel.appendChild(this.footerEl);
    this.el.appendChild(panel);
  }

  private bindEvents() {
    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el && this.view === 'cheat-sheet') this.hide();
    });

    document.addEventListener('keydown', (e) => {
      if (!this.isOpen()) return;
      if (this.view === 'welcome') {
        if (e.key === 'Tab') {
          e.stopPropagation();
          return;
        }
        if (this.isInteractiveTarget(e.target) && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) {
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (this.view === 'cheat-sheet' && e.key === 'Escape') {
        e.stopPropagation();
        this.hide();
        return;
      }
      if (this.view !== 'quick-start') return;
      if (this.isInteractiveTarget(e.target)) return;
      if (e.key === 'ArrowLeft' && this.quickStartStepIdx !== 2) {
        e.preventDefault();
        this.goToQuickStartStep(this.quickStartStepIdx - 1);
        return;
      }
      if (this.quickStartStepIdx === 2 && modeManager.getMode().type === 'normal') {
        const navKeyLabel = this.getMoveStepKeyLabel(e.key);
        if (navKeyLabel) {
          this.quickStartPendingMoveAxis = this.getMoveStepAxis(e.key);
          this.recordQuickStartActivity(`Saw \`${navKeyLabel}\`. Focus has not moved yet.`);
        }
      }
    }, true);

    const guardQuickStartInteraction = (e: Event) => {
      if (this.view !== 'quick-start' || !this.isOpen()) return;
      const target = e.target;
      if (target instanceof Node && this.panelEl.contains(target)) return;
      if (target instanceof Node && this.currentSpotlightTarget?.contains(target)) return;
      if (!this.currentSpotlightTarget) return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('pointerdown', guardQuickStartInteraction, true);
    document.addEventListener('wheel', guardQuickStartInteraction, { capture: true, passive: false });
    window.addEventListener('resize', () => this.scheduleQuickStartLayoutSync());
    document.addEventListener('scroll', () => this.scheduleQuickStartLayoutSync(), true);

    document.addEventListener('workspace-scroll-used', () => {
      if (this.view !== 'quick-start' || !this.isOpen()) return;
      if (this.quickStartStepIdx === 5) {
        this.recordQuickStartActivity('Detected workspace scroll on the highlighted area.');
        this.completeQuickStartStep(false);
      }
    });

    document.addEventListener('insert-command-submitted', (e: Event) => {
      if (this.view !== 'quick-start' || !this.isOpen() || this.quickStartStepIdx !== 3) return;
      const detail = (e as CustomEvent<{ text?: string; paneId?: number }>).detail;
      const text = detail?.text?.trim();
      if (!text) return;
      this.quickStartInsertCommandSeen = true;
      this.quickStartInsertCommandText = text;
      this.quickStartInsertCommandEnteredAt = Date.now();
      this.recordQuickStartActivity(`Sent \`${text}\` to the highlighted terminal.`);
      this.render();
      this.scheduleQuickStartLayoutSync();
      window.setTimeout(() => {
        if (!this.isOpen() || this.view !== 'quick-start' || this.quickStartStepIdx !== 3) return;
        this.scheduleQuickStartLayoutSync();
      }, 1100);
    });

    sessionManager.onChange((panes) => {
      if (this.view !== 'quick-start' || !this.isOpen()) return;
      if (this.quickStartStepIdx === 0 && panes.length > this.quickStartPaneCountBaseline) {
        this.recordQuickStartActivity('Detected a new terminal row.');
        this.completeQuickStartStep();
        return;
      }
      if (this.quickStartStepIdx === 1 && this.getMaxRowWidth() > this.quickStartMaxRowWidthBaseline) {
        this.recordQuickStartActivity('Detected a new split in the active row.');
        this.completeQuickStartStep();
        return;
      }
      this.scheduleQuickStartLayoutSync();
    });

    sessionManager.onActiveChange((paneId) => {
      if (this.view !== 'quick-start' || !this.isOpen()) return;
      if (this.quickStartStepIdx === 2) {
        const prevPaneId = this.quickStartActivePaneBaseline;
        const pane = sessionManager.getPane(paneId);
        this.recordQuickStartActivity(`Focus moved to ${pane?.name ? `\`${pane.name}\`` : `pane ${paneId}`}.`);
        if (prevPaneId != null && paneId !== prevPaneId) {
          const confirmedAxis = this.getMoveAxisBetweenPanes(prevPaneId, paneId) ?? this.quickStartPendingMoveAxis;
          if (confirmedAxis) {
            this.quickStartMoveAxesSeen.add(confirmedAxis);
            this.recordQuickStartActivity(
              confirmedAxis === 'horizontal'
                ? 'Confirmed horizontal navigation.'
                : 'Confirmed vertical navigation.',
            );
          }
          this.quickStartPendingMoveAxis = null;
          this.quickStartActivePaneBaseline = paneId;
          if (this.quickStartMoveAxesSeen.size >= 2) {
            this.completeQuickStartStep();
            return;
          }
        }
      }
      this.scheduleQuickStartLayoutSync();
    });

    modeManager.onChange((mode) => {
      if (this.view !== 'quick-start' || !this.isOpen()) return;
      if (this.quickStartStepIdx === 3) {
        if (!this.quickStartInsertSeen && mode.type === 'insert') {
          this.quickStartInsertSeen = true;
          this.recordQuickStartActivity('Entered `Insert` mode.');
          this.render();
          return;
        }
        if (this.quickStartInsertSeen && this.quickStartInsertCommandSeen && mode.type === 'normal') {
          this.recordQuickStartActivity('Returned to `Normal` mode.');
          this.completeQuickStartStep();
          return;
        }
      }
      if (this.quickStartStepIdx === 4) {
        if (!this.quickStartTerminalSeen && mode.type === 'terminal') {
          this.quickStartTerminalSeen = true;
          this.quickStartTerminalEnteredAt = Date.now();
          this.recordQuickStartActivity('Entered raw terminal mode.');
          this.render();
          window.setTimeout(() => {
            if (!this.isOpen() || this.view !== 'quick-start' || this.quickStartStepIdx !== 4) return;
            if (modeManager.getMode().type !== 'terminal') return;
            this.scheduleQuickStartLayoutSync();
          }, 900);
          return;
        }
        if (this.quickStartTerminalSeen && mode.type === 'normal') {
          this.recordQuickStartActivity('Returned to `Normal` mode.');
          this.completeQuickStartStep();
          return;
        }
      }
      this.scheduleQuickStartLayoutSync();
    });

    document.addEventListener('open-quick-start', () => this.showQuickStart(0));
    document.addEventListener('open-cheat-sheet', () => this.showCheatSheet());
  }

  private render() {
    this.el.classList.toggle('quickstart-mode', this.view === 'quick-start');
    this.el.classList.toggle('welcome-mode', this.view === 'welcome');
    this.closeBtnEl.textContent = this.view === 'welcome' ? 'Skip' : '✕';
    this.closeBtnEl.title = this.view === 'welcome' ? 'Skip guide' : 'Close guide';
    this.closeBtnEl.classList.toggle('guide-close-skip', this.view === 'welcome');
    this.quickStartTabEl.style.display = this.view === 'welcome' ? 'none' : '';
    this.cheatSheetTabEl.style.display = this.view === 'welcome' ? 'none' : '';
    this.quickStartTabEl.classList.toggle('active', this.view === 'quick-start');
    this.cheatSheetTabEl.classList.toggle('active', this.view === 'cheat-sheet');

    if (this.view === 'welcome') {
      this.spotlightEl.style.display = 'none';
      this.currentSpotlightTarget = null;
      this.panelEl.style.removeProperty('left');
      this.panelEl.style.removeProperty('top');
      this.panelEl.style.removeProperty('transform');
      this.syncQuickStartDemoState();
      this.titleEl.textContent = 'Welcome to fluxtty';
      this.subtitleEl.textContent = 'Take the interactive tour first, or skip it and explore on your own. You can always reopen both from Help or Settings.';
      this.renderWelcome();
      return;
    }

    if (this.view === 'quick-start') {
      this.titleEl.textContent = 'Quick Start';
      this.subtitleEl.textContent = 'Do the action below in the highlighted area. This step advances automatically.';
      this.syncQuickStartDemoState();
      this.renderQuickStart();
      this.scheduleQuickStartLayoutSync();
      return;
    }

    this.spotlightEl.style.display = 'none';
    this.currentSpotlightTarget = null;
    this.panelEl.style.removeProperty('left');
    this.panelEl.style.removeProperty('top');
    this.panelEl.style.removeProperty('transform');
    this.syncQuickStartDemoState();
    this.titleEl.textContent = 'Cheat Sheet';
    this.subtitleEl.textContent = 'A persistent reference for the controls you will use most while this app window is active.';
    this.renderCheatSheet();
  }

  private renderWelcome() {
    const modifierLabel = getWorkspaceModifierLabel(configContext.get().input.workspace_scroll_modifier);
    const steps = getQuickStartSteps({
      workspaceModifierLabel: modifierLabel,
    });

    this.bodyEl.replaceChildren();
    this.footerEl.replaceChildren();

    const hero = document.createElement('div');
    hero.className = 'guide-welcome-hero';

    const heroTitle = document.createElement('h3');
    heroTitle.className = 'guide-cheatsheet-title';
    heroTitle.textContent = 'Choose how to start';
    hero.appendChild(heroTitle);

    const heroCopy = document.createElement('p');
    heroCopy.className = 'guide-cheatsheet-copy';
    heroCopy.replaceChildren(...this.renderRichText('The tour is interactive: it watches for real actions like `N`, `S`, `H/J/K/L`, `I`, `Esc`, `Ctrl+\\`, and workspace scrolling, then advances automatically.'));
    hero.appendChild(heroCopy);

    const list = document.createElement('div');
    list.className = 'guide-welcome-list';
    steps.forEach((step, idx) => {
      const item = document.createElement('div');
      item.className = 'guide-welcome-item';

      const index = document.createElement('span');
      index.className = 'guide-step-index';
      index.textContent = String(idx + 1).padStart(2, '0');
      item.appendChild(index);

      const text = document.createElement('div');
      text.className = 'guide-welcome-item-copy';

      const title = document.createElement('div');
      title.className = 'guide-welcome-item-title';
      title.textContent = step.title;
      text.appendChild(title);

      const summary = document.createElement('div');
      summary.className = 'guide-welcome-item-summary';
      summary.replaceChildren(...this.renderRichText(step.summary));
      text.appendChild(summary);

      item.appendChild(text);
      list.appendChild(item);
    });

    this.bodyEl.appendChild(hero);
    this.bodyEl.appendChild(list);

    const leftActions = document.createElement('div');
    leftActions.className = 'guide-footer-actions';
    const skipBtn = document.createElement('button');
    skipBtn.className = 'settings-btn';
    skipBtn.type = 'button';
    skipBtn.textContent = 'Skip for now';
    skipBtn.addEventListener('click', () => this.hide());
    leftActions.appendChild(skipBtn);

    const rightActions = document.createElement('div');
    rightActions.className = 'guide-footer-actions';
    const startBtn = document.createElement('button');
    startBtn.className = 'settings-btn settings-btn-primary';
    startBtn.type = 'button';
    startBtn.textContent = 'Start Tour';
    startBtn.addEventListener('click', () => this.showQuickStart(0));
    rightActions.appendChild(startBtn);

    this.footerEl.appendChild(leftActions);
    this.footerEl.appendChild(rightActions);
  }

  private renderQuickStart() {
    const steps = getQuickStartSteps({
      workspaceModifierLabel: getWorkspaceModifierLabel(configContext.get().input.workspace_scroll_modifier),
    });
    const step = steps[Math.min(this.quickStartStepIdx, steps.length - 1)];

    this.bodyEl.replaceChildren();
    this.footerEl.replaceChildren();

    const progress = document.createElement('div');
    progress.className = 'guide-progress';

    const progressText = document.createElement('div');
    progressText.className = 'guide-progress-text';
    progressText.textContent = `Step ${this.quickStartStepIdx + 1} of ${steps.length}`;
    progress.appendChild(progressText);

    const progressDots = document.createElement('div');
    progressDots.className = 'guide-progress-dots';
    steps.forEach((item, idx) => {
      const dot = document.createElement('div');
      dot.className = `guide-progress-dot${idx === this.quickStartStepIdx ? ' active' : ''}${idx < this.quickStartStepIdx ? ' complete' : ''}`;
      dot.title = item.title;
      progressDots.appendChild(dot);
    });
    progress.appendChild(progressDots);

    const card = this.renderQuickStartCard(step);
    const layout = document.createElement('div');
    layout.className = 'guide-quickstart-inline';
    layout.appendChild(progress);
    layout.appendChild(card);
    this.bodyEl.appendChild(layout);

    const leftActions = document.createElement('div');
    leftActions.className = 'guide-footer-actions';

    const skipBtn = document.createElement('button');
    skipBtn.className = 'settings-btn';
    skipBtn.type = 'button';
    skipBtn.textContent = 'Skip Tour';
    skipBtn.addEventListener('click', () => this.hide());
    leftActions.appendChild(skipBtn);

    const sheetBtn = document.createElement('button');
    sheetBtn.className = 'settings-btn';
    sheetBtn.type = 'button';
    sheetBtn.textContent = 'Open Cheat Sheet';
    sheetBtn.addEventListener('click', () => this.showCheatSheet());
    leftActions.appendChild(sheetBtn);

    const rightActions = document.createElement('div');
    rightActions.className = 'guide-footer-actions';

    const backBtn = document.createElement('button');
    backBtn.className = 'settings-btn';
    backBtn.type = 'button';
    backBtn.textContent = 'Back';
    backBtn.disabled = this.quickStartStepIdx === 0;
    backBtn.addEventListener('click', () => {
      this.goToQuickStartStep(this.quickStartStepIdx - 1);
    });
    rightActions.appendChild(backBtn);

    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'settings-btn settings-btn-primary';
    if (this.quickStartStepIdx === steps.length - 1 && this.quickStartStepComplete) {
      actionBtn.textContent = 'Done';
      actionBtn.addEventListener('click', () => {
        markQuickStartCompleted();
        this.hide();
      });
    } else {
      actionBtn.textContent = this.quickStartStepComplete ? 'Next' : (this.quickStartStepIdx === steps.length - 1 ? 'Finish Later' : 'Skip Step');
      actionBtn.addEventListener('click', () => {
        if (this.quickStartStepIdx === steps.length - 1 && !this.quickStartStepComplete) {
          this.hide();
          return;
        }
        this.advanceQuickStart(false);
      });
    }
    rightActions.appendChild(actionBtn);

    this.footerEl.appendChild(leftActions);
    this.footerEl.appendChild(rightActions);
  }

  private renderQuickStartCard(step: QuickStartStep): HTMLElement {
    const card = document.createElement('div');
    card.className = `guide-step-card accent-${step.accent}`;

    const top = document.createElement('div');
    top.className = 'guide-step-top';

    const copy = document.createElement('div');
    copy.className = 'guide-step-copy';

    const title = document.createElement('h3');
    title.className = 'guide-step-title';
    title.textContent = step.title;
    copy.appendChild(title);

    const summary = document.createElement('p');
    summary.className = 'guide-step-summary';
    summary.replaceChildren(...this.renderRichText(step.summary));
    copy.appendChild(summary);

    const detail = document.createElement('p');
    detail.className = 'guide-step-detail';
    detail.replaceChildren(...this.renderRichText(step.detail));
    copy.appendChild(detail);

    top.appendChild(copy);

    const shortcuts = document.createElement('div');
    shortcuts.className = 'guide-step-shortcuts';
    step.shortcuts.forEach(shortcut => shortcuts.appendChild(this.renderKeycap(shortcut)));
    top.appendChild(shortcuts);

    card.appendChild(top);

    const action = document.createElement('div');
    action.className = `guide-task-status${this.quickStartStepComplete ? ' complete' : ''}`;

    const badge = document.createElement('span');
    badge.className = 'guide-task-badge';
    badge.textContent = this.quickStartStepComplete ? 'Done' : 'Do This';
    action.appendChild(badge);

    const message = document.createElement('div');
    message.className = 'guide-task-copy';
    message.replaceChildren(...this.renderRichText(this.getQuickStartStatusMessage(step)));
    action.appendChild(message);

    card.appendChild(action);

    const preview = this.renderStepPreview(step);
    card.appendChild(preview);
    card.appendChild(this.renderActivityFeed());

    const note = document.createElement('div');
    note.className = 'guide-step-note';
    note.replaceChildren(...this.renderRichText('Use the highlighted area and the shortcut above. This step completes automatically when the action is detected.'));
    card.appendChild(note);

    return card;
  }

  private renderStepPreview(step: QuickStartStep): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'guide-step-preview';

    const label = document.createElement('div');
    label.className = 'guide-step-preview-label';
    label.textContent = 'Expected result';
    wrap.appendChild(label);

    const canvas = document.createElement('div');
    canvas.className = `guide-step-preview-canvas preview-${step.id}`;

    if (step.id === 'new-terminal') {
      canvas.innerHTML = `
        <div class="guide-mini-stack">
          <div class="guide-mini-row"><span></span></div>
          <div class="guide-mini-arrow">↓</div>
          <div class="guide-mini-row new"><span></span></div>
        </div>
      `;
    } else if (step.id === 'split-row') {
      canvas.innerHTML = `
        <div class="guide-mini-row split">
          <span class="active"></span>
          <span class="new"></span>
        </div>
      `;
    } else if (step.id === 'move') {
      canvas.innerHTML = `
        <div class="guide-mini-grid">
          <span class="active"></span>
          <span></span>
          <span></span>
          <span class="target"></span>
        </div>
        <div class="guide-mini-arrows">
          <span>H / ←</span>
          <span>J / ↓</span>
          <span>K / ↑</span>
          <span>L / →</span>
        </div>
      `;
    } else if (step.id === 'modes') {
      canvas.innerHTML = `
        <div class="guide-mini-insert-flow">
          <div class="guide-mini-inputbar">
            <span class="guide-mini-inputbar-mode">INSERT</span>
            <span class="guide-mini-inputbar-text">ls</span>
          </div>
          <div class="guide-mini-arrow">↓</div>
          <div class="guide-mini-terminal-shot">
            <div class="guide-mini-terminal-line prompt">$ ls</div>
            <div class="guide-mini-terminal-line result">Desktop&nbsp;&nbsp;Documents&nbsp;&nbsp;src</div>
          </div>
        </div>
      `;
    } else if (step.id === 'terminal-toggle') {
      canvas.innerHTML = `
        <div class="guide-mini-modes">
          <span class="guide-mini-mode normal">NORMAL</span>
          <span class="guide-mini-mode terminal">TERMINAL</span>
        </div>
      `;
    } else {
      canvas.innerHTML = `
        <div class="guide-mini-scroll">
          <div class="guide-mini-scroll-rows">
            <span></span><span></span><span class="focus"></span><span></span>
          </div>
          <div class="guide-mini-scroll-window"></div>
        </div>
      `;
    }

    wrap.appendChild(canvas);
    return wrap;
  }

  private renderActivityFeed(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'guide-activity';

    const label = document.createElement('div');
    label.className = 'guide-step-preview-label';
    label.textContent = 'Detected';
    wrap.appendChild(label);

    const list = document.createElement('div');
    list.className = 'guide-activity-list';

    if (this.quickStartActivity.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'guide-activity-item empty';
      empty.textContent = 'Waiting for the required action in the highlighted area.';
      list.appendChild(empty);
    } else {
      [...this.quickStartActivity].reverse().forEach((entry) => {
        const item = document.createElement('div');
        item.className = 'guide-activity-item';
        item.replaceChildren(...this.renderRichText(entry));
        list.appendChild(item);
      });
    }

    wrap.appendChild(list);
    return wrap;
  }

  private renderCheatSheet() {
    const modifierLabel = getWorkspaceModifierLabel(configContext.get().input.workspace_scroll_modifier);
    const sections = getCheatSheetSections({
      isMac: this.isMac,
      workspaceModifierLabel: modifierLabel,
    });

    this.bodyEl.replaceChildren();
    this.footerEl.replaceChildren();

    const intro = document.createElement('div');
    intro.className = 'guide-cheatsheet-hero';

    const introTitle = document.createElement('h3');
    introTitle.className = 'guide-cheatsheet-title';
    introTitle.textContent = 'Keep this nearby while the muscle memory forms.';
    intro.appendChild(introTitle);

    const introText = document.createElement('p');
    introText.className = 'guide-cheatsheet-copy';
    introText.replaceChildren(...this.renderRichText('App-level shortcuts stay available while the fluxtty window is focused, even when a terminal pane is active.'));
    intro.appendChild(introText);

    const introActions = document.createElement('div');
    introActions.className = 'guide-cheatsheet-actions';
    const replayBtn = document.createElement('button');
    replayBtn.className = 'settings-btn';
    replayBtn.type = 'button';
    replayBtn.textContent = 'Replay Quick Start';
    replayBtn.addEventListener('click', () => this.showQuickStart(0));
    introActions.appendChild(replayBtn);
    intro.appendChild(introActions);

    const grid = document.createElement('div');
    grid.className = 'guide-sheet-grid';
    sections.forEach(section => grid.appendChild(this.renderCheatSheetSection(section)));

    this.bodyEl.appendChild(intro);
    this.bodyEl.appendChild(grid);

    const leftActions = document.createElement('div');
    leftActions.className = 'guide-footer-actions';
    const quickStartBtn = document.createElement('button');
    quickStartBtn.className = 'settings-btn';
    quickStartBtn.type = 'button';
    quickStartBtn.textContent = 'Replay Quick Start';
    quickStartBtn.addEventListener('click', () => this.showQuickStart(0));
    leftActions.appendChild(quickStartBtn);

    const rightActions = document.createElement('div');
    rightActions.className = 'guide-footer-actions';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'settings-btn settings-btn-primary';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => this.hide());
    rightActions.appendChild(closeBtn);

    this.footerEl.appendChild(leftActions);
    this.footerEl.appendChild(rightActions);
  }

  private renderCheatSheetSection(section: CheatSheetSection): HTMLElement {
    const card = document.createElement('section');
    card.className = 'guide-sheet-card';

    const title = document.createElement('h3');
    title.className = 'guide-sheet-title';
    title.textContent = section.title;
    card.appendChild(title);

    const summary = document.createElement('p');
    summary.className = 'guide-sheet-summary';
    summary.textContent = section.summary;
    card.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'guide-sheet-list';

    section.items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'guide-sheet-item';

      const shortcutWrap = document.createElement('div');
      shortcutWrap.className = 'guide-sheet-shortcuts';
      item.shortcuts.forEach(shortcut => shortcutWrap.appendChild(this.renderKeycap(shortcut)));
      row.appendChild(shortcutWrap);

      const desc = document.createElement('div');
      desc.className = 'guide-sheet-description';
      desc.replaceChildren(...this.renderRichText(item.description));
      row.appendChild(desc);

      list.appendChild(row);
    });

    card.appendChild(list);
    return card;
  }

  private advanceQuickStart(markComplete = false) {
    const steps = getQuickStartSteps({
      workspaceModifierLabel: getWorkspaceModifierLabel(configContext.get().input.workspace_scroll_modifier),
    });

    if (markComplete) {
      this.quickStartStepComplete = true;
    }

    if (this.quickStartStepIdx >= steps.length - 1) {
      markQuickStartCompleted();
      this.hide();
      return;
    }

    this.goToQuickStartStep(this.quickStartStepIdx + 1);
  }

  private renderKeycap(text: string): HTMLElement {
    const el = document.createElement('kbd');
    el.className = 'hint-keycap';
    el.textContent = text;
    return el;
  }

  private renderRichText(text: string): Node[] {
    const parts = text.split(/(`[^`]+`)/g).filter(Boolean);
    return parts.map(part => {
      if (part.startsWith('`') && part.endsWith('`')) {
        return this.renderKeycap(part.slice(1, -1));
      }
      return document.createTextNode(part);
    });
  }

  private isInteractiveTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLButtonElement
      || target instanceof HTMLAnchorElement
      || target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || (target instanceof HTMLElement && target.isContentEditable);
  }

  private getCurrentQuickStartStep(): QuickStartStep {
    const steps = getQuickStartSteps({
      workspaceModifierLabel: getWorkspaceModifierLabel(configContext.get().input.workspace_scroll_modifier),
    });
    return steps[Math.min(this.quickStartStepIdx, steps.length - 1)];
  }

  private getMoveStepKeyLabel(key: string): string | null {
    switch (key) {
      case 'h':
      case 'H':
        return 'H';
      case 'j':
      case 'J':
        return 'J';
      case 'k':
      case 'K':
        return 'K';
      case 'l':
      case 'L':
        return 'L';
      case 'ArrowLeft':
        return '←';
      case 'ArrowDown':
        return '↓';
      case 'ArrowUp':
        return '↑';
      case 'ArrowRight':
        return '→';
      default:
        return null;
    }
  }

  private getMoveStepAxis(key: string): 'horizontal' | 'vertical' | null {
    switch (key) {
      case 'h':
      case 'H':
      case 'l':
      case 'L':
      case 'ArrowLeft':
      case 'ArrowRight':
        return 'horizontal';
      case 'j':
      case 'J':
      case 'k':
      case 'K':
      case 'ArrowDown':
      case 'ArrowUp':
        return 'vertical';
      default:
        return null;
    }
  }

  private getPanePosition(paneId: number): { rowIndex: number; paneIndex: number } | null {
    const rows = Array.from(document.querySelectorAll('.terminal-row'));
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const panes = Array.from(rows[rowIndex].querySelectorAll('.terminal-pane'));
      const paneIndex = panes.findIndex((pane) => (pane as HTMLElement).dataset.paneId === String(paneId));
      if (paneIndex !== -1) {
        return { rowIndex, paneIndex };
      }
    }
    return null;
  }

  private getMoveAxisBetweenPanes(fromPaneId: number, toPaneId: number): 'horizontal' | 'vertical' | null {
    const from = this.getPanePosition(fromPaneId);
    const to = this.getPanePosition(toPaneId);
    if (!from || !to) return null;
    if (from.rowIndex !== to.rowIndex) return 'vertical';
    if (from.paneIndex !== to.paneIndex) return 'horizontal';
    return null;
  }

  private resolveQuickStartTarget(step: QuickStartStep): HTMLElement | null {
    const activePaneEl = document.querySelector('.terminal-pane.active') as HTMLElement | null;
    const activeRowEl = activePaneEl?.parentElement as HTMLElement | null;
    switch (step.id) {
      case 'new-terminal':
        return activeRowEl ?? document.querySelector('.waterfall-area');
      case 'split-row':
        return activeRowEl ?? activePaneEl ?? document.querySelector('.waterfall-area');
      case 'move':
        return activePaneEl ?? activeRowEl ?? document.querySelector('.waterfall-area');
      case 'modes':
        if (this.quickStartInsertCommandSeen) {
          const justSubmitted = Date.now() - this.quickStartInsertCommandEnteredAt < 1100;
          if (justSubmitted) {
            return activePaneEl?.querySelector('.term-container') as HTMLElement | null
              ?? activePaneEl
              ?? document.querySelector('.waterfall-area');
          }
        }
        return document.querySelector('.input-bar-wrapper') ?? document.querySelector('.mode-indicator');
      case 'terminal-toggle':
        if (modeManager.getMode().type === 'terminal') {
          const justEnteredTerminal = Date.now() - this.quickStartTerminalEnteredAt < 900;
          if (justEnteredTerminal) {
            return document.querySelector('.input-bar-wrapper') ?? document.querySelector('.mode-indicator');
          }
        }
        return activePaneEl?.querySelector('.term-container') as HTMLElement | null
          ?? activePaneEl
          ?? document.querySelector('.waterfall-area');
      case 'scroll':
        return activeRowEl
          ?? activePaneEl
          ?? document.querySelector('.waterfall-area');
      default:
        return null;
    }
  }

  private scheduleQuickStartLayoutSync() {
    if (!this.isOpen() || this.view !== 'quick-start') return;
    if (this.quickStartLayoutRaf != null) return;
    this.quickStartLayoutRaf = requestAnimationFrame(() => {
      this.quickStartLayoutRaf = null;
      this.syncQuickStartLayout();
    });
  }

  private syncQuickStartDemoState() {
    const workspace = document.querySelector('.waterfall-area') as HTMLElement | null;
    if (!workspace) return;
    workspace.classList.remove('guide-scroll-demo');
  }

  private syncQuickStartLayout() {
    if (!this.isOpen() || this.view !== 'quick-start') {
      this.currentSpotlightTarget = null;
      this.spotlightEl.style.display = 'none';
      this.panelEl.style.removeProperty('left');
      this.panelEl.style.removeProperty('top');
      return;
    }

    const step = this.getCurrentQuickStartStep();
    const target = this.resolveQuickStartTarget(step);
    this.currentSpotlightTarget = target;

    if (!target) {
      this.spotlightEl.style.display = 'none';
      this.panelEl.style.left = '50%';
      this.panelEl.style.top = '50%';
      this.panelEl.style.transform = 'translate(-50%, -50%)';
      return;
    }

    const targetRect = target.getBoundingClientRect();
    const pad = step.id === 'scroll' ? 10 : 8;
    this.spotlightEl.style.display = 'block';
    this.spotlightEl.style.left = `${Math.max(8, targetRect.left - pad)}px`;
    this.spotlightEl.style.top = `${Math.max(8, targetRect.top - pad)}px`;
    this.spotlightEl.style.width = `${Math.max(44, targetRect.width + pad * 2)}px`;
    this.spotlightEl.style.height = `${Math.max(34, targetRect.height + pad * 2)}px`;

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const panelRect = this.panelEl.getBoundingClientRect();
    const panelW = Math.min(panelRect.width || 470, Math.max(320, viewportW - 32));
    const panelH = Math.min(panelRect.height || 520, Math.max(240, viewportH - 32));
    const margin = 16;
    const gap = 18;
    const focusRect = {
      left: Math.max(8, targetRect.left - pad),
      top: Math.max(8, targetRect.top - pad),
      right: Math.min(viewportW - 8, targetRect.right + pad),
      bottom: Math.min(viewportH - 8, targetRect.bottom + pad),
      width: Math.max(44, targetRect.width + pad * 2),
      height: Math.max(34, targetRect.height + pad * 2),
    };

    const spaces = {
      right: viewportW - focusRect.right - margin,
      left: focusRect.left - margin,
      below: viewportH - focusRect.bottom - margin,
      above: focusRect.top - margin,
    };
    const horizontalFirst: Array<'right' | 'left'> = spaces.right >= spaces.left ? ['right', 'left'] : ['left', 'right'];
    const verticalFirst: Array<'below' | 'above'> = spaces.below >= spaces.above ? ['below', 'above'] : ['above', 'below'];
    const directions: Array<'right' | 'left' | 'below' | 'above'> = [
      horizontalFirst[0],
      verticalFirst[0],
      horizontalFirst[1],
      verticalFirst[1],
    ];

    const fittedCandidate = directions
      .map((direction) => this.makePanelCandidate(direction, focusRect, panelW, panelH, viewportW, viewportH, margin, gap))
      .find((candidate) => candidate.fits && candidate.overlapArea === 0)
      ?? directions
        .map((direction) => this.makePanelCandidate(direction, focusRect, panelW, panelH, viewportW, viewportH, margin, gap))
        .sort((a, b) => a.overlapArea - b.overlapArea || a.adjustment - b.adjustment || a.distance - b.distance)[0];

    this.panelEl.style.left = `${Math.round(fittedCandidate.left)}px`;
    this.panelEl.style.top = `${Math.round(fittedCandidate.top)}px`;
    this.panelEl.style.transform = 'none';
  }

  private clamp(value: number, min: number, max: number): number {
    if (max <= min) return min;
    return Math.min(Math.max(value, min), max);
  }

  private makePanelCandidate(
    direction: 'right' | 'left' | 'below' | 'above',
    focusRect: { left: number; top: number; right: number; bottom: number; width: number; height: number },
    panelW: number,
    panelH: number,
    viewportW: number,
    viewportH: number,
    margin: number,
    gap: number,
  ) {
    let preferredLeft = 0;
    let preferredTop = 0;
    let fits = false;

    if (direction === 'right') {
      preferredLeft = focusRect.right + gap;
      preferredTop = focusRect.top + (focusRect.height - panelH) / 2;
      fits = focusRect.right + gap + panelW <= viewportW - margin;
    } else if (direction === 'left') {
      preferredLeft = focusRect.left - panelW - gap;
      preferredTop = focusRect.top + (focusRect.height - panelH) / 2;
      fits = focusRect.left - gap - panelW >= margin;
    } else if (direction === 'below') {
      preferredLeft = focusRect.left + (focusRect.width - panelW) / 2;
      preferredTop = focusRect.bottom + gap;
      fits = focusRect.bottom + gap + panelH <= viewportH - margin;
    } else {
      preferredLeft = focusRect.left + (focusRect.width - panelW) / 2;
      preferredTop = focusRect.top - panelH - gap;
      fits = focusRect.top - gap - panelH >= margin;
    }

    const left = this.clamp(preferredLeft, margin, viewportW - panelW - margin);
    const top = this.clamp(preferredTop, margin, viewportH - panelH - margin);

    const rect = {
      left,
      top,
      right: left + panelW,
      bottom: top + panelH,
    };
    const overlapArea = this.getRectOverlapArea(rect, focusRect);
    const focusCenterX = focusRect.left + focusRect.width / 2;
    const focusCenterY = focusRect.top + focusRect.height / 2;
    const panelCenterX = rect.left + panelW / 2;
    const panelCenterY = rect.top + panelH / 2;
    const distance = Math.hypot(panelCenterX - focusCenterX, panelCenterY - focusCenterY);

    return {
      left,
      top,
      fits,
      overlapArea,
      distance,
      adjustment: Math.abs(left - preferredLeft) + Math.abs(top - preferredTop),
    };
  }

  private getRectOverlapArea(
    a: { left: number; top: number; right: number; bottom: number },
    b: { left: number; top: number; right: number; bottom: number },
  ): number {
    const overlapW = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const overlapH = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return overlapW * overlapH;
  }

  private recordQuickStartActivity(message: string) {
    if (this.quickStartActivity[this.quickStartActivity.length - 1] === message) return;
    this.quickStartActivity.push(message);
    if (this.quickStartActivity.length > 4) {
      this.quickStartActivity.shift();
    }
    if (this.view === 'quick-start' && this.isOpen()) {
      this.render();
    }
  }

  private goToQuickStartStep(idx: number) {
    const steps = getQuickStartSteps({
      workspaceModifierLabel: getWorkspaceModifierLabel(configContext.get().input.workspace_scroll_modifier),
    });
    this.quickStartStepIdx = Math.min(Math.max(idx, 0), steps.length - 1);
    this.armQuickStartStep();
    this.render();
  }

  private armQuickStartStep() {
    if (this.quickStartAdvanceTimer) {
      clearTimeout(this.quickStartAdvanceTimer);
      this.quickStartAdvanceTimer = null;
    }

    this.quickStartStepComplete = false;
    this.quickStartPaneCountBaseline = sessionManager.getAllPanes().length;
    this.quickStartMaxRowWidthBaseline = this.getMaxRowWidth();
    this.quickStartActivePaneBaseline = sessionManager.getActivePaneId();
    this.quickStartPendingMoveAxis = null;
    this.quickStartMoveAxesSeen = new Set();
    this.quickStartInsertSeen = false;
    this.quickStartInsertCommandSeen = false;
    this.quickStartInsertCommandText = '';
    this.quickStartInsertCommandEnteredAt = 0;
    this.quickStartTerminalSeen = false;
    this.quickStartTerminalEnteredAt = 0;
    this.quickStartActivity = [];

    if (this.quickStartStepIdx === 5 && getWorkspaceModifierLabel(configContext.get().input.workspace_scroll_modifier) === null) {
      this.quickStartStepComplete = true;
      this.quickStartActivity.push('Workspace scroll modifier is disabled in Settings, so this step is already marked complete.');
    } else if (this.quickStartStepIdx === 5) {
      this.quickStartActivity.push('Workspace movement should now be clearly visible during this step.');
    }
  }

  private getMaxRowWidth(): number {
    const rows = sessionManager.getPanesByRow();
    return rows.reduce((max, row) => Math.max(max, row.length), 0);
  }

  private completeQuickStartStep(autoAdvance = true) {
    if (this.quickStartStepComplete) return;
    this.quickStartStepComplete = true;
    this.render();

    const steps = getQuickStartSteps({
      workspaceModifierLabel: getWorkspaceModifierLabel(configContext.get().input.workspace_scroll_modifier),
    });
    if (!autoAdvance || this.quickStartStepIdx >= steps.length - 1) return;

    this.quickStartAdvanceTimer = setTimeout(() => {
      this.quickStartAdvanceTimer = null;
      if (!this.isOpen() || this.view !== 'quick-start') return;
      this.goToQuickStartStep(this.quickStartStepIdx + 1);
    }, 720);
  }

  private getQuickStartStatusMessage(step: QuickStartStep): string {
    switch (step.id) {
      case 'new-terminal':
        return this.quickStartStepComplete
          ? 'A new terminal row is in place.'
          : 'Press `N` now to create one more terminal row.';
      case 'split-row':
        return this.quickStartStepComplete
          ? 'The active row now has multiple panes.'
          : 'Press `S` now to split the active row.';
      case 'move':
        return this.quickStartStepComplete
          ? 'Keyboard navigation is working.'
          : this.quickStartMoveAxesSeen.size === 0
            ? 'Start with one sideways move on the split row, then make one up/down move with `H` `J` `K` `L` or the arrow keys.'
            : this.quickStartMoveAxesSeen.has('horizontal')
              ? 'Horizontal move confirmed. Now make one vertical move with `J` `K` or `↑` `↓`.'
              : 'Vertical move confirmed. Return to the split row, then make one horizontal move with `H` `L` or `←` `→`.';
      case 'modes':
        if (this.quickStartStepComplete) return 'You sent a command from Insert mode and returned to Normal.';
        if (!this.quickStartInsertSeen) return 'Press `I` to enter Insert mode.';
        if (!this.quickStartInsertCommandSeen) {
          return modeManager.getMode().type === 'insert'
            ? 'Type `ls` in the input bar and press `Enter`. Watch it appear in the highlighted terminal.'
            : 'Press `I` again, then type `ls` and press `Enter`. Watch it appear in the highlighted terminal.';
        }
        return `Command sent${this.quickStartInsertCommandText ? `: \`${this.quickStartInsertCommandText}\`` : ''}. Now press \`Esc\` to return to \`Normal\`.`;
      case 'scroll':
        if (this.quickStartStepComplete && step.shortcuts[0] === 'Disabled') {
          return 'Workspace scroll modifier is disabled right now. You can enable it later in Settings.';
        }
        return this.quickStartStepComplete
          ? 'Workspace scrolling is configured and working.'
          : `Try scrolling with \`${step.shortcuts[0]}\` now.`;
      case 'terminal-toggle':
        if (this.quickStartStepComplete) return 'Raw terminal mode is working on the highlighted pane.';
        if (this.quickStartTerminalSeen) return 'Raw terminal mode is active. Keys now go straight to the highlighted terminal. Press `Ctrl+\\` again to return to `Normal`.';
        return 'Press `Ctrl+\\` and watch the highlighted terminal pane take raw keyboard input.';
      default:
        if (this.quickStartStepComplete) return 'Raw terminal mode is working.';
        if (this.quickStartTerminalSeen) return 'Now press `Ctrl+\\` again to return to `Normal`.';
        return 'Press `Ctrl+\\` to enter raw terminal mode, then press it again to return.';
    }
  }
}
