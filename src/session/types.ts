export type SessionStatus = 'idle' | 'running' | 'error';

export type AgentType =
  | 'none'
  | 'claude'
  | 'codex'
  | 'aider'
  | 'gemini'
  | 'opencode'
  | 'goose'
  | 'cursor'
  | 'qwen'
  | 'amp'
  | 'crush'
  | 'openhands'
  | 'unknown';

export type PaneNameSource = 'auto' | 'manual';

export interface PaneInfo {
  id: number;
  name: string;
  group: string;
  note: string;
  status: SessionStatus;
  cwd: string;
  /** tmux session attached by this pane when tmux launch is enabled. Null for normal PTYs. */
  tmux_session: string | null;
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
  | { type: 'view'; paneId: number }        // v: show only the active row (i → insert, click → terminal, Esc → normal)
  | { type: 'ai' }                          // a: free-form chat with Workspace AI
  | { type: 'insert' }                      // i: line editor → active pane PTY (agent-aware)
  | { type: 'terminal'; paneId: number }    // Ctrl+\: xterm owns raw keyboard
  | { type: 'pane-selector'; query: string }  // fuzzy pane search (reachable via sidebar)
  | { type: 'pane-search'; paneId: number; query: string }; // /: in-terminal content search

export const AGENT_LABELS: Record<AgentType, string> = {
  none: '',
  claude: 'Claude',
  codex: 'Codex',
  aider: 'Aider',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  goose: 'Goose',
  cursor: 'Cursor',
  qwen: 'Qwen',
  amp: 'Amp',
  crush: 'Crush',
  openhands: 'OpenHands',
  unknown: 'Agent',
};

const COMMON_AGENT_SLASH_COMMANDS = [
  '/help', '/clear', '/exit', '/quit', '/model',
  '/models', '/status', '/init', '/reset', '/undo', '/diff',
];

export const AGENT_SLASH_COMMANDS: Record<AgentType, string[]> = {
  none: [],
  unknown: COMMON_AGENT_SLASH_COMMANDS,
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
  gemini: [
    '/help', '/clear', '/compress', '/quit', '/stats',
    '/tools', '/mcp', '/memory', '/chat', '/model',
  ],
  opencode: [
    '/help', '/clear', '/exit', '/models', '/model',
    '/sessions', '/share', '/init', '/undo', '/redo',
  ],
  goose: COMMON_AGENT_SLASH_COMMANDS,
  cursor: COMMON_AGENT_SLASH_COMMANDS,
  qwen: COMMON_AGENT_SLASH_COMMANDS,
  amp: COMMON_AGENT_SLASH_COMMANDS,
  crush: COMMON_AGENT_SLASH_COMMANDS,
  openhands: COMMON_AGENT_SLASH_COMMANDS,
};
