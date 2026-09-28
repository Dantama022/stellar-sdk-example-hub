import { Command } from 'commander';
import { analyzeWasm } from './analyzer';
import { outputJson, outputCsv } from './reporters';

const program = new Command();

program
  .name('wasm-unreachable')
  .description('Analyze Soroban WASM artifacts for unreachable code')
  .requiredOption('-f, --file <path>', 'WASM file path')
  .option('-c, --compare <path>', 'Compare with previous artifact')
  .option('-o, --output <format>', 'Output format (json|csv)', 'json')
  .option('-d, --diff', 'Show diff between artifacts')
  .action(async (options) => {
    const result = await analyzeWasm(options.file, options.compare);
    if (options.output === 'json') {
      outputJson(result, options.diff);
    } else {
      outputCsv(result, options.diff);
    }
  });

program.parse(process.argv);