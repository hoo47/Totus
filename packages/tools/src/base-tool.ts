// BaseTool - Abstract base class for all tools
// Provides common boilerplate and helpers so individual tools focus on logic

import type { ZodSchema } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  Tool,
  ToolCallResult,
  ToolResult,
  ToolProgress,
  ToolUseContext,
  CanUseToolFn,
  ValidationResult,
} from '@agent-platform/core';

export abstract class BaseTool<TInput = unknown> implements Tool<TInput> {
  abstract readonly name: string;

  abstract description(input?: unknown): string;
  abstract prompt(context?: { dangerouslySkipPermissions?: boolean }): string;
  abstract inputSchema: ZodSchema<TInput>;

  abstract call(
    input: TInput,
    context: ToolUseContext,
    canUseTool?: CanUseToolFn,
  ): AsyncGenerator<ToolCallResult, void, unknown>;

  // ── Default implementations (override as needed) ──

  isReadOnly(): boolean {
    return false;
  }

  isEnabled(): boolean {
    return true;
  }

  needsPermissions(_input?: TInput): boolean {
    return false;
  }

  userFacingName(): string {
    return this.name;
  }

  renderToolUseMessage?(input: TInput): string;

  // ── JSON Schema auto-conversion from Zod ──

  get inputJSONSchema(): Record<string, unknown> {
    return zodToJsonSchema(this.inputSchema, {
      target: 'openApi3',
      $refStrategy: 'none',
    }) as Record<string, unknown>;
  }

  // ── Helper methods for subclasses ──

  protected createResult(data: unknown, resultForAssistant: string): ToolResult {
    return { type: 'result', data, resultForAssistant };
  }

  protected createProgress(content: unknown): ToolProgress {
    return { type: 'progress', content };
  }
}
