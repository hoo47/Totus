import * as p from '@clack/prompts';
import chalk from 'chalk';
import { ConfigService, type TotusConfig } from './config.js';

export async function runOnboarding(configService: ConfigService): Promise<TotusConfig> {
  console.clear();
  p.intro(chalk.bgBlue.white.bold(' Welcome to Totus AI CLI Setup '));
  p.note(
    'It looks like this is your first time running Totus, or your configuration is missing.\nLet\'s set up your default AI provider.',
    'Setup Required'
  );

  const providerGroup = await p.group({
    provider: () => p.select({
      message: 'Which LLM Provider would you like to use by default?',
      options: [
        { value: 'claude', label: 'Anthropic (Claude)' },
        { value: 'openai', label: 'OpenAI (GPT)' },
        { value: 'gemini', label: 'Google (Gemini)' },
        { value: 'ollama', label: 'Local (Ollama)' },
      ] as any,
    }),
    model: async ({ results }) => {
      const provider = (results.provider as unknown) as string;
      if (provider === 'claude') {
        return p.text({ message: 'Enter the model name', defaultValue: 'claude-3-7-sonnet-20250219' });
      } else if (provider === 'openai') {
        return p.text({ message: 'Enter the model name', defaultValue: 'gpt-4o' });
      } else if (provider === 'gemini') {
        return p.text({ message: 'Enter the model name', defaultValue: 'gemini-2.5-pro' });
      } else {
        try {
          const res = await fetch('http://127.0.0.1:11434/api/tags');
          if (!res.ok) throw new Error('Fetch status not OK');
          const data = await res.json() as any;
          if (!data.models || data.models.length === 0) throw new Error('No models');
          
          return p.select({
            message: 'Select the Ollama model:',
            options: data.models.map((m: any) => ({ value: m.name, label: m.name })) as any,
          });
        } catch (err) {
          p.log.warn('Could not list Ollama models (is Ollama running?). Please enter manually.');
          return p.text({ message: 'Enter the Ollama model name', defaultValue: 'llama3.2' });
        }
      }
    },
    apiKey: ({ results }) => {
      const provider = (results.provider as unknown) as string;
      if (provider === 'ollama') return Promise.resolve('');
      return p.password({ message: `Please enter your API Key for ${provider} (input is hidden)` });
    }
  }, {
    onCancel: () => {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }
  });

  const existingConfig = configService.getConfig() || {
    defaultProvider: '',
    defaultModel: '',
    apiKeys: {}
  };

  const providerStr = (providerGroup.provider as unknown) as string;
  const newConfig: TotusConfig = {
    defaultProvider: providerStr,
    defaultModel: (providerGroup.model as unknown) as string,
    apiKeys: { ...existingConfig.apiKeys }
  };

  const keyInput = (providerGroup.apiKey as unknown) as string | undefined;
  if (keyInput && keyInput.trim().length > 0) {
    if (providerStr === 'claude') newConfig.apiKeys.anthropic = keyInput.trim();
    if (providerStr === 'openai') newConfig.apiKeys.openai = keyInput.trim();
    if (providerStr === 'gemini') newConfig.apiKeys.gemini = keyInput.trim();
  }

  configService.saveConfig(newConfig);

  p.outro(chalk.green('Configuration saved to ~/.totus/config.json!'));
  return newConfig;
}
