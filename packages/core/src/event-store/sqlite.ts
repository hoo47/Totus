// SQLite-based Event Store implementation using Drizzle ORM
// Persists conversation history to a local SQLite file

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, and, gte, lte, desc, sql, max } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

import type { EventStore } from './store.js';
import type {
  ConversationEvent,
  Conversation,
  CompactionRequest,
  ForkRequest,
} from './types.js';
import * as schema from './schema.js';

export class SQLiteEventStore implements EventStore {
  private db: BetterSQLite3Database<typeof schema>;
  private sqlite: Database.Database;

  constructor(dbPath: string) {
    // Ensure parent directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Create database connection
    this.sqlite = new Database(dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');

    // Create Drizzle instance
    this.db = drizzle(this.sqlite, { schema });

    // Auto-migrate: create tables if not exist
    this.migrate();
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        agent_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sequence_number INTEGER NOT NULL,
        type TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        parent_event_id TEXT,
        is_compacted INTEGER NOT NULL DEFAULT 0,
        compacted_summary TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_conversation_seq
        ON events(conversation_id, sequence_number);
    `);
  }

  // ── Conversation CRUD ────────────────────────────────────────

  async createConversation(data: Omit<Conversation, 'createdAt' | 'updatedAt'>): Promise<Conversation> {
    const now = new Date();
    const row = {
      id: data.id,
      title: data.title ?? null,
      agentId: data.agentId,
      providerId: data.providerId,
      model: data.model,
      metadata: data.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    this.db.insert(schema.conversations).values(row).run();

    return {
      ...data,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const row = this.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, id))
      .get();

    if (!row) return null;
    return this.rowToConversation(row);
  }

  async listConversations(options?: { limit?: number; offset?: number }): Promise<Conversation[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const rows = this.db
      .select()
      .from(schema.conversations)
      .orderBy(desc(schema.conversations.updatedAt))
      .limit(limit)
      .offset(offset)
      .all();

    return rows.map(r => this.rowToConversation(r));
  }

  async updateConversation(id: string, updates: Partial<Pick<Conversation, 'title' | 'metadata'>>): Promise<Conversation> {
    const existing = await this.getConversation(id);
    if (!existing) throw new Error(`Conversation ${id} not found`);

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.title !== undefined) updateData['title'] = updates.title;
    if (updates.metadata !== undefined) updateData['metadata'] = updates.metadata;

    this.db
      .update(schema.conversations)
      .set(updateData)
      .where(eq(schema.conversations.id, id))
      .run();

    const updated = await this.getConversation(id);
    return updated!;
  }

  async deleteConversation(id: string): Promise<void> {
    this.db
      .delete(schema.conversations)
      .where(eq(schema.conversations.id, id))
      .run();
  }

  // ── Events ───────────────────────────────────────────────────

  async appendEvent(data: Omit<ConversationEvent, 'id' | 'createdAt'>): Promise<ConversationEvent> {
    const id = uuidv4();
    const now = new Date();

    const row = {
      id,
      conversationId: data.conversationId,
      sequenceNumber: data.sequenceNumber,
      type: data.type,
      role: data.role,
      content: data.content,
      metadata: data.metadata ?? {},
      parentEventId: data.parentEventId ?? null,
      isCompacted: data.isCompacted,
      compactedSummary: data.compactedSummary ?? null,
      createdAt: now,
    };

    this.db.insert(schema.events).values(row).run();

    // Update conversation's updatedAt
    this.db
      .update(schema.conversations)
      .set({ updatedAt: now })
      .where(eq(schema.conversations.id, data.conversationId))
      .run();

    return { ...data, id, createdAt: now };
  }

  async getEvents(
    conversationId: string,
    options?: { fromSequence?: number; toSequence?: number },
  ): Promise<ConversationEvent[]> {
    const conditions = [eq(schema.events.conversationId, conversationId)];

    if (options?.fromSequence !== undefined) {
      conditions.push(gte(schema.events.sequenceNumber, options.fromSequence));
    }
    if (options?.toSequence !== undefined) {
      conditions.push(lte(schema.events.sequenceNumber, options.toSequence));
    }

    const rows = this.db
      .select()
      .from(schema.events)
      .where(and(...conditions))
      .orderBy(schema.events.sequenceNumber)
      .all();

    return rows.map(r => this.rowToEvent(r));
  }

  async getEvent(conversationId: string, sequenceNumber: number): Promise<ConversationEvent | null> {
    const row = this.db
      .select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.conversationId, conversationId),
          eq(schema.events.sequenceNumber, sequenceNumber),
        ),
      )
      .get();

    if (!row) return null;
    return this.rowToEvent(row);
  }

  async getLatestSequence(conversationId: string): Promise<number> {
    const result = this.db
      .select({ maxSeq: max(schema.events.sequenceNumber) })
      .from(schema.events)
      .where(eq(schema.events.conversationId, conversationId))
      .get();

    return result?.maxSeq ?? -1;
  }

  // ── Compaction ───────────────────────────────────────────────

  async compact(request: CompactionRequest): Promise<void> {
    this.sqlite.transaction(() => {
      this.db
        .update(schema.events)
        .set({
          isCompacted: true,
          compactedSummary: request.summary,
        })
        .where(
          and(
            eq(schema.events.conversationId, request.conversationId),
            gte(schema.events.sequenceNumber, request.fromSequence),
            lte(schema.events.sequenceNumber, request.toSequence),
          ),
        )
        .run();
    })();
  }

  // ── Fork ─────────────────────────────────────────────────────

  async fork(request: ForkRequest): Promise<Conversation> {
    const sourceConv = await this.getConversation(request.conversationId);
    if (!sourceConv) throw new Error(`Conversation ${request.conversationId} not found`);

    const newId = uuidv4();
    const now = new Date();

    const result = this.sqlite.transaction(() => {
      // Create new conversation
      const newConversation: Conversation = {
        id: newId,
        title: request.newTitle || `Fork of ${sourceConv.title ?? sourceConv.id}`,
        agentId: sourceConv.agentId,
        providerId: sourceConv.providerId,
        model: sourceConv.model,
        createdAt: now,
        updatedAt: now,
        metadata: {
          ...sourceConv.metadata,
          forkedFrom: request.conversationId,
          forkedAtSequence: request.atSequence,
        },
      };

      this.db.insert(schema.conversations).values({
        ...newConversation,
        metadata: newConversation.metadata,
      }).run();

      // Copy events up to the fork point
      const sourceEvents = this.db
        .select()
        .from(schema.events)
        .where(
          and(
            eq(schema.events.conversationId, request.conversationId),
            lte(schema.events.sequenceNumber, request.atSequence),
          ),
        )
        .orderBy(schema.events.sequenceNumber)
        .all();

      for (const event of sourceEvents) {
        this.db.insert(schema.events).values({
          id: uuidv4(),
          conversationId: newId,
          sequenceNumber: event.sequenceNumber,
          type: event.type,
          role: event.role,
          content: event.content,
          metadata: event.metadata,
          parentEventId: event.id,
          isCompacted: event.isCompacted,
          compactedSummary: event.compactedSummary,
          createdAt: now,
        }).run();
      }

      return newConversation;
    })();

    return result;
  }

  // ── Replay ───────────────────────────────────────────────────

  async getEventsForReplay(conversationId: string, fromSequence: number): Promise<{
    context: ConversationEvent[];
    replay: ConversationEvent[];
  }> {
    const allEvents = await this.getEvents(conversationId);

    return {
      context: allEvents.filter(e => e.sequenceNumber < fromSequence),
      replay: allEvents.filter(e => e.sequenceNumber >= fromSequence),
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────

  close(): void {
    this.sqlite.close();
  }

  // ── Private Helpers ──────────────────────────────────────────

  private rowToConversation(row: typeof schema.conversations.$inferSelect): Conversation {
    return {
      id: row.id,
      title: row.title ?? undefined,
      agentId: row.agentId,
      providerId: row.providerId,
      model: row.model,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowToEvent(row: typeof schema.events.$inferSelect): ConversationEvent {
    return {
      id: row.id,
      conversationId: row.conversationId,
      sequenceNumber: row.sequenceNumber,
      type: row.type as ConversationEvent['type'],
      role: row.role as ConversationEvent['role'],
      content: row.content,
      metadata: (row.metadata ?? {}) as ConversationEvent['metadata'],
      parentEventId: row.parentEventId ?? undefined,
      isCompacted: row.isCompacted,
      compactedSummary: row.compactedSummary ?? undefined,
      createdAt: row.createdAt,
    };
  }
}
