import { agentDetector } from '../input/AgentDetector';
import { sessionManager } from './SessionManager';
import { suggestCommandNameForPane, suggestCwdNameForPane } from './PaneNamingPolicy';
import type { PaneInfo } from './types';
import { transport } from '../transport';

class SessionObserver {
  private initialized = false;
  private previousCwd: Map<number, string> = new Map();
  private observedAgentPanes: Set<number> = new Set();

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
    for (const id of this.observedAgentPanes) {
      if (!livePaneIds.has(id)) {
        this.observedAgentPanes.delete(id);
        agentDetector.clearPane(id);
      }
    }

    for (const pane of panes) {
      this.observeAgent(pane.id);

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
