// Stub for @tauri-apps/api/core used in tests.
// Individual tests override transport.send via vi.mock('../transport').
export function invoke(_cmd: string, _args?: unknown): Promise<unknown> {
  return Promise.resolve(undefined);
}
