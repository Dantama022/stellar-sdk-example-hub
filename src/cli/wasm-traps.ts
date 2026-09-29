import { Command } from 'commander';
import { readFileSync } from 'fs';
import { analyzeWasmTraps, compareWasmTraps } from '../examples/272-wasm-traps';
import { formatCsvOutput } from '../utils/output-formatters';

export function setupWasmTrapsCommand() {
  const program = new Command('wasm-traps')
    .description('Analyze WASM instructions for potential runtime trap conditions (offline)')
    .argument('<wasmFile>', 'Path to WASM file')
    .option('-o, --output <format>', 'Output format (json|csv)', 'json')
    .option('-c, --compare <wasmFile>', 'Compare with another WASM artifact')
    .action(async (wasmFile: string, options: any) => {
      try {
        const wasmBuffer = readFileSync(wasmFile);

        if (options.compare) {
          const compareBuffer = readFileSync(options.compare);
          const comparison = compareWasmTraps(wasmBuffer, compareBuffer);
          console.log(JSON.stringify(comparison, null, 2));
        } else {
          const analysis = analyzeWasmTraps(wasmBuffer);
          if (options.output === 'csv') {
            const rows = analysis.findings.map((f) => ({
              functionIndex: f.functionIndex,
              basicBlock: f.basicBlock,
              instructionIndex: f.instructionIndex,
              opcode: f.opcode,
              trapCategory: f.trapCategory,
              classification: f.classification,
              details: f.details,
            }));
            console.log(formatCsvOutput(rows));
          } else {
            console.log(JSON.stringify(analysis, null, 2));
          }
        }
      } catch (error: any) {
        console.error('Trap analysis failed:', error.message || error);
        process.exit(1);
      }
    });

  return program;
}
