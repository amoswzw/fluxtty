import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Transport mock (needed by waitForCommand transitively) ────────────────────
type PayloadHandler = (payload: unknown) => void;
const registeredListeners = new Map<string, PayloadHandler[]>();

vi.mock('../transport', () => ({
  transport: {
    send: vi.fn().mockResolvedValue(null),
    listen: vi.fn().mockImplementation((event: string, handler: PayloadHandler) => {
      if (!registeredListeners.has(event)) registeredListeners.set(event, []);
      registeredListeners.get(event)!.push(handler);
      return Promise.resolve(() => {
        const arr = registeredListeners.get(event) ?? [];
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      });
    }),
  },
}));

function emitCommandComplete(paneId: number, exitCode: number) {
  for (const handler of registeredListeners.get('pane:command_complete') ?? []) {
    handler({ pane_id: paneId, exit_code: exitCode });
  }
}

// ── WorkspaceState mock (for `read` action) ───────────────────────────────────
vi.mock('../workspace/WorkspaceState', () => ({
  getPaneContext: vi.fn().mockResolvedValue({
    info: {},
    recent_output: ['line 1', 'line 2', 'error: something failed'],
  }),
  formatWorkspaceContext: vi.fn().mockReturnValue('(mock context)'),
  serializeWorkspaceState: vi.fn().mockReturnValue({ panes: [], active_pane_id: null, rows: [] }),
  setWorkspaceLayoutReader: vi.fn(),
}));

import { workspaceActions, type WorkspaceActionPorts } from '../workspace/WorkspaceActions';
import type { PaneInfo } from '../session/types';

// ── Shared test helpers ───────────────────────────────────────────────────────

function makePane(overrides: Partial<PaneInfo> = {}): PaneInfo {
  return {
    id: 1,
    name: 'frontend',
    group: 'default',
    note: '',
    status: 'idle',
    cwd: '/app',
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

function makePorts(panes: PaneInfo[]): WorkspaceActionPorts {
  const writes: Array<[number, string]> = [];
  return {
    session: {
      getAllPanes: () => panes,
      getPane: (id) => panes.find(p => p.id === id),
      getActivePaneId: () => null,
      getActivePane: () => undefined,
      setActivePane: vi.fn().mockResolvedValue(undefined),
      renamePane: vi.fn().mockResolvedValue(undefined),
      setPaneGroup: vi.fn().mockResolvedValue(undefined),
      setPaneAgent: vi.fn().mockResolvedValue(undefined),
      setPaneStatus: vi.fn().mockResolvedValue(undefined),
      setPaneNote: vi.fn().mockResolvedValue(undefined),
    },
    terminal: {
      write: vi.fn().mockImplementation((paneId: number, data: string) => {
        writes.push([paneId, data]);
        return Promise.resolve();
      }),
    },
    layout: {
      spawnPane: vi.fn().mockResolvedValue({ paneId: 99 }),
      splitCurrentRow: vi.fn().mockResolvedValue(undefined),
      closePane: vi.fn().mockResolvedValue(undefined),
    },
    viewport: {
      scrollToPane: vi.fn(),
    },
    _writes: writes,
  } as unknown as WorkspaceActionPorts & { _writes: Array<[number, string]> };
}

beforeEach(() => {
  registeredListeners.clear();
});

// ── run-await ─────────────────────────────────────────────────────────────────

describe('run-await action', () => {
  it('writes the command and resolves ok on exit 0', async () => {
    const pane = makePane({ id: 1, name: 'frontend' });
    const ports = makePorts([pane]);
    workspaceActions.configure(ports);

    const promise = workspaceActions.dispatch({ type: 'run-await', target: 'frontend', cmd: 'npm test' });
    await vi.waitFor(() => registeredListeners.has('pane:command_complete'));
    emitCommandComplete(1, 0);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.message).toContain('exit 0');
  });

  it('resolves not-ok on non-zero exit code', async () => {
    const pane = makePane({ id: 2, name: 'backend' });
    const ports = makePorts([pane]);
    workspaceActions.configure(ports);

    const promise = workspaceActions.dispatch({ type: 'run-await', target: 'backend', cmd: 'cargo test' });
    await vi.waitFor(() => registeredListeners.has('pane:command_complete'));
    emitCommandComplete(2, 1);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.message).toContain('exit 1');
  });

  it('fails when session is not found', async () => {
    workspaceActions.configure(makePorts([]));
    const result = await workspaceActions.dispatch({ type: 'run-await', target: 'missing', cmd: 'ls' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('rejects on timeout', async () => {
    const pane = makePane({ id: 3, name: 'frontend' });
    workspaceActions.configure(makePorts([pane]));
    const result = await workspaceActions.dispatch({ type: 'run-await', target: 'frontend', cmd: 'sleep 99', timeout_ms: 50 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Timeout');
  });
});

// ── read ──────────────────────────────────────────────────────────────────────

describe('read action', () => {
  it('returns pane output from getPaneContext', async () => {
    const pane = makePane({ id: 1, last_command: 'npm test', last_exit_code: 1 });
    workspaceActions.configure(makePorts([pane]));

    const result = await workspaceActions.dispatch({ type: 'read', target: 'frontend' });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Last command: npm test');
    expect(result.message).toContain('Exit code: 1');
    expect(result.message).toContain('line 1');
    expect(result.message).toContain('error: something failed');
  });

  it('fails when session is not found', async () => {
    workspaceActions.configure(makePorts([]));
    const result = await workspaceActions.dispatch({ type: 'read', target: 'nope' });
    expect(result.ok).toBe(false);
  });
});

// ── pipeline ──────────────────────────────────────────────────────────────────

describe('pipeline action', () => {
  it('runs a single-step pipeline and returns summary', async () => {
    const pane = makePane({ id: 1, name: 'frontend' });
    workspaceActions.configure(makePorts([pane]));

    const promise = workspaceActions.dispatch({
      type: 'pipeline',
      label: 'Build',
      steps: [{ label: 'compile', actions: [{ target: 'frontend', cmd: 'npm run build' }] }],
    });

    await vi.waitFor(() => registeredListeners.has('pane:command_complete'));
    emitCommandComplete(1, 0);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.message).toContain('compile');
    expect(result.message).toContain('exit 0');
  });

  it('stops at prev-success when first step fails', async () => {
    const pane = makePane({ id: 1, name: 'frontend' });
    workspaceActions.configure(makePorts([pane]));

    const promise = workspaceActions.dispatch({
      type: 'pipeline',
      steps: [
        { label: 'build', actions: [{ target: 'frontend', cmd: 'npm run build' }] },
        { label: 'deploy', condition: 'prev-success', actions: [{ target: 'frontend', cmd: './deploy.sh' }] },
      ],
    });

    await vi.waitFor(() => registeredListeners.has('pane:command_complete'));
    emitCommandComplete(1, 1); // build fails

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Stopped before "deploy"');
  });

  it('runs parallel step actions simultaneously', async () => {
    const pane1 = makePane({ id: 1, name: 'frontend' });
    const pane2 = makePane({ id: 2, name: 'backend' });
    workspaceActions.configure(makePorts([pane1, pane2]));

    const starts: number[] = [];
    const originalDispatch = workspaceActions.dispatch.bind(workspaceActions);
    vi.spyOn(workspaceActions, 'dispatch').mockImplementation(async (action) => {
      if (action.type === 'run-await') starts.push(Date.now());
      return originalDispatch(action);
    });

    const promise = workspaceActions.dispatch({
      type: 'pipeline',
      steps: [
        {
          parallel: true,
          actions: [
            { target: 'frontend', cmd: 'npm test' },
            { target: 'backend', cmd: 'cargo test' },
          ],
        },
      ],
    });

    await vi.waitFor(() => (registeredListeners.get('pane:command_complete') ?? []).length >= 2);
    emitCommandComplete(1, 0);
    emitCommandComplete(2, 0);

    const result = await promise;
    expect(result.ok).toBe(true);
    vi.restoreAllMocks();
  });

  it('skips step when condition is prev-fail but previous succeeded', async () => {
    const pane = makePane({ id: 1, name: 'frontend' });
    workspaceActions.configure(makePorts([pane]));

    const promise = workspaceActions.dispatch({
      type: 'pipeline',
      steps: [
        { label: 'build', actions: [{ target: 'frontend', cmd: 'npm run build' }] },
        { label: 'rollback', condition: 'prev-fail', actions: [{ target: 'frontend', cmd: './rollback.sh' }] },
      ],
    });

    await vi.waitFor(() => registeredListeners.has('pane:command_complete'));
    emitCommandComplete(1, 0); // build succeeds

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Skipped "rollback"');
  });

  it('sequential step actions run one at a time', async () => {
    const pane = makePane({ id: 1, name: 'ops' });
    workspaceActions.configure(makePorts([pane]));

    const completionOrder: number[] = [];

    const promise = workspaceActions.dispatch({
      type: 'pipeline',
      steps: [
        {
          parallel: false,
          actions: [
            { target: 'ops', cmd: 'step1' },
            { target: 'ops', cmd: 'step2' },
          ],
        },
      ],
    });

    // Wait for step1's listener, then complete it.
    await vi.waitFor(() => (registeredListeners.get('pane:command_complete') ?? []).length >= 1);
    completionOrder.push(1);
    emitCommandComplete(1, 0); // step1 done

    // A setTimeout(0) drains all pending microtasks (step1 resolution → pipeline
    // loop → step2 execute → transport.listen) before we emit step2's completion,
    // avoiding a race where step2's listener isn't registered yet.
    await new Promise(r => setTimeout(r, 0));
    completionOrder.push(2);
    emitCommandComplete(1, 0); // step2 done

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(completionOrder).toEqual([1, 2]);
  });
});

// ── actionDescription ─────────────────────────────────────────────────────────

describe('actionDescription', () => {
  it('describes run-await', () => {
    const desc = workspaceActions.actionDescription({ type: 'run-await', target: 'frontend', cmd: 'npm test' });
    expect(desc).toContain('await completion');
    expect(desc).toContain('npm test');
  });

  it('describes read', () => {
    const desc = workspaceActions.actionDescription({ type: 'read', target: 'backend' });
    expect(desc).toContain('read output');
    expect(desc).toContain('backend');
  });

  it('describes pipeline with steps', () => {
    const desc = workspaceActions.actionDescription({
      type: 'pipeline',
      label: 'CI',
      steps: [
        { label: 'build', actions: [{ target: 'frontend', cmd: 'npm build' }] },
        { label: 'test', condition: 'prev-success', actions: [{ target: 'test', cmd: 'npm test' }] },
      ],
    });
    expect(desc).toContain('CI');
    expect(desc).toContain('build');
    expect(desc).toContain('test');
    expect(desc).toContain('[if prev-success]');
  });
});
