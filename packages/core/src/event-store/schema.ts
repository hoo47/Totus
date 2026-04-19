// Drizzle ORM schema for SQLite EventStore

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import type { EventContent, EventMetadata } from './types.js';

// ── Conversations Table ─────────────────────────────────────────

export const conversations = sqliteTable('conversations', {
  id:         text('id').primaryKey(),
  title:      text('title'),
  agentId:    text('agent_id').notNull(),
  providerId: text('provider_id').notNull(),
  model:      text('model').notNull(),
  metadata:   text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  createdAt:  integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt:  integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

// ── Events Table ────────────────────────────────────────────────

export const events = sqliteTable('events', {
  id:               text('id').primaryKey(),
  conversationId:   text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  sequenceNumber:   integer('sequence_number').notNull(),
  type:             text('type').notNull(),
  role:             text('role').notNull(),
  content:          text('content', { mode: 'json' }).$type<EventContent>().notNull(),
  metadata:         text('metadata', { mode: 'json' }).$type<EventMetadata>().notNull().default({}),
  parentEventId:    text('parent_event_id'),
  isCompacted:      integer('is_compacted', { mode: 'boolean' }).notNull().default(false),
  compactedSummary: text('compacted_summary'),
  createdAt:        integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
