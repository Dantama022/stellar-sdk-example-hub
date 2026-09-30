#!/usr/bin/env node

import { Command } from 'commander';
import { createWasmNamesCommand } from './commands/wasm-names';

const program = new Command();

program
  .name('stellar-sdk-example-hub')
  .description('Stellar SDK and Soroban examples')
  .version('1.0.0')
  .addCommand(createWasmNamesCommand());

program.parse(process.argv);
