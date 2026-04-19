// BashTool - Execute shell commands

import { z } from 'zod';
import { spawn } from 'child_process';
import * as path from 'path';
import type { ToolCallResult, ToolUseContext, CanUseToolFn } from '@agent-platform/core';
import { BaseTool } from '../base-tool.js';

const inputSchema = z.object({
  command: z.string().describe('Shell command to execute'),
  cwd: z.string().optional().describe('Working directory (defaults to process.cwd())'),
  timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
});

type BashInput = z.infer<typeof inputSchema>;

const MAX_OUTPUT_CHARS = 50000;

export class BashTool extends BaseTool<BashInput> {
  readonly name = 'Bash';
  inputSchema = inputSchema;

  description(): string {
    return 'Execute shell commands in the user\'s environment.';
  }

  prompt(): string {
    return `Execute a shell command using bash.
Input:
- command (required): The command to execute
- cwd (optional): Working directory (defaults to current directory)
- timeout (optional): Timeout in milliseconds (default: 30000)
Returns stdout, stderr, and exit code. Long output is truncated to the last portion.
Important: Be careful with destructive commands. Commands run with the user's permissions.`;
  }

  needsPermissions(): boolean {
    return true;
  }

  override renderToolUseMessage(input: BashInput): string {
    const cmdPreview = input.command.length > 60
      ? input.command.slice(0, 60) + '...'
      : input.command;
    return `Running: ${cmdPreview}`;
  }

  async *call(
    input: BashInput,
    context: ToolUseContext,
    _canUseTool?: CanUseToolFn,
  ): AsyncGenerator<ToolCallResult, void, unknown> {
    const cwd = input.cwd ? path.resolve(input.cwd) : process.cwd();
    const timeout = input.timeout ?? 30000;

    try {
      const result = await executeCommand(input.command, cwd, timeout, context.abortController.signal);

      const parts: string[] = [];

      if (result.stdout) {
        const stdout = truncateOutput(result.stdout, MAX_OUTPUT_CHARS);
        parts.push(`stdout:\n${stdout}`);
      }

      if (result.stderr) {
        const stderr = truncateOutput(result.stderr, MAX_OUTPUT_CHARS / 2);
        parts.push(`stderr:\n${stderr}`);
      }

      parts.push(`Exit code: ${result.exitCode}`);

      if (result.timedOut) {
        parts.push('(Command timed out)');
      }

      yield this.createResult(
        {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        },
        parts.join('\n\n'),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      yield this.createResult(null, `Error executing command: ${msg}`);
    }
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

function executeCommand(
  command: string,
  cwd: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: { ...process.env, PAGER: 'cat' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000);
    }, timeout);

    const abortHandler = () => {
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', abortHandler, { once: true });

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      resolve({
        stdout,
        stderr: stderr + '\n' + err.message,
        exitCode: 1,
        timedOut: false,
      });
    });
  });
}

function truncateOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  const truncated = output.slice(-maxChars);
  const firstNewline = truncated.indexOf('\n');
  const clean = firstNewline > 0 ? truncated.slice(firstNewline + 1) : truncated;
  return `... (output truncated, showing last ${clean.length} chars)\n${clean}`;
}
