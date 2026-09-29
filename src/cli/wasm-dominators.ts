import { Command } from 'commander';
import { readFileSync } from 'fs';
import { WASMAnalyzer } from '../analyzer/wasm-analyzer';
import { formatJsonOutput, formatDotOutput } from '../utils/output-formatters';

export function setupWasmDominatorsCommand() {
  const program = new Command('wasm-dominators')
    .description('Analyze WASM dominator tree structure')
    .argument('<wasmFile>', 'Path to WASM file')
    .option('-o, --output <format>', 'Output format (json|dot)', 'json')
    .option('-c, --compare <wasmFile>', 'Compare with another WASM file')
    .action(async (wasmFile: string, options: any) => {
      try {
        const wasmBuffer = readFileSync(wasmFile);
        const analyzer = new WASMAnalyzer(wasmBuffer);

        if (options.compare) {
          const compareBuffer = readFileSync(options.compare);
          const comparison = analyzer.compareWith(compareBuffer);
          console.log(formatJsonOutput(comparison));
        } else {
          const analysis = analyzer.analyze();
          if (options.output === 'dot') {
            console.log(formatDotOutput(analysis));
          } else {
            console.log(formatJsonOutput(analysis));
          }
        }
      } catch (error) {
        console.error('Analysis failed:', error);
        process.exit(1);
      }
    });

  return program;
}