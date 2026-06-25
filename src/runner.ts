import dotenv from 'dotenv';
import chalk from 'chalk';
import inquirer from 'inquirer';

// Load env variables
dotenv.config();

export interface Example {
  name: string;
  description: string;
  run: (params?: any) => Promise<void>;
  // Optional inquirer prompts for parameters
  params?: Array<{
    type: string;
    name: string;
    message: string;
    default?: any;
  }>;
}

const examples: Record<string, Example> = {
  '01-create-account': {
    name: '01-create-account',
    description: 'Generate keypairs and fund a test account using Friendbot',
    run: async () => {
      const mod = await import('./examples/01-create-account');
      await mod.run();
    },
  },
  '02-payment': {
    name: '02-payment',
    description: 'Send native XLM payment to a destination address',
    run: async () => {
      const mod = await import('./examples/02-payment');
      await mod.run();
    },
  },
  '03-create-trustline': {
    name: '03-create-trustline',
    description: 'Establish a trustline for a custom asset (USD)',
    run: async () => {
      const mod = await import('./examples/03-create-trustline');
      await mod.run();
    },
  },
  '04-multisig': {
    name: '04-multisig',
    description: 'Configure multi-signature and modify account thresholds',
    run: async () => {
      const mod = await import('./examples/04-multisig');
      await mod.run();
    },
  },
  '05-soroban-invoke': {
    name: '05-soroban-invoke',
    description: 'Simulate and invoke a Soroban smart contract method',
    run: async () => {
      const mod = await import('./examples/05-soroban-invoke');
      await mod.run();
    },
  },
  '12-asset-issuance': {
    name: '12-asset-issuance',
    description: 'Issue a custom asset and lock the issuer account',
    run: async (params) => {
      const mod = await import('./examples/12-asset-issuance');
      await mod.run(params);
    },
    params: [
      {
        type: 'input',
        name: 'assetCode',
        message: 'Enter custom asset code:',
        default: 'MYASSET',
      },
      {
        type: 'input',
        name: 'amount',
        message: 'Enter issuance amount:',
        default: '10000',
      },
    ],
  },
  '17-offline-signing': {
    name: '17-offline-signing',
    description: 'Construct, export XDR, sign offline, and verify a transaction',
    run: async (params) => {
      const mod = await import('./examples/17-offline-signing');
      await mod.run(params);
    },
    params: [
      {
        type: 'input',
        name: 'amount',
        message: 'Enter payment amount (XLM):',
        default: '10',
      },
    ],
  },
  '18-soroban-errors': {
    name: '18-soroban-errors',
    description: 'Intentionally trigger and parse Soroban RPC and transaction errors',
    run: async () => {
      const mod = await import('./examples/18-soroban-errors');
      await mod.run();
    },
  },
  '21-sep24-deposit-withdrawal': {
    name: '21-sep24-deposit-withdrawal',
    description: 'SEP-24 interactive deposit and withdrawal with a real testnet anchor',
    run: async () => {
      const mod = await import('./examples/21-sep24-deposit-withdrawal');
      await mod.run();
    },
  },
};

/**
 * Handles the interactive inquirer CLI prompt selection flow.
 */
async function runInteractivePrompt(): Promise<void> {
  console.log(chalk.bold.green('\n🎓 Stellar SDK Example Hub — Interactive Runner 🎓\n'));

  // Build selectable choices with descriptions
  const choices = Object.values(examples).map((ex) => ({
    name: `${chalk.yellow(ex.name)}: ${ex.description}`,
    value: ex.name,
  }));

  choices.push({
    name: chalk.red('Exit gracefully'),
    value: 'exit',
  });

  const { selectedExampleName } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedExampleName',
      message: 'Select an example to run:',
      choices,
    },
  ]);

  if (selectedExampleName === 'exit') {
    console.log(chalk.blue('\nGoodbye!'));
    process.exit(0);
  }

  const ex = examples[selectedExampleName];
  let params: any = {};

  // Request example-specific parameters if they exist
  if (ex.params && ex.params.length > 0) {
    console.log(chalk.cyan(`\nConfigure parameters for: ${ex.name}`));
    params = await inquirer.prompt(ex.params);
  }

  // Display a summary of the selected example before execution
  console.log(chalk.bold.cyan(`\n=== Selected Example Details ===`));
  console.log(`${chalk.bold('Name:')}        ${ex.name}`);
  console.log(`${chalk.bold('Description:')} ${ex.description}`);
  if (Object.keys(params).length > 0) {
    console.log(`${chalk.bold('Parameters:')}`);
    for (const [key, value] of Object.entries(params)) {
      console.log(`  - ${chalk.yellow(key)}: ${value}`);
    }
  }
  console.log('=================================\n');

  const { confirmRun } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmRun',
      message: 'Do you want to run this example now?',
      default: true,
    },
  ]);

  if (!confirmRun) {
    console.log(chalk.yellow('\nExecution canceled.'));
    return;
  }

  console.log(chalk.bold.cyan(`\n=== Running Example: ${ex.name} ===\n`));
  try {
    await ex.run(params);
    console.log(chalk.bold.green(`\n=== Execution Completed Successfully ===\n`));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.bold.red(`\n=== Execution Failed: ${message} ===\n`));
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const targetExample = args[0];

  if (targetExample) {
    // Non-interactive command line execution
    const ex = examples[targetExample];
    if (!ex) {
      console.error(chalk.red(`Error: Example "${targetExample}" not found.`));
      console.log(`Available examples: ${Object.keys(examples).join(', ')}`);
      process.exit(1);
    }

    console.log(chalk.bold.cyan(`\n=== Running Example: ${ex.name} ===`));
    console.log(chalk.gray(`${ex.description}\n`));
    try {
      await ex.run();
      console.log(chalk.bold.green(`\n=== Execution Completed Successfully ===`));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.bold.red(`\n=== Execution Failed: ${message} ===`));
      process.exit(1);
    }
  } else {
    // Interactive prompt execution when no arguments are provided
    await runInteractivePrompt();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
