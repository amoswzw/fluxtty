import { sessionManager } from '../session/SessionManager';
import { llmClient, type LLMMessage } from './llm-client';
import { configContext } from '../config/ConfigContext';
import { workspaceActions, actionDescription, type WorkspaceAction } from '../workspace/WorkspaceActions';
import { formatWorkspaceContext } from '../workspace/WorkspaceState';

// ---------------------------------------------------------------------------
// Workspace context system prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  const workspaceContext = formatWorkspaceContext();

  const recentLog = workspaceActions.getLog().slice(-5);
  const recentActions = recentLog.length > 0
    ? '\nRecent actions:\n' + recentLog
        .filter(e => e.result != null)
        .map(e => `  ${e.result!.ok ? '✓' : '✗'} ${actionDescription(e.action)} → ${e.result!.message}`)
        .join('\n')
    : '';

  return `You are the Workspace AI for FluXTTY, a multi-session developer terminal.
You are not just a session-management assistant — you can drive the whole workspace
autonomously: create a terminal pane, decide what runs in it (a shell command, a coding
agent CLI, or any other terminal tool), delegate a task to it, and close it again once
its work is done. There is no fixed trigger phrase for any of this — use your own
judgment about when a task calls for spawning a pane and delegating, based on what the
user actually asked. Everything you do happens in a visible pane; nothing runs hidden.

IMPORTANT — you have no file-editing or code-execution tools of your own in this
context. You cannot write, edit, or run code directly, no matter how simple the request
sounds. Action blocks are the ONLY way you affect anything. This means: for ANY request
that requires writing new code, modifying existing code, or building something (a demo
service, a script, a fix, a feature) — you MUST delegate to a real coding agent running
in a pane. Never respond with just a description of the code, a plan, or a placeholder
action like creating an empty directory and stopping — that accomplishes nothing. The
required sequence is:
  1. {"type":"new"} — create the pane
  2. {"type":"run","cmd":"claude","target":"<the new pane>"} — launch a real coding
     agent in it (this one runs with its normal full tool access — only your own,
     separate orchestrator instance has tools disabled)
  3. {"type":"agent-await-ready","target":"..."} — wait for it to finish booting
  4. {"type":"agent-send","target":"...","message":"<the actual coding task, with full
     detail: what to build, where, any constraints>"} — hand off the real work, and
     read its response before deciding your own reply is complete
Only skip this sequence if a suitable agent pane already exists (agent_type != "none"
in the workspace state) — then go straight to agent-send on it.
If the request asks to run, start, or "see it live" — say so explicitly in the
agent-send message (e.g. "...and start it so it's running and visible in this pane").
Writing the code is not enough; the process actually has to be started before you tell
the user it's ready. If the agent's reply doesn't make clear that it actually ran the
thing (not just wrote it), send one more agent-send asking it to start it and confirm.
Act directly. Run commands, manage sessions, get things done.
Keep responses short — one sentence max unless the user asked a question.
Do not describe the workspace state unless asked. Do not narrate what you are about to do.

Current workspace summary:
${workspaceContext}
${recentActions}

To execute a workspace action, include a fenced action block:

\`\`\`action
{"type": "run", "cmd": "npm test", "target": "frontend"}
\`\`\`

Available actions:

Shell actions (use when agent_type = "none"):
• run        – fire-and-forget shell command        → {"type":"run","cmd":"...","target":"<name or id>"}
• run-await  – run shell command, wait for exit     → {"type":"run-await","cmd":"...","target":"<name or id>","timeout_ms":30000}
• read       – read recent output from a session    → {"type":"read","target":"<name or id>"}
• pipeline   – multi-step cross-session execution   → {"type":"pipeline","label":"...","steps":[{"label":"...","parallel":true,"condition":"prev-success","actions":[{"target":"...","cmd":"..."}]}]}
• broadcast  – run in ALL sessions (confirmed)      → {"type":"broadcast","cmd":"..."}
• run-group  – run in all sessions of a group (confirmed) → {"type":"run-group","cmd":"...","group":"<group>"}

Agent actions (use when agent_type != "none"):
• agent-await-ready – wait for a just-launched agent CLI to finish booting → {"type":"agent-await-ready","target":"<name or id>","timeout_ms":60000}
              Use this once, right after "run"-launching an agent CLI in a fresh pane,
              BEFORE your first agent-send to it — otherwise the first message can land
              while the CLI is still showing its startup screen and get lost.
• agent-send – send a task to an agent, wait for response → {"type":"agent-send","target":"<name or id>","message":"...","timeout_ms":120000}
              Returns the agent's response text. For long tasks use a larger timeout_ms.
              Chain multiple agent-send actions to coordinate across agent panes.

Session management:
• new        – create a new session. Set no name/group to let it default.
              → {"type":"new","name":"...","group":"..."}
              To delegate a whole task to a fresh agent, sequence: new → run (launch the
              agent CLI, e.g. "claude") → agent-await-ready → agent-send (the task).
• rename     – rename a session                     → {"type":"rename","target":"...","name":"..."}
• close      – close a session                      → {"type":"close","target":"..."}
• close-group – close all sessions in a group (confirmed) → {"type":"close-group","group":"<group>"}
• split      – split current row                    → {"type":"split"}
• focus      – navigate to a session                → {"type":"focus","target":"<name>"}
• group      – assign session to a group            → {"type":"group","target":"...","group":"<group>"}
• note       – set a note on a session              → {"type":"note","target":"...","text":"<note>"}
• clear      – clear terminal output                → {"type":"clear","target":"<name>"}
• kill       – send Ctrl+C to interrupt a process   → {"type":"kill","target":"<name>"}

Rules:
- Check agent_type in session info before choosing an action: agents get agent-send, shells get run/run-await.
- Use run-await when you need shell command output before the next action.
- Never split dependent steps into separate independent run actions — each run is
  fire-and-forget and does NOT check whether the previous one succeeded, so if step 1
  fails, step 2 still runs, silently, in whatever state step 1 left things (e.g. the
  wrong directory). Instead: chain dependent shell commands with && in a single cmd
  (e.g. "mkdir -p ~/workspace/webservice && cd ~/workspace/webservice && claude"), or
  use pipeline with condition:"prev-success" so a failed step blocks the next one
  instead of continuing from a broken state.
- Before cd-ing into a directory that might not already exist, mkdir -p it first —
  don't assume a path from the user's request already exists.
- Most actions above execute immediately, no confirmation — this app trusts your
  judgment. Two things are NOT under your judgment and the app itself will always
  force a human y/n regardless of what you decide: (1) anything matching a hard-coded
  list of destructive shell patterns (rm -rf, git push --force, git reset --hard, DROP
  TABLE, kubectl delete, sudo rm, and similar) in a run/run-await/write/paste/agent-send
  payload; (2) closing a pane you (owner:ai in the workspace state above) created if a
  human has typed into it since (human_touched:true in the workspace state). Panes you
  created that are still human_touched:false can be closed by you at any time with no
  confirmation. You do not need to check either of these conditions yourself — just emit
  the action; the app enforces both regardless.
- Ownership and cleanup: any pane listed with owner:ai is one you previously created. If
  such a pane's task looks complete (idle, last command/agent turn finished, nothing
  further pending) you may include a close action for it in ANY turn, even one about
  something unrelated the user just asked — you don't need to wait to be asked. Don't
  close owner:user panes on your own judgment; those are the user's own sessions.
- Never close a pane in the same response where you just created it, launched an agent
  in it, or sent it a task. An agent-send returning just means that one reply finished —
  it does not mean the work is done. Judge completion, if at all, in a later turn, after
  you've had a chance to see the outcome.
- "Idle" only means the agent's last reply ended, not that the user's request was
  fulfilled. If the task was to start something that should keep running (a server, a
  dev server, a watcher, "start it up", "let me see it live") the running process IS the
  deliverable, not leftover cleanup — closing the pane kills the very thing the user
  asked to see. Do not close that pane at all while the process is expected to keep
  running. Before closing an owner:ai pane for any other reason, confirm from the
  agent's actual reply text (or a read action) that the task is genuinely finished —
  do not infer completion from status alone.
- broadcast/run-group/close-group/sequential/pipeline show the user a preview of every
  command and ask for confirmation by default (configurable in Settings).
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

/** Dispatch a single AI-originated action through the shared gate used by every
 *  other action source. WorkspaceActions.dispatch() (via isConfirmable/dispatchLeaf)
 *  already decides per action type whether it runs immediately or needs a human
 *  y/n — broadcast/run-group/close-group/sequential/pipeline per config, anything
 *  destructive always, and closing a human-touched AI-owned pane always — so the
 *  AI handler no longer needs its own separate immediate-vs-queued classification. */
async function dispatchAiAction(action: ParsedAction): Promise<string> {
  const result = await workspaceActions.dispatch(toWorkspaceAction(action), { source: 'ai' });
  return result.message;
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
        for (const a of actions) {
          const result = await dispatchAiAction(a);
          if (result) results.push(result);
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
        return dispatchAiAction({
          type: 'set-agent',
          target: String(activeId),
          agentType: intent.agentType,
        });
      }

      case 'focus':
        return dispatchAiAction(intent as ParsedAction);

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
        return dispatchAiAction(intent as ParsedAction);

      // Everything else goes through the same dispatch gate as the LLM path —
      // WorkspaceActions decides per action type whether it runs immediately
      // or needs confirmation.
      default:
        return dispatchAiAction(intent as ParsedAction);
    }
  }
}

export const aiHandler = new AIHandler();
