// LM Studio (Local Model) Provider Adapter
// Connects to LM Studio's OpenAI-compatible API server (default: http://localhost:1234/v1)

import OpenAI from 'openai';
import type {
  LLMProviderAdapter,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ProviderConfig,
} from './adapter.js';
import type { MessageContent, ModelInfo, TokenUsage } from '../types/messages.js';

export class LMStudioAdapter implements LLMProviderAdapter {
  readonly id = 'lmstudio';
  readonly name = 'LM Studio (Local)';
  readonly supportedModels: string[] = [];

  private client: OpenAI;
  private baseUrl: string;

  constructor(config: ProviderConfig = {}) {
    this.baseUrl = (config.baseUrl || process.env['LMSTUDIO_BASE_URL'] || 'http://localhost:1234').replace(/\/$/, '');

    this.client = new OpenAI({
      apiKey: 'lm-studio', // LM Studio does not require a real API key
      baseURL: `${this.baseUrl}/v1`,
      maxRetries: 0,
      timeout: config.timeout || 120_000, // Local models may need longer timeout
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const params = this.buildParams(request);

    const response = await this.client.chat.completions.create({
      ...params,
      stream: false,
    }, { signal: request.signal });

    return this.mapResponse(response, request.model);
  }

  async *streamComplete(request: CompletionRequest): AsyncGenerator<StreamChunk, CompletionResponse, unknown> {
    const params = this.buildParams(request);

    const stream = await this.client.chat.completions.create({
      ...params,
      stream: true,
      stream_options: { include_usage: true },
    }, { signal: request.signal });

    let accumulatedContent = '';
    let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    yield { type: 'message_start' };

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        accumulatedContent += delta.content;
        yield { type: 'content_delta', delta: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.id) {
            toolCalls.push({ id: tc.id, name: tc.function?.name ?? '', arguments: '' });
          }
          if (tc.function?.arguments) {
            const last = toolCalls[toolCalls.length - 1];
            if (last) {
              last.arguments += tc.function.arguments;
            }
          }
        }
      }

      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          totalTokens: chunk.usage.total_tokens,
        };
      }
    }

    const content: MessageContent[] = [];
    if (accumulatedContent) {
      content.push({ type: 'text', text: accumulatedContent });
    }
    for (const tc of toolCalls) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch { /* ignore */ }
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parsedArgs });
    }

    const response: CompletionResponse = {
      id: `lmstudio-${Date.now()}`,
      content,
      usage,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      model: request.model,
      costUSD: 0, // Local models are free
    };

    yield { type: 'message_end', usage };

    return response;
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const models = await this.client.models.list();
      const result: ModelInfo[] = [];

      for await (const model of models) {
        result.push({
          id: model.id,
          name: model.id,
          provider: this.id,
          maxContextTokens: 128_000, // Varies by model, use reasonable default
          maxOutputTokens: 8192,
          supportsToolUse: true,
          supportsStreaming: true,
          costPerMillionInputTokens: 0,
          costPerMillionOutputTokens: 0,
        });
      }

      return result;
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const models = await this.client.models.list();
      // Just check if we can iterate at least once
      for await (const _model of models) {
        return true;
      }
      return true; // Empty list is still a valid response
    } catch {
      return false;
    }
  }

  calculateCost(_model: string, _usage: TokenUsage): number {
    return 0; // Local models are free
  }

  // ── Private helpers ──────────────────────────────────────────

  private buildParams(request: CompletionRequest) {
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    // System prompt
    if (request.systemPrompt?.length) {
      messages.push({
        role: 'system',
        content: request.systemPrompt.join('\n'),
      });
    }

    // Conversation messages
    for (const msg of request.messages) {
      if (msg.role === 'tool') {
        // tool_result messages
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              messages.push({
                role: 'tool',
                tool_call_id: block.toolUseId,
                content: block.content,
              });
            }
          }
        }
        continue;
      }

      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      } else {
        // Handle structured content
        const textParts = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
        const toolUseParts = msg.content.filter(b => b.type === 'tool_use');

        if (msg.role === 'assistant' && toolUseParts.length > 0) {
          messages.push({
            role: 'assistant',
            content: textParts || null,
            tool_calls: toolUseParts.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input),
              },
            })),
          });
        } else {
          messages.push({ role: msg.role as 'user' | 'assistant', content: textParts });
        }
      }
    }

    // Tools
    const tools: OpenAI.ChatCompletionTool[] | undefined = request.tools?.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as OpenAI.FunctionParameters,
      },
    }));

    return {
      model: request.model,
      messages,
      tools: tools?.length ? tools : undefined,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens || 8192,
    };
  }

  private mapResponse(response: OpenAI.ChatCompletion, model: string): CompletionResponse {
    const choice = response.choices[0];
    const content: MessageContent[] = [];

    if (choice?.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }

    if (choice?.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch { /* ignore */ }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parsedArgs });
      }
    }

    const usage: TokenUsage = {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    };

    return {
      id: response.id,
      content,
      usage,
      stopReason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
      model: response.model,
      costUSD: 0,
    };
  }
}
