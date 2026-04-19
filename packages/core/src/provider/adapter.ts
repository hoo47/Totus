// LLM Provider Adapter interface
// Abstracts away differences between Claude, OpenAI, Gemini, and local models

import type { Message, TokenUsage, ModelInfo, MessageContent } from '../types/messages.js';

// ============================================================
// Request / Response Types
// ============================================================

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string;
  messages: Message[];
  systemPrompt?: string[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  maxThinkingTokens?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface CompletionResponse {
  id: string;
  content: MessageContent[];
  usage: TokenUsage;
  stopReason: string | null;
  model: string;
  costUSD?: number;
}

export interface StreamChunk {
  type: 'content_start' | 'content_delta' | 'content_end' | 'message_start' | 'message_end' | 'error';
  content?: Partial<MessageContent>;
  delta?: string;
  usage?: Partial<TokenUsage>;
  error?: string;
}

// ============================================================
// Provider Adapter Interface
// ============================================================

export interface LLMProviderAdapter {
  /** Unique provider identifier */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** List of model IDs this provider supports */
  readonly supportedModels: string[];

  /** Complete a conversation (non-streaming) */
  complete(request: CompletionRequest): Promise<CompletionResponse>;

  /** Stream a conversation response */
  streamComplete(request: CompletionRequest): AsyncGenerator<StreamChunk, CompletionResponse, unknown>;

  /** Get available models from this provider */
  listModels(): Promise<ModelInfo[]>;

  /** Check if the provider is reachable and configured */
  healthCheck(): Promise<boolean>;

  /** Calculate cost for a given usage (provider-specific pricing) */
  calculateCost(model: string, usage: TokenUsage): number;
}

// ============================================================
// Provider Configuration
// ============================================================

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  customHeaders?: Record<string, string>;
  [key: string]: unknown;
}

// ============================================================
// Provider Registry
// ============================================================

export interface ProviderRegistry {
  register(provider: LLMProviderAdapter): void;
  unregister(providerId: string): void;
  get(providerId: string): LLMProviderAdapter | undefined;
  getAll(): LLMProviderAdapter[];
  getDefault(): LLMProviderAdapter;
  setDefault(providerId: string): void;
}
