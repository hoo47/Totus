// Claude (Anthropic) Provider Adapter
// Reference: claude-code/src/services/claude.ts

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import type {
  LLMProviderAdapter,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ProviderConfig,
  ToolSchema,
} from './adapter.js';
import type { MessageContent, ModelInfo, TokenUsage } from '../types/messages.js';

// Cost per million tokens (Claude 3.5/3.7 Sonnet pricing)
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-3-7-sonnet-20250219': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-20250514': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
};

function getDefaultPricing() {
  return { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
}

export class ClaudeAdapter implements LLMProviderAdapter {
  readonly id = 'claude';
  readonly name = 'Anthropic Claude';
  readonly supportedModels = Object.keys(PRICING);

  private client: Anthropic;
  private config: ProviderConfig;

  constructor(config: ProviderConfig = {}) {
    this.config = config;
    this.client = new Anthropic({
      apiKey: config.apiKey || process.env['ANTHROPIC_API_KEY'],
      baseURL: config.baseUrl,
      maxRetries: 0, // We handle retries ourselves
      timeout: config.timeout || 60_000,
      defaultHeaders: {
        ...config.customHeaders,
      },
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const { messages, systemPrompt, tools, model } = this.buildParams(request);

    const response = await this.client.messages.create({
      model,
      max_tokens: request.maxTokens || 8192,
      messages,
      system: systemPrompt,
      tools: tools as Anthropic.Tool[],
      temperature: request.temperature ?? 1,
      ...(request.maxThinkingTokens && request.maxThinkingTokens > 0
        ? { thinking: { budget_tokens: request.maxThinkingTokens, type: 'enabled' as const } }
        : {}),
    }, { signal: request.signal });

    return this.mapResponse(response, model);
  }

  async *streamComplete(request: CompletionRequest): AsyncGenerator<StreamChunk, CompletionResponse, unknown> {
    const { messages, systemPrompt, tools, model } = this.buildParams(request);

    const stream = this.client.messages.stream({
      model,
      max_tokens: request.maxTokens || 8192,
      messages,
      system: systemPrompt,
      tools: tools as Anthropic.Tool[],
      temperature: request.temperature ?? 1,
      ...(request.maxThinkingTokens && request.maxThinkingTokens > 0
        ? { thinking: { budget_tokens: request.maxThinkingTokens, type: 'enabled' as const } }
        : {}),
    }, { signal: request.signal });

    let ttftMs: number | undefined;
    const startTime = Date.now();

    for await (const event of stream) {
      if (event.type === 'message_start') {
        ttftMs = Date.now() - startTime;
        yield { type: 'message_start' };
      } else if (event.type === 'content_block_start') {
        yield { type: 'content_start', content: this.mapContentBlock(event.content_block) };
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        yield {
          type: 'content_delta',
          delta: 'text' in delta ? delta.text : undefined,
        };
      } else if (event.type === 'content_block_stop') {
        yield { type: 'content_end' };
      }
    }

    const finalMessage = await stream.finalMessage();
    const response = this.mapResponse(finalMessage, model);

    yield { type: 'message_end', usage: response.usage };

    return response;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.supportedModels.map(id => ({
      id,
      name: id,
      provider: this.id,
      maxContextTokens: 200_000,
      maxOutputTokens: 8192,
      supportsToolUse: true,
      supportsStreaming: true,
      supportsThinking: id.includes('3-7') || id.includes('opus') || id.includes('sonnet-4'),
      costPerMillionInputTokens: (PRICING[id] ?? getDefaultPricing()).input,
      costPerMillionOutputTokens: (PRICING[id] ?? getDefaultPricing()).output,
    }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'test' }],
        temperature: 0,
      });
      return true;
    } catch {
      return false;
    }
  }

  calculateCost(model: string, usage: TokenUsage): number {
    const pricing = PRICING[model] ?? getDefaultPricing();
    return (
      (usage.inputTokens / 1_000_000) * pricing.input +
      (usage.outputTokens / 1_000_000) * pricing.output +
      ((usage.cacheReadInputTokens ?? 0) / 1_000_000) * pricing.cacheRead +
      ((usage.cacheCreationInputTokens ?? 0) / 1_000_000) * pricing.cacheWrite
    );
  }

  // ── Private helpers ──────────────────────────────────────────

  private buildParams(request: CompletionRequest) {
    const model = request.model;

    const messages = request.messages.map(msg => ({
      role: msg.role as 'user' | 'assistant',
      content: typeof msg.content === 'string'
        ? msg.content
        : msg.content.map(block => this.contentToAnthropicBlock(block)),
    })) as unknown as MessageParam[];

    const systemPrompt: TextBlockParam[] = (request.systemPrompt ?? []).map(text => ({
      type: 'text' as const,
      text,
    }));

    const tools = (request.tools ?? []).map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));

    return { messages, systemPrompt, tools, model };
  }

  private contentToAnthropicBlock(block: MessageContent): Record<string, unknown> {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'tool_use':
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      case 'tool_result':
        return { type: 'tool_result', tool_use_id: block.toolUseId, content: block.content, is_error: block.isError };
      case 'thinking':
        return { type: 'thinking', thinking: block.text };
      default:
        return { type: 'text', text: '' };
    }
  }

  private mapContentBlock(block: unknown): Partial<MessageContent> {
    const b = block as Record<string, unknown>;
    if (b['type'] === 'text') {
      return { type: 'text', text: b['text'] as string };
    }
    if (b['type'] === 'tool_use') {
      return { type: 'tool_use', id: b['id'] as string, name: b['name'] as string, input: b['input'] as Record<string, unknown> };
    }
    if (b['type'] === 'thinking') {
      return { type: 'thinking', text: b['thinking'] as string };
    }
    return { type: 'text', text: '' };
  }

  private mapResponse(response: Anthropic.Message, model: string): CompletionResponse {
    const content: MessageContent[] = response.content.map(block => {
      if (block.type === 'text') {
        return { type: 'text' as const, text: block.text };
      }
      if (block.type === 'tool_use') {
        return { type: 'tool_use' as const, id: block.id, name: block.name, input: block.input as Record<string, unknown> };
      }
      // thinking blocks
      if ('thinking' in block) {
        return { type: 'thinking' as const, text: (block as unknown as Record<string, unknown>)['thinking'] as string };
      }
      return { type: 'text' as const, text: '' };
    });

    const usageRaw = response.usage as unknown as Record<string, number>;
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadInputTokens: usageRaw['cache_read_input_tokens'] ?? 0,
      cacheCreationInputTokens: usageRaw['cache_creation_input_tokens'] ?? 0,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    };

    const costUSD = this.calculateCost(model, usage);

    return {
      id: response.id,
      content,
      usage,
      stopReason: response.stop_reason,
      model: response.model,
      costUSD,
    };
  }
}
