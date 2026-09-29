import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { analyzeWasmMemory, MemoryAccessAnalysis, ComparisonResult } from '../lib/wasm-memory-analyzer';
import { formatJsonOutput, formatCsvOutput } from '../lib/formatters';

export function createWasmMemoryAccessCommand(program: Command) {
  const command = new Command('wasm-memory-access')
    .description('Analyze WASM memory access patterns in Soroban contracts')
    .argument('<wasmFile>', 'Path to the WASM file to analyze')
    .option('-c, --compare <file>', 'Compare with another WASM file')
    .option('-o, --output <format>', 'Output format (json|csv)', 'json')
    .option('--csv-access', 'Include access-level details in CSV output')
    .action(async (wasmFile: string, options: { compare?: string; output: string; csvAccess: boolean }) => {
      try {
        const wasmPath = path.resolve(wasmFile);
        if (!fs.existsSync(wasmPath)) {
          throw new Error(`WASM file not found: ${wasmPath}`);
        }

        const wasmBuffer = fs.readFileSync(wasmPath);
        const analysis = analyzeWasmMemory(wasmBuffer);

        if (options.compare) {
          const comparePath = path.resolve(options.compare);
          if (!fs.existsSync(comparePath)) {
            throw new Error(`Comparison WASM file not found: ${comparePath}`);
          }
          const compareBuffer = fs.readFileSync(comparePath);
          const comparison = analyzeWasmMemory(compareBuffer);
          const result: ComparisonResult = {
            original: analysis,
            modified: comparison,
            differences: compareAnalyses(analysis, comparison)
          };

          if (options.output === 'csv') {
            console.log(formatCsvOutput(result, options.csvAccess));
          } else {
            console.log(formatJsonOutput(result));
          }
        } else {
          if (options.output === 'csv') {
            console.log(formatCsvOutput(analysis, options.csvAccess));
          } else {
            console.log(formatJsonOutput(analysis));
          }
        }
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return command;
}

function compareAnalyses(original: MemoryAccessAnalysis, modified: MemoryAccessAnalysis) {
  const differences: any = {
    addedAccessSites: [],
    removedAccessSites: [],
    changedOperations: [],
    changedWidths: [],
    changedOffsets: [],
    newMemoryAccessFunctions: []
  };

  // Implement comparison logic here
  // This is a simplified version - actual implementation would need to:
  // 1. Normalize access sites for comparison
  // 2. Detect added/removed sites
  // 3. Detect changes in operations, widths, offsets
  // 4. Identify functions with new memory access

  return differences;
}