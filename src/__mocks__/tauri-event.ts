// Stub for @tauri-apps/api/event used in tests.
// Individual tests override transport.listen via vi.mock('../transport').
export type UnlistenFn = () => void;

export function listen<T>(
  _event: string,
  _handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return Promise.resolve(() => {});
}
