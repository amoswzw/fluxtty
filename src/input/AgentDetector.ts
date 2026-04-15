import type { AgentType } from '../session/types';

type AgentRule = { agent: AgentType; patterns: RegExp[] };

const AGENT_COMMAND_PATTERNS: AgentRule[] = [
  { agent: 'claude', patterns: [/^claude\b/, /^@anthropic-ai\/claude-code\b/] },
  { agent: 'codex', patterns: [/^codex\b/, /^@openai\/codex\b/] },
  { agent: 'aider', patterns: [/^aider\b/] },
  { agent: 'gemini', patterns: [/^gemini(?:-cli)?\b/, /^@google\/gemini-cli\b/] },
  { agent: 'opencode', patterns: [/^opencode\b/, /^opencode-ai\b/] },
  { agent: 'goose', patterns: [/^goose\b/] },
  { agent: 'cursor', patterns: [/^cursor-agent\b/, /^cursor\s+(?:agent|chat)\b/] },
  { agent: 'qwen', patterns: [/^qwen(?:-code)?\b/] },
  { agent: 'amp', patterns: [/^amp\b/] },
  { agent: 'crush', patterns: [/^crush\b/] },
  { agent: 'openhands', patterns: [/^openhands\b/] },
];

// PTY output patterns that identify agent type
const AGENT_PATTERNS: AgentRule[] = [
  {
    agent: 'claude',
    patterns: [
      /Claude Code/i,               // header text
      /\bClaude\b.*❯/,
      /^\s*claude\b.*>\s*$/im,
      /✻ Welcome to Claude/i,
    ],
  },
  {
    agent: 'codex',
    patterns: [
      /OpenAI Codex/i,
      /Welcome to Codex/i,
      /\bcodex\b.*>\s*$/im,
      /\[codex\]/i,
    ],
  },
  {
    agent: 'aider',
    patterns: [
      /aider\s*>\s*$/im,
      /\baider\b.*v\d+\.\d+/i,
    ],
  },
  {
    agent: 'gemini',
    patterns: [
      /Gemini CLI/i,
      /\bGemini\b.*(?:chat|agent|prompt)/i,
    ],
  },
  {
    agent: 'opencode',
    patterns: [
      /\bOpenCode\b/i,
      /\bopencode\b.*(?:model|session|tokens)/i,
    ],
  },
  {
    agent: 'goose',
    patterns: [
      /\bGoose\b.*(?:session|agent)/i,
      /\bgoose\b.*>\s*$/im,
    ],
  },
  {
    agent: 'cursor',
    patterns: [
      /\bCursor Agent\b/i,
      /\bcursor-agent\b/i,
    ],
  },
  {
    agent: 'qwen',
    patterns: [
      /\bQwen Code\b/i,
      /\bqwen\b.*>\s*$/im,
    ],
  },
  {
    agent: 'amp',
    patterns: [
      /\bAmp\b.*(?:agent|code)/i,
      /\bamp\b.*>\s*$/im,
    ],
  },
  {
    agent: 'crush',
    patterns: [
      /\bCrush\b.*(?:agent|code)/i,
      /\bcrush\b.*>\s*$/im,
    ],
  },
  {
    agent: 'openhands',
    patterns: [
      /\bOpenHands\b/i,
    ],
  },
];

// Patterns that signal the agent has exited back to a plain shell prompt
const EXIT_PATTERNS = [/\$\s*$/, /[%#]\s*$/, /❯\s*$/, /➜\s*$/, /→\s*$/];

function unwrapCommand(command: string): string {
  let current = command.trim();
  for (let i = 0; i < 4; i++) {
    const before = current;
    current = current
      .replace(/^(?:sudo|command|exec|time|nohup)\s+/, '')
      .replace(/^env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(.*)$/, '$1')
      .replace(/^(?:npx|bunx|uvx)\s+(?:-y\s+)?/, '')
      .replace(/^pnpm\s+dlx\s+/, '')
      .replace(/^yarn\s+dlx\s+/, '');
    if (current === before) break;
  }
  return current;
}

export function detectAgentFromCommand(command: string): AgentType {
  const normalized = unwrapCommand(command);
  for (const { agent, patterns } of AGENT_COMMAND_PATTERNS) {
    if (patterns.some(p => p.test(normalized))) return agent;
  }
  return 'none';
}

export class AgentDetector {
  private buffers: Map<number, string> = new Map();
  private detectedAgents: Map<number, AgentType> = new Map();
  private listeners: Map<number, Array<(agent: AgentType) => void>> = new Map();

  addCommand(paneId: number, command: string): AgentType {
    const detected = detectAgentFromCommand(command);
    if (detected !== 'none') {
      this.setDetected(paneId, detected);
    }
    return detected;
  }

  addOutput(paneId: number, data: string) {
    let buf = (this.buffers.get(paneId) || '') + data;
    if (buf.length > 2000) buf = buf.slice(-2000);
    this.buffers.set(paneId, buf);

    const current = this.detectedAgents.get(paneId) || 'none';

    if (current === 'none') {
      // Not yet detected — scan for agent signatures
      const detected = this.detect(buf);
      if (detected !== 'none') {
        this.setDetected(paneId, detected);
      }
    } else {
      // Already detected — only clear when a plain shell prompt re-appears,
      // indicating the agent exited. Don't un-detect just because the launch
      // output scrolled out of the buffer window.
      if (EXIT_PATTERNS.some(p => p.test(buf))) {
        this.buffers.set(paneId, '');
        this.setDetected(paneId, 'none');
      }
    }
  }

  private detect(buf: string): AgentType {
    for (const { agent, patterns } of AGENT_PATTERNS) {
      if (patterns.some(p => p.test(buf))) return agent;
    }
    return 'none';
  }

  getAgent(paneId: number): AgentType {
    return this.detectedAgents.get(paneId) || 'none';
  }

  setManual(paneId: number, agent: AgentType) {
    this.setDetected(paneId, agent);
  }

  private setDetected(paneId: number, agent: AgentType) {
    if ((this.detectedAgents.get(paneId) || 'none') === agent) return;
    this.detectedAgents.set(paneId, agent);
    const ls = this.listeners.get(paneId) || [];
    ls.forEach(l => l(agent));
  }

  onAgentChange(paneId: number, listener: (agent: AgentType) => void) {
    if (!this.listeners.has(paneId)) this.listeners.set(paneId, []);
    this.listeners.get(paneId)!.push(listener);
  }

  clearPane(paneId: number) {
    this.buffers.delete(paneId);
    this.detectedAgents.delete(paneId);
    this.listeners.delete(paneId);
  }
}

export const agentDetector = new AgentDetector();
