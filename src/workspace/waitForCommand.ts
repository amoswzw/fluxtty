import { transport } from '../transport';

interface CommandCompletePayload {
  pane_id: number;
  exit_code: number;
}

/**
 * Waits for the shell in `paneId` to emit an OSC 133;D sequence, which the
 * Rust backend translates into a `pane:command_complete` event.
 *
 * Limitation: if another command completes in the same pane before the one you
 * just wrote (e.g. a background job), this promise resolves early. Callers that
 * need stricter sequencing should snapshot `PaneInfo.last_exit_code` before
 * writing and compare after resolving.
 */
export function waitForCommandComplete(
  paneId: number,
  timeoutMs = 60_000,
): Promise<{ exitCode: number }> {
  return new Promise((resolve, reject) => {
    let unlisten: (() => void) | null = null;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unlisten?.();
      reject(new Error(`Timeout waiting for pane ${paneId} to complete (${timeoutMs}ms)`));
    }, timeoutMs);

    transport.listen<CommandCompletePayload>('pane:command_complete', (payload) => {
      if (payload.pane_id !== paneId || settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten?.();
      resolve({ exitCode: payload.exit_code });
    }).then(fn => { unlisten = fn; });
  });
}
