import { Command } from 'commander';
import { existsSync, writeFileSync } from 'fs';
import {
  analyzeMemoryAccessFile,
  compareMemoryAccesses,
  formatMemoryAccessComparison,
  formatMemoryAccessReport,
  memoryAccessToCsv,
} from '../wasm/memoryAccess';
import { WasmParseError } from '../wasm/wasmBinary';
import { formatJsonOutput } from '../utils/output-formatters';

/**
 * CLI for ISSUE-267: analyze the linear-memory access patterns of a Soroban
 * contract artifact.
 *
 * The command works completely offline. The artifact is decoded and
 * inspected, never instantiated or executed.
 */
export function setupWasmMemoryAccessCommand() {
  const program = new Command('wasm-memory-access')
    .description('Analyze WASM linear-memory load/store access patterns')
    .argument('<wasmFile>', 'Path to WASM file')
    .option('-o, --output <format>', 'Output format (text|json)', 'text')
    .option('--csv <path>', 'Write the access-level inventory to a CSV file')
    .option('-c, --compare <wasmFile>', 'Compare with another WASM file')
    .action((wasmFile: string, options: any) => {
      try {
        if (!existsSync(wasmFile)) {
          console.error(`File not found: ${wasmFile}`);
          process.exit(1);
        }

        const report = analyzeMemoryAccessFile(wasmFile);

        if (options.csv) {
          writeFileSync(options.csv, `${memoryAccessToCsv(report)}\n`, 'utf8');
          console.log(`CSV report written to ${options.csv}`);
        }

        if (options.compare) {
          if (!existsSync(options.compare)) {
            console.error(`File not found: ${options.compare}`);
            process.exit(1);
          }
          const other = analyzeMemoryAccessFile(options.compare);
          const comparison = compareMemoryAccesses(report, other);
          if (options.output === 'json') {
            console.log(formatJsonOutput(comparison));
          } else {
            console.log(formatMemoryAccessComparison(comparison));
          }
          return;
        }

        if (options.output === 'json') {
          console.log(formatJsonOutput(report));
        } else {
          console.log(formatMemoryAccessReport(report));
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
