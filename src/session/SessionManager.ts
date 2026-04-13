import { transport } from '../transport';
import type { PaneInfo, AgentType, SessionStatus, PaneNameSource } from './types';

type SessionListener = (panes: PaneInfo[], activePaneId: number | null) => void;
type ActivePaneListener = (paneId: number) => void;

class SessionManager {
  private panes: Map<number, PaneInfo> = new Map();
  private activePaneId: number | null = null;
  private listeners: SessionListener[] = [];
  private activeListeners: ActivePaneListener[] = [];

  async init() {
    // Load initial state
    const result = await transport.send<{ panes: PaneInfo[]; active_pane_id: number | null }>('session_list');
    this.panes = new Map(result.panes.map(p => [p.id, p]));
    this.activePaneId = result.active_pane_id;

    // Subscribe to backend events
    await transport.listen<PaneInfo[]>('session:changed', (panes) => {
      this.panes = new Map(panes.map(p => [p.id, p]));
      this.notifyListeners();
    });

    await transport.listen<number>('session:active_changed', (paneId) => {
      this.activePaneId = paneId;
      this.notifyActiveListeners(paneId);
    });
  }

  onChange(listener: SessionListener) {
    this.listeners.push(listener);
  }

  onActiveChange(listener: ActivePaneListener) {
    this.activeListeners.push(listener);
  }

  private notifyListeners() {
    const panes = this.getAllPanes();
    this.listeners.forEach(l => l(panes, this.activePaneId));
  }

  private notifyActiveListeners(id: number) {
    this.activeListeners.forEach(l => l(id));
  }

  getAllPanes(): PaneInfo[] {
    return Array.from(this.panes.values()).sort((a, b) =>
      a.row_index !== b.row_index ? a.row_index - b.row_index : a.pane_index - b.pane_index
    );
  }

  getPane(id: number): PaneInfo | undefined {
    return this.panes.get(id);
  }

  getActivePaneId(): number | null {
    return this.activePaneId;
  }

  getActivePane(): PaneInfo | undefined {
    return this.activePaneId != null ? this.panes.get(this.activePaneId) : undefined;
  }

  async setActivePane(id: number) {
    this.activePaneId = id;
    this.notifyActiveListeners(id);
    await transport.send('session_set_active', { paneId: id });
  }

  async renamePane(id: number, name: string, nameSource: PaneNameSource = 'manual') {
    await transport.send('session_rename', { paneId: id, name, nameSource });
  }

  async setPaneGroup(id: number, group: string) {
    await transport.send('session_set_group', { paneId: id, group });
  }

  async setPaneAgent(id: number, agentType: AgentType) {
    await transport.send('session_set_agent', { paneId: id, agentType });
  }

  async setPaneStatus(id: number, status: SessionStatus) {
    await transport.send('session_set_status', { paneId: id, status });
  }

  async setPaneNote(id: number, note: string) {
    await transport.send('session_set_note', { paneId: id, note });
  }

  getRowPanes(rowIndex: number): PaneInfo[] {
    return this.getAllPanes().filter(p => p.row_index === rowIndex);
  }

  getRowCount(): number {
    const rows = new Set(this.getAllPanes().map(p => p.row_index));
    return rows.size;
  }

  getPanesByRow(): PaneInfo[][] {
    const rows: PaneInfo[][] = [];
    for (const pane of this.getAllPanes()) {
      if (!rows[pane.row_index]) rows[pane.row_index] = [];
      rows[pane.row_index].push(pane);
    }
    return rows.filter(Boolean);
  }

  scrollToPane(_id: number) {
    // Viewport scrolling is exposed through WorkspaceActions ports.
  }
}

export const sessionManager = new SessionManager();
