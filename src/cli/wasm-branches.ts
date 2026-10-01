import { Command } from 'commander';
import {
  analyzeBranchesFile,
  branchesToCsv,
  branchesToDot,
  compareBranches,
} from '../wasm/branchAnalysis';
import { formatJsonOutput } from '../utils/output-formatters';

/**
 * CLI for ISSUE-284: offline WASM branch-condition analysis.
 *
 * Never executes the module — the file is parsed only.
 */
export function setupWasmBranchesCommand() {
  const program = new Command('wasm-branches')
    .description('Analyze WASM branch conditions and their sources')
    .argument('<wasmFile>', 'Path to WASM file')
    .option('-o, --output <format>', 'Output format (json|csv|dot)', 'json')
    .option('-c, --compare <wasmFile>', 'Compare with another WASM file')
    .action((wasmFile: string, options: any) => {
      try {
        if (options.compare) {
          console.log(formatJsonOutput(compareBranches(analyzeBranchesFile(wasmFile), analyzeBranchesFile(options.compare))));
          return;
        }

        const report = analyzeBranchesFile(wasmFile);
        if (options.output === 'csv') console.log(branchesToCsv(report));
        else if (options.output === 'dot') console.log(branchesToDot(report));
        else console.log(formatJsonOutput(report));
      } catch (error) {
        console.error('Branch analysis failed:', error);
        process.exit(1);
      }
    });

  return program;
}