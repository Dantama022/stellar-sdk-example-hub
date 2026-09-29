#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { analyzeWasm } from './analyzer';
import { AnalysisResult, CLIOptions } from './types';
import * as fs from 'fs';
import * as path from 'path';

function formatJson(result: AnalysisResult): string {
  return JSON.stringify(result, null, 2);
}

function formatCsv(result: AnalysisResult): string {
  const headers = ['Function', 'Classification', 'Memory Writes', 'Memory Reads', 
                  'Mutable Global Writes', 'Mutable Global Reads', 'Table Mutations',
                  'Imported Calls', 'Indirect Calls', 'Trapping Ops', 'Transitive Effects'];
  
  const rows = result.functions.map(f => [
    f.name,
    f.classification,
    f.evidence.memoryWrites.toString(),
    f.evidence.memoryReads.toString(),
    f.evidence.mutableGlobalWrites.join(';'),
    f.evidence.mutableGlobalReads.join(';'),
    f.evidence.tableMutations.toString(),
    f.evidence.importedCalls.join(';'),
    f.evidence.indirectCalls.toString(),
    f.evidence.trappingOps.toString(),
    f.evidence.transitiveEffects.join(';')
  ]);

  return [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
}

function formatDot(result: AnalysisResult): string {
  const lines: string[] = [
    'digraph FunctionSideEffects {',
    '  rankdir=LR;',
    '  node [shape=box];',
    ''
  ];

  // Add nodes with colors based on classification
  const colorMap: Record<string, string> = {
    'pure': 'lightgreen',
    'read-only': 'lightblue',
    'state-mutating': 'pink',
    'externally-dependent': 'gold',
    'effectful': 'orange',
    'unknown': 'gray'
  };

  for (const func of result.functions) {
    const color = colorMap[func.classification] || 'white';
    lines.push(`  "${func.name}" [fillcolor=${color}, style=filled, label="${func.name}\\n${func.classification}"];`);
  }

  lines.push('');

  // Add edges for calls
  for (const func of result.functions) {
    for (const callee of func.callees) {
      if (callee !== '__indirect__') {
        lines.push(`  "${func.name}" -> "${callee}";`);
      }
    }
  }

  lines.push('}');
  return lines.join('\n');
}

async function run(argv: CLIOptions): Promise<void> {
  try {
    const result = await analyzeWasm(argv.wasmFile);

    let output: string;
    switch (argv.format) {
      case 'json':
        output = formatJson(result);
        break;
      case 'csv':
        output = formatCsv(result);
        break;
      case 'dot':
        output = formatDot(result);
        break;
      default:
        output = formatJson(result);
    }

    if (argv.output) {
      await fs.promises.writeFile(argv.output, output);
      console.log(`Results written to ${argv.output}`);
    } else {
      console.log(output);
    }

    if (argv.verbose) {
      console.log('\nSummary:');
      console.log(`Total functions: ${result.summary.total}`);
      console.log(`Pure: ${result.summary.pure}`);
      console.log(`Read-only: ${result.summary.readOnly}`);
      console.log(`State-mutating: ${result.summary.stateMutating}`);
      console.log(`Externally dependent: ${result.summary.externallyDependent}`);
      console.log(`Effectful: ${result.summary.effectful}`);
      console.log(`Unknown: ${result.summary.unknown}`);
      console.log(`Transitive effectful: ${result.summary.transitiveEffectful}`);
    }
  } catch (error) {
    console.error('Error analyzing WASM file:', error);
    process.exit(1);
  }
}

const argv = yargs(hideBin(process.argv))
  .usage('Usage: wasm-side-effects <wasmFile> [options]')
  .positional('wasmFile', {
    describe: 'Path to the WASM file to analyze',
    type: 'string',
    demandOption: true
  })
  .option('output', {
    alias: 'o',
    describe: 'Output file path',
    type: 'string'
  })
  .option('format', {
    alias: 'f',
    describe: 'Output format',
    choices: ['json', 'csv', 'dot'],
    default: 'json'
  })
  .option('verbose', {
    alias: 'v',
    describe: 'Show verbose output',
    type: 'boolean',
    default: false
  })
  .argv as CLIOptions;

run(argv);
