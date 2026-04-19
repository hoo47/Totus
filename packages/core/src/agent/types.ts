// Agent Plugin types

import type { Tool } from '../tool/types.js';

export interface AgentConfig {
  workingDirectory?: string;
  providerId?: string;
  model?: string;
  customSettings?: Record<string, unknown>;
}

export interface AgentContext {
  workingDirectory: string;
  model: string;
  providerId: string;
}

export interface AgentPlugin {
  /** Unique identifier for this agent */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Semantic version */
  readonly version: string;

  /** Description of what this agent does */
  readonly description: string;

  /** Get the tools this agent provides */
  getTools(): Tool[];

  /** Get the system prompt for this agent */
  getSystemPrompt(context: AgentContext): Promise<string[]>;

  /** Collect context relevant to this agent's domain */
  getContext(workingDir: string): Promise<Record<string, string>>;

  /** Initialize the agent with configuration */
  initialize(config: AgentConfig): Promise<void>;

  /** Clean up resources */
  dispose(): Promise<void>;

  /** Check if this agent is available/healthy */
  isAvailable(): Promise<boolean>;
}
