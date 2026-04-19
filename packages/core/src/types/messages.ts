// Shared message types for the AI Agent Platform
// Based on claude-code's query.ts patterns, generalized for multi-provider support

import type { UUID } from 'crypto';

// ============================================================
// Message Types
// ============================================================

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image' | 'thinking';
  text?: string;
  id?: string; // tool_use ID
  name?: string; // tool name
  input?: Record<string, unknown>; // tool input
  content?: string | ContentBlock[]; // tool result content
  isError?: boolean;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  name?: string; // tool name
  content: string;
  isError?: boolean;
}

export interface ThinkingContent {
  type: 'thinking';
  text: string;
}

export type MessageContent = TextContent | ToolUseContent | ToolResultContent | ThinkingContent;

export interface Message {
  role: MessageRole;
  content: string | MessageContent[];
}

// ============================================================
// Token Usage
// ============================================================

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens: number;
}

// ============================================================
// Model Info
// ============================================================

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  supportsToolUse: boolean;
  supportsStreaming: boolean;
  supportsThinking?: boolean;
  costPerMillionInputTokens?: number;
  costPerMillionOutputTokens?: number;
}

// ============================================================
// User & Assistant Message (Enriched for internal use)
// ============================================================

export interface UserMessage {
  type: 'user';
  uuid: UUID;
  message: Message;
  toolUseResult?: {
    data: unknown;
    resultForAssistant: string;
  };
}

export interface AssistantMessage {
  type: 'assistant';
  uuid: UUID;
  message: {
    id: string;
    content: MessageContent[];
    model: string;
    stopReason: string | null;
    usage: TokenUsage;
  };
  costUSD: number;
  durationMs: number;
  isApiErrorMessage?: boolean;
}

export interface ProgressMessage {
  type: 'progress';
  uuid: UUID;
  toolUseId: string;
  content: AssistantMessage;
}

export type InternalMessage = UserMessage | AssistantMessage | ProgressMessage;
