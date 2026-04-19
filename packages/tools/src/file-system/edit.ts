// EditTool - Make targeted edits to specific files

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createTwoFilesPatch } from 'diff';
import type { ToolCallResult, ToolUseContext, CanUseToolFn } from '@agent-platform/core';
import { BaseTool } from '../base-tool.js';

const inputSchema = z.object({
  path: z.string().describe('Absolute path to the file to edit'),
  oldText: z.string().describe('The exact text to find and replace (must match exactly)'),
  newText: z.string().describe('The replacement text'),
});

type EditInput = z.infer<typeof inputSchema>;

export class EditTool extends BaseTool<EditInput> {
  readonly name = 'Edit';
  inputSchema = inputSchema;

  description(): string {
    return 'Make targeted edits to specific files by replacing exact text matches.';
  }

  prompt(): string {
    return `Make targeted edits to a file. Finds and replaces an exact text match.
Input:
- path (required): Absolute path to the file to edit
- oldText (required): The exact string to find (must match exactly, including whitespace)
- newText (required): The replacement string
The oldText must appear exactly once in the file. If it appears zero or multiple times, the edit will fail.`;
  }

  needsPermissions(): boolean {
    return true;
  }

  override renderToolUseMessage(input: EditInput): string {
    const oldPreview = input.oldText.length > 40
      ? input.oldText.slice(0, 40) + '...'
      : input.oldText;
    return `Editing ${input.path}: replacing "${oldPreview}"`;
  }

  async *call(
    input: EditInput,
    _context: ToolUseContext,
    _canUseTool?: CanUseToolFn,
  ): AsyncGenerator<ToolCallResult, void, unknown> {
    const filePath = path.resolve(input.path);

    try {
      // Read existing file
      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch {
        yield this.createResult(null, `Error: File not found: ${filePath}`);
        return;
      }

      // Find occurrences of oldText
      const occurrences = countOccurrences(content, input.oldText);

      if (occurrences === 0) {
        yield this.createResult(null, `Error: Could not find the specified text in ${filePath}. Make sure the oldText matches exactly.`);
        return;
      }

      if (occurrences > 1) {
        yield this.createResult(null, `Error: Found ${occurrences} occurrences of the specified text in ${filePath}. The oldText must be unique. Add more surrounding context to make it unique.`);
        return;
      }

      // Apply the edit
      const newContent = content.replace(input.oldText, input.newText);

      // Generate diff for display
      const diff = createTwoFilesPatch(
        filePath,
        filePath,
        content,
        newContent,
        'original',
        'modified',
        { context: 3 },
      );

      // Write the modified file
      await fs.writeFile(filePath, newContent, 'utf-8');

      yield this.createResult(
        { path: filePath, diff },
        `Successfully edited ${filePath}\n\n${diff}`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      yield this.createResult(null, `Error editing file: ${msg}`);
    }
  }
}

function countOccurrences(str: string, substr: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = str.indexOf(substr, pos)) !== -1) {
    count++;
    pos += substr.length;
  }
  return count;
}
