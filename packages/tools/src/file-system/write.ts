// WriteTool - Create or overwrite files

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ToolCallResult, ToolUseContext, CanUseToolFn } from '@agent-platform/core';
import { BaseTool } from '../base-tool.js';

const inputSchema = z.object({
  path: z.string().describe('Absolute path to the file to write'),
  content: z.string().describe('Content to write to the file'),
  createDirectories: z.boolean().optional().describe('Create parent directories if they do not exist (default: true)'),
});

type WriteInput = z.infer<typeof inputSchema>;

export class WriteTool extends BaseTool<WriteInput> {
  readonly name = 'Write';
  inputSchema = inputSchema;

  description(): string {
    return 'Create or overwrite a file with the given content.';
  }

  prompt(): string {
    return `Create or overwrite a file with the given content.
Input:
- path (required): Absolute path to the file to write
- content (required): The full content to write
- createDirectories (optional, default true): Create parent directories if they don't exist
Overwrites the file if it already exists.`;
  }

  needsPermissions(): boolean {
    return true;
  }

  override renderToolUseMessage(input: WriteInput): string {
    return `Writing to ${input.path} (${input.content.split('\n').length} lines)`;
  }

  async *call(
    input: WriteInput,
    _context: ToolUseContext,
    _canUseTool?: CanUseToolFn,
  ): AsyncGenerator<ToolCallResult, void, unknown> {
    const filePath = path.resolve(input.path);

    try {
      // Create parent directories if needed
      if (input.createDirectories !== false) {
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
      }

      // Check if file exists (for reporting)
      let existed = false;
      try {
        await fs.access(filePath);
        existed = true;
      } catch {
        // File doesn't exist, that's fine
      }

      // Write the file
      await fs.writeFile(filePath, input.content, 'utf-8');

      const lineCount = input.content.split('\n').length;
      const action = existed ? 'Updated' : 'Created';

      yield this.createResult(
        { path: filePath, action: action.toLowerCase(), lines: lineCount },
        `${action} file: ${filePath} (${lineCount} lines)`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      yield this.createResult(null, `Error writing file: ${msg}`);
    }
  }
}
