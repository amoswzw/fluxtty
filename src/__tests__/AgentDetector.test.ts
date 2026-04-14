import { describe, expect, it, vi } from 'vitest';
import { AgentDetector, detectAgentFromCommand } from '../input/AgentDetector';

describe('detectAgentFromCommand', () => {
  it.each([
    ['claude', 'claude'],
    ['codex', 'codex'],
    ['npx -y @openai/codex', 'codex'],
    ['opencode run', 'opencode'],
    ['pnpm dlx opencode', 'opencode'],
    ['gemini --prompt hello', 'gemini'],
    ['uvx aider', 'aider'],
    ['cursor-agent', 'cursor'],
    ['qwen-code', 'qwen'],
  ] as const)('detects %s from "%s"', (command, expected) => {
    expect(detectAgentFromCommand(command)).toBe(expected);
  });

  it('does not mark regular commands as agents', () => {
    expect(detectAgentFromCommand('npm test')).toBe('none');
    expect(detectAgentFromCommand('git status')).toBe('none');
  });
});

describe('AgentDetector', () => {
  it('notifies immediately when an agent command is submitted', () => {
    const detector = new AgentDetector();
    const listener = vi.fn();
    detector.onAgentChange(1, listener);

    expect(detector.addCommand(1, 'codex')).toBe('codex');
    expect(detector.getAgent(1)).toBe('codex');
    expect(listener).toHaveBeenCalledWith('codex');
  });

  it('detects agent output signatures', () => {
    const detector = new AgentDetector();
    detector.addOutput(1, 'Welcome to Codex\ncodex> ');
    expect(detector.getAgent(1)).toBe('codex');
  });

  it('clears detected agent when a shell prompt returns', () => {
    const detector = new AgentDetector();
    detector.addCommand(1, 'opencode');
    detector.addOutput(1, '\n$ ');
    expect(detector.getAgent(1)).toBe('none');
  });
});
