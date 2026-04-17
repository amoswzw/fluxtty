import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KeybindingManager } from '../keybindings/KeybindingManager';

const windowApi = vi.hoisted(() => ({
  close: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    close: windowApi.close,
  }),
}));

function makeKeyEvent(overrides: Partial<KeyboardEvent> = {}) {
  let defaultPrevented = false;
  const event = {
    key: 'q',
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    get defaultPrevented() {
      return defaultPrevented;
    },
    preventDefault: vi.fn(() => {
      defaultPrevented = true;
    }),
    stopPropagation: vi.fn(),
    ...overrides,
  };

  return event as unknown as KeyboardEvent;
}

describe('KeybindingManager', () => {
  beforeEach(() => {
    windowApi.close.mockClear();
  });

  it('consumes Cmd+Q before it can reach normal-mode q handling', () => {
    const quit = vi.fn();
    const manager = new KeybindingManager() as unknown as {
      handlers: unknown;
      dispatch: (event: KeyboardEvent) => void;
    };

    manager.handlers = {
      waterfallArea: {},
      sidebar: {},
      openSettings: vi.fn(),
      quit,
    };

    const event = makeKeyEvent();
    manager.dispatch(event);

    expect(event.defaultPrevented).toBe(true);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(windowApi.close).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });
});
