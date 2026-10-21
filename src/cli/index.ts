import { setupWasmDominatorsCommand } from '../cli/wasm-dominators';
import { setupWasmCallGraphCommand } from '../cli/wasm-call-graph';
import { setupWasmReachabilityCommand } from '../cli/wasm-reachability';
import { setupWasmFunctionDepsCommand } from '../cli/wasm-function-deps';
import { setupWasmStackCommand } from '../cli/wasm-stack';
import { setupWasmDiffCommand } from '../cli/wasm-diff';
import { setupWasmMemoryAccessCommand } from '../cli/wasm-memory-access';
import { setupWasmConstantsCommand } from '../cli/wasm-constants';
import { Command } from 'commander';

const program = new Command();

program
  .addCommand(setupWasmDominatorsCommand())
  .addCommand(setupWasmCallGraphCommand())
  .addCommand(setupWasmReachabilityCommand())
  .addCommand(setupWasmFunctionDepsCommand())
  .addCommand(setupWasmStackCommand())
  .addCommand(setupWasmDiffCommand())
  .addCommand(setupWasmMemoryAccessCommand())
  .addCommand(setupWasmConstantsCommand())
  .parse(process.argv);
