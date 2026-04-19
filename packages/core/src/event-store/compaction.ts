// Compaction Engine
// Summarizes a range of conversation events into a compact representation

import type { EventStore } from './store.js';
import type { ConversationEvent, CompactionRequest } from './types.js';
import type { LLMProviderAdapter, CompletionRequest } from '../provider/adapter.js';

export interface CompactionEngine {
  /**
   * Compact a range of events by generating a summary
   * and marking the original events as compacted
   */
  compactRange(
    conversationId: string,
    fromSequence: number,
    toSequence: number,
  ): Promise<string>;
}

export class LLMCompactionEngine implements CompactionEngine {
  constructor(
    private eventStore: EventStore,
    private provider: LLMProviderAdapter,
    private model: string,
  ) {}

  async compactRange(
    conversationId: string,
    fromSequence: number,
    toSequence: number,
  ): Promise<string> {
    // 1. Get the events to compact
    const events = await this.eventStore.getEvents(conversationId, {
      fromSequence,
      toSequence,
    });

    if (events.length === 0) {
      throw new Error(`No events found in range ${fromSequence}-${toSequence}`);
    }

    // 2. Generate a summary using LLM
    const summary = await this.generateSummary(events);

    // 3. Mark events as compacted in the store
    await this.eventStore.compact({
      conversationId,
      fromSequence,
      toSequence,
      summary,
    });

    return summary;
  }

  private async generateSummary(events: ConversationEvent[]): Promise<string> {
    const eventsDescription = events.map(e => {
      const role = e.role;
      const type = e.type;
      let contentStr: string;

      if (typeof e.content.content === 'string') {
        contentStr = e.content.content.slice(0, 500);
      } else {
        contentStr = JSON.stringify(e.content.content).slice(0, 500);
      }

      return `[${type}] ${role}: ${contentStr}`;
    }).join('\n');

    const request: CompletionRequest = {
      model: this.model,
      messages: [
        {
          role: 'user',
          content: `Summarize the following conversation events concisely. Focus on key actions taken, decisions made, and results achieved. Keep the summary under 200 words.\n\nEvents:\n${eventsDescription}`,
        },
      ],
      systemPrompt: [
        'You are a conversation summarizer. Create concise summaries that capture the essential information needed to continue the conversation from this point.',
      ],
      temperature: 0,
      maxTokens: 512,
    };

    const response = await this.provider.complete(request);
    const textContent = response.content.find(c => c.type === 'text');
    return textContent?.text ?? 'Summary unavailable';
  }
}

/**
 * Simple compaction that just concatenates event descriptions
 * Used when no LLM is available
 */
export class SimpleCompactionEngine implements CompactionEngine {
  constructor(private eventStore: EventStore) {}

  async compactRange(
    conversationId: string,
    fromSequence: number,
    toSequence: number,
  ): Promise<string> {
    const events = await this.eventStore.getEvents(conversationId, {
      fromSequence,
      toSequence,
    });

    if (events.length === 0) {
      throw new Error(`No events found in range ${fromSequence}-${toSequence}`);
    }

    const summary = events.map(e => {
      const action = e.type === 'tool_call'
        ? `Called tool: ${e.content.toolName}`
        : e.type === 'tool_result'
          ? `Tool result: ${e.content.isError ? 'ERROR' : 'OK'}`
          : `${e.role}: ${typeof e.content.content === 'string' ? e.content.content.slice(0, 100) : '(structured)'}`;
      return `[seq ${e.sequenceNumber}] ${action}`;
    }).join('\n');

    await this.eventStore.compact({
      conversationId,
      fromSequence,
      toSequence,
      summary,
    });

    return summary;
  }
}
