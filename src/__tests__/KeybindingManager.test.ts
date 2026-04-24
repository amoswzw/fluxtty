import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KeybindingManager } from '../keybindings/KeybindingManager';
import { configContext } from '../config/ConfigContext';
import { modeManager } from '../input/ModeManager';

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
    vi.restoreAllMocks();
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

  it('does not steal Ctrl bindings from insert-mode shell editing', () => {
    vi.spyOn(modeManager, 'getMode').mockReturnValue({ type: 'insert' });
    vi.spyOn(configContext, 'get').mockReturnValue({
      keybindings: [
        { key: 'B', mods: 'Control', action: 'ToggleSidebar' },
      ],
    } as never);

    const manager = new KeybindingManager() as unknown as {
      handlers: unknown;
      dispatch: (event: KeyboardEvent) => void;
      executeAction: ReturnType<typeof vi.fn>;
    };

    manager.handlers = {
      waterfallArea: {},
      sidebar: {},
      openSettings: vi.fn(),
      quit: vi.fn(),
    };
    manager.executeAction = vi.fn();

    const event = makeKeyEvent({
      key: 'b',
      metaKey: false,
      ctrlKey: true,
      target: { tagName: 'INPUT' } as unknown as EventTarget,
    });

    manager.dispatch(event);

    expect(event.defaultPrevented).toBe(false);
    expect(manager.executeAction).not.toHaveBeenCalled();
  });

  it('lets shift-modified Ctrl bindings reach matchAction in insert mode', () => {
    vi.spyOn(modeManager, 'getMode').mockReturnValue({ type: 'insert' });
    vi.spyOn(configContext, 'get').mockReturnValue({
      keybindings: [
        { key: 'C', mods: 'Control|Shift', action: 'Copy' },
      ],
    } as never);

    const manager = new KeybindingManager() as unknown as {
      handlers: unknown;
      dispatch: (event: KeyboardEvent) => void;
      executeAction: ReturnType<typeof vi.fn>;
    };

    manager.handlers = {
      waterfallArea: {},
      sidebar: {},
      openSettings: vi.fn(),
      quit: vi.fn(),
    };
    manager.executeAction = vi.fn();

    const event = makeKeyEvent({
      key: 'C',
      metaKey: false,
      ctrlKey: true,
      shiftKey: true,
      target: { tagName: 'INPUT' } as unknown as EventTarget,
    });

    manager.dispatch(event);

    expect(manager.executeAction).toHaveBeenCalledWith('Copy');
  });

  it('still fires Ctrl+F SearchPane fallback while in insert mode on non-Mac', () => {
    vi.spyOn(modeManager, 'getMode').mockReturnValue({ type: 'insert' });
    vi.spyOn(configContext, 'get').mockReturnValue({ keybindings: [] } as never);

    const manager = new KeybindingManager() as unknown as {
      handlers: unknown;
      dispatch: (event: KeyboardEvent) => void;
      executeAction: ReturnType<typeof vi.fn>;
    };

    manager.handlers = {
      waterfallArea: {},
      sidebar: {},
      openSettings: vi.fn(),
      quit: vi.fn(),
    };
    manager.executeAction = vi.fn();

    const event = makeKeyEvent({
      key: 'f',
      metaKey: false,
      ctrlKey: true,
      target: { tagName: 'INPUT' } as unknown as EventTarget,
    });

    manager.dispatch(event);

    expect(manager.executeAction).toHaveBeenCalledWith('SearchPane');
  });
});
