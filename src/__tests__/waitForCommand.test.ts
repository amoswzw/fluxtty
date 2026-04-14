import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture listener registrations so tests can fire events manually.
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

function emit(event: string, payload: unknown) {
  for (const handler of registeredListeners.get(event) ?? []) {
    handler(payload);
  }
}

import { waitForCommandComplete } from '../workspace/waitForCommand';

beforeEach(() => {
  registeredListeners.clear();
});

describe('waitForCommandComplete', () => {
  it('resolves with exit code when pane:command_complete fires for matching pane', async () => {
    const promise = waitForCommandComplete(3);
    await vi.waitFor(() => registeredListeners.has('pane:command_complete'));
    emit('pane:command_complete', { pane_id: 3, exit_code: 0 });
    const result = await promise;
    expect(result.exitCode).toBe(0);
  });

  it('resolves with non-zero exit code on failure', async () => {
    const promise = waitForCommandComplete(5);
    await vi.waitFor(() => registeredListeners.has('pane:command_complete'));
    emit('pane:command_complete', { pane_id: 5, exit_code: 127 });
    const result = await promise;
    expect(result.exitCode).toBe(127);
  });

  it('ignores events for a different pane', async () => {
    const promise = waitForCommandComplete(10, 100);
    await vi.waitFor(() => registeredListeners.has('pane:command_complete'));
    // Fire for a different pane — should be ignored.
    emit('pane:command_complete', { pane_id: 99, exit_code: 0 });
    // The promise should timeout because pane 10 never completes.
    await expect(promise).rejects.toThrow('Timeout');
  });

  it('rejects on timeout', async () => {
    const promise = waitForCommandComplete(7, 50);
    await expect(promise).rejects.toThrow('Timeout waiting for pane 7');
  });

  it('unsubscribes after resolving (no memory leak)', async () => {
    const promise = waitForCommandComplete(4);
    await vi.waitFor(() => registeredListeners.has('pane:command_complete'));
    emit('pane:command_complete', { pane_id: 4, exit_code: 0 });
    await promise;
    // A second event for the same pane should not throw.
    expect(() => emit('pane:command_complete', { pane_id: 4, exit_code: 1 })).not.toThrow();
  });
});
