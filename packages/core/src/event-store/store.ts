// Event Store interface

import type {
  ConversationEvent,
  Conversation,
  CompactionRequest,
  ForkRequest,
} from './types.js';

export interface EventStore {
  // ── Conversation CRUD ────────────────────────────────────────
  createConversation(conversation: Omit<Conversation, 'createdAt' | 'updatedAt'>): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | null>;
  listConversations(options?: { limit?: number; offset?: number }): Promise<Conversation[]>;
  updateConversation(id: string, updates: Partial<Pick<Conversation, 'title' | 'metadata'>>): Promise<Conversation>;
  deleteConversation(id: string): Promise<void>;

  // ── Events ───────────────────────────────────────────────────
  appendEvent(event: Omit<ConversationEvent, 'id' | 'createdAt'>): Promise<ConversationEvent>;
  getEvents(conversationId: string, options?: { fromSequence?: number; toSequence?: number }): Promise<ConversationEvent[]>;
  getEvent(conversationId: string, sequenceNumber: number): Promise<ConversationEvent | null>;
  getLatestSequence(conversationId: string): Promise<number>;

  // ── Compaction ───────────────────────────────────────────────
  compact(request: CompactionRequest): Promise<void>;

  // ── Fork ─────────────────────────────────────────────────────
  fork(request: ForkRequest): Promise<Conversation>;

  // ── Replay (for resuming from a specific point) ──────────────
  getEventsForReplay(conversationId: string, fromSequence: number): Promise<{
    context: ConversationEvent[];    // Events before fromSequence (for context)
    replay: ConversationEvent[];     // Events from fromSequence onward
  }>;
}
