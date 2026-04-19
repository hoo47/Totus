// ReadTool - Read file contents with optional line range

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ToolCallResult, ToolUseContext, CanUseToolFn } from '@agent-platform/core';
import { BaseTool } from '../base-tool.js';

const inputSchema = z.object({
  path: z.string().describe('Absolute path to the file to read'),
  startLine: z.number().optional().describe('Starting line number (1-indexed, inclusive)'),
  endLine: z.number().optional().describe('Ending line number (1-indexed, inclusive)'),
});

type ReadInput = z.infer<typeof inputSchema>;

export class ReadTool extends BaseTool<ReadInput> {
  readonly name = 'Read';
  inputSchema = inputSchema;

  description(): string {
    return 'Read the contents of a file from the local filesystem.';
  }

  prompt(): string {
    return `Read the contents of a file from the local filesystem. Supports reading specific line ranges.
Input:
- path (required): Absolute path to the file to read
- startLine (optional): Starting line number (1-indexed, inclusive)
- endLine (optional): Ending line number (1-indexed, inclusive)
Returns the file contents as text. For binary files, returns a descriptive message.`;
  }

  isReadOnly(): boolean {
    return true;
  }

  override renderToolUseMessage(input: ReadInput): string {
    const range = input.startLine
      ? ` (lines ${input.startLine}-${input.endLine ?? 'end'})`
      : '';
    return `Reading ${input.path}${range}`;
  }

  async *call(
    input: ReadInput,
    _context: ToolUseContext,
    _canUseTool?: CanUseToolFn,
  ): AsyncGenerator<ToolCallResult, void, unknown> {
    const filePath = path.resolve(input.path);

    try {
      await fs.access(filePath);
    } catch {
      yield this.createResult(null, `Error: File not found: ${filePath}`);
      return;
    }

    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        yield this.createResult(null, `Error: ${filePath} is a directory, not a file.`);
        return;
      }

      // Check for binary files
      const buffer = Buffer.alloc(8192);
      const fd = await fs.open(filePath, 'r');
      const { bytesRead } = await fd.read(buffer, 0, 8192, 0);
      await fd.close();

      const slice = buffer.subarray(0, bytesRead);
      if (isBinaryBuffer(slice)) {
        yield this.createResult(
          { path: filePath, binary: true, size: stat.size },
          `(binary file: ${filePath}, ${stat.size} bytes)`,
        );
        return;
      }

      // Read text content
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const totalLines = lines.length;

      let startLine = input.startLine ?? 1;
      let endLine = input.endLine ?? totalLines;

      startLine = Math.max(1, startLine);
      endLine = Math.min(totalLines, endLine);

      const selectedLines = lines.slice(startLine - 1, endLine);
      const numberedContent = selectedLines
        .map((line, i) => `${startLine + i}: ${line}`)
        .join('\n');

      const header = `File: ${filePath}\nTotal lines: ${totalLines}\nShowing lines ${startLine}-${endLine}`;
      const result = `${header}\n\n${numberedContent}`;

      yield this.createResult(
        { path: filePath, totalLines, startLine, endLine, content: selectedLines.join('\n') },
        result,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      yield this.createResult(null, `Error reading file: ${msg}`);
    }
  }
}

function isBinaryBuffer(buffer: Buffer): boolean {
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i]!;
    // Check for null bytes or other control characters (except common ones)
    if (byte === 0) return true;
    if (byte < 8 && byte !== 0) return true;
    if (byte > 13 && byte < 32 && byte !== 27) return true;
  }
  return false;
}
