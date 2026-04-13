import { sessionManager } from '../session/SessionManager';
import { transport } from '../transport';
import type { PaneInfo } from '../session/types';

// ── Per-pane AI context API ───────────────────────────────────────────────────

export interface PaneContext {
  info: PaneInfo;
  /** Recent PTY output lines (ANSI stripped, up to 50 lines). */
  recent_output: string[];
}

/** Fetch structured context for a single pane, including recent output. */
export async function getPaneContext(paneId: number): Promise<PaneContext | null> {
  return transport.send<PaneContext | null>('get_pane_context', { paneId });
}

export interface WorkspaceRowSnapshot {
  note: string;
  panes: { id: number }[];
}

export interface WorkspaceLayoutReader {
  getRowsWithNotes(): WorkspaceRowSnapshot[];
}

export interface SerializedWorkspaceState {
  panes: PaneInfo[];
  active_pane_id: number | null;
  rows: Array<{
    index: number;
    note: string;
    pane_ids: number[];
  }>;
}

let layoutReader: WorkspaceLayoutReader | null = null;

export function setWorkspaceLayoutReader(reader: WorkspaceLayoutReader) {
  layoutReader = reader;
}

export function serializeWorkspaceState(): SerializedWorkspaceState {
  const panes = sessionManager.getAllPanes();
  const rows = (layoutReader?.getRowsWithNotes() ?? sessionManager.getPanesByRow().map(row => ({
    note: '',
    panes: row.map(p => ({ id: p.id })),
  }))).map((row, index) => ({
    index,
    note: row.note,
    pane_ids: row.panes.map(p => p.id),
  }));

  return {
    panes,
    active_pane_id: sessionManager.getActivePaneId(),
    rows,
  };
}

export function formatWorkspaceContext(state: SerializedWorkspaceState = serializeWorkspaceState()): string {
  const lines = state.panes.map(pane => {
    const active = pane.id === state.active_pane_id ? ' <- active' : '';
    const agent = pane.agent_type !== 'none' ? ` (${pane.agent_type})` : '';
    const source = pane.name_source === 'auto' ? 'auto-name' : 'manual-name';
    const altScreen = pane.alternate_screen ? ' [alt-screen]' : '';
    const lastCmd = pane.last_command ? ` last: ${pane.last_command}` : '';
    const exitCode = pane.last_exit_code != null
      ? ` exit:${pane.last_exit_code}`
      : '';
    return `  ${pane.id}. ${pane.name} [${pane.group}] ${pane.status}${agent} ${source} cwd: ${pane.cwd}${altScreen}${lastCmd}${exitCode}${active}`;
  });

  if (lines.length === 0) return '  (no sessions)';

  const rowLines = state.rows.length > 0
    ? state.rows.map(row => {
        const note = row.note.trim() ? ` note: ${row.note.trim()}` : '';
        return `  row ${row.index}: ${row.pane_ids.join(', ')}${note}`;
      })
    : [];

  return rowLines.length > 0
    ? `${lines.join('\n')}\n\nRows:\n${rowLines.join('\n')}`
    : lines.join('\n');
}
