// Event-Sourced Conversation Store types

export type EventType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'system_prompt'
  | 'context_injection'
  | 'fork'
  | 'compaction'
  | 'error';

export interface EventContent {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | Record<string, unknown>[];
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  isError?: boolean;
}

export interface EventMetadata {
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  durationMs?: number;
  stopReason?: string;
  [key: string]: unknown;
}

export interface ConversationEvent {
  id: string;
  conversationId: string;
  sequenceNumber: number;
  type: EventType;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: EventContent;
  metadata: EventMetadata;
  parentEventId?: string;
  isCompacted: boolean;
  compactedSummary?: string;
  createdAt: Date;
}

export interface Conversation {
  id: string;
  title?: string;
  agentId: string;
  providerId: string;
  model: string;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

export interface CompactionRequest {
  conversationId: string;
  fromSequence: number;
  toSequence: number;
  summary: string;
}

export interface ResumeRequest {
  conversationId: string;
  fromSequence: number;
}

export interface ForkRequest {
  conversationId: string;
  atSequence: number;
  newTitle?: string;
}
