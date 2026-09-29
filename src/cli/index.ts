import { setupWasmDominatorsCommand } from '../cli/wasm-dominators';
import { Command } from 'commander';

const program = new Command();

program
  .addCommand(setupWasmDominatorsCommand())
  .parse(process.argv);