#!/usr/bin/env node

import { Command } from 'commander';
import { createWasmConstantsCommand } from './commands/wasm-constants.js';

const program = new Command();

program
  .name('stellar-sdk-example-hub')
  .description('Stellar SDK Example Hub with Soroban support')
  .version('1.0.0');

// Add commands
createWasmConstantsCommand(program);

// Parse command line arguments
program.parse(process.argv);