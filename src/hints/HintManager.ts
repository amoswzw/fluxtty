import { configContext } from '../config/ConfigContext';
import { hasCompletedQuickStart } from '../help/OnboardingState';
import {
  getInsertEscPassthroughHintText,
  getNormalShortcutsHintText,
  getTerminalToggleHintText,
  getWorkspaceModifierLabel,
  getWorkspaceScrollHintText,
} from '../help/helpContent';

export type HintId = 'normal-shortcuts' | 'terminal-toggle' | 'workspace-scroll' | 'insert-esc-passthrough';

export interface ActiveHint {
  id: HintId;
  text: string;
}

type HintEvent =
  | { type: 'mode-changed'; mode: string; prevMode: string | null }
  | { type: 'normal-shortcut-used'; key: string }
  | { type: 'terminal-toggle-used' }
  | { type: 'terminal-wheel'; withModifier: boolean }
  | { type: 'workspace-scroll-used' }
  | { type: 'insert-interactive-detected'; context: 'agent' | 'tui' };

type HintListener = (hint: ActiveHint | null) => void;

interface HintState {
  learned: Partial<Record<HintId, boolean>>;
  shown: Partial<Record<HintId, number>>;
  lastShownAt: Partial<Record<HintId, number>>;
  normalShortcutKeys: string[];
  terminalWheelWithoutModifierCount: number;
}

const STORAGE_KEY = 'fluxtty.hints.v1';
const DISPLAY_MS = 8000;
const NORMAL_SHORTCUT_KEYS = new Set(['h', 'j', 'k', 'l', 'n', 's', 'q', 'r', 'm']);

function defaultState(): HintState {
  return {
    learned: {},
    shown: {},
    lastShownAt: {},
    normalShortcutKeys: [],
    terminalWheelWithoutModifierCount: 0,
  };
}

function safeLoadState(): HintState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<HintState>;
    return {
      learned: parsed.learned ?? {},
      shown: parsed.shown ?? {},
      lastShownAt: parsed.lastShownAt ?? {},
      normalShortcutKeys: Array.isArray(parsed.normalShortcutKeys) ? parsed.normalShortcutKeys : [],
      terminalWheelWithoutModifierCount: parsed.terminalWheelWithoutModifierCount ?? 0,
    };
  } catch {
    return defaultState();
  }
}

export class HintManager {
  private listeners: HintListener[] = [];
  private activeHint: ActiveHint | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private hideDeadlineAt = 0;
  private remainingMs = DISPLAY_MS;
  private state = safeLoadState();

  onChange(listener: HintListener) {
    this.listeners.push(listener);
    listener(this.activeHint);
  }

  record(event: HintEvent) {
    switch (event.type) {
      case 'mode-changed':
        this.handleModeChanged(event.mode, event.prevMode);
        break;
      case 'normal-shortcut-used':
        this.handleNormalShortcutUsed(event.key);
        break;
      case 'terminal-toggle-used':
        this.markLearned('terminal-toggle');
        break;
      case 'terminal-wheel':
        this.handleTerminalWheel(event.withModifier);
        break;
      case 'workspace-scroll-used':
        this.markLearned('workspace-scroll');
        break;
      case 'insert-interactive-detected':
        this.handleInsertInteractiveDetected(event.context);
        break;
    }
  }

  dismissActive(permanent = true) {
    if (permanent && this.activeHint) {
      this.markLearned(this.activeHint.id);
      return;
    }
    this.hideActiveHint();
  }

  reset() {
    this.state = defaultState();
    this.hideActiveHint();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore storage failures in private mode / restricted environments.
    }
  }

  pauseActive() {
    if (!this.activeHint || !this.hideTimer) return;
    const remaining = this.hideDeadlineAt > 0
      ? Math.max(1200, this.hideDeadlineAt - Date.now())
      : DISPLAY_MS;
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.remainingMs = remaining;
    this.hideDeadlineAt = 0;
  }

  resumeActive() {
    if (!this.activeHint || this.hideTimer) return;
    this.startHideTimer(this.remainingMs);
  }

  showCurrentHint(mode: string) {
    if (mode === 'terminal') {
      this.displayHint('terminal-toggle', getTerminalToggleHintText());
      return;
    }
    if (mode === 'normal' || mode === 'pane-selector') {
      this.displayHint('normal-shortcuts', getNormalShortcutsHintText());
      return;
    }

    const workspaceScrollText = getWorkspaceScrollHintText(
      getWorkspaceModifierLabel(configContext.get().input.workspace_scroll_modifier),
    );
    if (workspaceScrollText) {
      this.displayHint('workspace-scroll', workspaceScrollText);
      return;
    }

    this.displayHint('normal-shortcuts', getNormalShortcutsHintText());
  }

  private emit() {
    this.listeners.forEach(listener => listener(this.activeHint));
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Ignore storage failures in private mode / restricted environments.
    }
  }

  private canShow(id: HintId, maxShows: number, cooldownMs: number): boolean {
    if (this.state.learned[id]) return false;
    const shown = this.state.shown[id] ?? 0;
    if (shown >= maxShows) return false;
    const lastShownAt = this.state.lastShownAt[id] ?? 0;
    if (lastShownAt > 0 && Date.now() - lastShownAt < cooldownMs) return false;
    return true;
  }

  private showHint(id: HintId, text: string, maxShows: number, cooldownMs: number) {
    if (!this.canShow(id, maxShows, cooldownMs)) return;
    if (this.activeHint?.id === id && this.activeHint.text === text) return;

    this.state.shown[id] = (this.state.shown[id] ?? 0) + 1;
    this.state.lastShownAt[id] = Date.now();
    this.save();
    this.displayHint(id, text);
  }

  private hideActiveHint() {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.hideDeadlineAt = 0;
    this.remainingMs = DISPLAY_MS;
    if (!this.activeHint) return;
    this.activeHint = null;
    this.emit();
  }

  private displayHint(id: HintId, text: string) {
    this.activeHint = { id, text };
    this.emit();
    this.startHideTimer(DISPLAY_MS);
  }

  private startHideTimer(ms: number) {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    const delay = Math.max(1200, ms);
    this.remainingMs = delay;
    this.hideDeadlineAt = Date.now() + delay;
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.hideDeadlineAt = 0;
      this.hideActiveHint();
    }, delay);
  }

  private markLearned(id: HintId) {
    if (this.state.learned[id]) return;
    this.state.learned[id] = true;
    this.save();
    if (this.activeHint?.id === id) {
      this.hideActiveHint();
    }
  }

  private handleModeChanged(mode: string, prevMode: string | null) {
    if (mode === 'normal' && prevMode !== 'normal') {
      if (hasCompletedQuickStart()) return;
      this.showHint(
        'normal-shortcuts',
        getNormalShortcutsHintText(),
        2,
        20_000,
      );
      return;
    }

    // User entered Terminal mode from Insert — they've learned how to handle
    // the ESC passthrough situation, so mark the hint as learned.
    if (mode === 'terminal' && prevMode === 'insert') {
      this.markLearned('insert-esc-passthrough');
    }

    if (mode === 'terminal' && prevMode !== 'terminal') {
      if (hasCompletedQuickStart()) return;
      this.showHint(
        'terminal-toggle',
        getTerminalToggleHintText(),
        2,
        10_000,
      );
    }
  }

  private handleNormalShortcutUsed(key: string) {
    const normalized = key.toLowerCase();
    if (!NORMAL_SHORTCUT_KEYS.has(normalized)) return;
    if (this.state.normalShortcutKeys.includes(normalized)) return;

    this.state.normalShortcutKeys.push(normalized);
    this.save();

    if (this.state.normalShortcutKeys.length >= 3) {
      this.markLearned('normal-shortcuts');
    }
  }

  private handleTerminalWheel(withModifier: boolean) {
    if (getWorkspaceModifierLabel(configContext.get().input.workspace_scroll_modifier) === null) return;
    if (withModifier) {
      this.markLearned('workspace-scroll');
      return;
    }
    if (hasCompletedQuickStart()) return;

    this.state.terminalWheelWithoutModifierCount += 1;
    this.save();

    if (this.state.terminalWheelWithoutModifierCount >= 3) {
      const text = getWorkspaceScrollHintText(
        getWorkspaceModifierLabel(configContext.get().input.workspace_scroll_modifier),
      );
      if (!text) return;
      this.showHint(
        'workspace-scroll',
        text,
        2,
        20_000,
      );
    }
  }

  private handleInsertInteractiveDetected(context: 'agent' | 'tui') {
    this.showHint(
      'insert-esc-passthrough',
      getInsertEscPassthroughHintText(context),
      3,
      60_000,
    );
  }
}

export const hintManager = new HintManager();
