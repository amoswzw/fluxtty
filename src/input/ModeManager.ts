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
    const cur = this.mode as Record<string, unknown>;
    const nxt = mode as Record<string, unknown>;
    if (cur.type === nxt.type && cur.paneId === nxt.paneId) return;
    this.mode = mode;
    this.listeners.forEach(l => l(mode));
  }

  // Ctrl+\: toggle between terminal (raw xterm) and normal
  toggle() {
    if (this.mode.type === 'terminal') {
      this.enterNormal();
    } else {
      this.enterTerminal();
    }
  }

  enterNormal() { this.set({ type: 'normal' }); }
  enterInsert() {
    if (sessionManager.getActivePaneId() == null) return; // no pane to send to
    this.set({ type: 'insert' });
  }
  enterAI()     { this.set({ type: 'ai' }); }

  enterTerminal(paneId?: number) {
    const id = paneId ?? sessionManager.getActivePaneId();
    if (id == null) return;
    this.set({ type: 'terminal', paneId: id });
  }

  enterPaneSelector() {
    this.set({ type: 'pane-selector', query: '' });
  }

  // Compat aliases used by TerminalPane / AgentDetector
  isInPaneMode(): boolean     { return this.mode.type === 'terminal'; }
  isInShellMode(): boolean    { return this.mode.type === 'insert'; }
  isInNormalMode(): boolean   { return this.mode.type === 'normal'; }
  isInAIMode(): boolean       { return this.mode.type === 'ai'; }
  isInSelectorMode(): boolean { return this.mode.type === 'pane-selector'; }

  getCurrentPaneId(): number | null {
    if (this.mode.type === 'terminal') return this.mode.paneId;
    return null;
  }
}

export const modeManager = new ModeManager();
