import { describe, expect, it } from 'vitest';
import { isSignificantCommand, suggestName } from '../session/AutoNamer';

describe('AutoNamer AI agent commands', () => {
  it.each([
    ['codex', 'repo · codex'],
    ['npx -y @openai/codex', 'repo · codex'],
    ['opencode run', 'repo · opencode'],
    ['gemini --prompt hello', 'repo · gemini'],
    ['qwen-code', 'repo · qwen'],
  ] as const)('names %s', (command, expected) => {
    expect(isSignificantCommand(command)).toBe(true);
    expect(suggestName(command, '/Users/amos/repo')).toBe(expected);
  });
});

describe('AutoNamer TUI commands', () => {
  it.each([
    ['lazygit', 'repo · lazygit'],
    ['yazi', 'repo · yazi'],
    ['tmux', 'repo · tmux'],
    ['hx src/main.ts', 'repo · hx: main.ts'],
    ['k9s', 'repo · k9s'],
  ] as const)('names %s', (command, expected) => {
    expect(isSignificantCommand(command)).toBe(true);
    expect(suggestName(command, '/Users/amos/repo')).toBe(expected);
  });

  it('does not treat transient commands as significant', () => {
    expect(isSignificantCommand('git status')).toBe(false);
    expect(isSignificantCommand('ls')).toBe(false);
  });
});
