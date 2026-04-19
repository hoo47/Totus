import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config as loadDotenv } from 'dotenv';

export interface TotusConfig {
  defaultProvider: string;
  defaultModel: string;
  apiKeys: {
    openai?: string;
    anthropic?: string;
    gemini?: string;
  };
}

const CONFIG_DIR = path.join(os.homedir(), '.totus');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export class ConfigService {
  constructor() {
    loadDotenv(); // Load local .env if available
  }

  getConfig(): TotusConfig | null {
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
        return JSON.parse(data) as TotusConfig;
      } catch (err) {
        return null;
      }
    }
    return null;
  }

  saveConfig(config: TotusConfig) {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  }

  hasValidConfig(): boolean {
    const config = this.getConfig();
    if (!config) return false;

    // Local .env keys can override or satisfy missing ones
    const getEnvKey = (provider: string) => {
      switch (provider) {
        case 'openai': return process.env.OPENAI_API_KEY;
        case 'claude': return process.env.ANTHROPIC_API_KEY;
        case 'gemini': return process.env.GEMINI_API_KEY;
        case 'ollama': return 'local'; // no key required
        case 'lmstudio': return 'local'; // no key required
        default: return undefined;
      }
    };

    const providerId = config.defaultProvider;
    if (providerId === 'ollama' || providerId === 'lmstudio') return true;

    const keyFromConfig = providerId === 'openai' ? config.apiKeys.openai 
      : providerId === 'claude' ? config.apiKeys.anthropic
      : providerId === 'gemini' ? config.apiKeys.gemini
      : undefined;

    return !!(keyFromConfig || getEnvKey(providerId));
  }
}
