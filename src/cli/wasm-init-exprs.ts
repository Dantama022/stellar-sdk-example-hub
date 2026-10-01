import { Command } from 'commander';
import { readFileSync } from 'fs';
import {
  analyzeInitExprsFile,
  toCsv,
  toDot,
  compareInitExprs,
  type InitExprReport,
} from '../wasm/initExprAnalysis';
import { formatJsonOutput } from '../utils/output-formatters';

/**
 * CLI for ISSUE-282: analyze WASM initialization expressions offline.
 *
 * Never instantiates or executes the module — the file is parsed only.
 */
export function setupWasmInitExprsCommand() {
  const program = new Command('wasm-init-exprs')
    .description('Analyze WASM initialization expressions (globals, data, element segments)')
    .argument('<wasmFile>', 'Path to WASM file')
    .option('-o, --output <format>', 'Output format (json|csv|dot)', 'json')
    .option('-c, --compare <wasmFile>', 'Compare with another WASM file')
    .action((wasmFile: string, options: any) => {
      try {
        if (options.compare) {
          const before: InitExprReport = analyzeInitExprsFile(wasmFile);
          const after: InitExprReport = analyzeInitExprsFile(options.compare);
          console.log(formatJsonOutput(compareInitExprs(before, after)));
          return;
        }

        const report = analyzeInitExprsFile(wasmFile);

        if (options.output === 'csv') {
          console.log(toCsv(report));
        } else if (options.output === 'dot') {
          console.log(toDot(report));
        } else {
          console.log(formatJsonOutput(report));
        }
      } catch (error) {
        console.error('Analysis failed:', error);
        process.exit(1);
      }
    });

  return program;
}

/** Exported for the runner so the example is exercised without a WASM fixture. */
export function readWasm(path: string): Buffer {
  return readFileSync(path);
}