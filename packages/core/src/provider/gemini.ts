// Gemini (Google) Provider Adapter

import { GoogleGenerativeAI, type GenerativeModel, type Content, type Part } from '@google/generative-ai';
import type {
  LLMProviderAdapter,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ProviderConfig,
} from './adapter.js';
import type { MessageContent, ModelInfo, TokenUsage } from '../types/messages.js';

const PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.0-flash-lite': { input: 0.02, output: 0.1 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.15, output: 0.6 },
};

interface GeminiResponseLike {
  text: () => string;
  usageMetadata?: Record<string, number>;
  functionCalls?: () => Array<{ name: string; args: Record<string, unknown> }>;
}

function getDefaultPricing() {
  return { input: 0.1, output: 0.4 };
}

export class GeminiAdapter implements LLMProviderAdapter {
  readonly id = 'gemini';
  readonly name = 'Google Gemini';
  readonly supportedModels = Object.keys(PRICING);

  private genAI: GoogleGenerativeAI;

  constructor(config: ProviderConfig = {}) {
    const apiKey = (config.apiKey || process.env['GOOGLE_API_KEY']) ?? '';
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = this.getModel(request);
    const { contents, tools } = this.buildParams(request);

    const result = await model.generateContent({
      contents,
      tools: tools ? [{ functionDeclarations: tools }] as unknown as import('@google/generative-ai').Tool[] : undefined,
    } as import('@google/generative-ai').GenerateContentRequest, { signal: request.signal });

    const response = result.response;
    return this.mapResponse(response as unknown as GeminiResponseLike, request.model);
  }

  async *streamComplete(request: CompletionRequest): AsyncGenerator<StreamChunk, CompletionResponse, unknown> {
    const model = this.getModel(request);
    const { contents, tools } = this.buildParams(request);

    const result = await model.generateContentStream({
      contents,
      tools: tools ? [{ functionDeclarations: tools }] as unknown as import('@google/generative-ai').Tool[] : undefined,
    } as import('@google/generative-ai').GenerateContentRequest, { signal: request.signal });

    yield { type: 'message_start' };

    let accumulatedText = '';

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        accumulatedText += text;
        yield { type: 'content_delta', delta: text };
      }
    }

    const aggregatedResponse = await result.response;
    const response = this.mapResponse(aggregatedResponse as unknown as GeminiResponseLike, request.model);

    yield { type: 'message_end', usage: response.usage };

    return response;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.supportedModels.map(id => ({
      id,
      name: id,
      provider: this.id,
      maxContextTokens: id.includes('pro') ? 1_000_000 : 1_000_000,
      maxOutputTokens: 8192,
      supportsToolUse: true,
      supportsStreaming: true,
      supportsThinking: id.includes('2.5'),
      costPerMillionInputTokens: (PRICING[id] ?? getDefaultPricing()).input,
      costPerMillionOutputTokens: (PRICING[id] ?? getDefaultPricing()).output,
    }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      const model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      await model.generateContent('test');
      return true;
    } catch {
      return false;
    }
  }

  calculateCost(model: string, usage: TokenUsage): number {
    const pricing = PRICING[model] ?? getDefaultPricing();
    return (
      (usage.inputTokens / 1_000_000) * pricing.input +
      (usage.outputTokens / 1_000_000) * pricing.output
    );
  }

  // ── Private helpers ──────────────────────────────────────────

  private getModel(request: CompletionRequest): GenerativeModel {
    const systemInstruction = request.systemPrompt?.join('\n');
    return this.genAI.getGenerativeModel({
      model: request.model,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        temperature: request.temperature ?? 1,
        maxOutputTokens: request.maxTokens || 8192,
      },
    });
  }

  private buildParams(request: CompletionRequest) {
    const contents: Content[] = request.messages
      .filter(msg => msg.role === 'user' || msg.role === 'assistant')
      .map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: this.messageToParts(msg.content),
      }));

    // Gemini API does not support 'additionalProperties' in OpenAPI schemas
    const stripAdditionalProperties = (schema: any): any => {
      if (typeof schema !== 'object' || schema === null) return schema;
      if (Array.isArray(schema)) return schema.map(stripAdditionalProperties);
      
      const newSchema: any = {};
      for (const [key, value] of Object.entries(schema)) {
        if (key === 'additionalProperties') continue;
        newSchema[key] = stripAdditionalProperties(value);
      }
      return newSchema;
    };

    const tools = request.tools?.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: stripAdditionalProperties(tool.inputSchema),
    }));

    return { contents, tools };
  }

  private messageToParts(content: string | MessageContent[]): Part[] {
    if (typeof content === 'string') {
      return [{ text: content }];
    }
    return content.map(block => {
      if (block.type === 'text') return { text: block.text };
      if (block.type === 'tool_use') {
        return {
          functionCall: { name: block.name, args: block.input },
        };
      }
      if (block.type === 'tool_result') {
        return {
          functionResponse: { name: block.name || '', response: { result: block.content } },
        };
      }
      return { text: '' };
    }) as Part[];
  }

  private mapResponse(response: GeminiResponseLike, model: string): CompletionResponse {
    const content: MessageContent[] = [];

    const text = response.text();
    if (text) {
      content.push({ type: 'text', text });
    }

    try {
      const fnCalls = response.functionCalls?.();
      if (fnCalls) {
        for (const fc of fnCalls) {
          content.push({
            type: 'tool_use',
            id: `gemini-tc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name: fc.name,
            input: fc.args,
          });
        }
      }
    } catch { /* no function calls */ }

    const usageMeta = response.usageMetadata ?? {};
    const usage: TokenUsage = {
      inputTokens: usageMeta['promptTokenCount'] ?? 0,
      outputTokens: usageMeta['candidatesTokenCount'] ?? 0,
      totalTokens: usageMeta['totalTokenCount'] ?? 0,
    };

    return {
      id: `gemini-${Date.now()}`,
      content,
      usage,
      stopReason: content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn',
      model,
      costUSD: this.calculateCost(model, usage),
    };
  }
}
