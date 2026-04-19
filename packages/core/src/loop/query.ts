// Agentic Loop (Query Engine)
// Based on claude-code's query.ts - the recursive tool_use → tool_result loop
// Generalized for multi-provider support

import { v4 as uuidv4 } from 'uuid';
import type { UUID } from 'crypto';
import type { LLMProviderAdapter, CompletionRequest, CompletionResponse, ToolSchema } from '../provider/adapter.js';
import type { Tool, ToolUseContext, CanUseToolFn } from '../tool/types.js';
import type { Message, MessageContent, UserMessage, AssistantMessage, InternalMessage } from '../types/messages.js';
import type { EventStore } from '../event-store/store.js';

export interface QueryOptions {
  provider: LLMProviderAdapter;
  model: string;
  tools: Tool[];
  systemPrompt: string[];
  context: Record<string, string>;
  dangerouslySkipPermissions?: boolean;
  maxThinkingTokens?: number;
  maxToolUseConcurrency?: number;
  eventStore?: EventStore;
  conversationId?: string;
}

const MAX_TOOL_USE_CONCURRENCY = 10;

/**
 * The core agentic loop. Sends messages to the LLM, processes tool calls,
 * and recursively continues until the model stops using tools.
 */
export async function* query(
  messages: InternalMessage[],
  options: QueryOptions,
  canUseTool: CanUseToolFn,
  abortSignal?: AbortSignal,
): AsyncGenerator<InternalMessage, void, unknown> {
  // Build the full system prompt with context
  const fullSystemPrompt = buildSystemPromptWithContext(options.systemPrompt, options.context);

  // Convert internal messages to API format
  const apiMessages = normalizeMessagesForAPI(messages);

  // Build tool schemas for the API
  const toolSchemas = await buildToolSchemas(options.tools, options.dangerouslySkipPermissions);

  // Call the LLM
  const request: CompletionRequest = {
    model: options.model,
    messages: apiMessages,
    systemPrompt: fullSystemPrompt,
    tools: toolSchemas,
    temperature: 1,
    maxThinkingTokens: options.maxThinkingTokens,
    signal: abortSignal,
  };

  let response: CompletionResponse;
  try {
    response = await options.provider.complete(request);
  } catch (error) {
    yield createErrorAssistantMessage(error);
    return;
  }

  // Create and yield the assistant message
  const assistantMessage: AssistantMessage = {
    type: 'assistant',
    uuid: uuidv4() as UUID,
    message: {
      id: response.id,
      content: response.content,
      model: response.model,
      stopReason: response.stopReason,
      usage: response.usage,
    },
    costUSD: response.costUSD ?? 0,
    durationMs: 0,
  };

  // Save event if event store is available
  if (options.eventStore && options.conversationId) {
    const latestSeq = await options.eventStore.getLatestSequence(options.conversationId);
    await options.eventStore.appendEvent({
      conversationId: options.conversationId,
      sequenceNumber: latestSeq + 1,
      type: 'assistant_message',
      role: 'assistant',
      content: {
        role: 'assistant',
        content: response.content as unknown as Record<string, unknown>[],
      },
      metadata: {
        model: response.model,
        provider: options.provider.id,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        costUSD: response.costUSD,
      },
      isCompacted: false,
    });
  }

  yield assistantMessage;

  // Check for tool use
  const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');
  if (toolUseBlocks.length === 0) {
    return; // No more tool calls, we're done
  }

  // Execute tools
  const toolResults: UserMessage[] = [];

  for (const toolUse of toolUseBlocks) {
    if (abortSignal?.aborted) break;
    if (toolUse.type !== 'tool_use') continue;

    const tool = options.tools.find(t => t.name === toolUse.name);
    if (!tool) {
      toolResults.push(createToolErrorMessage(toolUse.id, `Tool not found: ${toolUse.name}`));
      continue;
    }

    // Permission check
    if (!options.dangerouslySkipPermissions) {
      const permResult = await canUseTool(tool, toolUse.input, {
        abortController: new AbortController(),
        options: { tools: options.tools, model: options.model, maxThinkingTokens: options.maxThinkingTokens ?? 0 },
        readFileTimestamps: {},
      });
      if (!permResult.result) {
        toolResults.push(createToolErrorMessage(toolUse.id, permResult.message));
        continue;
      }
    }

    // Execute the tool
    try {
      const generator = tool.call(toolUse.input as never, {
        abortController: new AbortController(),
        options: { tools: options.tools, model: options.model, maxThinkingTokens: options.maxThinkingTokens ?? 0 },
        readFileTimestamps: {},
      }, canUseTool);

      for await (const result of generator) {
        if (result.type === 'result') {
          const resultMessage: UserMessage = {
            type: 'user',
            uuid: uuidv4() as UUID,
            message: {
              role: 'user',
              content: [{
                type: 'tool_result',
                toolUseId: toolUse.id,
                name: toolUse.name,
                content: result.resultForAssistant,
              }],
            },
            toolUseResult: { data: result.data, resultForAssistant: result.resultForAssistant },
          };
          toolResults.push(resultMessage);
          yield resultMessage;
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errorResult = createToolErrorMessage(toolUse.id, errMsg);
      toolResults.push(errorResult);
      yield errorResult;
    }
  }

  if (abortSignal?.aborted) return;

  // Recursively continue the conversation with tool results
  yield* query(
    [...messages, assistantMessage, ...toolResults],
    options,
    canUseTool,
    abortSignal,
  );
}

// ── Helper Functions ──────────────────────────────────────────────

function buildSystemPromptWithContext(systemPrompt: string[], context: Record<string, string>): string[] {
  if (Object.keys(context).length === 0) return systemPrompt;

  const contextBlock = Object.entries(context)
    .map(([key, value]) => `<context name="${key}">${value}</context>`)
    .join('\n');

  return [...systemPrompt, `\nAdditional context:\n${contextBlock}`];
}

function normalizeMessagesForAPI(messages: InternalMessage[]): Message[] {
  return messages
    .filter(m => m.type === 'user' || m.type === 'assistant')
    .map(m => {
      if (m.type === 'user') {
        return m.message;
      }
      return {
        role: 'assistant' as const,
        content: m.message.content,
      };
    });
}

async function buildToolSchemas(tools: Tool[], dangerouslySkipPermissions?: boolean): Promise<ToolSchema[]> {
  return Promise.all(
    tools.map(async tool => ({
      name: tool.name,
      description: await tool.prompt({ dangerouslySkipPermissions }),
      inputSchema: tool.inputJSONSchema ?? {},
    }))
  );
}

function createErrorAssistantMessage(error: unknown): AssistantMessage {
  const message = error instanceof Error ? error.message : String(error);
  return {
    type: 'assistant',
    uuid: uuidv4() as UUID,
    message: {
      id: `error-${Date.now()}`,
      content: [{ type: 'text', text: `API Error: ${message}` }],
      model: 'unknown',
      stopReason: 'error',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    },
    costUSD: 0,
    durationMs: 0,
    isApiErrorMessage: true,
  };
}

function createToolErrorMessage(toolUseId: string, message: string): UserMessage {
  return {
    type: 'user',
    uuid: uuidv4() as UUID,
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        toolUseId,
        content: message,
        isError: true,
      }],
    },
  };
}
