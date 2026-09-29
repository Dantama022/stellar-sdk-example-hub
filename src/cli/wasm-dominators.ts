import { Command } from 'commander';
import { analyzeWasmDominators, compareReports, reportToDot } from '../examples/218-wasm-dominators';
import { formatJsonOutput } from '../utils/output-formatters';

export function setupWasmDominatorsCommand() {
  const program = new Command('wasm-dominators')
    .description('Analyze WASM dominator tree structure')
    .argument('<wasmFile>', 'Path to WASM file')
    .option('-o, --output <format>', 'Output format (json|dot)', 'json')
    .option('-c, --compare <wasmFile>', 'Compare with another WASM file')
    .action(async (wasmFile: string, options: any) => {
      try {
        if (options.compare) {
          const repA = analyzeWasmDominators(wasmFile);
          const repB = analyzeWasmDominators(options.compare);
          const comparison = compareReports(repA, repB);
          console.log(formatJsonOutput(comparison));
        } else {
          const analysis = analyzeWasmDominators(wasmFile);
          if (options.output === 'dot') {
            console.log(reportToDot(analysis));
          } else {
            console.log(formatJsonOutput(analysis));
          }
        }
      } catch (error: any) {
        console.error('Analysis failed:', error?.message || error);
        process.exit(1);
      }
    });

  return program;
}