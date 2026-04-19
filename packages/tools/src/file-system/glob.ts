// GlobTool - Find files based on pattern matching

import { z } from 'zod';
import { glob } from 'glob';
import * as path from 'path';
import type { ToolCallResult, ToolUseContext, CanUseToolFn } from '@agent-platform/core';
import { BaseTool } from '../base-tool.js';

const inputSchema = z.object({
  pattern: z.string().describe('Glob pattern to match files (e.g., "**/*.ts", "src/**/*.json")'),
  cwd: z.string().optional().describe('Working directory for the glob (defaults to process.cwd())'),
});

type GlobInput = z.infer<typeof inputSchema>;

export class GlobTool extends BaseTool<GlobInput> {
  readonly name = 'Glob';
  inputSchema = inputSchema;

  description(): string {
    return 'Find files based on glob pattern matching.';
  }

  prompt(): string {
    return `Find files matching a glob pattern.
Input:
- pattern (required): Glob pattern (e.g., "**/*.ts", "src/**/*.json")
- cwd (optional): Working directory for the search (defaults to current directory)
Returns a list of matched file paths. Ignores node_modules and .git by default.`;
  }

  isReadOnly(): boolean {
    return true;
  }

  override renderToolUseMessage(input: GlobInput): string {
    return `Searching for files: ${input.pattern}`;
  }

  async *call(
    input: GlobInput,
    _context: ToolUseContext,
    _canUseTool?: CanUseToolFn,
  ): AsyncGenerator<ToolCallResult, void, unknown> {
    const cwd = input.cwd ? path.resolve(input.cwd) : process.cwd();

    try {
      const files = await glob(input.pattern, {
        cwd,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.totus/**'],
        absolute: true,
        nodir: true,
      });

      if (files.length === 0) {
        yield this.createResult(
          { pattern: input.pattern, matches: [] },
          `No files found matching pattern: ${input.pattern}`,
        );
        return;
      }

      // Sort files for consistent output
      files.sort();

      const maxDisplay = 200;
      const displayFiles = files.slice(0, maxDisplay);
      const truncated = files.length > maxDisplay;

      const resultText = [
        `Found ${files.length} file(s) matching "${input.pattern}":`,
        '',
        ...displayFiles.map(f => `  ${f}`),
        ...(truncated ? [`  ... and ${files.length - maxDisplay} more`] : []),
      ].join('\n');

      yield this.createResult(
        { pattern: input.pattern, matches: files, total: files.length },
        resultText,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      yield this.createResult(null, `Error searching files: ${msg}`);
    }
  }
}
