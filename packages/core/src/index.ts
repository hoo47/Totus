// @agent-platform/core
// Core engine for the modular AI Agent Platform

// Types
export type {
  Message, MessageRole, MessageContent, TextContent, ToolUseContent,
  ToolResultContent, ThinkingContent, ContentBlock, TokenUsage, ModelInfo,
  UserMessage, AssistantMessage, ProgressMessage, SystemEventMessage, InternalMessage,
} from './types/messages.js';

// Provider
export {
  type LLMProviderAdapter, type CompletionRequest, type CompletionResponse,
  type StreamChunk, type ProviderConfig, type ProviderRegistry, type ToolSchema,
  DefaultProviderRegistry, ClaudeAdapter, OpenAIAdapter, GeminiAdapter, OllamaAdapter, LMStudioAdapter,
} from './provider/index.js';

// Event Store
export {
  type EventStore, type ConversationEvent, type Conversation, type EventType,
  type EventContent, type EventMetadata, type CompactionRequest, type ResumeRequest,
  type ForkRequest, type CompactionEngine,
  InMemoryEventStore, SQLiteEventStore, LLMCompactionEngine, SimpleCompactionEngine,
} from './event-store/index.js';

// Tool
export {
  type Tool, type ToolResult, type ToolProgress, type ToolCallResult,
  type ToolUseContext, type CanUseToolFn, type ToolRegistry, type ValidationResult,
  DefaultToolRegistry,
} from './tool/index.js';

// Agent
export {
  type AgentPlugin, type AgentConfig, type AgentContext, type OrchestratorConfig,
  AgentOrchestrator,
} from './agent/index.js';

// Loop
export { query, type QueryOptions } from './loop/index.js';
