import { agentDetector, detectAgentFromCommand } from '../input/AgentDetector';
import { sessionManager } from './SessionManager';
import { suggestAltScreenNameForPane, suggestCommandNameForPane, suggestCwdNameForPane } from './PaneNamingPolicy';
import type { PaneInfo } from './types';
import { transport } from '../transport';

class SessionObserver {
  private initialized = false;
  private previousCwd: Map<number, string> = new Map();
  private observedAgentPanes: Set<number> = new Set();
  private previousLastCommand: Map<number, string | null> = new Map();
  private previousAltScreen: Map<number, boolean> = new Map();

  init() {
    if (this.initialized) return;
    this.initialized = true;

    sessionManager.onChange((panes) => this.handlePanes(panes));
    this.handlePanes(sessionManager.getAllPanes());

    document.addEventListener('insert-command-submitted', (event: Event) => {
      const { text, paneId } = (event as CustomEvent<{ text: string; paneId: number }>).detail;
      agentDetector.addCommand(paneId, text);

      const pane = sessionManager.getPane(paneId);
      if (!pane) return;
      const nextName = suggestCommandNameForPane(pane, text);
      if (nextName) {
        void sessionManager.renamePane(paneId, nextName, 'auto');
      }
    });

    void transport.listen<{ pane_id: number }>('pane:command_complete', ({ pane_id }) => {
      if (agentDetector.getAgent(pane_id) !== 'none') {
        agentDetector.setManual(pane_id, 'none');
      }
    });
  }

  private observeAgent(paneId: number) {
    if (this.observedAgentPanes.has(paneId)) return;
    this.observedAgentPanes.add(paneId);
    agentDetector.onAgentChange(paneId, (agent) => {
      void sessionManager.setPaneAgent(paneId, agent);
    });
  }

  private handlePanes(panes: PaneInfo[]) {
    const livePaneIds = new Set(panes.map(pane => pane.id));

    for (const id of this.previousCwd.keys()) {
      if (!livePaneIds.has(id)) this.previousCwd.delete(id);
    }
    for (const id of this.previousLastCommand.keys()) {
      if (!livePaneIds.has(id)) this.previousLastCommand.delete(id);
    }
    for (const id of this.previousAltScreen.keys()) {
      if (!livePaneIds.has(id)) this.previousAltScreen.delete(id);
    }
    for (const id of this.observedAgentPanes) {
      if (!livePaneIds.has(id)) {
        this.observedAgentPanes.delete(id);
        agentDetector.clearPane(id);
      }
    }

    for (const pane of panes) {
      this.observeAgent(pane.id);

      // Detect agent from last_command reported by OSC 133 (covers Terminal mode launches)
      const prevCmd = this.previousLastCommand.get(pane.id);
      if (pane.last_command !== null && pane.last_command !== prevCmd) {
        this.previousLastCommand.set(pane.id, pane.last_command);
        const detected = detectAgentFromCommand(pane.last_command);
        if (detected !== 'none') {
          agentDetector.addCommand(pane.id, pane.last_command);
        }
      } else if (!this.previousLastCommand.has(pane.id)) {
        this.previousLastCommand.set(pane.id, pane.last_command);
      }

      // Rename when a TUI enters alternate screen — catches apps not in the SIGNIFICANT list
      const prevAlt = this.previousAltScreen.get(pane.id);
      this.previousAltScreen.set(pane.id, pane.alternate_screen);
      if (pane.alternate_screen && prevAlt === false) {
        const nextName = suggestAltScreenNameForPane(pane);
        if (nextName) {
          void sessionManager.renamePane(pane.id, nextName, 'auto');
        }
      }

      const previous = this.previousCwd.get(pane.id);
      this.previousCwd.set(pane.id, pane.cwd);

      const shouldNameInitialPane = previous === undefined;
      const cwdChanged = previous !== undefined && previous !== pane.cwd;
      if (shouldNameInitialPane || cwdChanged) {
        const nextName = suggestCwdNameForPane(pane);
        if (nextName) {
          void sessionManager.renamePane(pane.id, nextName, 'auto');
        }
      }
    }
  }
}

export const sessionObserver = new SessionObserver();
