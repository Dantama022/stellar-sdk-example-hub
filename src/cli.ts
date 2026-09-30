import { Command } from 'commander';
import { wasmDiffCommand } from './commands/wasmDiff';

const program = new Command();

program
  .name('stellar-api-inspector')
  .description('CLI utilities for inspecting Stellar Soroban contracts')
  .version('1.0.0');

// Existing commands would be registered here
// ...

// Register the new wasm-diff command
program
  .command('wasm-diff <oldWasm> <newWasm>')
  .description('Compare two Soroban contract WASM binaries at the section level')
  .option('--json', 'Output diff in JSON format')
  .action(wasmDiffCommand);

program.parse(process.argv);
