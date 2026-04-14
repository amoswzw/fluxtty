import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock all external dependencies ────────────────────────────────────────────

vi.mock('../transport', () => ({
  transport: { send: vi.fn().mockResolvedValue(null), listen: vi.fn().mockResolvedValue(() => {}) },
}));

// vi.mock is hoisted to the top of the file before variable declarations, so
// mockComplete must be declared with vi.hoisted() to be accessible in the factory.
const { mockComplete } = vi.hoisted(() => ({ mockComplete: vi.fn() }));
vi.mock('../ai/llm-client', () => ({
  llmClient: { complete: mockComplete },
}));

vi.mock('../config/ConfigContext', () => ({
  configContext: {
    get: vi.fn().mockReturnValue({
      workspace_ai: { model: 'claude-test', provider: null, api_key_env: 'ANTHROPIC_API_KEY', base_url: null },
    }),
  },
}));

vi.mock('../session/SessionManager', () => ({
  sessionManager: {
    getAllPanes: vi.fn().mockReturnValue([]),
    getActivePaneId: vi.fn().mockReturnValue(null),
    getActivePane: vi.fn().mockReturnValue(undefined),
  },
}));

vi.mock('../workspace/WorkspaceActions', () => ({
  workspaceActions: {
    dispatch: vi.fn().mockResolvedValue({ ok: true, message: 'done', action: {} }),
    queueActionBatch: vi.fn().mockResolvedValue('Plan: queued\nConfirm? (y/n)'),
    getLog: vi.fn().mockReturnValue([]),
    configure: vi.fn(),
    findPane: vi.fn(),
    actionDescription: vi.fn().mockReturnValue('action desc'),
  },
  actionDescription: vi.fn().mockReturnValue('action desc'),
}));

vi.mock('../workspace/WorkspaceState', () => ({
  formatWorkspaceContext: vi.fn().mockReturnValue('  1. shell [default] idle auto-name cwd:/home'),
  serializeWorkspaceState: vi.fn().mockReturnValue({ panes: [], active_pane_id: null, rows: [] }),
  setWorkspaceLayoutReader: vi.fn(),
}));

vi.mock('../ai/plan-executor', () => ({
  planExecutor: {
    setPending: vi.fn(),
    getPlanPreview: vi.fn().mockReturnValue('Plan: ...\nConfirm? (y/n)'),
    isWaitingForConfirm: vi.fn().mockReturnValue(false),
    handleConfirm: vi.fn().mockResolvedValue('Done.'),
    enqueue: vi.fn(),
    clearAll: vi.fn(),
    pendingCount: vi.fn().mockReturnValue(0),
  },
  setPlanLogFn: vi.fn(),
}));

import { aiHandler } from '../ai/ai-handler';

beforeEach(() => {
  aiHandler.resetHistory();
  mockComplete.mockReset();
  vi.clearAllMocks();
  // Restore mock implementations cleared by clearAllMocks
  mockComplete.mockResolvedValue('No action needed.');
});

// ── Conversation history ──────────────────────────────────────────────────────

describe('AIHandler conversation history', () => {
  it('includes prior turns in subsequent calls', async () => {
    mockComplete
      .mockResolvedValueOnce('First response.')
      .mockResolvedValueOnce('Second response.');

    await aiHandler.handle('first message');
    await aiHandler.handle('second message');

    const secondCallMessages = mockComplete.mock.calls[1][0] as Array<{ role: string; content: string }>;
    const roles = secondCallMessages.map(m => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');

    // First user message and assistant response should appear in second call
    const contents = secondCallMessages.map(m => m.content);
    expect(contents).toContain('first message');
    expect(contents).toContain('First response.');
    expect(contents).toContain('second message');
  });

  it('always places system prompt first', async () => {
    mockComplete.mockResolvedValue('ok');
    await aiHandler.handle('hello');
    await aiHandler.handle('world');

    for (const call of mockComplete.mock.calls) {
      const messages = call[0] as Array<{ role: string }>;
      expect(messages[0].role).toBe('system');
    }
  });

  it('resetHistory clears conversation', async () => {
    mockComplete.mockResolvedValue('response');
    await aiHandler.handle('turn one');
    aiHandler.resetHistory();
    await aiHandler.handle('fresh start');

    const messages = mockComplete.mock.calls[1][0] as Array<{ role: string; content: string }>;
    const contents = messages.map(m => m.content);
    expect(contents).not.toContain('turn one');
  });

  it('trims history beyond MAX_HISTORY_TURNS (10 turns = 20 messages)', async () => {
    mockComplete.mockResolvedValue('ok');
    // Send 11 turns — history should stay at 10 turns (20 messages) max.
    for (let i = 0; i < 11; i++) {
      await aiHandler.handle(`message ${i}`);
    }

    const lastCall = mockComplete.mock.calls[10][0] as Array<{ role: string; content: string }>;
    // system prompt (1) + at most 10 turns (20) + current user (1) = 22 max
    // After trimming oldest pair: system + 10 turns + current = 22
    const nonSystem = lastCall.filter(m => m.role !== 'system');
    expect(nonSystem.length).toBeLessThanOrEqual(21); // 10 history turns + 1 current
  });
});

// ── System prompt contents ────────────────────────────────────────────────────

describe('system prompt', () => {
  it('includes new action types: run-await, read, pipeline', async () => {
    mockComplete.mockResolvedValue('ok');
    await aiHandler.handle('test');

    const systemMsg = (mockComplete.mock.calls[0][0] as Array<{ role: string; content: string }>)
      .find(m => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain('run-await');
    expect(systemMsg!.content).toContain('read');
    expect(systemMsg!.content).toContain('pipeline');
  });

  it('rebuilds workspace context on every call (no stale snapshot)', async () => {
    const { formatWorkspaceContext } = await import('../workspace/WorkspaceState');
    mockComplete.mockResolvedValue('ok');
    await aiHandler.handle('call 1');
    await aiHandler.handle('call 2');
    expect(vi.mocked(formatWorkspaceContext).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Action execution ──────────────────────────────────────────────────────────

describe('AIHandler action routing', () => {
  it('queues workspace-changing model actions for confirmation', async () => {
    const { workspaceActions } = await import('../workspace/WorkspaceActions');
    mockComplete.mockResolvedValue([
      'I will run it.',
      '```action',
      '{"type":"run","target":"frontend","cmd":"npm test"}',
      '```',
    ].join('\n'));

    const result = await aiHandler.handle('run tests');

    expect(result).toContain('Plan: queued');
    expect(vi.mocked(workspaceActions.queueActionBatch)).toHaveBeenCalledWith(
      expect.stringContaining('action desc'),
      [{ type: 'run', target: 'frontend', cmd: 'npm test' }],
      { source: 'ai' },
    );
    expect(vi.mocked(workspaceActions.dispatch)).not.toHaveBeenCalled();
  });

  it('executes read actions immediately', async () => {
    const { workspaceActions } = await import('../workspace/WorkspaceActions');
    mockComplete.mockResolvedValue([
      '```action',
      '{"type":"read","target":"frontend"}',
      '```',
    ].join('\n'));

    const result = await aiHandler.handle('read frontend');

    expect(result).toContain('done');
    expect(vi.mocked(workspaceActions.dispatch)).toHaveBeenCalledWith(
      { type: 'read', target: 'frontend' },
      { source: 'ai' },
    );
    expect(vi.mocked(workspaceActions.queueActionBatch)).not.toHaveBeenCalled();
  });

  it('accepts an array of actions in one action block', async () => {
    const { workspaceActions } = await import('../workspace/WorkspaceActions');
    mockComplete.mockResolvedValue([
      '```action',
      '[',
      '  {"type":"new","name":"server"},',
      '  {"type":"focus","target":"server"}',
      ']',
      '```',
    ].join('\n'));

    await aiHandler.handle('set up server');

    expect(vi.mocked(workspaceActions.dispatch)).toHaveBeenCalledWith(
      { type: 'focus', target: 'server' },
      { source: 'ai' },
    );
    expect(vi.mocked(workspaceActions.queueActionBatch)).toHaveBeenCalledWith(
      expect.stringContaining('action desc'),
      [{ type: 'new', name: 'server' }],
      { source: 'ai' },
    );
  });
});
