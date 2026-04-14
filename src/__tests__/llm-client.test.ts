import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('../transport', () => ({
  transport: {
    send,
    listen: vi.fn(),
  },
}));

import { LLMClient, resolveModelConfig } from '../ai/llm-client';

function cfg(model: string, provider: unknown = null): any {
  return {
    workspace_ai: {
      model,
      provider,
      api_key_env: '',
      base_url: null,
    },
  };
}

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue('ok');
});

describe('resolveModelConfig', () => {
  it('preserves aggregator model ids after the provider prefix', () => {
    const resolved = resolveModelConfig(cfg('openrouter/anthropic/claude-sonnet-4.5'));

    expect(resolved?.providerId).toBe('openrouter');
    expect(resolved?.modelId).toBe('anthropic/claude-sonnet-4.5');
    expect(resolved?.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  it('resolves GLM-5.1 through Z.AI defaults', () => {
    const resolved = resolveModelConfig(cfg('zai/glm-5.1'));

    expect(resolved?.providerId).toBe('zai');
    expect(resolved?.modelId).toBe('glm-5.1');
    expect(resolved?.baseURL).toBe('https://api.z.ai/api/coding/paas/v4');
    expect(resolved?.options.chatCompletionsPath).toBe('chat/completions');
  });

  it('recognizes CLI-backed model ids', () => {
    const resolved = resolveModelConfig(cfg('opencode-cli'));

    expect(resolved?.providerId).toBe('opencode-cli');
    expect(resolved?.modelId).toBe('opencode-cli');
  });
});

describe('LLMClient CLI routing', () => {
  it('routes codex-cli through ai_cli_query', async () => {
    const client = new LLMClient();

    await client.complete([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hello' },
    ], cfg('codex-cli'));

    expect(send).toHaveBeenCalledWith('ai_cli_query', {
      cli: 'codex-cli',
      prompt: 'Be brief.\n\nhello',
    });
  });
});
