/**
 * 253-wasm-literals
 *
 * Offline Soroban contract WASM literal and magic-number analysis.
 *
 * Extracts statically embedded numeric constants (i32.const, i64.const,
 * f32.const, f64.const), records where they occur, groups repeated values,
 * classifies structural patterns (zero, power-of-two, bit-mask, etc.), and
 * reports aggregate statistics.
 *
 * No WASM code is executed. The analysis is completely offline.
 *
 * Usage (CLI):
 *   stellar-api-inspector wasm-literals <wasmFile> [compareFile] [--json] [--csv]
 *   stellar-api-inspector wasm-literals <wasmFile> [--search <value>] [--search-hex <hex>] [--type <i32|i64|f32|f64>] [--min-occurrences <n>]
 *
 * Usage (programmatic):
 *   import { run } from './253-wasm-literals';
 *   await run({ wasmFile: 'hello.wasm', json: true });
 */

import chalk from 'chalk';

import {
  LiteralStructuralClass,
  LiteralType,
  WasmLiteralOccurrenceSummary,
  WasmLiteralRecord,
  WasmLiteralsAnalysisOptions,
  WasmLiteralsReport,
  analyzeLiterals,
  compareLiteralsReports,
} from '../utils/wasm-static-analysis';

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

const CSV_HEADER =
  'functionIndex,blockIndex,instructionIndex,opcode,literalType,signedValue,unsignedValue,hexValue,structuralClass,contentHash';

function toCsvRow(rec: WasmLiteralRecord): string {
  return [
    rec.functionIndex,
    rec.blockIndex,
    rec.instructionIndex,
    rec.opcode,
    rec.literalType,
    `"${rec.signedValue}"`,
    `"${rec.unsignedValue}"`,
    rec.hexValue,
    rec.structuralClass,
    rec.contentHash,
  ].join(',');
}

export function toCsv(records: WasmLiteralRecord[]): string {
  return [CSV_HEADER, ...records.map(toCsvRow)].join('\n');
}

// ---------------------------------------------------------------------------
// Human-readable printer
// ---------------------------------------------------------------------------

const CLASS_LABELS: Record<LiteralStructuralClass, string> = {
  zero: chalk.dim('zero'),
  one: chalk.dim('one'),
  negative_one: chalk.dim('neg-one'),
  power_of_two: chalk.cyan('pow2'),
  bit_mask: chalk.yellow('bitmask'),
  byte_mask: chalk.yellow('bytemask'),
  alignment_like: chalk.blue('align'),
  small_integer: chalk.dim('small-int'),
  large_integer: chalk.magenta('large-int'),
  unusual_constant: chalk.red('unusual'),
  positive_float: chalk.dim('float+'),
  negative_float: chalk.dim('float-'),
  zero_float: chalk.dim('float-zero'),
  float_edge: chalk.red('float-edge'),
  none: chalk.dim('?'),
};

const TYPE_LABELS: Record<LiteralType, string> = {
  i32: 'i32',
  i64: 'i64',
  f32: 'f32',
  f64: 'f64',
};

function printOccurrenceSummary(s: WasmLiteralOccurrenceSummary, rank: number): void {
  const multiTag = s.usedInMultipleFunctions ? chalk.blue(' [multi-fn]') : '';
  const valueDisplay = s.literalType === 'f32' || s.literalType === 'f64'
    ? s.signedValue
    : `${s.signedValue} (${s.hexValue})`;
  console.log(
    `  ${String(rank).padStart(4)}. ` +
    `[${TYPE_LABELS[s.literalType].padEnd(3)}] ` +
    `${CLASS_LABELS[s.structuralClass].padEnd(12)}  ` +
    `×${String(s.occurrenceCount).padStart(4)}  ` +
    `${chalk.cyan(valueDisplay)}` +
    multiTag,
  );
  if (s.functionIndices.length > 0) {
    console.log(chalk.dim(`         functions: [${s.functionIndices.slice(0, 10).join(', ')}${s.functionIndices.length > 10 ? ', …' : ''}]`));
  }
}

function printReport(report: WasmLiteralsReport): void {
  const s = report.statistics;
  console.log(chalk.bold('\n=== WASM Literal & Magic-Number Analysis ==='));
  console.log(`${chalk.bold('File:')}                          ${report.file}`);
  console.log(`${chalk.bold('Total literal occurrences:')}     ${s.totalLiteralOccurrences}`);
  console.log(`${chalk.bold('Unique literals:')}               ${s.uniqueLiterals}`);
  console.log(`${chalk.bold('  Integer literals:')}            ${s.integerLiterals}`);
  console.log(`${chalk.bold('  Floating-point literals:')}     ${s.floatingPointLiterals}`);
  console.log(`${chalk.bold('Shared across functions:')}       ${s.literalsSharedAcrossFunctions}`);
  console.log(`${chalk.bold('Unusual constants (threshold=')}${s.largeConstantThreshold}): ${s.unusualConstantCount}`);

  if (s.maxObservedInteger !== null) {
    console.log(`${chalk.bold('Max integer observed:')}          ${s.maxObservedInteger}`);
    console.log(`${chalk.bold('Min integer observed:')}          ${s.minObservedInteger}`);
  }

  if (report.occurrenceSummaries.length === 0) {
    console.log(chalk.dim('\nNo numeric literal constants found.'));
    return;
  }

  if (s.mostFrequentLiteral) {
    console.log(chalk.bold('\n--- Most Frequent Literal ---'));
    console.log(
      `  ${chalk.cyan(s.mostFrequentLiteral.signedValue)} (${s.mostFrequentLiteral.literalType})` +
      `  ×${s.mostFrequentLiteral.occurrenceCount}` +
      `  ${CLASS_LABELS[s.mostFrequentLiteral.structuralClass]}`,
    );
  }

  console.log(chalk.bold('\n--- Literal Inventory (sorted by frequency) ---'));
  report.occurrenceSummaries.slice(0, 40).forEach((summary, i) => {
    printOccurrenceSummary(summary, i + 1);
  });
  if (report.occurrenceSummaries.length > 40) {
    console.log(chalk.dim(`  … and ${report.occurrenceSummaries.length - 40} more unique literals`));
  }

  // Structural class summary
  const classCounts: Partial<Record<LiteralStructuralClass, number>> = {};
  for (const s2 of report.occurrenceSummaries) {
    classCounts[s2.structuralClass] = (classCounts[s2.structuralClass] ?? 0) + s2.occurrenceCount;
  }
  const classEntries = Object.entries(classCounts).sort(([, a], [, b]) => (b ?? 0) - (a ?? 0));
  if (classEntries.length > 0) {
    console.log(chalk.bold('\n--- Structural Class Breakdown ---'));
    classEntries.forEach(([cls, count]) => {
      console.log(`  ${(CLASS_LABELS[cls as LiteralStructuralClass] ?? cls).padEnd(20)}: ${count}`);
    });
  }
}

function printComparison(result: ReturnType<typeof compareLiteralsReports>): void {
  const { comparison } = result;
  console.log(chalk.bold('\n--- Literal Comparison ---'));
  console.log(`Total occurrence delta: ${comparison.totalOccurrenceDelta >= 0 ? '+' : ''}${comparison.totalOccurrenceDelta}`);
  console.log(`Unique literals delta:  ${comparison.uniqueLiteralsDelta >= 0 ? '+' : ''}${comparison.uniqueLiteralsDelta}`);
  if (comparison.addedLiterals.length > 0) {
    console.log(chalk.red(`Added literals: +${comparison.addedLiterals.length}`));
    comparison.addedLiterals.slice(0, 10).forEach((l) =>
      console.log(`  + ${l.literalType} ${chalk.cyan(l.signedValue)} (${l.hexValue})`),
    );
  }
  if (comparison.removedLiterals.length > 0) {
    console.log(chalk.green(`Removed literals: -${comparison.removedLiterals.length}`));
    comparison.removedLiterals.slice(0, 10).forEach((l) =>
      console.log(`  - ${l.literalType} ${chalk.cyan(l.signedValue)}`),
    );
  }
  if (comparison.changedOccurrenceCounts.length > 0) {
    console.log(chalk.yellow(`Changed occurrence counts: ${comparison.changedOccurrenceCounts.length}`));
    comparison.changedOccurrenceCounts.slice(0, 5).forEach(({ key, before, after }) => {
      console.log(`  ~ ${key}: ${before} → ${after}`);
    });
  }
  if (comparison.literalsInNewFunctions.length > 0) {
    console.log(chalk.blue(`Literals introduced into new functions: ${comparison.literalsInNewFunctions.length}`));
  }
  const noChanges =
    comparison.addedLiterals.length === 0 &&
    comparison.removedLiterals.length === 0 &&
    comparison.changedOccurrenceCounts.length === 0 &&
    comparison.literalsInNewFunctions.length === 0;
  if (noChanges) console.log(chalk.green('No literal changes detected between artifacts.'));
}

// ---------------------------------------------------------------------------
// Argument parsing helper
// ---------------------------------------------------------------------------

export function parseWasmLiteralsArgs(args: string[]): {
  wasmFile?: string;
  compareFile?: string;
  json: boolean;
  csv: boolean;
  options: WasmLiteralsAnalysisOptions;
} {
  const json = args.includes('--json') || args.includes('--json=true');
  const csv = args.includes('--csv') || args.includes('--csv=true');

  const searchIdx = args.findIndex((a) => a === '--search');
  const searchValue = searchIdx !== -1 ? args[searchIdx + 1] : undefined;

  const searchHexIdx = args.findIndex((a) => a === '--search-hex');
  const searchHex = searchHexIdx !== -1 ? args[searchHexIdx + 1] : undefined;

  const typeIdx = args.findIndex((a) => a === '--type');
  const typeFilter = typeIdx !== -1 ? (args[typeIdx + 1] as LiteralType) : undefined;

  const minOccIdx = args.findIndex((a) => a === '--min-occurrences');
  const minOccurrences = minOccIdx !== -1 ? parseInt(args[minOccIdx + 1] ?? '1', 10) : undefined;

  const thresholdIdx = args.findIndex((a) => a === '--large-threshold');
  const largeConstantThreshold = thresholdIdx !== -1 ? parseInt(args[thresholdIdx + 1] ?? '100000', 10) : undefined;

  const flags = ['--json', '--json=true', '--csv', '--csv=true', '--search', '--search-hex', '--type', '--min-occurrences', '--large-threshold'];
  const files = args.filter((a) => {
    if (flags.includes(a)) return false;
    const prev = args[args.indexOf(a) - 1] ?? '';
    if (['--search', '--search-hex', '--type', '--min-occurrences', '--large-threshold'].includes(prev)) return false;
    return !a.startsWith('--');
  });

  return {
    wasmFile: files[0],
    compareFile: files[1],
    json,
    csv,
    options: {
      searchValue,
      searchHex,
      literalTypeFilter: typeFilter,
      minOccurrences: isNaN(minOccurrences as number) ? undefined : minOccurrences,
      largeConstantThreshold: isNaN(largeConstantThreshold as number) ? undefined : largeConstantThreshold,
    },
  };
}

// ---------------------------------------------------------------------------
// Public run() entry-point
// ---------------------------------------------------------------------------

export async function run(
  params: {
    wasmFile?: string;
    compareFile?: string;
    json?: boolean;
    csv?: boolean;
    searchValue?: string;
    searchHex?: string;
    literalTypeFilter?: LiteralType;
    minOccurrences?: number;
    largeConstantThreshold?: number;
  } = {},
): Promise<void> {
  const wasmFile = params.wasmFile ?? process.env.WASM_FILE;
  if (!wasmFile) {
    throw new Error(
      'Usage: stellar-api-inspector wasm-literals <wasmFile> [compareFile] [--json] [--csv] [--search <value>] [--search-hex <hex>] [--type <i32|i64|f32|f64>]',
    );
  }

  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const csv = params.csv === true || process.env.CSV_OUTPUT === 'true';
  const compareFile = params.compareFile ?? process.env.COMPARE_WASM_FILE;

  const options: WasmLiteralsAnalysisOptions = {
    searchValue: params.searchValue ?? process.env.SEARCH_VALUE,
    searchHex: params.searchHex ?? process.env.SEARCH_HEX,
    literalTypeFilter: params.literalTypeFilter ?? (process.env.LITERAL_TYPE as LiteralType | undefined),
    minOccurrences: params.minOccurrences ?? (process.env.MIN_OCCURRENCES ? parseInt(process.env.MIN_OCCURRENCES, 10) : undefined),
    largeConstantThreshold: params.largeConstantThreshold ?? (process.env.LARGE_THRESHOLD ? parseInt(process.env.LARGE_THRESHOLD, 10) : undefined),
  };

  if (compareFile) {
    const result = compareLiteralsReports(wasmFile, compareFile, options);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printReport(result.before);
      console.log(chalk.bold('\n\n=== Second artifact ==='));
      printReport(result.after);
      printComparison(result);
    }
    return;
  }

  const report = analyzeLiterals(wasmFile, options);

  if (csv) {
    console.log(toCsv(report.records));
    return;
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printReport(report);
}
