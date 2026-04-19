// Tool system types
// Based on claude-code's Tool interface, generalized for plugin architecture

import type { ZodSchema } from 'zod';

export interface ToolResult {
  type: 'result';
  data: unknown;
  resultForAssistant: string;
}

export interface ToolProgress {
  type: 'progress';
  content: unknown;
}

export type ToolCallResult = ToolResult | ToolProgress;

export interface ValidationResult {
  result: boolean;
  message?: string;
  meta?: Record<string, string>;
}

export interface ToolUseContext {
  abortController: AbortController;
  options: {
    tools: Tool[];
    model: string;
    maxThinkingTokens: number;
    dangerouslySkipPermissions?: boolean;
  };
  readFileTimestamps: Record<string, number>;
}

export interface Tool<TInput = unknown, TOutput = unknown> {
  /** Unique tool name */
  name: string;

  /** Human-readable description, can be dynamic */
  description(input?: unknown): string | Promise<string>;

  /** Prompt text sent to LLM describing the tool */
  prompt(context?: { dangerouslySkipPermissions?: boolean }): string | Promise<string>;

  /** Zod schema for input validation */
  inputSchema: ZodSchema<TInput>;

  /** JSON schema alternative (for providers that don't support Zod) */
  inputJSONSchema?: Record<string, unknown>;

  /** Whether this tool only reads data (safe for concurrent execution) */
  isReadOnly(): boolean;

  /** Whether this tool is currently enabled */
  isEnabled(): boolean | Promise<boolean>;

  /** Whether this tool requires permission checks */
  needsPermissions(input?: TInput): boolean;

  /** Validate input beyond schema (business logic validation) */
  validateInput?(input: TInput, context: ToolUseContext): Promise<ValidationResult>;

  /** Execute the tool */
  call(
    input: TInput,
    context: ToolUseContext,
    canUseTool?: CanUseToolFn,
  ): AsyncGenerator<ToolCallResult, void, unknown>;

  /** User-facing display name */
  userFacingName(): string;

  /** Render tool use message for display */
  renderToolUseMessage?(input: TInput): string;
}

export type CanUseToolFn = (
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  assistantMessage?: unknown,
) => Promise<{ result: true } | { result: false; message: string }>;

export interface ToolRegistry {
  register(tool: Tool): void;
  unregister(toolName: string): void;
  get(toolName: string): Tool | undefined;
  getAll(): Tool[];
  getReadOnly(): Tool[];
}
