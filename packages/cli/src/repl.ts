import * as p from '@clack/prompts';
import chalk from 'chalk';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { AgentOrchestrator, type InternalMessage } from '@agent-platform/core';
import { createPermissionHandler } from './permission.js';

// Sentinel value to signal "re-prompt with pre-populated content"
const REPROMPT = Symbol('reprompt');

export interface ReplOptions {
  agentId: string;
  providerId?: string;
  model?: string;
}

export interface ReplConfig {
  skipPermissions?: boolean;
}

export class ReplService {
  private orchestrator: AgentOrchestrator;
  private rl!: readline.Interface;
  private conversationId: string | undefined = undefined;
  private config: ReplConfig;
  private fileCache: string[] | null = null;
  private currentModel?: string;
  private currentProviderId?: string;
  private abortController: AbortController | null = null;
  private keypressHandler: ((char: string | undefined, key: any) => void) | null = null;
  private lastSigintTime = 0;

  // Interrupt & Restart state
  private pendingLineContent: string | null = null;
  private currentPromptReject: ((reason: any) => void) | null = null;

  // Only true when waiting for the MAIN user input prompt.
  // False during: chat processing, permission prompts, tool execution, dropdown interactions.
  // This prevents keypress handlers from firing file/@slash dropdowns at the wrong time.
  private isWaitingForInput = false;

  constructor(orchestrator: AgentOrchestrator, config?: ReplConfig) {
    this.orchestrator = orchestrator;
    this.config = config ?? {};
    this.createReadlineInterface();
  }

  /**
   * Create a fresh readline interface.
   * Called at startup and after each interrupt (file mention / slash command / model switch).
   */
  private createReadlineInterface() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    this.rl.on('SIGINT', () => {
      const now = Date.now();
      if (now - this.lastSigintTime < 1000) {
        // Double Ctrl+C within 1 second → force exit
        p.outro('Goodbye!');
        process.exit(0);
      }
      this.lastSigintTime = now;

      if (this.abortController) {
        this.abortController.abort();
      } else {
        p.outro('Goodbye!');
        process.exit(0);
      }
    });

    // Prevent unexpected close from killing the app
    this.rl.on('close', () => {
      // Intentionally empty - we manage lifecycle explicitly
    });
  }

  /**
   * Register keypress handler on process.stdin.
   * Always removes the previous handler first to prevent duplicates.
   */
  private setupKeypressHandler() {
    if (this.keypressHandler) {
      process.stdin.removeListener('keypress', this.keypressHandler);
      this.keypressHandler = null;
    }

    this.keypressHandler = (char: string | undefined, key: any) => {
      // Ctrl+C: always handle regardless of state (for aborting chat)
      if (key && key.ctrl && key.name === 'c') {
        const now = Date.now();
        if (now - this.lastSigintTime < 1000) {
          // Double Ctrl+C within 1 second → force exit
          p.outro('Goodbye!');
          process.exit(0);
        }
        this.lastSigintTime = now;

        if (this.abortController) {
          this.abortController.abort();
        } else {
          // Exit regardless of isWaitingForInput state
          p.outro('Goodbye!');
          process.exit(0);
        }
        return;
      }

      // GUARD: Only trigger dropdown interactions when waiting for main user input.
      // This prevents file mention/@slash popup from firing during:
      // - Permission prompts (the bug where typing @ in permission causes crash)
      // - Chat processing
      // - Other interactive prompts
      if (!char || !this.isWaitingForInput) return;

      // Slash Command Dropdown: only when "/" is the entire line content
      if (char === '/' && this.rl.line === '/') {
        this.triggerSlashCommand();
        return;
      }

      // File Mention Dropdown
      if (char === '@') {
        // setTimeout(0) ensures rl.line and rl.cursor are fully updated
        // (readline's internal handler fires first, then our handler)
        setTimeout(() => {
          if (!this.isWaitingForInput) return;

          const cursor = this.rl.cursor;
          const line = this.rl.line;

          // Valid position: @ is at start of line OR preceded by a space
          const charBefore = cursor >= 2 ? line[cursor - 2] : undefined;
          const isValid = cursor === 1 || charBefore === ' ';

          if (isValid) {
            this.triggerFileMention();
          }
        }, 0);
      }
    };

    process.stdin.on('keypress', this.keypressHandler);
  }

  /**
   * Promise-based user input with pre-population support.
   * Replaces the old recursive rl.question callback pattern.
   */
  private promptUser(promptText: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.currentPromptReject = reject;

      this.rl.question(promptText, (answer) => {
        this.currentPromptReject = null;
        this.isWaitingForInput = false;
        resolve(answer);
      });

      // Mark that we're now waiting for main user input
      this.isWaitingForInput = true;

      // Pre-populate if there's pending content (from file mention or slash command)
      if (this.pendingLineContent !== null) {
        this.rl.write(this.pendingLineContent);
        this.pendingLineContent = null;
      }
    });
  }

  async run(options: ReplOptions): Promise<void> {
    this.currentModel = options.model;
    this.currentProviderId = options.providerId;
    p.intro(chalk.bgBlue.white.bold(' Totus AI CLI '));
    p.note(
      `Agent: ${options.agentId}\nModel: ${options.model || 'Default'}\nPermissions: ${this.config.skipPermissions ? chalk.yellow('SKIPPED') : chalk.green('Enabled')}`,
      'Configuration',
    );

    // Permission handler uses getter to always access the current rl instance
    const canUseTool = createPermissionHandler(
      () => this.rl,
      this.config.skipPermissions ?? false,
    );

    // Setup keypress handler once (will be re-setup after readline recreation)
    this.setupKeypressHandler();

    // ── Main REPL Loop ──────────────────────────────────────────
    while (true) {
      try {
        const input = await this.promptUser(chalk.green('You: '));
        const text = input.trim();

        if (!text) continue;

        if (await this.handleMetaCommand(text, options.agentId)) {
          continue;
        }

        const { processedText, attachedFiles } = await this.processMentions(text);
        if (attachedFiles.length > 0) {
          p.log.info(chalk.magenta(`📎 Attached: ${attachedFiles.join(', ')}`));
        }

        // keepAlive timer prevents the Node.js event loop from exiting
        // during chat processing (especially during permission prompts
        // where readline may not keep the event loop alive).
        const keepAlive = setInterval(() => {}, 30000);

        try {
          const s = p.spinner();
          s.start('Thinking...');

          // Ensure stdin stays alive throughout the chat
          process.stdin.ref();
          process.stdin.resume();

          this.abortController = new AbortController();

          let firstMessageReceived = false;
          let currentAssistantMessage = '';

          const stream = this.orchestrator.chat(options.agentId, this.conversationId, processedText, {
            model: this.currentModel,
            providerId: this.currentProviderId,
            canUseTool,
            signal: this.abortController.signal,
          });

          for await (const message of stream) {
            // Capture conversationId from system events
            if (message.type === 'system_event' && message.event === 'conversation_created') {
              this.conversationId = message.conversationId;
              continue;
            }

            if (message.type === 'assistant') {
              if (!firstMessageReceived) {
                s.stop('Response:');
                firstMessageReceived = true;
                process.stdout.write(chalk.blue('Assistant: '));
              }

              for (const contentBlock of message.message.content) {
                if (contentBlock.type === 'text') {
                  currentAssistantMessage += contentBlock.text;
                } else if (contentBlock.type === 'tool_use') {
                  p.log.step(chalk.yellow(`⚙️ Using tool: ${contentBlock.name}`));
                } else if (contentBlock.type === 'tool_result') {
                  const truncateText = (str: string, len: number) => str.length > len ? str.slice(0, len) + '...' : str;
                  const resultStr = truncateText(JSON.stringify(contentBlock.content), 50);
                  p.log.success(chalk.dim(`✓ Tool returned: ${resultStr}`));
                }
              }
            }
          }

          if (!firstMessageReceived) {
            s.stop('Done.');
          }

          if (currentAssistantMessage) {
            console.log(currentAssistantMessage);
          }

          console.log(); // Empty line after response
        } catch (error: any) {
          if (error.name === 'AbortError' || error.message?.includes('aborted') || error.message?.toLowerCase().includes('cancel')) {
            p.log.warn(chalk.yellow('작업이 취소되었습니다. (Cancelled by user)'));
          } else {
            p.log.error(chalk.red(`Error: ${error.message}`));
          }
        } finally {
          clearInterval(keepAlive);
          this.abortController = null;
          process.stdin.ref();
          process.stdin.resume();
        }
      } catch (e: any) {
        if (e === REPROMPT) {
          // File mention or slash command completed - re-prompt with pre-populated content
          continue;
        }
        if (e?.code === 'ERR_USE_AFTER_CLOSE') {
          this.createReadlineInterface();
          this.setupKeypressHandler();
        } else {
          p.log.error(chalk.red(`Unexpected error: ${e?.message || e}`));
        }
      }
    }
  }

  // ── Interrupt & Restart: File Mention ───────────────────────────

  /**
   * Triggered when user types '@' at a valid position in the main input.
   *
   * Flow:
   * 1. Save current line state (text before @, text after cursor)
   * 2. Close readline to release stdin for inquirer
   * 3. Run inquirer file search
   * 4. Set pendingLineContent with the selected file path
   * 5. Recreate readline
   * 6. Reject the current promptUser promise with REPROMPT
   * 7. While loop catches REPROMPT → calls promptUser → pre-populates with pendingLineContent
   */
  private triggerFileMention() {
    // Capture current state BEFORE closing readline
    const currentLine = this.rl.line || '';
    const cursor = this.rl.cursor;
    const beforeAt = currentLine.substring(0, cursor - 1); // text before the @
    const afterCursor = currentLine.substring(cursor);      // text after cursor

    // Capture the reject function before nulling it
    const rejectFn = this.currentPromptReject;
    this.currentPromptReject = null;
    this.isWaitingForInput = false;

    // Close readline to release stdin for inquirer
    this.rl.close();

    (async () => {
      try {
        this.buildFileCache();
        const { search } = await import('@inquirer/prompts');

        const choice = await search({
          message: 'File:',
          source: async (term) => {
            const cache = this.fileCache || [];
            const results = term
              ? cache.filter(f => f.toLowerCase().includes((term || '').toLowerCase()))
              : cache;
            return results.map(f => ({ value: '@' + f, name: f }));
          }
        });

        // Reconstruct line: [before @] + [@chosen/file] + [space] + [after cursor]
        this.pendingLineContent = beforeAt + choice + ' ' + afterCursor;
      } catch (e) {
        // User cancelled - restore original line without the @
        this.pendingLineContent = beforeAt + afterCursor;
      } finally {
        // Recreate readline & keypress handler for clean state
        this.createReadlineInterface();
        this.setupKeypressHandler();

        // Signal the while loop to re-prompt with pre-populated content
        if (rejectFn) {
          rejectFn(REPROMPT);
        }
      }
    })();
  }

  // ── Interrupt & Restart: Slash Command ──────────────────────────

  /**
   * Triggered when user types '/' as the first character.
   * Same interrupt-and-restart pattern as file mention.
   */
  private triggerSlashCommand() {
    const rejectFn = this.currentPromptReject;
    this.currentPromptReject = null;
    this.isWaitingForInput = false;

    this.rl.close();

    (async () => {
      try {
        const { search } = await import('@inquirer/prompts');

        const choice = await search({
          message: 'Command:',
          source: async (term) => {
            const commands = ['/help', '/tools', '/model', '/compact', '/clear', '/exit', '/quit'];
            const filtered = term ? commands.filter(c => c.includes(term)) : commands;
            return filtered.map(c => ({ value: c }));
          }
        });

        this.pendingLineContent = choice;
      } catch (e) {
        // Cancelled - empty line
        this.pendingLineContent = '';
      } finally {
        this.createReadlineInterface();
        this.setupKeypressHandler();

        if (rejectFn) {
          rejectFn(REPROMPT);
        }
      }
    })();
  }

  // ── Mentions Processing ─────────────────────────────────────────

  private async processMentions(input: string): Promise<{ processedText: string, attachedFiles: string[] }> {
    const mentionRegex = /(?:^|\s)@([^\s]+)/g;
    let match;
    const attachedFiles: string[] = [];
    let fileContexts = '';
    const processedPaths = new Set<string>();

    while ((match = mentionRegex.exec(input)) !== null) {
      const rawPath = match[1]!;
      const absPath = path.resolve(process.cwd(), rawPath);
      const filesToAttach: string[] = [];

      if (fs.existsSync(absPath)) {
        filesToAttach.push(absPath);
      } else {
        this.buildFileCache();
        const matches = (this.fileCache || []).filter(cachedPath =>
          cachedPath === rawPath || path.basename(cachedPath) === rawPath || cachedPath.endsWith('/' + rawPath)
        );
        for (const matchPath of matches) {
          filesToAttach.push(path.resolve(process.cwd(), matchPath));
        }
      }

      for (const fileAbsPath of filesToAttach) {
        if (processedPaths.has(fileAbsPath)) continue;
        processedPaths.add(fileAbsPath);

        try {
          const stats = await fs.promises.stat(fileAbsPath);
          const relPath = path.relative(process.cwd(), fileAbsPath);
          if (stats.isFile()) {
            if (stats.size > 100 * 1024) {
              p.log.warn(chalk.yellow(`⚠️ File @${relPath} is too large (>100KB) and was not attached.`));
              continue;
            }
            const content = await fs.promises.readFile(fileAbsPath, 'utf8');
            attachedFiles.push(relPath);
            fileContexts += `\n<file path="${relPath}">\n${content}\n</file>\n`;
          }
        } catch (err) {
          // silently ignore read errors
        }
      }
    }

    if (fileContexts.length > 0) {
      return { processedText: input + '\n\n' + fileContexts, attachedFiles };
    }
    return { processedText: input, attachedFiles };
  }

  private buildFileCache() {
    if (this.fileCache !== null) return;

    this.fileCache = [];
    const rootDir = process.cwd();

    const walkSync = (dir: string) => {
      let files;
      try {
        files = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const file of files) {
        if (
          file.name.startsWith('.') ||
          file.name === 'node_modules' ||
          file.name === 'dist' ||
          file.name === 'build' ||
          file.name === 'coverage'
        ) {
          continue;
        }

        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
          walkSync(fullPath);
        } else {
          this.fileCache!.push(path.relative(rootDir, fullPath));
        }
      }
    };

    walkSync(rootDir);
  }

  // ── Meta Commands ───────────────────────────────────────────────

  private async handleMetaCommand(input: string, agentId: string): Promise<boolean> {
    switch (input.toLowerCase()) {
      case '/exit':
      case '/quit':
        p.outro('Goodbye!');
        process.exit(0);
        return true;
      case '/clear':
        console.clear();
        p.intro(chalk.bgBlue.white.bold(' Totus AI CLI '));
        return true;
      case '/model':
        await this.handleModelSwitch();
        return true;
      case '/compact':
        await this.handleCompact();
        return true;
      case '/tools': {
        const tools = this.orchestrator.getAgentAvailableTools(agentId || 'coding-agent');
        console.log(chalk.yellow('\n🛠️  Available Tools for Current Agent:'));
        for (const tool of tools) {
          console.log(chalk.cyan(`  - ${tool.name}: `) + chalk.dim(String(tool.description).substring(0, 80).replace(/\n/g, ' ') + '...'));
        }
        console.log('');
        return true;
      }
      case '/help':
        console.log(chalk.cyan(`
Available commands:
  /help    - Show this help message
  /model   - Switch LLM provider and model
  /tools   - View available tools for the agent
  /compact - Compact conversation events into a summary
  /clear   - Clear the terminal
  /exit    - Exit the application
        `));
        return true;
      default:
        return false;
    }
  }

  // ── Model Switch (uses same close/reopen pattern) ──────────────

  private async handleModelSwitch(): Promise<void> {
    // Close readline to let inquirer take over stdin cleanly
    this.rl.close();

    try {
      const { search, select, password } = await import('@inquirer/prompts');

      const modelType = await select({
        message: '원하시는 모델의 환경을 선택해주세요 (API vs Local):',
        choices: [
          { value: 'api', name: '☁️  API Models (Claude, OpenAI, Gemini)' },
          { value: 'local', name: '💻 Local Models (Ollama, LM Studio)' }
        ]
      });

      let targetProviderId = '';
      if (modelType === 'api') {
        targetProviderId = await select({
          message: '제공자(Provider)를 선택하세요:',
          choices: [
            { value: 'claude', name: 'Anthropic (Claude)' },
            { value: 'openai', name: 'OpenAI (GPT)' },
            { value: 'gemini', name: 'Google (Gemini)' }
          ]
        });
      } else {
        targetProviderId = await select({
          message: '로컬 모델 서버를 선택하세요:',
          choices: [
            { value: 'ollama', name: '🦙 Ollama' },
            { value: 'lmstudio', name: '🖥️  LM Studio' }
          ]
        });
      }

      const { ConfigService } = await import('./config.js');
      const configService = new ConfigService();
      const config = configService.getConfig() || { defaultProvider: 'claude', defaultModel: '', apiKeys: {} };

      const getEnvKey = (provider: string) => {
        switch (provider) {
          case 'openai': return process.env.OPENAI_API_KEY;
          case 'claude': return process.env.ANTHROPIC_API_KEY;
          case 'gemini': return process.env.GEMINI_API_KEY;
          default: return undefined;
        }
      };

      let hasKey = false;
      if (targetProviderId === 'ollama' || targetProviderId === 'lmstudio') hasKey = true;
      else {
        const savedKey =
          targetProviderId === 'openai' ? config.apiKeys.openai
            : targetProviderId === 'claude' ? config.apiKeys.anthropic
              : targetProviderId === 'gemini' ? config.apiKeys.gemini
                : undefined;
        if (savedKey || getEnvKey(targetProviderId)) {
          hasKey = true;
        }
      }

      if (!hasKey) {
        const newKey = await password({ message: `API Key 설정이 필요합니다. ${targetProviderId}의 비밀 키를 입력하세요:` });
        if (!newKey) throw new Error('cancelled');

        if (targetProviderId === 'openai') config.apiKeys.openai = newKey;
        else if (targetProviderId === 'claude') config.apiKeys.anthropic = newKey;
        else if (targetProviderId === 'gemini') config.apiKeys.gemini = newKey;

        configService.saveConfig(config);

        const { OpenAIAdapter, ClaudeAdapter, GeminiAdapter } = await import('@agent-platform/core');
        let adapter;
        if (targetProviderId === 'openai') adapter = new OpenAIAdapter({ apiKey: newKey });
        else if (targetProviderId === 'claude') adapter = new ClaudeAdapter({ apiKey: newKey });
        else if (targetProviderId === 'gemini') adapter = new GeminiAdapter({ apiKey: newKey });

        if (adapter) {
          this.orchestrator.registerProvider(adapter);
          p.log.success(`키가 저장되고 ${targetProviderId} 제공자가 활성화 되었습니다!`);
        }
      } else {
        const registry = this.orchestrator.getProviderRegistry();
        if (!registry.get(targetProviderId)) {
          const existingKey =
            targetProviderId === 'openai' ? (config.apiKeys.openai || process.env.OPENAI_API_KEY)
              : targetProviderId === 'claude' ? (config.apiKeys.anthropic || process.env.ANTHROPIC_API_KEY)
                : targetProviderId === 'gemini' ? (config.apiKeys.gemini || process.env.GEMINI_API_KEY)
                  : undefined;

          const { OpenAIAdapter, ClaudeAdapter, GeminiAdapter, OllamaAdapter, LMStudioAdapter } = await import('@agent-platform/core');
          let adapter;
          if (targetProviderId === 'openai') adapter = new OpenAIAdapter({ apiKey: existingKey });
          else if (targetProviderId === 'claude') adapter = new ClaudeAdapter({ apiKey: existingKey });
          else if (targetProviderId === 'gemini') adapter = new GeminiAdapter({ apiKey: existingKey });
          else if (targetProviderId === 'ollama') adapter = new OllamaAdapter({ baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434' });
          else if (targetProviderId === 'lmstudio') adapter = new LMStudioAdapter({ baseUrl: process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234' });

          if (adapter) this.orchestrator.registerProvider(adapter);
        }
      }

      const provider = this.orchestrator.getProviderRegistry().get(targetProviderId);
      if (!provider) {
        p.log.warn('선택하신 제공자(Provider) 플러그인을 초기화할 수 없습니다.');
        return;
      }

      p.log.step(`Fetching available models for ${provider.name}...`);
      let models;
      try {
        models = await provider.listModels();
      } catch (e) {
        p.log.warn('네트워크 오류이거나 입력하신 키가 유효하지 않습니다.');
        return;
      }

      const formattedModels = models.map(m => ({
        name: `[${provider.name}] ${m.name}`,
        value: { model: m.id, provider: provider.id }
      }));

      const choice = await search({
        message: '변경할 모델을 고르세요:',
        source: async (term) => {
          const results = term ? formattedModels.filter(m => m.name.toLowerCase().includes(term.toLowerCase())) : formattedModels;
          return results;
        }
      });

      this.currentModel = choice.model;
      this.currentProviderId = choice.provider;

      config.defaultModel = choice.model;
      config.defaultProvider = choice.provider;
      configService.saveConfig(config);

      p.log.success(chalk.green(`현재 대화 모델이 성공적으로 변경되었습니다 => ${choice.model} (${choice.provider})`));
    } catch (e) {
      console.log(chalk.yellow('\n취소되었습니다. (Cancelled)'));
    } finally {
      // Recreate readline for clean state after inquirer interactions
      this.createReadlineInterface();
      this.setupKeypressHandler();
      process.stdin.resume();
    }
  }

  // ── Compact (uses same close/reopen pattern) ───────────────────

  private async handleCompact(): Promise<void> {
    if (!this.conversationId) {
      p.log.warn(chalk.yellow('아직 대화가 시작되지 않았습니다. 먼저 대화를 진행해주세요.'));
      return;
    }

    // Close readline to let inquirer take over stdin cleanly
    this.rl.close();

    try {
      const { checkbox } = await import('@inquirer/prompts');

      // Fetch all events for this conversation
      const eventStore = this.orchestrator.getEventStore();
      const events = await eventStore.getEvents(this.conversationId);

      if (events.length < 2) {
        p.log.warn(chalk.yellow('Compact할 이벤트가 충분하지 않습니다. (최소 2개)'));
        return;
      }

      // Filter out already-compacted events and build display list
      const selectableEvents = events.filter(e => !e.isCompacted);

      if (selectableEvents.length < 2) {
        p.log.warn(chalk.yellow('Compact 가능한 이벤트가 충분하지 않습니다.'));
        return;
      }

      // Build choices for inquirer checkbox
      const choices = selectableEvents.map(e => {
        const role = e.role === 'user' ? '👤 user' : e.role === 'assistant' ? '🤖 asst' : `📎 ${e.role}`;
        let preview: string;
        if (typeof e.content.content === 'string') {
          preview = e.content.content.replace(/\n/g, ' ').substring(0, 60);
        } else {
          preview = JSON.stringify(e.content.content).replace(/\n/g, ' ').substring(0, 60);
        }
        if (preview.length >= 60) preview += '...';

        return {
          name: `[${e.sequenceNumber}] ${role}: ${preview}`,
          value: e.sequenceNumber,
        };
      });

      p.log.info(chalk.cyan('처음과 끝 이벤트를 spacebar로 선택하세요 (정확히 2개):'));

      const selected = await checkbox({
        message: 'Compact 범위 선택 (spacebar로 시작/끝 선택, enter로 확인):',
        choices,
        required: true,
      });

      if (selected.length !== 2) {
        p.log.warn(chalk.yellow(`정확히 2개를 선택해야 합니다. (${selected.length}개 선택됨)`));
        return;
      }

      const fromSeq = Math.min(...selected);
      const toSeq = Math.max(...selected);

      // Count events in range
      const eventsInRange = selectableEvents.filter(
        e => e.sequenceNumber >= fromSeq && e.sequenceNumber <= toSeq
      );

      p.log.step(chalk.blue(`이벤트 ${fromSeq}~${toSeq} 범위 (${eventsInRange.length}개)를 compact합니다...`));

      const s = p.spinner();
      s.start('LLM Subagent가 요약을 생성하고 있습니다...');

      try {
        const summary = await this.orchestrator.compactConversation(
          this.conversationId,
          fromSeq,
          toSeq,
          this.currentProviderId,
          this.currentModel,
        );

        s.stop('Compact 완료!');
        p.log.success(chalk.green('📝 요약:'));
        console.log(chalk.dim(summary));
        console.log('');
      } catch (err: any) {
        s.stop('Compact 실패');
        p.log.error(chalk.red(`Compact 오류: ${err.message}`));
      }
    } catch (e) {
      console.log(chalk.yellow('\n취소되었습니다. (Cancelled)'));
    } finally {
      // Recreate readline for clean state after inquirer interactions
      this.createReadlineInterface();
      this.setupKeypressHandler();
      process.stdin.resume();
    }
  }
}
