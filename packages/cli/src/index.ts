import { Command } from 'commander';
import { EngineService } from './engine.js';
import { ReplService } from './repl.js';
import { ConfigService, type TotusConfig } from './config.js';
import { runOnboarding } from './onboarding.js';

const program = new Command();

program
  .name('totus')
  .description('Totus AI CLI Platform')
  .version('0.1.0')
  .option('-a, --agent <id>', 'Agent ID to use', 'coding-agent')
  .option('-m, --model <name>', 'Model to use (overrides config)')
  .option('-p, --provider <id>', 'Provider ID to use (overrides config)')
  .option('--dangerouslySkipPermissions', 'Skip all tool permission checks')
  .option('--in-memory', 'Use in-memory event store instead of SQLite')
  .action(async (options) => {
    try {
      const configService = new ConfigService();
      let activeConfig: TotusConfig | null = configService.getConfig();

      // Check if valid config exists or onboarding is needed
      if (!configService.hasValidConfig() || !activeConfig) {
        activeConfig = await runOnboarding(configService);
      }

      const engineService = new EngineService({
        skipPermissions: options.dangerouslySkipPermissions ?? false,
        useInMemory: options.inMemory ?? false,
        config: activeConfig,
      });
      await engineService.init();

      const replService = new ReplService(
        engineService.getOrchestrator(),
        { skipPermissions: options.dangerouslySkipPermissions ?? false },
      );
      
      const providerToUse = options.provider || activeConfig?.defaultProvider || 'claude';
      const modelToUse = options.model || activeConfig?.defaultModel || 'claude-3-7-sonnet-20250219';

      await replService.run({
        agentId: options.agent,
        model: modelToUse,
        providerId: providerToUse,
      });
    } catch (err) {
      console.error('Failed to start Totus CLI:', err);
      process.exit(1);
    }
  });

program.parse(process.argv);
