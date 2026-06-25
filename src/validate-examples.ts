import chalk from 'chalk';

import { runExampleValidation } from './validation';

interface CliOptions {
  configPath?: string;
  includeExcluded: boolean;
  onlyExampleNames?: string[];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runExampleValidation({
    configPath: options.configPath,
    includeExcluded: options.includeExcluded,
    onlyExampleNames: options.onlyExampleNames,
  });

  console.log(chalk.bold.cyan('\n=== Example Validation Report ===\n'));
  console.log(result.report);

  process.exitCode = result.summary.failed > 0 ? 1 : 0;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    includeExcluded: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--include-excluded') {
      options.includeExcluded = true;
      continue;
    }

    if (arg === '--config') {
      const value = args[i + 1];
      if (!value) {
        throw new Error('--config requires a file path');
      }
      options.configPath = value;
      i += 1;
      continue;
    }

    if (arg === '--only') {
      const value = args[i + 1];
      if (!value) {
        throw new Error('--only requires a comma-separated list of example names');
      }
      options.onlyExampleNames = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Example validation failed to start: ${message}`));
    process.exit(1);
  });
}
