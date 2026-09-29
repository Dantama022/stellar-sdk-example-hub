#!/usr/bin/env node

import { Command } from 'commander';
import { createWasmMemoryAccessCommand } from './commands/wasm-memory-access';

const program = new Command();

program
  .name('stellar-sdk-example-hub')
  .description('CLI tools for Stellar and Soroban development')
  .version('1.0.0');

// Add commands
program.addCommand(createWasmMemoryAccessCommand(program));

// Parse arguments
program.parse(process.argv);