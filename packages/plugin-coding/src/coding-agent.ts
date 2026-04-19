import { type AgentPlugin, type AgentConfig, type AgentContext, type Tool } from '@agent-platform/core';
import { ReadTool, WriteTool, EditTool, GlobTool, GrepTool, BashTool } from '@agent-platform/tools';

export class CodingAgentPlugin implements AgentPlugin {
  id = 'coding-agent';
  name = 'Coding Agent';
  version = '0.1.0';
  description = 'An expert coding assistant agent with file system and shell tools.';
  
  async isAvailable(): Promise<boolean> { return true; }

  async initialize(config: AgentConfig): Promise<void> {}

  async dispose(): Promise<void> {}

  async getSystemPrompt(context: AgentContext): Promise<string[]> {
    return [
      'You are an expert coding assistant. You have access to tools for reading, writing, and editing files, as well as running shell commands.',
      '',
      'Guidelines:',
      '- When asked to make changes, use the Read tool first to understand the existing code, then use Edit or Write to make modifications.',
      '- Always use Grep or Glob to find relevant files before making assumptions about the codebase.',
      '- When running shell commands with Bash, be precise and careful. Avoid destructive operations unless explicitly asked.',
      '- Provide clear explanations of what you are doing and why.',
      '',
      `Current working directory: ${context.workingDirectory}`,
      `Model: ${context.model}`,
    ];
  }

  async getContext(workingDirectory: string): Promise<Record<string, string>> {
    return { pwd: workingDirectory };
  }

  getTools(): Tool[] {
    return [
      new ReadTool(),
      new WriteTool(),
      new EditTool(),
      new GlobTool(),
      new GrepTool(),
      new BashTool(),
    ];
  }
}
