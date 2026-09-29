import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { analyzeWasmLiterals, WasmLiteralAnalysisOptions } from '../analyzers/wasmLiteralsAnalyzer';
import { LiteralOutputFormat } from '../types/wasmLiterals';

const program = new Command();

program
  .name('wasm-literals')
  .description('Analyze WASM literals and magic numbers in Soroban contracts')
  .argument('<wasmFile>', 'Path to the WASM file to analyze')
  .option('-o, --output <path>', 'Output file path (default: stdout)')
  .option('-f, --format <format>', 'Output format: json or csv', 'json')
  .option('--min-occurrences <number>', 'Minimum occurrences threshold for literals', parseInt, 1)
  .option('--include-floats', 'Include floating-point literals in analysis', true)
  .option('--include-hex', 'Include hexadecimal representations', true)
  .option('--classify-patterns', 'Classify common patterns (zero, powers of two, etc.)', true)
  .option('--compare <file>', 'Compare with another WASM file (experimental)')
  .action(async (wasmFile, options) => {
    try {
      const absolutePath = path.resolve(wasmFile);
      if (!fs.existsSync(absolutePath)) {
        console.error(`Error: File not found: ${absolutePath}`);
        process.exit(1);
      }

      const wasmBuffer = fs.readFileSync(absolutePath);
      const analysisOptions: WasmLiteralAnalysisOptions = {
        includeFloats: options.includeFloats,
        includeHex: options.includeHex,
        classifyPatterns: options.classifyPatterns,
        minOccurrences: options.minOccurrences
      };

      const result = analyzeWasmLiterals(wasmBuffer, analysisOptions);

      if (options.compare) {
        const comparePath = path.resolve(options.compare);
        if (!fs.existsSync(comparePath)) {
          console.error(`Error: Comparison file not found: ${comparePath}`);
          process.exit(1);
        }
        const compareBuffer = fs.readFileSync(comparePath);
        const compareResult = analyzeWasmLiterals(compareBuffer, analysisOptions);
        result.comparison = {
          file: options.compare,
          sharedLiterals: findSharedLiterals(result, compareResult),
          uniqueToFirst: findUniqueLiterals(result, compareResult),
          uniqueToSecond: findUniqueLiterals(compareResult, result)
        };
      }

      const outputFormat = options.format as LiteralOutputFormat;
      const output = formatOutput(result, outputFormat);

      if (options.output) {
        fs.writeFileSync(path.resolve(options.output), output);
        console.log(`Analysis written to: ${options.output}`);
      } else {
        console.log(output);
      }
    } catch (error) {
      console.error(`Error analyzing WASM file: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

function findSharedLiterals(a: any, b: any): any[] {
  const aLiterals = new Set(a.literals.map((l: any) => l.normalizedValue));
  const bLiterals = new Set(b.literals.map((l: any) => l.normalizedValue));
  return Array.from(aLiterals).filter(l => bLiterals.has(l));
}

function findUniqueLiterals(a: any, b: any): any[] {
  const aLiterals = new Set(a.literals.map((l: any) => l.normalizedValue));
  const bLiterals = new Set(b.literals.map((l: any) => l.normalizedValue));
  return Array.from(aLiterals).filter(l => !bLiterals.has(l));
}

function formatOutput(result: any, format: LiteralOutputFormat): string {
  if (format === 'csv') {
    return formatAsCsv(result);
  }
  return JSON.stringify(result, null, 2);
}

function formatAsCsv(result: any): string {
  const headers = [
    'value', 'type', 'signed', 'unsigned', 'hex',
    'bitWidth', 'opcode', 'functionIndex', 'blockIndex',
    'instructionIndex', 'occurrences', 'classification'
  ];

  const rows = result.literals.flatMap((literal: any) =>
    literal.occurrences.map((occurrence: any) => [
      literal.normalizedValue,
      literal.type,
      literal.signedValue,
      literal.unsignedValue,
      literal.hexValue,
      literal.bitWidth,
      occurrence.opcode,
      occurrence.functionIndex ?? '',
      occurrence.blockIndex ?? '',
      occurrence.instructionIndex,
      literal.occurrences.length,
      literal.classification?.join(';') ?? ''
    ])
  );

  return [
    headers.join(','),
    ...rows.map((row: any[]) => row.map(field => `"${String(field).replace(/"/g, '""')}"`).join(','))
  ].join('\n');
}

program.parse(process.argv);