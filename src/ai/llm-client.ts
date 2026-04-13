import { transport } from '../transport';
import type { AiProviderConfig, AppConfig } from '../config/ConfigContext';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ResolvedModelConfig {
  providerId: string;
  modelId: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseURL?: string;
  options: Record<string, unknown>;
}

function inferProvider(model: string): string {
  if (model === 'claude-cli') return 'claude-cli';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-') || model.startsWith('o1-') || model.startsWith('o3-')
      || model.startsWith('o4-') || model.startsWith('chatgpt-')) return 'openai';
  if (model.startsWith('gemini-')) return 'google';
  if (model.startsWith('ollama/') || model.startsWith('ollama:')) return 'ollama';
  return 'openai';
}

function providerMap(provider: AppConfig['workspace_ai']['provider']): Record<string, AiProviderConfig> {
  if (!provider || typeof provider === 'string') return {};
  return provider;
}

function firstProviderId(providers: Record<string, AiProviderConfig>): string | null {
  const keys = Object.keys(providers);
  return keys.length === 1 ? keys[0] : null;
}

function splitModel(model: string, providers: Record<string, AiProviderConfig>): { providerId: string; modelKey: string } {
  const slash = model.indexOf('/');
  if (slash > 0) {
    return {
      providerId: model.slice(0, slash),
      modelKey: model.slice(slash + 1),
    };
  }

  return {
    providerId: firstProviderId(providers) ?? inferProvider(model),
    modelKey: model,
  };
}

function stringOption(options: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = options[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function resolveModelConfig(cfg: AppConfig): ResolvedModelConfig | null {
  const wai = cfg.workspace_ai;
  const model = wai.model?.trim();
  if (!model || model === 'none') return null;

  const providers = providerMap(wai.provider);
  const { providerId, modelKey } = splitModel(model, providers);
  if (providerId === 'claude-cli' || model === 'claude-cli') {
    return {
      providerId: 'claude-cli',
      modelId: 'claude-cli',
      options: {},
    };
  }

  const providerCfg = providers[providerId] ?? {};
  const providerOptions = providerCfg.options ?? {};
  const modelCfg = providerCfg.models?.[modelKey];
  const modelOptions = modelCfg?.options ?? {};
  const options = { ...providerOptions, ...modelOptions };

  return {
    providerId,
    modelId: modelCfg?.id || modelKey,
    apiKey: stringOption(options, ['apiKey', 'api_key']),
    apiKeyEnv: wai.api_key_env,
    baseURL: stringOption(options, ['baseURL', 'base_url']) ?? wai.base_url ?? undefined,
    options,
  };
}

// ---------------------------------------------------------------------------
// Public client — all API calls go through the Rust backend to avoid CORS
// and to work with both HTTP (Ollama) and HTTPS endpoints in all environments.
// ---------------------------------------------------------------------------

export class LLMClient {
  async complete(messages: LLMMessage[], cfg: AppConfig): Promise<string> {
    const wai = cfg.workspace_ai;
    if (!wai.model || wai.model === 'none') return '';
    const resolved = resolveModelConfig(cfg);
    if (!resolved) return '';

    if (resolved.providerId === 'claude-cli') {
      // claude-cli uses a subprocess, handled by its own IPC command
      const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      if (!lastUser) return '';
      const prompt = systemParts.length > 0
        ? systemParts.join('\n\n') + '\n\n' + lastUser.content
        : lastUser.content;
      return transport.send<string>('claude_cli_query', { prompt });
    }

    // All other providers: delegate to Rust for native HTTP (no CORS, no fetch restrictions)
    return transport.send<string>('llm_complete', {
      args: {
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        model: resolved.modelId,
        provider: resolved.providerId,
        api_key: resolved.apiKey ?? null,
        api_key_env: resolved.apiKeyEnv ?? null,
        base_url: resolved.baseURL ?? null,
        options: resolved.options,
      },
    });
  }
}

export const llmClient = new LLMClient();
