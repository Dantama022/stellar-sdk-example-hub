/**
 * 271-wasm-memory-alias
 *
 * Offline Soroban contract WASM memory-alias analysis.
 *
 * Parses WASM function bodies, reconstructs conservatively bounded address
 * expressions for supported loads and stores, and classifies pairs of accesses
 * as must-alias, may-alias, no-alias, or unknown. No WASM code is executed.
 *
 * Usage (CLI):
 *   wasm-memory-alias <wasmFile> [compareFile] [--json] [--csv]
 *     [--function <n>] [--type <load|store>]
 *     [--min-address <n>] [--max-address <n>]
 *     [--alias <must-alias|may-alias|no-alias|unknown>]
 *     [--max-pairs <n>]
 */

import chalk from 'chalk';

import {
  MemoryAliasAnalysisOptions,
  MemoryAliasClassification,
  MemoryAliasPair,
  MemoryAliasReport,
  MemoryAccessType,
  analyzeMemoryAlias,
  compareMemoryAliasReports,
} from '../utils/wasm-memory-alias';

const ALIAS_CLASSIFICATIONS: MemoryAliasClassification[] = [
  'must-alias',
  'may-alias',
  'no-alias',
  'unknown',
];

const CSV_HEADER = [
  'functionA',
  'blockA',
  'instructionA',
  'accessTypeA',
  'functionB',
  'blockB',
  'instructionB',
  'accessTypeB',
  'memoryIndex',
  'alias',
  'relationship',
  'sameBlock',
  'sameFunction',
  'overlappingBytes',
  'potentialConflict',
  'addressA',
  'addressB',
  'widthA',
  'widthB',
].join(',');

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(pair: MemoryAliasPair): string {
  return [
    pair.accessA.functionIndex,
    pair.accessA.blockIndex,
    pair.accessA.instructionIndex,
    pair.accessA.accessType,
    pair.accessB.functionIndex,
    pair.accessB.blockIndex,
    pair.accessB.instructionIndex,
    pair.accessB.accessType,
    pair.accessA.memoryIndex,
    pair.alias,
    pair.relationship,
    pair.sameBlock,
    pair.sameFunction,
    pair.overlappingBytes,
    pair.potentialConflict,
    pair.accessA.address.expression,
    pair.accessB.address.expression,
    pair.accessA.width,
    pair.accessB.width,
  ]
    .map((value) => csvEscape(String(value)))
    .join(',');
}

export function toCsv(pairs: MemoryAliasPair[]): string {
  return [CSV_HEADER, ...pairs.map(toCsvRow)].join('\n');
}

export function compareMemoryAliasFiles(
  beforeFile: string,
  afterFile: string,
  options: MemoryAliasAnalysisOptions = {},
) {
  return compareMemoryAliasReports(beforeFile, afterFile, options);
}

function printPair(pair: MemoryAliasPair): void {
  const a = pair.accessA;
  const b = pair.accessB;
  const conflict = pair.potentialConflict ? chalk.yellow(' [conflict]') : '';
  console.log(
    `  ${pair.alias.padEnd(11)} ${pair.relationship.padEnd(10)} ` +
      `fn[${a.functionIndex}] ${a.opcode}@${a.address.expression} ` +
      `<-> fn[${b.functionIndex}] ${b.opcode}@${b.address.expression}` +
      `${conflict}`,
  );
  console.log(chalk.dim(`    ${pair.reason}`));
}

function printReport(report: MemoryAliasReport): void {
  const s = report.statistics;
  console.log(chalk.bold('\n=== WASM Memory Alias Analysis ==='));
  console.log(`${chalk.bold('File:')} ${report.file}`);
  console.log(`${chalk.bold('Memory accesses:')} ${s.totalMemoryAccesses}`);
  console.log(`${chalk.bold('Access pairs compared:')} ${s.totalAccessPairsCompared}`);
  console.log(`  ${chalk.bold('Must-alias:')}  ${s.mustAliasPairs}`);
  console.log(`  ${chalk.bold('May-alias:')}   ${s.mayAliasPairs}`);
  console.log(`  ${chalk.bold('No-alias:')}    ${s.noAliasPairs}`);
  console.log(`  ${chalk.bold('Unknown:')}     ${s.unknownRelationships}`);
  console.log(`${chalk.bold('Potential read/write conflicts:')} ${s.potentialReadWriteConflicts}`);
  console.log(`${chalk.bold('Max alias density:')} ${(s.maxAliasDensity * 100).toFixed(1)}%`);
  if (s.pairComparisonsTruncated) {
    console.log(
      chalk.yellow(
        `Pair comparison truncated at the configured limit of ${s.pairComparisonLimit}.`,
      ),
    );
  }

  console.log(chalk.bold('\n--- Address Information ---'));
  console.log(`  exact:    ${s.addressClassCounts.exact}`);
  console.log(`  range:    ${s.addressClassCounts.range}`);
  console.log(`  symbolic: ${s.addressClassCounts.symbolic}`);
  console.log(`  unknown:  ${s.addressClassCounts.unknown}`);
  console.log(`  loads:    ${s.accessTypeCounts.load}`);
  console.log(`  stores:   ${s.accessTypeCounts.store}`);

  if (s.functionsWithLargestAliasingAccessSets.length > 0) {
    console.log(chalk.bold('\n--- Functions With Largest Aliasing Access Sets ---'));
    for (const summary of s.functionsWithLargestAliasingAccessSets) {
      console.log(
        `  fn[${summary.functionIndex}] aliasingAccesses=${summary.aliasingAccesses} ` +
          `aliasPairs=${summary.aliasPairs} density=${(summary.aliasDensity * 100).toFixed(1)}%`,
      );
    }
  }

  if (report.pairs.length > 0) {
    console.log(chalk.bold('\n--- Alias Relationships (first 20) ---'));
    report.pairs.slice(0, 20).forEach(printPair);
    if (report.pairs.length > 20) {
      console.log(chalk.dim(`  ... ${report.pairs.length - 20} more pairs`));
    }
  } else {
    console.log(chalk.dim('\nNo alias relationships matched the current filters.'));
  }

  if (report.warnings.length > 0) {
    console.log(chalk.yellow('\n--- Warnings ---'));
    for (const warning of report.warnings) console.log(`  ${warning}`);
  }
}

function printComparison(result: ReturnType<typeof compareMemoryAliasReports>): void {
  printReport(result.before);
  printReport(result.after);
  const c = result.comparison;
  console.log(chalk.bold('\n--- Artifact Comparison ---'));
  console.log(`  Total pair delta        : ${c.totalPairDelta >= 0 ? '+' : ''}${c.totalPairDelta}`);
  console.log(
    `  Conflict delta          : ${c.potentialConflictDelta >= 0 ? '+' : ''}${c.potentialConflictDelta}`,
  );
  console.log(`  Added relationships     : ${c.addedAliasRelationships.length}`);
  console.log(`  Removed relationships   : ${c.removedAliasRelationships.length}`);
  console.log(`  Changed classifications : ${c.changedAliasClassifications.length}`);
  console.log(`  New conflicts           : ${c.newlyIntroducedConflicts.length}`);

  if (c.changedAliasClassifications.length > 0) {
    console.log(chalk.yellow('\n  Changed alias classifications:'));
    for (const change of c.changedAliasClassifications.slice(0, 20)) {
      console.log(
        `    ${change.before.alias} -> ${change.after.alias}: ` +
          `fn[${change.after.accessA.functionIndex}] ${change.after.accessA.opcode} <-> ` +
          `fn[${change.after.accessB.functionIndex}] ${change.after.accessB.opcode}`,
      );
    }
  }

  if (c.newlyIntroducedConflicts.length > 0) {
    console.log(chalk.yellow('\n  Newly introduced potential conflicts:'));
    for (const pair of c.newlyIntroducedConflicts.slice(0, 20)) printPair(pair);
  }
}

function numericOption(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a non-negative number`);
  }
  return parsed;
}

export function parseMemoryAliasArgs(args: string[]): {
  wasmFile?: string;
  compareFile?: string;
  json: boolean;
  csv: boolean;
  options: MemoryAliasAnalysisOptions;
} {
  const json = args.includes('--json') || args.includes('--json=true');
  const csv = args.includes('--csv') || args.includes('--csv=true');
  const options: MemoryAliasAnalysisOptions = {};
  const files: string[] = [];
  let compareFile: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json' || arg === '--json=true' || arg === '--csv' || arg === '--csv=true') {
      continue;
    }
    if (arg === '--compare' || arg.startsWith('--compare=')) {
      const inline = arg.startsWith('--compare=') ? arg.slice('--compare='.length) : undefined;
      const value = inline ?? args[++i];
      if (!value || value.startsWith('-')) throw new Error('--compare requires a WASM file');
      compareFile = value;
      continue;
    }

    const [flag, inlineValue] = arg.split('=', 2);
    if (flag === '--function') {
      const value = inlineValue ?? args[++i];
      if (value === undefined) throw new Error('--function requires a function index');
      options.functionIndex = numericOption(value, '--function');
    } else if (flag === '--type') {
      const value = inlineValue ?? args[++i];
      if (value !== 'load' && value !== 'store') {
        throw new Error('--type must be either "load" or "store"');
      }
      options.accessType = value as MemoryAccessType;
    } else if (flag === '--min-address') {
      const value = inlineValue ?? args[++i];
      if (value === undefined) throw new Error('--min-address requires a number');
      options.minAddress = numericOption(value, '--min-address');
    } else if (flag === '--max-address') {
      const value = inlineValue ?? args[++i];
      if (value === undefined) throw new Error('--max-address requires a number');
      options.maxAddress = numericOption(value, '--max-address');
    } else if (flag === '--alias') {
      const value = inlineValue ?? args[++i];
      if (!ALIAS_CLASSIFICATIONS.includes(value as MemoryAliasClassification)) {
        throw new Error(`--alias must be one of: ${ALIAS_CLASSIFICATIONS.join(', ')}`);
      }
      options.aliasClassification = value as MemoryAliasClassification;
    } else if (flag === '--max-pairs') {
      const value = inlineValue ?? args[++i];
      if (value === undefined) throw new Error('--max-pairs requires a number');
      const parsed = numericOption(value, '--max-pairs');
      if (parsed === 0) throw new Error('--max-pairs must be greater than zero');
      options.maxPairComparisons = parsed;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown wasm-memory-alias option: ${arg}`);
    } else {
      files.push(arg);
    }
  }

  if (files.length > 2) {
    throw new Error('Usage: wasm-memory-alias <wasmFile> [compareFile] [--json] [--csv] [filters]');
  }

  return {
    wasmFile: files[0],
    compareFile: compareFile ?? files[1],
    json,
    csv,
    options,
  };
}

export async function run(
  params: {
    wasmFile?: string;
    compareFile?: string;
    json?: boolean;
    csv?: boolean;
    options?: MemoryAliasAnalysisOptions;
  } = {},
): Promise<void> {
  if (!params.wasmFile) {
    throw new Error('Usage: wasm-memory-alias <wasmFile> [compareFile] [--json] [--csv] [filters]');
  }

  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const csv = params.csv === true || process.env.CSV_OUTPUT === 'true';
  const options = params.options ?? {};

  if (params.compareFile) {
    const result = compareMemoryAliasFiles(params.wasmFile, params.compareFile, options);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printComparison(result);
    }
    return;
  }

  const report = analyzeMemoryAlias(params.wasmFile, options);

  if (csv) {
    console.log(toCsv(report.pairs));
    return;
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printReport(report);
}
