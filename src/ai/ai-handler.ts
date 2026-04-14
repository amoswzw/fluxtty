import { sessionManager } from '../session/SessionManager';
import { llmClient, type LLMMessage } from './llm-client';
import { configContext } from '../config/ConfigContext';
import { workspaceActions, actionDescription, type WorkspaceAction } from '../workspace/WorkspaceActions';
import { formatWorkspaceContext, serializeWorkspaceState } from '../workspace/WorkspaceState';

// ---------------------------------------------------------------------------
// Workspace context system prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  const workspaceState = serializeWorkspaceState();
  const workspaceContext = formatWorkspaceContext(workspaceState);
  const workspaceJson = JSON.stringify(workspaceState, null, 2);

  const recentLog = workspaceActions.getLog().slice(-5);
  const recentActions = recentLog.length > 0
    ? '\nRecent actions:\n' + recentLog
        .filter(e => e.result != null)
        .map(e => `  ${e.result!.ok ? '✓' : '✗'} ${actionDescription(e.action)} → ${e.result!.message}`)
        .join('\n')
    : '';

  return `You are the Workspace AI for FluXTTY, a multi-session developer terminal.
Act directly. Run commands, manage sessions, get things done.
Keep responses short — one sentence max unless the user asked a question.
Do not describe the workspace state unless asked. Do not narrate what you are about to do.

Current workspace summary:
${workspaceContext}

Structured workspace state:
\`\`\`json
${workspaceJson}
\`\`\`${recentActions}

To execute a workspace action, include a fenced action block:

\`\`\`action
{"type": "run", "cmd": "npm test", "target": "frontend"}
\`\`\`

Available actions (workspace-changing actions are queued for user confirmation):

Shell actions (use when agent_type = "none"):
• run        – fire-and-forget shell command        → {"type":"run","cmd":"...","target":"<name or id>"}
• run-await  – run shell command, wait for exit     → {"type":"run-await","cmd":"...","target":"<name or id>","timeout_ms":30000}
• read       – read recent output from a session    → {"type":"read","target":"<name or id>"}
• pipeline   – multi-step cross-session execution   → {"type":"pipeline","label":"...","steps":[{"label":"...","parallel":true,"condition":"prev-success","actions":[{"target":"...","cmd":"..."}]}]}
• broadcast  – run in ALL sessions                  → {"type":"broadcast","cmd":"..."}
• run-group  – run in all sessions of a group       → {"type":"run-group","cmd":"...","group":"<group>"}

Agent actions (use when agent_type != "none"):
• agent-send – send a task to an agent, wait for response → {"type":"agent-send","target":"<name or id>","message":"...","timeout_ms":120000}
              Returns the agent's response text. For long tasks use a larger timeout_ms.
              Chain multiple agent-send actions to coordinate across agent panes.

Session management:
• new        – create a new session                 → {"type":"new","name":"...","group":"..."}
• rename     – rename a session                     → {"type":"rename","target":"...","name":"..."}
• close      – close a session                      → {"type":"close","target":"..."}
• close-group – close all sessions in a group       → {"type":"close-group","group":"<group>"}
• split      – split current row                    → {"type":"split"}
• focus      – navigate to a session                → {"type":"focus","target":"<name>"}
• group      – assign session to a group            → {"type":"group","target":"...","group":"<group>"}
• note       – set a note on a session              → {"type":"note","target":"...","text":"<note>"}
• clear      – clear terminal output                → {"type":"clear","target":"<name>"}
• kill       – send Ctrl+C to interrupt a process   → {"type":"kill","target":"<name>"}

Rules:
- Check agent_type in session info before choosing an action: agents get agent-send, shells get run/run-await.
- Use run-await when you need shell command output before the next action.
- Use pipeline for multi-step shell work with dependencies.
- read/focus execute immediately; workspace-changing actions are queued for confirmation.
- Refer to sessions by name. If names are similar, use the numeric id.
- To coordinate multiple agents: chain agent-send calls; each blocks until the agent responds.`;
}

// ---------------------------------------------------------------------------
// Action block parsing
// ---------------------------------------------------------------------------

interface ParsedAction {
  type: string;
  [key: string]: unknown;
}

function extractActions(text: string): { actions: ParsedAction[]; cleanText: string } {
  const actions: ParsedAction[] = [];
  // Match ```action ... ``` blocks
  const cleanText = text.replace(/```action\s*\n([\s\S]*?)```/g, (_match, json) => {
    try {
      const obj = JSON.parse(json.trim());
      const parsed = Array.isArray(obj) ? obj : [obj];
      for (const action of parsed) {
        if (action && typeof action.type === 'string') actions.push(action);
      }
    } catch {
      // malformed — skip
    }
    return '';
  }).trim();

  return { actions, cleanText };
}

// ---------------------------------------------------------------------------
// Regex-based intent parser (fallback when model = none)
// ---------------------------------------------------------------------------

interface ParsedIntent {
  type: string;
  [key: string]: unknown;
}

function parseIntent(input: string): ParsedIntent | null {
  const s = input.trim();

  const runIn = s.match(/^run\s+(.+?)\s+in\s+(.+)$/i);
  if (runIn) return { type: 'run', cmd: runIn[1], target: runIn[2] };

  const runAll = s.match(/^(.+?)\s+in\s+all(\s+sessions?)?$/i);
  if (runAll) return { type: 'broadcast', cmd: runAll[1] };

  const runGroup = s.match(/^run\s+(.+?)\s+in\s+group\s+(\S+)$/i);
  if (runGroup) return { type: 'run-group', cmd: runGroup[1], group: runGroup[2] };

  const sequential = s.match(/^run\s+(.+?)\s+then\s+run\s+(.+?)\s+in\s+(.+)$/i);
  if (sequential) return { type: 'sequential', cmds: [sequential[1], sequential[2]], target: sequential[3] };

  const newIn = s.match(/^new\s+(\S+)\s+in\s+(.+)$/i);
  if (newIn) return { type: 'new', name: newIn[1], group: newIn[2] };

  const newS = s.match(/^new(\s+(\S+))?$/i);
  if (newS) return { type: 'new', name: newS[2] || null, group: null };

  const rename = s.match(/^rename\s+(.+?)\s+to\s+(.+)$/i);
  if (rename) return { type: 'rename', target: rename[1], name: rename[2] };

  const closeGroup = s.match(/^close\s+group\s+(\S+)$/i);
  if (closeGroup) return { type: 'close-group', group: closeGroup[1] };

  const close = s.match(/^close\s+(.+)$/i);
  if (close) return { type: 'close', target: close[1] };

  const focus = s.match(/^focus\s+(.+)$/i);
  if (focus) return { type: 'focus', target: focus[1] };

  const groupAssign = s.match(/^group\s+(.+?)\s+as\s+(\S+)$/i);
  if (groupAssign) return { type: 'group', target: groupAssign[1], group: groupAssign[2] };

  const note = s.match(/^note\s+(.+?)\s+(.+)$/i);
  if (note) return { type: 'note', target: note[1], text: note[2] };

  const clear = s.match(/^clear\s+(.+)$/i);
  if (clear) return { type: 'clear', target: clear[1] };

  const read = s.match(/^read\s+(.+)$/i);
  if (read) return { type: 'read', target: read[1] };

  const kill = s.match(/^kill\s+(.+)$/i);
  if (kill) return { type: 'kill', target: kill[1] };

  if (/^split$/i.test(s)) return { type: 'split' };
  if (/^(list|status)$/i.test(s)) return { type: 'list' };
  if (/^help$/i.test(s)) return { type: 'help' };

  const agent = s.match(/^!agent\s+(\S+)$/i);
  if (agent) return { type: 'set-agent', agentType: agent[1] };

  return null;
}

// ---------------------------------------------------------------------------
// Action classification
// ---------------------------------------------------------------------------

function toWorkspaceAction(action: ParsedAction): WorkspaceAction {
  if (action.type === 'set-agent' && typeof action.target !== 'string') {
    const activeId = sessionManager.getActivePaneId();
    return {
      type: 'set-agent',
      target: activeId == null ? '' : String(activeId),
      agentType: action.agentType as never,
    };
  }
  return action as WorkspaceAction;
}

async function dispatchImmediateAction(action: ParsedAction): Promise<string> {
  const result = await workspaceActions.dispatch(toWorkspaceAction(action), { source: 'ai' });
  return result.message;
}

const IMMEDIATE_AI_ACTION_TYPES = new Set(['read', 'focus']);

function isImmediateAiAction(action: ParsedAction): boolean {
  return IMMEDIATE_AI_ACTION_TYPES.has(action.type);
}

async function queueAiActions(actions: ParsedAction[]): Promise<string> {
  const workspaceActionsToQueue = actions.map(toWorkspaceAction);
  const title = workspaceActionsToQueue.length === 1
    ? actionDescription(workspaceActionsToQueue[0])
    : `AI plan (${workspaceActionsToQueue.length} actions)`;
  return workspaceActions.queueActionBatch(title, workspaceActionsToQueue, { source: 'ai' });
}


// ---------------------------------------------------------------------------
// Main AI handler
// ---------------------------------------------------------------------------

const MAX_HISTORY_TURNS = 10;

class AIHandler {
  private conversationHistory: LLMMessage[] = [];

  /** Clear the conversation history (e.g. on :clear or new session). */
  resetHistory(): void {
    this.conversationHistory = [];
  }

  async handle(input: string): Promise<string> {
    const cfg = configContext.get();
    const model = cfg.workspace_ai.model;

    // ── LLM path ──────────────────────────────────────────────────────
    if (model && model !== 'none') {
      try {
        const messages: LLMMessage[] = [
          { role: 'system', content: buildSystemPrompt() },
          ...this.conversationHistory,
          { role: 'user', content: input },
        ];
        const raw = await llmClient.complete(messages, cfg);

        // Update sliding conversation window
        this.conversationHistory.push({ role: 'user', content: input });
        this.conversationHistory.push({ role: 'assistant', content: raw });
        if (this.conversationHistory.length > MAX_HISTORY_TURNS * 2) {
          this.conversationHistory.splice(0, 2);
        }

        const { actions, cleanText } = extractActions(raw);

        if (actions.length === 0) {
          // Pure text response — just show it
          return raw;
        }

        const results: string[] = [];
        const changingActions: ParsedAction[] = [];
        for (const a of actions) {
          if (!isImmediateAiAction(a)) {
            changingActions.push(a);
            continue;
          }
          const result = await dispatchImmediateAction(a);
          if (result) results.push(result);
        }

        if (changingActions.length > 0) {
          results.push(await queueAiActions(changingActions));
        }

        const resultText = results.join('\n').trim();
        if (cleanText && resultText) return `${cleanText}\n\n${resultText}`;
        return cleanText || resultText || raw;

      } catch (err) {
        return `AI error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // ── Regex intent parser (model: none) ─────────────────────────────
    const intent = parseIntent(input);
    if (!intent) {
      return 'Unknown command. Type "help" for available commands, or configure workspace_ai.model to enable natural language.';
    }

    switch (intent.type) {
      // ── Read-only / non-destructive — execute immediately ──────────────
      case 'list': {
        const panes = sessionManager.getAllPanes();
        if (panes.length === 0) return 'No sessions.';
        return panes.map(p =>
          `  ${p.id}. ${p.name} [${p.group}] ${p.status}${p.agent_type !== 'none' ? ` (${p.agent_type})` : ''}`
        ).join('\n');
      }

      case 'set-agent': {
        const activeId = sessionManager.getActivePaneId();
        if (activeId == null) return 'No active session.';
        return dispatchImmediateAction({
          type: 'set-agent',
          target: String(activeId),
          agentType: intent.agentType,
        });
      }

      case 'focus':
        return dispatchImmediateAction(intent as ParsedAction);

      case 'help':
        return [
          'Built-in commands (model: none):',
          '  run <cmd> in <session>          – run command in one session',
          '  run <cmd> in group <group>      – run in all sessions of group (confirm)',
          '  <cmd> in all sessions           – run in every session (confirm)',
          '  run X then run Y in <session>   – sequential commands',
          '  new [name] [in <group>]         – create session',
          '  rename <session> to <name>      – rename session',
          '  close <session> | close idle    – close session(s)',
          '  close group <group>             – close all in group (confirm)',
          '  split                           – split current row',
          '  focus <session>                 – navigate to session',
          '  group <session> as <group>      – assign session to group',
          '  note <session> <text>           – set note on session',
          '  read <session>                  – read recent output',
          '  clear <session>                 – clear terminal output',
          '  kill <session>                  – send Ctrl+C to session',
          '  list | status                   – list all sessions',
          '  !agent <claude|codex|aider|gemini|opencode|goose|cursor|qwen|amp|crush|openhands|none>',
          '',
          'Set workspace_ai.model to an OpenCode-style provider/model id, for example anthropic/claude-sonnet-4-5.',
        ].join('\n');

      case 'read':
        return dispatchImmediateAction(intent as ParsedAction);

      // State-changing actions are queued through the shared confirmation queue.
      default:
        return queueAiActions([intent as ParsedAction]);
    }
  }
}

export const aiHandler = new AIHandler();
