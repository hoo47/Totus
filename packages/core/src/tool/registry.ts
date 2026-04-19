// Tool Registry implementation

import type { Tool, ToolRegistry } from './types.js';

export class DefaultToolRegistry implements ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(toolName: string): void {
    this.tools.delete(toolName);
  }

  get(toolName: string): Tool | undefined {
    return this.tools.get(toolName);
  }

  getAll(): Tool[] {
    return [...this.tools.values()];
  }

  getReadOnly(): Tool[] {
    return this.getAll().filter(t => t.isReadOnly());
  }
}
