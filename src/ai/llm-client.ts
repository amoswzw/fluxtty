import { invoke } from '@tauri-apps/api/core';
import type { AppConfig } from '../config/ConfigContext';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ---------------------------------------------------------------------------
// Public client — all API calls go through the Rust backend to avoid CORS
// and to work with both HTTP (Ollama) and HTTPS endpoints in all environments.
// ---------------------------------------------------------------------------

export class LLMClient {
  async complete(messages: LLMMessage[], cfg: AppConfig): Promise<string> {
    const wai = cfg.workspace_ai;
    if (!wai.model || wai.model === 'none') return '';

    if (wai.model === 'claude-cli') {
      // claude-cli uses a subprocess, handled by its own IPC command
      const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      if (!lastUser) return '';
      const prompt = systemParts.length > 0
        ? systemParts.join('\n\n') + '\n\n' + lastUser.content
        : lastUser.content;
      return invoke<string>('claude_cli_query', { prompt });
    }

    // All other providers: delegate to Rust for native HTTP (no CORS, no fetch restrictions)
    return invoke<string>('llm_complete', {
      args: {
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        model: wai.model,
        provider: wai.provider ?? null,
        api_key_env: wai.api_key_env ?? null,
        base_url: wai.base_url ?? null,
      },
    });
  }
}

export const llmClient = new LLMClient();
