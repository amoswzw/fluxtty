import { transport } from '../transport';
import type { AgentType } from '../session/types';

interface PtyDataPayload {
  pane_id: number;
  data: string;
}

/**
 * Per-agent patterns that indicate the agent has returned to "waiting for input".
 * These are the prompt indicators each CLI agent shows between turns.
 */
const AGENT_READY_PATTERNS: Partial<Record<AgentType, RegExp[]>> = {
  claude: [
    /(^|\n)>\s*$/,   // Claude CLI's ">" prompt on its own line
    /❯\s*$/,         // Claude Code's ❯ prompt
  ],
  codex: [
    /(^|\n)codex>\s*$/i,
  ],
  aider: [
    /(^|\n)aider>\s*$/i,
  ],
};

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')   // CSI sequences (colors, cursor moves)
    .replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*?(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b[^[]/g, '');                  // other two-char escapes
}

/**
 * Waits for an AI agent running in `paneId` to finish its current response turn.
 *
 * Subscribes to the PTY data stream and resolves when the agent's "ready" prompt
 * pattern is detected after at least some output has arrived (i.e., after the
 * agent actually did something). Falls back to a 2-second stability window for
 * unknown agent types.
 *
 * Returns the ANSI-stripped PTY output accumulated since the call started.
 */
export function waitForAgentTurn(
  paneId: number,
  agentType: AgentType,
  timeoutMs = 120_000,
): Promise<string> {
  const patterns = AGENT_READY_PATTERNS[agentType];

  return new Promise((resolve, reject) => {
    let unlisten: (() => void) | null = null;
    let settled = false;
    let gotOutput = false;
    let buffer = '';
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const done = (ok: boolean, reason?: string) => {
      if (settled) return;
      settled = true;
      unlisten?.();
      clearTimeout(globalTimer);
      if (silenceTimer) clearTimeout(silenceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      if (ok) resolve(stripAnsi(buffer).replace(/\r/g, '\n'));
      else reject(new Error(reason));
    };

    const globalTimer = setTimeout(() => {
      // On timeout: if we got any output, resolve optimistically (agent may have
      // finished but its prompt didn't match our pattern). Otherwise reject.
      if (gotOutput) done(true);
      else done(false, `Agent in pane ${paneId} did not respond within ${timeoutMs}ms`);
    }, timeoutMs);

    if (!patterns || patterns.length === 0) {
      // Unknown agent type: resolve after 2s of silence following first output.
      transport.listen<PtyDataPayload>(`pty-data-${paneId}`, (payload) => {
        if (settled) return;
        gotOutput = true;
        buffer += payload.data;
        if (buffer.length > 16_000) buffer = buffer.slice(-16_000);
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => done(true), 2_000);
      }).then(fn => {
        if (settled) fn();
        else unlisten = fn;
      }).catch(err => {
        done(false, err instanceof Error ? err.message : String(err));
      });
      return;
    }

    // Pattern-based: accumulate output, watch for the agent's "ready" prompt.
    transport.listen<PtyDataPayload>(`pty-data-${paneId}`, (payload) => {
      if (settled) return;
      gotOutput = true;

      buffer += payload.data;
      if (buffer.length > 16_000) buffer = buffer.slice(-16_000);

      const clean = stripAnsi(buffer);
      if (patterns.some(p => p.test(clean))) {
        // Prompt detected — brief settling window to absorb any trailing output.
        if (!settleTimer) {
          settleTimer = setTimeout(() => done(true), 150);
        }
      } else if (settleTimer) {
        // More output arrived after we thought we saw the prompt — reset.
        clearTimeout(settleTimer);
        settleTimer = null;
      }
    }).then(fn => {
      if (settled) fn();
      else unlisten = fn;
    }).catch(err => {
      done(false, err instanceof Error ? err.message : String(err));
    });
  });
}
