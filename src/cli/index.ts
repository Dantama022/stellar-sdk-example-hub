import { setupWasmDominatorsCommand } from './wasm-dominators';
import { setupWasmTrapsCommand } from './wasm-traps';
import { Command } from 'commander';

const program = new Command();

program
  .name('stellar-sdk-example-hub')
  .description('Stellar SDK & Soroban WASM Analysis Tools')
  .addCommand(setupWasmDominatorsCommand())
  .addCommand(setupWasmTrapsCommand())
  .parse(process.argv);