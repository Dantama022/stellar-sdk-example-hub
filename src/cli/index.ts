import { setupWasmDominatorsCommand } from '../cli/wasm-dominators';
import { setupWasmCallGraphCommand } from '../cli/wasm-call-graph';
import { setupWasmReachabilityCommand } from '../cli/wasm-reachability';
import { setupWasmFunctionDepsCommand } from '../cli/wasm-function-deps';
import { setupWasmStackCommand } from '../cli/wasm-stack';
import { setupWasmInitExprsCommand } from '../cli/wasm-init-exprs';
import { setupWasmSliceCommand } from '../cli/wasm-slice';
import { setupWasmBranchesCommand } from '../cli/wasm-branches';
import { Command } from 'commander';

const program = new Command();

program
  .addCommand(setupWasmDominatorsCommand())
  .addCommand(setupWasmCallGraphCommand())
  .addCommand(setupWasmReachabilityCommand())
  .addCommand(setupWasmFunctionDepsCommand())
  .addCommand(setupWasmStackCommand())
  .addCommand(setupWasmInitExprsCommand())
  .addCommand(setupWasmSliceCommand())
  .addCommand(setupWasmBranchesCommand())
  .parse(process.argv);