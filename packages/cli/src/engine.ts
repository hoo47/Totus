import { config } from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { 
  AgentOrchestrator, 
  SQLiteEventStore,
  InMemoryEventStore,
  ClaudeAdapter,
  OpenAIAdapter,
  GeminiAdapter,
  OllamaAdapter,
  LMStudioAdapter,
  type LLMProviderAdapter,
  type EventStore,
} from '@agent-platform/core';
import { CodingAgentPlugin } from '@agent-platform/plugin-coding';
import { MonitorTool } from '@agent-platform/tools';
import type { TotusConfig } from './config.js';

export interface EngineOptions {
  skipPermissions?: boolean;
  useInMemory?: boolean;
  config?: TotusConfig;
}

export class EngineService {
  private orchestrator: AgentOrchestrator;
  readonly options: EngineOptions;
  
  constructor(options?: EngineOptions) {
    config(); // Load .env file if available
    this.options = options ?? {};
    
    // Choose EventStore implementation
    let eventStore: EventStore;
    
    if (options?.useInMemory) {
      eventStore = new InMemoryEventStore();
    } else {
      // Project-level SQLite DB
      const dbDir = path.join(process.cwd(), '.totus');
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      const dbPath = path.join(dbDir, 'data.db');
      eventStore = new SQLiteEventStore(dbPath);
    }
    
    // Config Resolution
    const defaultModel = this.options.config?.defaultModel || 'claude-3-7-sonnet-20250219';

    // Init Orchestrator
    this.orchestrator = new AgentOrchestrator({
      eventStore,
      defaultModel,
    });
  }
  
  async init(): Promise<void> {
    // 1. Setup Providers
    const providerId = this.options.config?.defaultProvider || 'claude';
    let adapter: LLMProviderAdapter;

    if (providerId === 'openai') {
      adapter = new OpenAIAdapter({
        apiKey: this.options.config?.apiKeys?.openai || process.env.OPENAI_API_KEY || '',
      });
    } else if (providerId === 'gemini') {
      adapter = new GeminiAdapter({
        apiKey: this.options.config?.apiKeys?.gemini || process.env.GEMINI_API_KEY || '',
      });
    } else if (providerId === 'ollama') {
      adapter = new OllamaAdapter({
        baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
      });
    } else if (providerId === 'lmstudio') {
      adapter = new LMStudioAdapter({
        baseUrl: process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234',
      });
    } else {
      // default: claude
      adapter = new ClaudeAdapter({
        apiKey: this.options.config?.apiKeys?.anthropic || process.env.ANTHROPIC_API_KEY || '',
      });
    }

    this.orchestrator.registerProvider(adapter);
    
    // 2. Register Global Tools (available to all agents)
    this.orchestrator.registerGlobalTool(new MonitorTool());

    // 3. Setup Agents
    const codingAgent = new CodingAgentPlugin();
    await this.orchestrator.registerAgent(codingAgent);
  }

  getOrchestrator(): AgentOrchestrator {
    return this.orchestrator;
  }
}
