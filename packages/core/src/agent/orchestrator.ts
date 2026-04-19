// Agent Orchestrator
// Manages agent plugins, provider registry, and coordinates the query loop

import type { AgentPlugin, AgentConfig, AgentContext } from './types.js';
import type { LLMProviderAdapter } from '../provider/adapter.js';
import type { EventStore } from '../event-store/store.js';
import type { CanUseToolFn, Tool } from '../tool/types.js';
import type { InternalMessage } from '../types/messages.js';
import { DefaultProviderRegistry } from '../provider/index.js';
import { DefaultToolRegistry } from '../tool/registry.js';
import { query, type QueryOptions } from '../loop/query.js';
import { v4 as uuidv4 } from 'uuid';

export interface OrchestratorConfig {
  eventStore: EventStore;
  defaultModel?: string;
}

export class AgentOrchestrator {
  private agents = new Map<string, AgentPlugin>();
  private providerRegistry = new DefaultProviderRegistry();
  private globalToolRegistry = new DefaultToolRegistry();
  private eventStore: EventStore;
  private defaultModel: string;

  constructor(config: OrchestratorConfig) {
    this.eventStore = config.eventStore;
    this.defaultModel = config.defaultModel ?? 'claude-3-7-sonnet-20250219';
  }

  // ── Agent Management ─────────────────────────────────────────

  async registerAgent(agent: AgentPlugin, config?: AgentConfig): Promise<void> {
    await agent.initialize(config ?? {});
    this.agents.set(agent.id, agent);
    // Note: Agent-local tools are kept within the agent and accessed via getTools()
    // when needed, rather than polluting the global registry.
  }

  async unregisterAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent) {
      await agent.dispose();
      this.agents.delete(agentId);
    }
  }

  getAgent(agentId: string): AgentPlugin | undefined {
    return this.agents.get(agentId);
  }

  listAgents(): AgentPlugin[] {
    return [...this.agents.values()];
  }

  // ── Tool Management ──────────────────────────────────────────

  registerGlobalTool(tool: Tool): void {
    this.globalToolRegistry.register(tool);
  }

  unregisterGlobalTool(toolName: string): void {
    this.globalToolRegistry.unregister(toolName);
  }

  getAgentAvailableTools(agentId: string): Tool[] {
    const agent = this.agents.get(agentId);
    const globalTools = this.globalToolRegistry.getAll();
    if (!agent) return globalTools;

    // Combine global tools and agent-local tools
    // Local tools take precedence in case of name collisions
    const localTools = agent.getTools();
    const localToolNames = new Set(localTools.map(t => t.name));
    
    const filteredGlobal = globalTools.filter(t => !localToolNames.has(t.name));
    return [...filteredGlobal, ...localTools];
  }

  // ── Provider Management ──────────────────────────────────────

  registerProvider(provider: LLMProviderAdapter): void {
    this.providerRegistry.register(provider);
  }

  getProviderRegistry() {
    return this.providerRegistry;
  }

  // ── Conversation Execution ───────────────────────────────────

  async *chat(
    agentId: string,
    conversationId: string | undefined,
    userMessage: string,
    options?: {
      providerId?: string;
      model?: string;
      canUseTool?: CanUseToolFn;
      /** 
       * List of tool names that are explicitly enabled.
       * If provided, only tools in this list will be exposed to the LLM.
       * If undefined, all available tools for the agent will be exposed.
       */
      enabledTools?: string[];
      signal?: AbortSignal;
    },
  ): AsyncGenerator<InternalMessage, void, unknown> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found`);

    const providerId = options?.providerId;
    const provider = providerId
      ? this.providerRegistry.get(providerId)
      : this.providerRegistry.getDefault();
    if (!provider) throw new Error(`Provider "${providerId}" not found`);

    const model = options?.model ?? this.defaultModel;

    // Create or get conversation
    let convId = conversationId;
    if (!convId) {
      convId = uuidv4();
      await this.eventStore.createConversation({
        id: convId,
        agentId,
        providerId: provider.id,
        model,
        metadata: {},
      });
    }

    // Get existing conversation events
    const existingEvents = await this.eventStore.getEvents(convId);

    // Convert events to messages for the query
    const messages: InternalMessage[] = this.eventsToMessages(existingEvents);

    // Add the new user message
    const latestSeq = await this.eventStore.getLatestSequence(convId);
    await this.eventStore.appendEvent({
      conversationId: convId,
      sequenceNumber: latestSeq + 1,
      type: 'user_message',
      role: 'user',
      content: { role: 'user', content: userMessage },
      metadata: {},
      isCompacted: false,
    });

    const userMsg: InternalMessage = {
      type: 'user',
      uuid: uuidv4() as `${string}-${string}-${string}-${string}-${string}`,
      message: { role: 'user', content: userMessage },
    };
    messages.push(userMsg);
    yield userMsg;

    // Get agent context
    const agentContext: AgentContext = {
      workingDirectory: process.cwd(),
      model,
      providerId: provider.id,
    };

    const [systemPrompt, context] = await Promise.all([
      agent.getSystemPrompt(agentContext),
      agent.getContext(agentContext.workingDirectory),
    ]);

    // Default permission handler (allow all)
    const canUseTool: CanUseToolFn = options?.canUseTool ?? (async () => ({ result: true as const }));

    // Get all available tools for this agent (Global + Local)
    const availableTools = this.getAgentAvailableTools(agentId);
    
    // Filter by enabledTools if specified
    const activeTools = options?.enabledTools
      ? availableTools.filter(t => options?.enabledTools?.includes(t.name))
      : availableTools;

    // Run the agentic loop
    const queryOptions: QueryOptions = {
      provider,
      model,
      tools: activeTools,
      systemPrompt,
      context,
      eventStore: this.eventStore,
      conversationId: convId,
    };

    yield* query(messages, queryOptions, canUseTool, options?.signal);
  }

  // ── Event Store Access ───────────────────────────────────────

  getEventStore(): EventStore {
    return this.eventStore;
  }

  // ── Private Helpers ──────────────────────────────────────────

  private eventsToMessages(events: import('../event-store/types.js').ConversationEvent[]): InternalMessage[] {
    const messages: InternalMessage[] = [];

    for (const event of events) {
      if (event.isCompacted) {
        // Use compacted summary
        messages.push({
          type: 'user',
          uuid: uuidv4() as `${string}-${string}-${string}-${string}-${string}`,
          message: {
            role: 'user',
            content: `[Previous conversation summary]: ${event.compactedSummary}`,
          },
        });
        continue;
      }

      if (event.type === 'user_message') {
        messages.push({
          type: 'user',
          uuid: uuidv4() as `${string}-${string}-${string}-${string}-${string}`,
          message: {
            role: 'user',
            content: typeof event.content.content === 'string'
              ? event.content.content
              : JSON.stringify(event.content.content),
          },
        });
      } else if (event.type === 'assistant_message') {
        messages.push({
          type: 'assistant',
          uuid: uuidv4() as `${string}-${string}-${string}-${string}-${string}`,
          message: {
            id: event.id,
            content: (Array.isArray(event.content.content)
              ? event.content.content
              : [{ type: 'text' as const, text: String(event.content.content) }]) as unknown as import('../types/messages.js').MessageContent[],
            model: (event.metadata.model as string) ?? 'unknown',
            stopReason: (event.metadata.stopReason as string) ?? null,
            usage: {
              inputTokens: (event.metadata.inputTokens as number) ?? 0,
              outputTokens: (event.metadata.outputTokens as number) ?? 0,
              totalTokens: ((event.metadata.inputTokens as number) ?? 0) + ((event.metadata.outputTokens as number) ?? 0),
            },
          },
          costUSD: (event.metadata.costUSD as number) ?? 0,
          durationMs: (event.metadata.durationMs as number) ?? 0,
        });
      }
    }

    return messages;
  }
}
