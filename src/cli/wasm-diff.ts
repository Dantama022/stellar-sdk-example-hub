import { Command } from 'commander';
import { existsSync } from 'fs';
import { diffWasmFiles, formatSectionDiff, sectionDiffToCsv } from '../wasm/sectionDiff';
import { WasmParseError } from '../wasm/wasmBinary';
import { formatJsonOutput } from '../utils/output-formatters';

/**
 * CLI for ISSUE-239: compare two Soroban contract artifacts at the level of
 * their WebAssembly sections.
 *
 * The command works completely offline. Neither artifact is instantiated or
 * executed — only the section table of each file is read and hashed.
 */
export function setupWasmDiffCommand() {
  const program = new Command('wasm-diff')
    .description('Compare two WASM artifacts at the WebAssembly section level')
    .argument('<oldFile>', 'Path to the old WASM artifact')
    .argument('<newFile>', 'Path to the new WASM artifact')
    .option('-o, --output <format>', 'Output format (text|json|csv)', 'text')
    .action((oldFile: string, newFile: string, options: any) => {
      try {
        for (const file of [oldFile, newFile]) {
          if (!existsSync(file)) {
            console.error(`File not found: ${file}`);
            process.exit(1);
          }
        }

        const report = diffWasmFiles(oldFile, newFile);

        if (options.output === 'json') {
          console.log(formatJsonOutput(report));
        } else if (options.output === 'csv') {
          console.log(sectionDiffToCsv(report));
        } else {
          console.log(formatSectionDiff(report));
        }
      } catch (error) {
        if (error instanceof WasmParseError) {
          console.error(`Invalid WASM file: ${error.message}`);
        } else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          console.error('File not found:', (error as Error).message);
        } else {
          console.error('Diff failed:', error instanceof Error ? error.message : 'Unknown error');
        }
        process.exit(1);
      }
    });

  return program;
}
