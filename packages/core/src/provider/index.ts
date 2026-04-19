// Provider Registry + barrel exports

import type { LLMProviderAdapter, ProviderRegistry } from './adapter.js';

export class DefaultProviderRegistry implements ProviderRegistry {
  private providers = new Map<string, LLMProviderAdapter>();
  private defaultProviderId: string | null = null;

  register(provider: LLMProviderAdapter): void {
    this.providers.set(provider.id, provider);
    if (this.providers.size === 1) {
      this.defaultProviderId = provider.id;
    }
  }

  unregister(providerId: string): void {
    this.providers.delete(providerId);
    if (this.defaultProviderId === providerId) {
      this.defaultProviderId = this.providers.keys().next().value ?? null;
    }
  }

  get(providerId: string): LLMProviderAdapter | undefined {
    return this.providers.get(providerId);
  }

  getAll(): LLMProviderAdapter[] {
    return [...this.providers.values()];
  }

  getDefault(): LLMProviderAdapter {
    if (!this.defaultProviderId) {
      throw new Error('No providers registered');
    }
    const provider = this.providers.get(this.defaultProviderId);
    if (!provider) {
      throw new Error(`Default provider "${this.defaultProviderId}" not found`);
    }
    return provider;
  }

  setDefault(providerId: string): void {
    if (!this.providers.has(providerId)) {
      throw new Error(`Provider "${providerId}" not registered`);
    }
    this.defaultProviderId = providerId;
  }
}

export { type LLMProviderAdapter, type CompletionRequest, type CompletionResponse, type StreamChunk, type ProviderConfig, type ProviderRegistry, type ToolSchema } from './adapter.js';
export { ClaudeAdapter } from './claude.js';
export { OpenAIAdapter } from './openai.js';
export { GeminiAdapter } from './gemini.js';
export { OllamaAdapter } from './ollama.js';
export { LMStudioAdapter } from './lmstudio.js';
