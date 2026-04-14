import type { AiProviderConfig } from '../config/ConfigContext';

export const BUILTIN_AI_PROVIDERS: Record<string, AiProviderConfig> = {
  anthropic: {
    name: 'Anthropic',
    options: { apiKey: '{env:ANTHROPIC_API_KEY}' },
  },
  openai: {
    name: 'OpenAI',
    options: { apiKey: '{env:OPENAI_API_KEY}' },
  },
  google: {
    name: 'Google Gemini',
    options: { apiKey: '{env:GOOGLE_API_KEY}' },
  },
  ollama: {
    name: 'Ollama',
    options: { baseURL: 'http://localhost:11434' },
  },
  lmstudio: {
    name: 'LM Studio',
    options: { baseURL: 'http://localhost:1234/v1' },
  },
  openrouter: {
    name: 'OpenRouter',
    options: { apiKey: '{env:OPENROUTER_API_KEY}', baseURL: 'https://openrouter.ai/api/v1' },
  },
  deepseek: {
    name: 'DeepSeek',
    options: { apiKey: '{env:DEEPSEEK_API_KEY}', baseURL: 'https://api.deepseek.com/v1' },
  },
  xai: {
    name: 'xAI',
    options: { apiKey: '{env:XAI_API_KEY}', baseURL: 'https://api.x.ai/v1' },
  },
  mistral: {
    name: 'Mistral AI',
    options: { apiKey: '{env:MISTRAL_API_KEY}', baseURL: 'https://api.mistral.ai/v1' },
  },
  groq: {
    name: 'Groq',
    options: { apiKey: '{env:GROQ_API_KEY}', baseURL: 'https://api.groq.com/openai/v1' },
  },
  together: {
    name: 'Together AI',
    options: { apiKey: '{env:TOGETHER_API_KEY}', baseURL: 'https://api.together.xyz/v1' },
  },
  moonshot: {
    name: 'Moonshot AI',
    options: { apiKey: '{env:MOONSHOT_API_KEY}', baseURL: 'https://api.moonshot.ai/v1' },
  },
  zai: {
    name: 'Z.AI',
    options: {
      apiKey: '{env:ZAI_API_KEY}',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      chatCompletionsPath: 'chat/completions',
    },
  },
  perplexity: {
    name: 'Perplexity',
    options: {
      apiKey: '{env:PERPLEXITY_API_KEY}',
      baseURL: 'https://api.perplexity.ai',
      chatCompletionsPath: 'chat/completions',
    },
  },
  fireworks: {
    name: 'Fireworks AI',
    options: { apiKey: '{env:FIREWORKS_API_KEY}', baseURL: 'https://api.fireworks.ai/inference/v1' },
  },
  cerebras: {
    name: 'Cerebras',
    options: { apiKey: '{env:CEREBRAS_API_KEY}', baseURL: 'https://api.cerebras.ai/v1' },
  },
};

export const KNOWN_PROVIDERS = [
  ...Object.keys(BUILTIN_AI_PROVIDERS),
  'claude-cli',
  'codex-cli',
  'opencode-cli',
  'gemini-cli',
  'qwen-cli',
  'openai-compatible',
];

export const CLI_MODEL_IDS = ['claude-cli', 'codex-cli', 'opencode-cli', 'gemini-cli', 'qwen-cli'] as const;

export function isCliModel(model: string): boolean {
  return CLI_MODEL_IDS.includes(model as typeof CLI_MODEL_IDS[number]);
}

export const KNOWN_MODELS = [
  'none',
  'claude-cli',
  'codex-cli',
  'opencode-cli',
  'gemini-cli',
  'qwen-cli',

  // Anthropic
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-opus-4-1',
  'anthropic/claude-haiku-4-5',

  // OpenAI
  'openai/gpt-5.4',
  'openai/gpt-5.4-mini',
  'openai/gpt-5.4-nano',
  'openai/gpt-5.2',
  'openai/gpt-5',
  'openai/gpt-4.1',

  // Google Gemini
  'google/gemini-3-pro-preview',
  'google/gemini-3-flash-preview',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',

  // OpenAI-compatible hosted providers
  'deepseek/deepseek-chat',
  'deepseek/deepseek-reasoner',
  'xai/grok-4',
  'xai/grok-code-fast-1',
  'mistral/mistral-large-latest',
  'mistral/codestral-latest',
  'moonshot/kimi-k2.5',
  'moonshot/kimi-k2-thinking',
  'zai/glm-5.1',
  'zai/glm-5',
  'zai/glm-5-turbo',
  'zai/glm-4.7',
  'groq/openai/gpt-oss-120b',
  'together/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8',
  'perplexity/sonar-pro',
  'fireworks/accounts/fireworks/models/qwen3-coder-480b-a35b-instruct',
  'cerebras/qwen-3-coder-480b',

  // Aggregators and local OpenAI-compatible servers
  'openrouter/anthropic/claude-sonnet-4.5',
  'openrouter/openai/gpt-5.4',
  'openrouter/google/gemini-3-pro-preview',
  'openrouter/deepseek/deepseek-chat',
  'lmstudio/local-model',

  // Ollama local models
  'ollama/gpt-oss:20b',
  'ollama/gpt-oss:120b',
  'ollama/qwen3-coder:latest',
  'ollama/deepseek-r1:latest',
  'ollama/llama3.3:70b',
  'ollama/mistral:latest',
];

function cloneProviderConfig(config: AiProviderConfig): AiProviderConfig {
  return {
    ...config,
    options: { ...(config.options ?? {}) },
    models: config.models ? { ...config.models } : undefined,
  };
}

export function builtinProviderConfig(providerId: string): AiProviderConfig | null {
  const config = BUILTIN_AI_PROVIDERS[providerId];
  return config ? cloneProviderConfig(config) : null;
}

export function withBuiltinProviderDefaults(
  providerId: string,
  config: AiProviderConfig | undefined,
): AiProviderConfig {
  const builtin = builtinProviderConfig(providerId);
  const existing = config ? cloneProviderConfig(config) : {};
  return {
    ...builtin,
    ...existing,
    options: {
      ...(builtin?.options ?? {}),
      ...(existing.options ?? {}),
    },
    models: {
      ...(builtin?.models ?? {}),
      ...(existing.models ?? {}),
    },
  };
}

export function defaultApiKeyPlaceholder(providerId: string): string {
  const apiKey = BUILTIN_AI_PROVIDERS[providerId]?.options?.apiKey;
  return typeof apiKey === 'string' ? apiKey : '{env:PROVIDER_API_KEY}';
}

export function defaultBaseUrlPlaceholder(providerId: string): string {
  const baseURL = BUILTIN_AI_PROVIDERS[providerId]?.options?.baseURL;
  if (typeof baseURL === 'string') return baseURL;
  if (providerId === 'openai' || providerId === 'openai-compatible') return 'https://api.openai.com/v1';
  return '';
}
