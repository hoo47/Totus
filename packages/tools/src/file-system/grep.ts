// GrepTool - Search for patterns in file contents

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import type { ToolCallResult, ToolUseContext, CanUseToolFn } from '@agent-platform/core';
import { BaseTool } from '../base-tool.js';

const inputSchema = z.object({
  pattern: z.string().describe('Search pattern (literal string or regex)'),
  path: z.string().optional().describe('Directory or file path to search (defaults to cwd)'),
  include: z.array(z.string()).optional().describe('Glob patterns to filter files (e.g., ["*.ts", "*.js"])'),
  isRegex: z.boolean().optional().describe('Treat pattern as regex if true (default: false)'),
  caseSensitive: z.boolean().optional().describe('Case-sensitive search (default: true)'),
});

type GrepInput = z.infer<typeof inputSchema>;

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export class GrepTool extends BaseTool<GrepInput> {
  readonly name = 'Grep';
  inputSchema = inputSchema;

  description(): string {
    return 'Search for patterns in file contents.';
  }

  prompt(): string {
    return `Search for a text pattern across files.
Input:
- pattern (required): The search term or regex pattern
- path (optional): Directory or file to search (defaults to current directory)
- include (optional): Glob patterns to filter files (e.g., ["*.ts", "*.js"])
- isRegex (optional): Treat pattern as a regular expression (default: false)
- caseSensitive (optional): Case-sensitive search (default: true)
Returns matching lines with file paths and line numbers. Results capped at 50 matches.`;
  }

  isReadOnly(): boolean {
    return true;
  }

  override renderToolUseMessage(input: GrepInput): string {
    return `Searching for "${input.pattern}"`;
  }

  async *call(
    input: GrepInput,
    _context: ToolUseContext,
    _canUseTool?: CanUseToolFn,
  ): AsyncGenerator<ToolCallResult, void, unknown> {
    const searchPath = input.path ? path.resolve(input.path) : process.cwd();
    const MAX_MATCHES = 50;

    try {
      // Build regex
      const flags = input.caseSensitive ? 'g' : 'gi';
      let regex: RegExp;
      try {
        regex = input.isRegex
          ? new RegExp(input.pattern, flags)
          : new RegExp(escapeRegex(input.pattern), flags);
      } catch (e) {
        yield this.createResult(null, `Error: Invalid regex pattern: ${input.pattern}`);
        return;
      }

      // Determine files to search
      let files: string[];
      try {
        const stat = await fs.stat(searchPath);
        if (stat.isFile()) {
          files = [searchPath];
        } else {
          const includePatterns = input.include ?? ['**/*'];
          const allFiles: string[] = [];
          for (const pattern of includePatterns) {
            const matched = await glob(pattern, {
              cwd: searchPath,
              ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.totus/**'],
              absolute: true,
              nodir: true,
            });
            allFiles.push(...matched);
          }
          files = [...new Set(allFiles)].sort();
        }
      } catch {
        yield this.createResult(null, `Error: Path not found: ${searchPath}`);
        return;
      }

      // Search files
      const matches: GrepMatch[] = [];

      for (const file of files) {
        if (matches.length >= MAX_MATCHES) break;

        try {
          const content = await fs.readFile(file, 'utf-8');
          const lines = content.split('\n');

          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= MAX_MATCHES) break;
            const line = lines[i]!;
            regex.lastIndex = 0;
            if (regex.test(line)) {
              matches.push({
                file,
                line: i + 1,
                content: line.trim(),
              });
            }
          }
        } catch {
          // Skip files that can't be read (binary, permission issues)
          continue;
        }
      }

      if (matches.length === 0) {
        yield this.createResult(
          { pattern: input.pattern, matches: [] },
          `No matches found for "${input.pattern}"`,
        );
        return;
      }

      const resultLines = matches.map(
        m => `${m.file}:${m.line}: ${m.content}`,
      );

      const header = matches.length >= MAX_MATCHES
        ? `Found ${MAX_MATCHES}+ matches for "${input.pattern}" (showing first ${MAX_MATCHES}):`
        : `Found ${matches.length} match(es) for "${input.pattern}":`;

      yield this.createResult(
        { pattern: input.pattern, matches, total: matches.length },
        `${header}\n\n${resultLines.join('\n')}`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      yield this.createResult(null, `Error searching: ${msg}`);
    }
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
