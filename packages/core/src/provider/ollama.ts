// Ollama (Local Model) Provider Adapter
// Connects to local Ollama instance via HTTP API

import type {
  LLMProviderAdapter,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ProviderConfig,
} from './adapter.js';
import type { MessageContent, ModelInfo, TokenUsage } from '../types/messages.js';

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

interface OllamaChatResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaModelTag {
  name: string;
  size: number;
  details: {
    parameter_size: string;
    quantization_level: string;
  };
}

export class OllamaAdapter implements LLMProviderAdapter {
  readonly id = 'ollama';
  readonly name = 'Ollama (Local)';
  readonly supportedModels: string[] = [];

  private baseUrl: string;

  constructor(config: ProviderConfig = {}) {
    this.baseUrl = (config.baseUrl || process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434').replace(/\/$/, '');
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body = this.buildBody(request, false);

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as OllamaChatResponse;
    return this.mapResponse(data, request.model);
  }

  async *streamComplete(request: CompletionRequest): AsyncGenerator<StreamChunk, CompletionResponse, unknown> {
    const body = this.buildBody(request, true);

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    yield { type: 'message_start' };

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let accumulatedContent = '';
    let finalData: OllamaChatResponse | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      const lines = text.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const data = JSON.parse(line) as OllamaChatResponse;
          if (data.message?.content) {
            accumulatedContent += data.message.content;
            yield { type: 'content_delta', delta: data.message.content };
          }
          if (data.done) {
            finalData = data;
          }
        } catch { /* skip malformed lines */ }
      }
    }

    const usage: TokenUsage = {
      inputTokens: finalData?.prompt_eval_count ?? 0,
      outputTokens: finalData?.eval_count ?? 0,
      totalTokens: (finalData?.prompt_eval_count ?? 0) + (finalData?.eval_count ?? 0),
    };

    const content: MessageContent[] = [];
    if (accumulatedContent) {
      content.push({ type: 'text', text: accumulatedContent });
    }

    const completionResponse: CompletionResponse = {
      id: `ollama-${Date.now()}`,
      content,
      usage,
      stopReason: 'end_turn',
      model: request.model,
      costUSD: 0, // Local models are free
    };

    yield { type: 'message_end', usage };

    return completionResponse;
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) return [];

      const data = await response.json() as { models: OllamaModelTag[] };
      return data.models.map(m => ({
        id: m.name,
        name: m.name,
        provider: this.id,
        maxContextTokens: 128_000, // Varies by model
        maxOutputTokens: 8192,
        supportsToolUse: true,
        supportsStreaming: true,
        costPerMillionInputTokens: 0,
        costPerMillionOutputTokens: 0,
      }));
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  calculateCost(_model: string, _usage: TokenUsage): number {
    return 0; // Local models are free
  }

  // ── Private helpers ──────────────────────────────────────────

  private buildBody(request: CompletionRequest, stream: boolean) {
    const messages: OllamaMessage[] = [];

    if (request.systemPrompt?.length) {
      messages.push({
        role: 'system',
        content: request.systemPrompt.join('\n'),
      });
    }

    for (const msg of request.messages) {
      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      } else {
        const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
        messages.push({ role: msg.role as 'user' | 'assistant', content: text });
      }
    }

    const tools = request.tools?.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    return {
      model: request.model,
      messages,
      stream,
      options: {
        temperature: request.temperature ?? 0.7,
        num_predict: request.maxTokens || 8192,
      },
      ...(tools?.length ? { tools } : {}),
    };
  }

  private mapResponse(data: OllamaChatResponse, model: string): CompletionResponse {
    const content: MessageContent[] = [];

    if (data.message.content) {
      content.push({ type: 'text', text: data.message.content });
    }

    if (data.message.tool_calls) {
      for (const tc of data.message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: `ollama-tc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: tc.function.name,
          input: tc.function.arguments,
        });
      }
    }

    const usage: TokenUsage = {
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
      totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
    };

    return {
      id: `ollama-${Date.now()}`,
      content,
      usage,
      stopReason: content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn',
      model,
      costUSD: 0,
    };
  }
}
