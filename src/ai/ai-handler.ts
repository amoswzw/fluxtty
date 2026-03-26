import { invoke } from '@tauri-apps/api/core';
import { sessionManager } from '../session/SessionManager';
import type { WaterfallArea } from '../waterfall/WaterfallArea';
import { planExecutor } from './plan-executor';
import { llmClient, type LLMMessage } from './llm-client';
import { configContext } from '../config/ConfigContext';

// Will be set after WaterfallArea is created
let waterfallArea: WaterfallArea | null = null;

export function setWaterfallArea(area: WaterfallArea) {
  waterfallArea = area;
}

// ---------------------------------------------------------------------------
// Workspace context system prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  const panes = sessionManager.getAllPanes();
  const activeId = sessionManager.getActivePaneId();

  const sessionLines = panes.map(p => {
    const active = p.id === activeId ? ' ← active' : '';
    const agent = p.agent_type !== 'none' ? ` (${p.agent_type})` : '';
    return `  ${p.id}. ${p.name} [${p.group}] ${p.status}${agent}  cwd: ${p.cwd}${active}`;
  }).join('\n') || '  (no sessions)';

  return `You are the Workspace AI for FluXTTY, a multi-session developer terminal.
You help the user accomplish ANY task by running shell commands and managing sessions.
Use terminal commands freely to get things done — check status, run builds, edit files, whatever is needed.

Current sessions:
${sessionLines}

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

/**
 * Actions that manage their own multi-step confirmation via planExecutor.setPlan().
 * Calling executeAction() on these returns the plan preview string and registers
 * the pending plan — no extra wrapping needed.
 */
const SELF_CONFIRM_TYPES = new Set(['broadcast', 'run-group', 'close-group', 'sequential']);

/** Human-readable description of a single state-changing action (for confirm prompt). */
function actionDescription(action: ParsedAction): string {
  switch (action.type) {
    case 'run':    return `run "${action.cmd as string}" in ${action.target as string}`;
    case 'new':    return `create new session${action.name ? ` "${action.name as string}"` : ''}${action.group ? ` in group "${action.group as string}"` : ''}`;
    case 'rename': return `rename "${action.target as string}" → "${action.name as string}"`;
    case 'close':  return (action.target as string).toLowerCase() === 'idle'
      ? 'close all idle sessions'
      : `close session "${action.target as string}"`;
    case 'split':  return 'split current row';
    case 'group':  return `move "${action.target as string}" to group "${action.group as string}"`;
    case 'note':   return `set note on "${action.target as string}": ${action.text as string}`;
    case 'clear':  return `clear terminal output of "${action.target as string}"`;
    case 'kill':   return `send Ctrl+C to "${action.target as string}"`;
    default:       return `${action.type} action`;
  }
}

// ---------------------------------------------------------------------------
// Pane lookup
// ---------------------------------------------------------------------------

function findPane(target: string) {
  const panes = sessionManager.getAllPanes();
  const t = target.toLowerCase();
  return panes.find(p =>
    p.name.toLowerCase() === t ||
    p.id === parseInt(t)
  ) || panes.find(p =>
    p.name.toLowerCase().includes(t)
  );
}

// ---------------------------------------------------------------------------
// Shared action executor (used by both LLM and regex paths)
// ---------------------------------------------------------------------------

async function executeAction(action: ParsedAction): Promise<string> {
  switch (action.type) {
    case 'run': {
      const pane = findPane(action.target as string);
      if (!pane) return `Session "${action.target}" not found.`;
      const tp = waterfallArea?.getPane(pane.id);
      if (!tp) return `Pane "${action.target}" not available.`;
      await tp.writeCommand(action.cmd as string);
      waterfallArea?.scrollToPane(pane.id);
      return `Ran "${action.cmd}" in ${pane.name}`;
    }

    case 'broadcast': {
      const panes = sessionManager.getAllPanes();
      const plan = panes.map(p => ({ paneId: p.id, cmd: action.cmd as string, paneName: p.name }));
      planExecutor.setPlan(plan, `Run "${action.cmd}" in all ${panes.length} sessions`);
      return planExecutor.getPlanPreview();
    }

    case 'sequential': {
      const pane = findPane(action.target as string);
      if (!pane) return `Session "${action.target}" not found.`;
      const cmds = action.cmds as string[];
      const plan = cmds.map(cmd => ({ paneId: pane.id, cmd, paneName: pane.name }));
      planExecutor.setPlan(plan, `Run ${cmds.length} commands in ${pane.name}`);
      return planExecutor.getPlanPreview();
    }

    case 'new': {
      if (!waterfallArea) return 'Waterfall not ready.';
      const pane = await waterfallArea.spawnPane({ newRow: true, group: (action.group as string) || 'default' });
      if (pane && action.name) {
        await sessionManager.renamePane(pane.paneId, action.name as string);
      }
      return pane
        ? `Created new session${action.name ? ` "${action.name}"` : ''}`
        : 'Failed to create session.';
    }

    case 'rename': {
      const pane = findPane(action.target as string);
      if (!pane) return `Session "${action.target}" not found.`;
      await sessionManager.renamePane(pane.id, action.name as string);
      return `Renamed ${pane.name} → ${action.name}`;
    }

    case 'close': {
      const target = (action.target as string).toLowerCase();
      if (target === 'idle') {
        const idle = sessionManager.getAllPanes().filter(p => p.status === 'idle');
        for (const p of idle) {
          const tp = waterfallArea?.getPane(p.id);
          if (tp) await tp.destroy();
        }
        return `Closed ${idle.length} idle session(s).`;
      }
      const pane = findPane(action.target as string);
      if (!pane) return `Session "${action.target}" not found.`;
      const tp = waterfallArea?.getPane(pane.id);
      if (tp) {
        await tp.destroy();
        return `Closed ${pane.name}.`;
      }
      return 'Pane not available.';
    }

    case 'split': {
      if (!waterfallArea) return 'Waterfall not ready.';
      waterfallArea.splitCurrentRow();
      return 'Split current row.';
    }

    case 'focus': {
      const pane = findPane(action.target as string);
      if (!pane) return `Session "${action.target}" not found.`;
      sessionManager.setActivePane(pane.id);
      waterfallArea?.scrollToPane(pane.id);
      return `Focused ${pane.name}.`;
    }

    case 'group': {
      const pane = findPane(action.target as string);
      if (!pane) return `Session "${action.target}" not found.`;
      await sessionManager.setPaneGroup(pane.id, action.group as string);
      return `Moved ${pane.name} to group "${action.group}".`;
    }

    case 'note': {
      const pane = findPane(action.target as string);
      if (!pane) return `Session "${action.target}" not found.`;
      await sessionManager.setPaneNote(pane.id, action.text as string);
      return `Set note on ${pane.name}.`;
    }

    case 'clear': {
      const pane = findPane(action.target as string);
      if (!pane) return `Session "${action.target}" not found.`;
      await invoke('pty_write', { args: { pane_id: pane.id, data: 'clear\r' } });
      return `Cleared ${pane.name}.`;
    }

    case 'kill': {
      const pane = findPane(action.target as string);
      if (!pane) return `Session "${action.target}" not found.`;
      await invoke('pty_write', { args: { pane_id: pane.id, data: '\x03' } });
      return `Sent Ctrl+C to ${pane.name}.`;
    }

    case 'run-group': {
      const group = (action.group as string).toLowerCase();
      const groupPanes = sessionManager.getAllPanes().filter(p => p.group.toLowerCase() === group);
      if (groupPanes.length === 0) return `No sessions in group "${action.group}".`;
      const plan = groupPanes.map(p => ({ paneId: p.id, cmd: action.cmd as string, paneName: p.name }));
      planExecutor.setPlan(plan, `Run "${action.cmd}" in group "${action.group}" (${groupPanes.length} sessions)`);
      return planExecutor.getPlanPreview();
    }

    case 'close-group': {
      const group = (action.group as string).toLowerCase();
      const groupPanes = sessionManager.getAllPanes().filter(p => p.group.toLowerCase() === group);
      if (groupPanes.length === 0) return `No sessions in group "${action.group}".`;
      const plan = groupPanes.map(p => ({ paneId: p.id, cmd: '__close__', paneName: p.name }));
      planExecutor.setPlan(plan, `Close all ${groupPanes.length} sessions in group "${action.group}"`);
      return planExecutor.getPlanPreview();
    }

    default:
      return `Unknown action type: ${action.type}`;
  }
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
          const desc = actionDescription(a);
          planExecutor.setPending(desc, () => executeAction(a));
          const preview = (cleanText ? cleanText + '\n\n' : '') + planExecutor.getPlanPreview();
          return preview;
        }

        // Multiple state-changing actions — build a unified plan for run/close,
        // execute self-confirm types inline, execute readonly immediately.
        const planSteps = changingActions
          .filter(a => !SELF_CONFIRM_TYPES.has(a.type))
          .flatMap(a => {
            if (a.type === 'run') {
              const pane = findPane(a.target as string);
              return pane ? [{ paneId: pane.id, cmd: a.cmd as string, paneName: pane.name }] : [];
            }
            if (a.type === 'close') {
              const pane = findPane(a.target as string);
              return pane ? [{ paneId: pane.id, cmd: '__close__', paneName: pane.name }] : [];
            }
            // Other actions (new/rename/etc.) are described inline in the plan title
            return [];
          });
        const nonPlanActions = changingActions.filter(
          a => !SELF_CONFIRM_TYPES.has(a.type) && a.type !== 'run' && a.type !== 'close'
        );
        const descriptions = [
          ...nonPlanActions.map(a => actionDescription(a)),
          ...planSteps.map(s => `${s.paneName} ❯ ${s.cmd === '__close__' ? '[close]' : s.cmd}`),
        ];
        planExecutor.setPending(
          descriptions.join('\n'),
          async () => {
            for (const a of nonPlanActions) await executeAction(a);
            for (const s of planSteps) {
              const tp = waterfallArea?.getPane(s.paneId);
              if (tp) {
                if (s.cmd === '__close__') await tp.destroy();
                else await tp.writeCommand(s.cmd);
              }
            }
            return 'Done.';
          }
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
        await sessionManager.setPaneAgent(activeId, intent.agentType as never);
        return `Set active session agent to "${intent.agentType}".`;
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
          'Set workspace_ai.model in config to enable natural language (Claude, GPT, Gemini, Ollama…)',
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
        const desc = actionDescription(action);
        planExecutor.setPending(desc, () => executeAction(action));
        return planExecutor.getPlanPreview();
      }
    }
  }
}

export const aiHandler = new AIHandler();
