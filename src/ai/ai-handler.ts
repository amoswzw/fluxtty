import { sessionManager } from '../session/SessionManager';
import { planExecutor } from './plan-executor';
import { llmClient, type LLMMessage } from './llm-client';
import { configContext } from '../config/ConfigContext';
import { workspaceActions, actionDescription, type WorkspaceAction } from '../workspace/WorkspaceActions';
import { formatWorkspaceContext } from '../workspace/WorkspaceState';

// ---------------------------------------------------------------------------
// Workspace context system prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  const workspaceContext = formatWorkspaceContext();

  return `You are the Workspace AI for FluXTTY, a multi-session developer terminal.
You help the user accomplish ANY task by running shell commands and managing sessions.
Use terminal commands freely to get things done — check status, run builds, edit files, whatever is needed.

Current sessions:
${workspaceContext}

To execute a workspace action, include a fenced action block in your response:

\`\`\`action
{"type": "run", "cmd": "npm test", "target": "frontend"}
\`\`\`

Available action types (★ = requires confirmation, safe to execute immediately otherwise):
• run        – run any shell command in one session → {"type":"run","cmd":"...","target":"<name or id>"}
• broadcast  ★ run in ALL sessions                 → {"type":"broadcast","cmd":"..."}
• run-group  ★ run in all sessions of a group      → {"type":"run-group","cmd":"...","group":"<group>"}
• new        – create a new session                → {"type":"new","name":"...","group":"..."}
• rename     – rename a session                    → {"type":"rename","target":"...","name":"..."}
• close      – close one session                   → {"type":"close","target":"..."} or "idle"
• close-group★ close all sessions in a group       → {"type":"close-group","group":"<group>"}
• split      – split current row                   → {"type":"split"}
• focus      – navigate to a session               → {"type":"focus","target":"<name or id>"}
• group      – assign session to a group           → {"type":"group","target":"...","group":"<group>"}
• note       – set a note on a session             → {"type":"note","target":"...","text":"<note>"}
• clear      – clear terminal output               → {"type":"clear","target":"<name or id>"}
• kill       – send Ctrl+C to interrupt a process  → {"type":"kill","target":"<name or id>"}

Rules:
- ★ actions (broadcast, run-group, close-group) always require user confirmation — list the plan and wait.
- All other actions execute immediately for a single session.
- Chain multiple run actions to accomplish complex tasks step by step.
- Keep responses short and direct.`;
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
      if (obj && typeof obj.type === 'string') actions.push(obj);
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

/** Read-only actions that never touch state — execute immediately, no confirm. */
const READONLY_TYPES = new Set(['list', 'help', 'set-agent', 'focus']);

const SELF_CONFIRM_TYPES = new Set(['broadcast', 'run-group', 'close-group', 'sequential']);

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

async function executeAction(action: ParsedAction): Promise<string> {
  const result = await workspaceActions.dispatch(toWorkspaceAction(action), { source: 'ai' });
  return result.message;
}

function describeAction(action: ParsedAction): string {
  return actionDescription(toWorkspaceAction(action));
}

// ---------------------------------------------------------------------------
// Main AI handler
// ---------------------------------------------------------------------------

class AIHandler {
  async handle(input: string): Promise<string> {
    const cfg = configContext.get();
    const model = cfg.workspace_ai.model;

    // ── LLM path ──────────────────────────────────────────────────────
    if (model && model !== 'none') {
      try {
        const messages: LLMMessage[] = [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: input },
        ];
        const raw = await llmClient.complete(messages, cfg);
        const { actions, cleanText } = extractActions(raw);

        if (actions.length === 0) {
          // Pure text response — just show it
          return raw;
        }

        // Separate readonly vs state-changing actions
        const readonlyActions = actions.filter(a => READONLY_TYPES.has(a.type));
        const changingActions = actions.filter(a => !READONLY_TYPES.has(a.type));

        // Execute readonly actions immediately
        for (const a of readonlyActions) {
          await executeAction(a);
        }

        if (changingActions.length === 0) {
          return cleanText || raw;
        }

        if (changingActions.length === 1 && SELF_CONFIRM_TYPES.has(changingActions[0].type)) {
          // Self-managing confirmation (broadcast/run-group/close-group/sequential)
          const result = await executeAction(changingActions[0]);
          return cleanText ? `${cleanText}\n\n${result}` : result;
        }

        if (changingActions.length === 1) {
          // Single state-changing action — show confirm prompt
          const a = changingActions[0];
          const desc = describeAction(a);
          planExecutor.setPending(desc, () => executeAction(a), [toWorkspaceAction(a)]);
          const preview = (cleanText ? cleanText + '\n\n' : '') + planExecutor.getPlanPreview();
          return preview;
        }

        // Multiple state-changing actions share the same confirmation queue.
        const descriptions = changingActions.map(a => describeAction(a));
        const queuedActions = changingActions.map(a => toWorkspaceAction(a));
        planExecutor.setPending(
          descriptions.join('\n'),
          async () => {
            const messages: string[] = [];
            for (const a of changingActions) messages.push(await executeAction(a));
            return messages.join('\n');
          },
          queuedActions,
        );
        return (cleanText ? cleanText + '\n\n' : '') + planExecutor.getPlanPreview();

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
        return executeAction({
          type: 'set-agent',
          target: String(activeId),
          agentType: intent.agentType,
        });
      }

      case 'focus':
        return executeAction(intent as ParsedAction);

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
          '  clear <session>                 – clear terminal output',
          '  kill <session>                  – send Ctrl+C to session',
          '  list | status                   – list all sessions',
          '  !agent <claude|codex|aider|none>',
          '',
          'Set workspace_ai.model to an OpenCode-style provider/model id, for example anthropic/claude-sonnet-4-5.',
        ].join('\n');

      // ── State-changing: self-managing confirmation ─────────────────
      case 'broadcast':
      case 'run-group':
      case 'close-group':
      case 'sequential':
        return executeAction(intent as ParsedAction);

      // ── State-changing: single action — route through confirm ──────
      default: {
        const action = intent as ParsedAction;
        const desc = describeAction(action);
        planExecutor.setPending(desc, () => executeAction(action), [toWorkspaceAction(action)]);
        return planExecutor.getPlanPreview();
      }
    }
  }
}

export const aiHandler = new AIHandler();
