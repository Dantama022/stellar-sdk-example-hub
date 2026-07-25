import dotenv from 'dotenv';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { examples } from './runner/catalog';

dotenv.config();

/**
 * Handles the interactive inquirer CLI prompt selection flow.
 */
async function runInteractivePrompt(): Promise<void> {
  console.log(chalk.bold.green('\n🎓 Stellar SDK Example Hub — Interactive Runner 🎓\n'));

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

  if (ex.params && ex.params.length > 0) {
    console.log(chalk.cyan(`\nConfigure parameters for: ${ex.name}`));
    params = await inquirer.prompt(ex.params);
  }

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
    await runInteractivePrompt();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
