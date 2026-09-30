import { Command } from 'commander';
import {
  sliceWasmFile,
  sliceToDot,
  compareSlices,
  type SliceMode,
} from '../wasm/programSlicing';
import { formatJsonOutput } from '../utils/output-formatters';

/**
 * CLI for ISSUE-283: offline WASM program slicing.
 *
 * Never executes the module — the file is parsed only.
 */
export function setupWasmSliceCommand() {
  const program = new Command('wasm-slice')
    .description('Analyze WASM program slices (backward, forward, bidirectional)')
    .argument('<wasmFile>', 'Path to WASM file')
    .option('-f, --function <index>', 'Function index', parseIndex)
    .option('-b, --block <index>', 'Basic block index', parseIndex)
    .option('-i, --instruction <index>', 'Instruction index', parseIndex)
    .option('-l, --local <index>', 'Local variable index', parseIndex)
    .option('-r, --return-value', 'Target the function return value', false)
    .option('-m, --mode <mode>', 'Slice mode (backward|forward|bidirectional)', 'backward')
    .option('-o, --output <format>', 'Output format (json|dot)', 'json')
    .option('-c, --compare <wasmFile>', 'Compare with another WASM file')
    .action((wasmFile: string, options: any) => {
      try {
        const mode = options.mode as SliceMode;
        const target = {
          funcIndex: options.function,
          blockIndex: options.block,
          instructionIndex: options.instruction,
          localIndex: options.local,
          returnValue: Boolean(options.returnValue),
        };

        if (options.compare) {
          const before = sliceWasmFile(wasmFile, target, mode);
          const after = sliceWasmFile(options.compare, target, mode);
          console.log(formatJsonOutput(compareSlices(before, after)));
          return;
        }

        const report = sliceWasmFile(wasmFile, target, mode);
        console.log(options.output === 'dot' ? sliceToDot(report) : formatJsonOutput(report));
      } catch (error) {
        console.error('Slicing failed:', error);
        process.exit(1);
      }
    });

  return program;
}

function parseIndex(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`expected a non-negative integer index, got "${value}"`);
  }
  return n;
}