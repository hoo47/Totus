// Permission Handler for CLI
// Prompts the user to approve tool execution when permissions are required

import * as readline from 'readline';
import chalk from 'chalk';
import type { CanUseToolFn, Tool, ToolUseContext } from '@agent-platform/core';

/**
 * Creates a permission handler that prompts the user before executing tools.
 * Accepts a getter function for readline to always access the current instance
 * (important since readline may be recreated during file mention interactions).
 */
export function createPermissionHandler(
  getRL: () => readline.Interface,
  skipPermissions: boolean,
): CanUseToolFn {
  // Track if user has chosen 'always' for this session
  let alwaysAllow = skipPermissions;

  return async (
    tool: Tool,
    input: Record<string, unknown>,
    _context: ToolUseContext,
  ) => {
    // Auto-allow if skip mode or tool doesn't need permissions
    if (alwaysAllow || !tool.needsPermissions(input)) {
      return { result: true as const };
    }

    // Build display message
    const toolName = tool.userFacingName();
    const toolMessage = tool.renderToolUseMessage
      ? tool.renderToolUseMessage(input)
      : `${toolName}(${JSON.stringify(input).slice(0, 100)})`;

    console.log('');
    console.log(chalk.yellow('⚠️  Permission required'));
    console.log(chalk.bold(`   Tool: ${toolName}`));
    console.log(chalk.dim(`   ${toolMessage}`));
    console.log('');

    // Ensure stdin is alive and readable before asking for input.
    // This prevents the event loop from exiting during the permission prompt.
    process.stdin.ref();
    process.stdin.resume();

    const answer = await askUser(
      getRL(),
      chalk.dim('   ') +
      chalk.green('[y]es') + ' / ' +
      chalk.red('[n]o') + ' / ' +
      chalk.cyan('[a]lways allow') + ': ',
    );

    const normalized = answer.toLowerCase();

    if (normalized === 'a' || normalized === 'always') {
      alwaysAllow = true;
      return { result: true as const };
    }

    if (normalized === 'y' || normalized === 'yes' || normalized === '') {
      return { result: true as const };
    }

    return {
      result: false as const,
      message: 'User denied permission for this tool use.',
    };
  };
}

function askUser(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    // Safety: if readline is closed, create a temporary one
    if ((rl as any).closed) {
      const tempRL = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });
      tempRL.question(question, (answer) => {
        tempRL.close();
        resolve(answer.trim());
      });
      return;
    }

    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}
