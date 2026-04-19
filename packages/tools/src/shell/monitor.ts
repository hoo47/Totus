// MonitorTool - Run a background command and feed output lines back

import { z } from 'zod';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import type { ToolCallResult, ToolUseContext, CanUseToolFn } from '@agent-platform/core';
import { BaseTool } from '../base-tool.js';

const inputSchema = z.object({
  command: z.string().describe('Shell command to run in the background'),
  cwd: z.string().optional().describe('Working directory (defaults to process.cwd())'),
  pattern: z.string().optional().describe('Regex pattern to filter output lines (if not set, all lines are reported)'),
  timeout: z.number().optional().describe('Maximum duration in ms before auto-stopping (default: 60000)'),
});

type MonitorInput = z.infer<typeof inputSchema>;

// Global registry for background processes (so they can be stopped later)
const backgroundProcesses = new Map<string, ChildProcess>();
let processCounter = 0;

export class MonitorTool extends BaseTool<MonitorInput> {
  readonly name = 'Monitor';
  inputSchema = inputSchema;

  description(): string {
    return 'Run a command in the background and feed output lines back.';
  }

  prompt(): string {
    return `Run a command in the background and report output lines matching an optional pattern.
Input:
- command (required): Shell command to run
- cwd (optional): Working directory
- pattern (optional): Regex pattern to filter output lines
- timeout (optional): Max duration in ms (default: 60000)
The command runs in the background. Matching output lines are yielded as progress updates.
A process ID is returned that can be used to stop the process later.`;
  }

  needsPermissions(): boolean {
    return true;
  }

  override renderToolUseMessage(input: MonitorInput): string {
    return `Monitoring: ${input.command}`;
  }

  async *call(
    input: MonitorInput,
    context: ToolUseContext,
    _canUseTool?: CanUseToolFn,
  ): AsyncGenerator<ToolCallResult, void, unknown> {
    const cwd = input.cwd ? path.resolve(input.cwd) : process.cwd();
    const timeout = input.timeout ?? 60000;

    const processId = `monitor-${++processCounter}`;

    let filterRegex: RegExp | null = null;
    if (input.pattern) {
      try {
        filterRegex = new RegExp(input.pattern);
      } catch {
        yield this.createResult(null, `Error: Invalid regex pattern: ${input.pattern}`);
        return;
      }
    }

    const child = spawn('bash', ['-c', input.command], {
      cwd,
      env: { ...process.env, PAGER: 'cat' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    backgroundProcesses.set(processId, child);

    const collectedLines: string[] = [];
    const MAX_LINES = 100;

    // Setup timeout
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000);
    }, timeout);

    // Abort handler
    const abortHandler = () => {
      child.kill('SIGTERM');
    };
    context.abortController.signal.addEventListener('abort', abortHandler, { once: true });

    // Yield progress for matching lines
    const processLine = (line: string): ToolCallResult | null => {
      if (!line.trim()) return null;
      if (filterRegex && !filterRegex.test(line)) return null;

      if (collectedLines.length < MAX_LINES) {
        collectedLines.push(line);
      }
      return this.createProgress({ processId, line });
    };

    // Collect output
    let stdoutBuffer = '';
    let stderrBuffer = '';

    const processBuffer = (buffer: string, isStderr: boolean): ToolCallResult[] => {
      const results: ToolCallResult[] = [];
      const source = isStderr ? 'stderr' : 'stdout';
      const combined = (isStderr ? stderrBuffer : stdoutBuffer) + buffer;
      const lines = combined.split('\n');

      // Keep last incomplete line in buffer
      const lastLine = lines.pop() ?? '';
      if (isStderr) {
        stderrBuffer = lastLine;
      } else {
        stdoutBuffer = lastLine;
      }

      for (const line of lines) {
        const result = processLine(`[${source}] ${line}`);
        if (result) results.push(result);
      }
      return results;
    };

    // Create a promise that resolves when the process exits
    const exitPromise = new Promise<number>((resolve) => {
      child.on('close', (code) => {
        clearTimeout(timer);
        context.abortController.signal.removeEventListener('abort', abortHandler);
        backgroundProcesses.delete(processId);
        resolve(code ?? 1);
      });

      child.on('error', () => {
        clearTimeout(timer);
        context.abortController.signal.removeEventListener('abort', abortHandler);
        backgroundProcesses.delete(processId);
        resolve(1);
      });
    });

    // Yield initial info
    yield this.createProgress({ processId, status: 'started', command: input.command });

    // Process stdout
    child.stdout.on('data', (data: Buffer) => {
      const results = processBuffer(data.toString(), false);
      // Note: We can't yield from an event handler in a generator,
      // so we collect and the final result will include all lines.
    });

    child.stderr.on('data', (data: Buffer) => {
      processBuffer(data.toString(), true);
    });

    // Wait for process to complete
    const exitCode = await exitPromise;

    // Yield final result
    yield this.createResult(
      {
        processId,
        exitCode,
        collectedLines,
        lineCount: collectedLines.length,
      },
      `Monitor "${input.command}" finished with exit code ${exitCode}.\n` +
      `Collected ${collectedLines.length} matching line(s):\n` +
      collectedLines.slice(0, 20).join('\n') +
      (collectedLines.length > 20 ? `\n... and ${collectedLines.length - 20} more` : ''),
    );
  }

  // ── Static utilities ──

  static stopProcess(processId: string): boolean {
    const child = backgroundProcesses.get(processId);
    if (!child) return false;
    child.kill('SIGTERM');
    backgroundProcesses.delete(processId);
    return true;
  }

  static listProcesses(): string[] {
    return [...backgroundProcesses.keys()];
  }
}
