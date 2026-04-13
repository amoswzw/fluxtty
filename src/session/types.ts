export type SessionStatus = 'idle' | 'running' | 'error';

export type AgentType = 'none' | 'claude' | 'codex' | 'aider' | 'unknown';

export type PaneNameSource = 'auto' | 'manual';

export interface PaneInfo {
  id: number;
  name: string;
  group: string;
  note: string;
  status: SessionStatus;
  cwd: string;
  name_source: PaneNameSource;
  agent_type: AgentType;
  row_index: number;
  pane_index: number;
  /** Last command submitted to the shell (from OSC 133;B). Null until first command runs. */
  last_command: string | null;
  /** Exit code of the last completed command (from OSC 133;D). Null until first command completes. */
  last_exit_code: number | null;
  /** Whether the pane is currently in alternate screen mode (e.g. vim, htop). */
  alternate_screen: boolean;
}

export interface RowInfo {
  pane_ids: number[];
}

export interface WorkspaceLayout {
  rows: RowInfo[];
  active_pane_id: number | null;
}

export type InputMode =
  | { type: 'normal' }                      // default: vi normal — navigation + inline command via :
  | { type: 'ai' }                          // a: free-form chat with Workspace AI
  | { type: 'insert' }                      // i: line editor → active pane PTY (agent-aware)
  | { type: 'terminal'; paneId: number }    // Ctrl+\: xterm owns raw keyboard
  | { type: 'pane-selector'; query: string }; // /: fuzzy pane search

export const AGENT_SLASH_COMMANDS: Record<AgentType, string[]> = {
  none: [],
  unknown: [],
  claude: [
    '/help', '/clear', '/compact', '/cost', '/doctor',
    '/exit', '/ide', '/init', '/login', '/logout',
    '/memory', '/mcp', '/model', '/permissions', '/pr_comments',
    '/release-notes', '/review', '/status', '/terminal',
    '/vim', '/bug', '/add-dir',
  ],
  codex: [
    '/help', '/clear', '/exit', '/run', '/diff',
    '/undo', '/explain', '/context',
  ],
  aider: [
    '/help', '/clear', '/exit', '/add', '/drop',
    '/ls', '/diff', '/undo', '/git', '/run',
    '/ask', '/model', '/voice',
  ],
};
