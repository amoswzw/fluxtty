import { describe, it, expect } from 'vitest';
import { formatWorkspaceContext } from '../workspace/WorkspaceState';
import type { SerializedWorkspaceState } from '../workspace/WorkspaceState';
import type { PaneInfo } from '../session/types';

function makePane(overrides: Partial<PaneInfo> = {}): PaneInfo {
  return {
    id: 1,
    name: 'test',
    group: 'default',
    note: '',
    status: 'idle',
    cwd: '/home/user',
    name_source: 'auto',
    agent_type: 'none',
    row_index: 0,
    pane_index: 0,
    last_command: null,
    last_exit_code: null,
    alternate_screen: false,
    ...overrides,
  };
}

function makeState(panes: PaneInfo[], activePaneId: number | null = null): SerializedWorkspaceState {
  return {
    panes,
    active_pane_id: activePaneId,
    rows: [{ index: 0, note: '', pane_ids: panes.map(p => p.id) }],
  };
}

describe('formatWorkspaceContext', () => {
  it('marks the active pane', () => {
    const pane = makePane({ id: 1, name: 'frontend' });
    const result = formatWorkspaceContext(makeState([pane], 1));
    expect(result).toContain('<- ACTIVE');
  });

  it('does not mark inactive panes as active', () => {
    const pane = makePane({ id: 2, name: 'backend' });
    const result = formatWorkspaceContext(makeState([pane], 1));
    expect(result).not.toContain('<- ACTIVE');
  });

  it('highlights non-zero exit codes with warning symbol', () => {
    const pane = makePane({ last_exit_code: 1 });
    const result = formatWorkspaceContext(makeState([pane]));
    expect(result).toContain('exit:1⚠');
  });

  it('shows exit:0 without warning symbol for success', () => {
    const pane = makePane({ last_exit_code: 0 });
    const result = formatWorkspaceContext(makeState([pane]));
    expect(result).toContain('exit:0');
    expect(result).not.toContain('⚠');
  });

  it('marks running panes as [RUNNING]', () => {
    const pane = makePane({ status: 'running' });
    const result = formatWorkspaceContext(makeState([pane]));
    expect(result).toContain('[RUNNING]');
  });

  it('marks alternate-screen panes as TUI:no-shell', () => {
    const pane = makePane({ alternate_screen: true });
    const result = formatWorkspaceContext(makeState([pane]));
    expect(result).toContain('[TUI:no-shell]');
  });

  it('shows last command in quotes', () => {
    const pane = makePane({ last_command: 'npm test' });
    const result = formatWorkspaceContext(makeState([pane]));
    expect(result).toContain('last:"npm test"');
  });

  it('shows agent type when set', () => {
    const pane = makePane({ agent_type: 'claude' });
    const result = formatWorkspaceContext(makeState([pane]));
    expect(result).toContain('(claude)');
  });

  it('returns empty state message when no panes', () => {
    const result = formatWorkspaceContext(makeState([]));
    expect(result).toContain('(no sessions)');
  });

  it('includes row notes when present', () => {
    const pane = makePane();
    const state: SerializedWorkspaceState = {
      panes: [pane],
      active_pane_id: null,
      rows: [{ index: 0, note: 'ci row', pane_ids: [1] }],
    };
    const result = formatWorkspaceContext(state);
    expect(result).toContain('note: ci row');
  });
});
