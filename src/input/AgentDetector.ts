import type { AgentType } from '../session/types';

// PTY output patterns that identify agent type
const AGENT_PATTERNS: Array<{ agent: AgentType; patterns: RegExp[] }> = [
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
];

// Patterns that signal the agent has exited back to a plain shell prompt
const EXIT_PATTERNS = [/\$\s*$/, /[%#]\s*$/];

class AgentDetector {
  private buffers: Map<number, string> = new Map();
  private detectedAgents: Map<number, AgentType> = new Map();
  private listeners: Map<number, Array<(agent: AgentType) => void>> = new Map();

  addOutput(paneId: number, data: string) {
    let buf = (this.buffers.get(paneId) || '') + data;
    if (buf.length > 2000) buf = buf.slice(-2000);
    this.buffers.set(paneId, buf);

    const current = this.detectedAgents.get(paneId) || 'none';

    if (current === 'none') {
      // Not yet detected — scan for agent signatures
      const detected = this.detect(buf);
      if (detected !== 'none') {
        this.detectedAgents.set(paneId, detected);
        (this.listeners.get(paneId) || []).forEach(l => l(detected));
      }
    } else {
      // Already detected — only clear when a plain shell prompt re-appears,
      // indicating the agent exited. Don't un-detect just because the launch
      // output scrolled out of the buffer window.
      if (EXIT_PATTERNS.some(p => p.test(buf))) {
        this.buffers.set(paneId, '');
        this.detectedAgents.set(paneId, 'none');
        (this.listeners.get(paneId) || []).forEach(l => l('none'));
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
