import type { InputMode } from '../session/types';
import { sessionManager } from '../session/SessionManager';

type ModeChangeListener = (mode: InputMode) => void;

export class ModeManager {
  private mode: InputMode = { type: 'normal' };
  private listeners: ModeChangeListener[] = [];

  getMode(): InputMode {
    return this.mode;
  }

  onChange(listener: ModeChangeListener) {
    this.listeners.push(listener);
  }

  private set(mode: InputMode) {
    // Always fire listeners, even when re-entering the same mode. If internal
    // mode state and DOM state ever diverge (e.g. stale readOnly on inputEl),
    // re-entering the mode via the user pressing its key heals the UI.
    this.mode = mode;
    this.listeners.forEach(l => l(mode));
  }

  // Ctrl+\: normal enters raw terminal; every other mode exits back to normal.
  toggle() {
    if (this.mode.type === 'normal') {
      this.enterTerminal();
    } else {
      this.enterNormal();
    }
  }

  enterNormal() { this.set({ type: 'normal' }); }
  enterInsert() {
    if (sessionManager.getActivePaneId() == null) return; // no pane to send to
    this.set({ type: 'insert' });
  }
  enterAI()     { this.set({ type: 'ai' }); }

  enterView(paneId?: number) {
    const id = paneId ?? sessionManager.getActivePaneId();
    if (id == null) return;
    this.set({ type: 'view', paneId: id });
  }

  enterTerminal(paneId?: number) {
    const id = paneId ?? sessionManager.getActivePaneId();
    if (id == null) return;
    this.set({ type: 'terminal', paneId: id });
  }

  enterPaneSelector() {
    this.set({ type: 'pane-selector', query: '' });
  }

  enterPaneSearch(paneId?: number) {
    const id = paneId ?? sessionManager.getActivePaneId();
    if (id == null) return;
    this.set({ type: 'pane-search', paneId: id, query: '' });
  }

  // Compat aliases used by TerminalPane / AgentDetector
  isInPaneMode(): boolean     { return this.mode.type === 'terminal'; }
  isInShellMode(): boolean    { return this.mode.type === 'insert'; }
  isInNormalMode(): boolean   { return this.mode.type === 'normal'; }
  isInAIMode(): boolean       { return this.mode.type === 'ai'; }
  isInSelectorMode(): boolean { return this.mode.type === 'pane-selector'; }
  isInPaneSearchMode(): boolean { return this.mode.type === 'pane-search'; }

  getCurrentPaneId(): number | null {
    if (this.mode.type === 'terminal') return this.mode.paneId;
    return null;
  }
}

export const modeManager = new ModeManager();
