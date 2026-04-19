// In-Memory Event Store implementation (for development/testing)

import { v4 as uuidv4 } from 'uuid';
import type { EventStore } from './store.js';
import type {
  ConversationEvent,
  Conversation,
  CompactionRequest,
  ForkRequest,
} from './types.js';

export class InMemoryEventStore implements EventStore {
  private conversations = new Map<string, Conversation>();
  private events = new Map<string, ConversationEvent[]>(); // conversationId -> events

  // ── Conversation CRUD ────────────────────────────────────────

  async createConversation(data: Omit<Conversation, 'createdAt' | 'updatedAt'>): Promise<Conversation> {
    const conversation: Conversation = {
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.conversations.set(data.id, conversation);
    this.events.set(data.id, []);
    return conversation;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null;
  }

  async listConversations(options?: { limit?: number; offset?: number }): Promise<Conversation[]> {
    const all = [...this.conversations.values()].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
    );
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 50;
    return all.slice(offset, offset + limit);
  }

  async updateConversation(id: string, updates: Partial<Pick<Conversation, 'title' | 'metadata'>>): Promise<Conversation> {
    const conv = this.conversations.get(id);
    if (!conv) throw new Error(`Conversation ${id} not found`);

    const updated = { ...conv, ...updates, updatedAt: new Date() };
    this.conversations.set(id, updated);
    return updated;
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations.delete(id);
    this.events.delete(id);
  }

  // ── Events ───────────────────────────────────────────────────

  async appendEvent(data: Omit<ConversationEvent, 'id' | 'createdAt'>): Promise<ConversationEvent> {
    const events = this.events.get(data.conversationId);
    if (!events) throw new Error(`Conversation ${data.conversationId} not found`);

    const event: ConversationEvent = {
      ...data,
      id: uuidv4(),
      createdAt: new Date(),
    };
    events.push(event);

    // Update conversation's updatedAt
    const conv = this.conversations.get(data.conversationId);
    if (conv) {
      conv.updatedAt = new Date();
    }

    return event;
  }

  async getEvents(conversationId: string, options?: { fromSequence?: number; toSequence?: number }): Promise<ConversationEvent[]> {
    const events = this.events.get(conversationId) ?? [];
    let filtered = events;

    if (options?.fromSequence !== undefined) {
      filtered = filtered.filter(e => e.sequenceNumber >= options.fromSequence!);
    }
    if (options?.toSequence !== undefined) {
      filtered = filtered.filter(e => e.sequenceNumber <= options.toSequence!);
    }

    return filtered.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  }

  async getEvent(conversationId: string, sequenceNumber: number): Promise<ConversationEvent | null> {
    const events = this.events.get(conversationId) ?? [];
    return events.find(e => e.sequenceNumber === sequenceNumber) ?? null;
  }

  async getLatestSequence(conversationId: string): Promise<number> {
    const events = this.events.get(conversationId) ?? [];
    if (events.length === 0) return -1;
    return Math.max(...events.map(e => e.sequenceNumber));
  }

  // ── Compaction ───────────────────────────────────────────────

  async compact(request: CompactionRequest): Promise<void> {
    const events = this.events.get(request.conversationId);
    if (!events) throw new Error(`Conversation ${request.conversationId} not found`);

    // Mark events in range as compacted
    for (const event of events) {
      if (event.sequenceNumber >= request.fromSequence && event.sequenceNumber <= request.toSequence) {
        event.isCompacted = true;
        event.compactedSummary = request.summary;
      }
    }
  }

  // ── Fork ─────────────────────────────────────────────────────

  async fork(request: ForkRequest): Promise<Conversation> {
    const sourceConv = this.conversations.get(request.conversationId);
    if (!sourceConv) throw new Error(`Conversation ${request.conversationId} not found`);

    const sourceEvents = this.events.get(request.conversationId) ?? [];
    const eventsToFork = sourceEvents.filter(e => e.sequenceNumber <= request.atSequence);

    const newId = uuidv4();
    const newConversation: Conversation = {
      ...sourceConv,
      id: newId,
      title: request.newTitle || `Fork of ${sourceConv.title ?? sourceConv.id}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: { ...sourceConv.metadata, forkedFrom: request.conversationId, forkedAtSequence: request.atSequence },
    };

    this.conversations.set(newId, newConversation);
    this.events.set(newId, eventsToFork.map(e => ({
      ...e,
      id: uuidv4(),
      conversationId: newId,
      parentEventId: e.id,
      createdAt: new Date(),
    })));

    return newConversation;
  }

  // ── Replay ───────────────────────────────────────────────────

  async getEventsForReplay(conversationId: string, fromSequence: number): Promise<{
    context: ConversationEvent[];
    replay: ConversationEvent[];
  }> {
    const events = this.events.get(conversationId) ?? [];
    const sorted = events.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    return {
      context: sorted.filter(e => e.sequenceNumber < fromSequence),
      replay: sorted.filter(e => e.sequenceNumber >= fromSequence),
    };
  }
}
