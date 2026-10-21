import { Command } from 'commander';
import { existsSync, writeFileSync } from 'fs';
import {
  analyzeConstantPropagationFile,
  compareConstantPropagation,
  formatConstantComparison,
  formatConstantPropagationReport,
  constantPropagationToCsv,
} from '../wasm/constantPropagation';
import { WasmParseError } from '../wasm/wasmBinary';
import { formatJsonOutput } from '../utils/output-formatters';

/**
 * CLI for ISSUE-268: analyze the constant values of a Soroban contract
 * artifact.
 *
 * The command works completely offline. The artifact is decoded and the
 * constant propagation engine evaluates operators statically — no contract
 * code is ever executed.
 */
export function setupWasmConstantsCommand() {
  const program = new Command('wasm-constants')
    .description('Analyze statically resolvable constants in a WASM artifact')
    .argument('<wasmFile>', 'Path to WASM file')
    .option('-o, --output <format>', 'Output format (text|json)', 'text')
    .option('--csv <path>', 'Write the constant findings to a CSV file')
    .option('-c, --compare <wasmFile>', 'Compare with another WASM file')
    .action((wasmFile: string, options: any) => {
      try {
        if (!existsSync(wasmFile)) {
          console.error(`File not found: ${wasmFile}`);
          process.exit(1);
        }

        const report = analyzeConstantPropagationFile(wasmFile);

        if (options.csv) {
          writeFileSync(options.csv, `${constantPropagationToCsv(report)}\n`, 'utf8');
          console.log(`CSV report written to ${options.csv}`);
        }

        if (options.compare) {
          if (!existsSync(options.compare)) {
            console.error(`File not found: ${options.compare}`);
            process.exit(1);
          }
          const other = analyzeConstantPropagationFile(options.compare);
          const comparison = compareConstantPropagation(report, other);
          if (options.output === 'json') {
            console.log(formatJsonOutput(comparison));
          } else {
            console.log(formatConstantComparison(comparison));
          }
          return;
        }

        if (options.output === 'json') {
          console.log(formatJsonOutput(report));
        } else {
          console.log(formatConstantPropagationReport(report));
        }
      } catch (error) {
        if (error instanceof WasmParseError) {
          console.error(`Invalid WASM file: ${error.message}`);
        } else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          console.error('File not found:', (error as Error).message);
        } else {
          console.error(
            'Analysis failed:',
            error instanceof Error ? error.message : 'Unknown error',
          );
        }
        process.exit(1);
      }
    });

  return program;
}
