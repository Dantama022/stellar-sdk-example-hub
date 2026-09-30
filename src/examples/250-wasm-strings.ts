/**
 * 250-wasm-strings
 *
 * Offline Soroban contract WASM embedded-string analysis.
 *
 * Extracts likely strings from data segments and custom sections of a WASM
 * artifact, classifies them, groups repeated occurrences, and reports
 * per-source and aggregate statistics.
 *
 * No WASM code is executed. The analysis is completely offline.
 *
 * Usage (CLI):
 *   stellar-api-inspector wasm-strings <wasmFile> [compareFile] [--json] [--csv]
 *   stellar-api-inspector wasm-strings <wasmFile> [--min-length <n>] [--search <pattern>] [--json]
 *
 * Usage (programmatic):
 *   import { run } from './250-wasm-strings';
 *   await run({ wasmFile: 'hello.wasm', json: true });
 */

import chalk from 'chalk';

import {
  StringCategory,
  StringEncoding,
  StringSourceSection,
  WasmStringAnalysisOptions,
  WasmStringRecord,
  WasmStringReport,
  analyzeStrings,
  compareStringReports,
} from '../utils/wasm-static-analysis';

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

const CSV_HEADER = 'sourceSection,segmentIndex,sectionName,byteOffset,encoding,category,occurrenceCount,byteLength,contentHash,value';

function toCsvRow(rec: WasmStringRecord): string {
  const escapedValue = `"${rec.value.replace(/"/g, '""')}"`;
  return [
    rec.sourceSection,
    rec.segmentIndex ?? '',
    rec.sectionName ?? '',
    rec.byteOffset,
    rec.encoding,
    rec.category,
    rec.occurrenceCount,
    rec.byteLength,
    rec.contentHash,
    escapedValue,
  ].join(',');
}

export function toCsv(records: WasmStringRecord[]): string {
  return [CSV_HEADER, ...records.map(toCsvRow)].join('\n');
}

// ---------------------------------------------------------------------------
// Human-readable printer
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<StringCategory, string> = {
  error_message: 'Error/Message',
  url_like: 'URL-like',
  identifier_like: 'Identifier-like',
  numeric_string: 'Numeric string',
  path_like: 'Path-like',
  uncategorized: 'Uncategorized',
};

const ENCODING_LABELS: Record<StringEncoding, string> = {
  ascii: 'ASCII',
  utf8: 'UTF-8',
};

const SOURCE_LABELS: Record<StringSourceSection, string> = {
  data_segment: 'Data segment',
  custom_section: 'Custom section',
};

function printReport(report: WasmStringReport): void {
  const s = report.statistics;
  console.log(chalk.bold('\n=== WASM Embedded String Analysis ==='));
  console.log(`${chalk.bold('File:')}                   ${report.file}`);
  console.log(`${chalk.bold('Total string occurrences:')} ${s.totalDetectedStrings}`);
  console.log(`${chalk.bold('Unique strings:')}          ${s.uniqueStrings}`);
  console.log(`${chalk.bold('Total string bytes:')}      ${s.totalStringBytes}`);
  console.log(`${chalk.bold('Average string length:')}   ${s.averageStringLength.toFixed(1)}`);
  console.log(`${chalk.bold('Maximum string length:')}   ${s.maximumStringLength}`);
  console.log(`${chalk.bold('Printable data %:')}        ${s.printableDataPercentage.toFixed(1)}%`);

  if (report.strings.length === 0) {
    console.log(chalk.dim('\nNo strings detected above minimum length threshold.'));
    return;
  }

  // Group by source
  const bySource = new Map<StringSourceSection, WasmStringRecord[]>();
  for (const rec of report.strings) {
    const existing = bySource.get(rec.sourceSection) ?? [];
    existing.push(rec);
    bySource.set(rec.sourceSection, existing);
  }

  for (const [source, recs] of bySource) {
    console.log(chalk.bold(`\n--- ${SOURCE_LABELS[source]} (${recs.length} unique) ---`));
    recs.slice(0, 30).forEach((rec) => {
      const truncated = rec.value.length > 60 ? rec.value.slice(0, 57) + '...' : rec.value;
      const repeated = rec.occurrenceCount > 1 ? chalk.yellow(` ×${rec.occurrenceCount}`) : '';
      const location = rec.segmentIndex !== null
        ? `seg[${rec.segmentIndex}]+${rec.byteOffset}`
        : `${rec.sectionName ?? '?'}+${rec.byteOffset}`;
      console.log(
        `  [${ENCODING_LABELS[rec.encoding].padEnd(5)}] [${CATEGORY_LABELS[rec.category].padEnd(17)}] ` +
        `@${location}  ${chalk.cyan(truncated)}${repeated}`,
      );
    });
    if (recs.length > 30) {
      console.log(chalk.dim(`  … and ${recs.length - 30} more`));
    }
  }

  if (s.mostFrequentStrings.length > 0) {
    console.log(chalk.bold('\n--- Most Frequently Repeated Strings ---'));
    s.mostFrequentStrings.slice(0, 5).forEach(({ value, count }) => {
      if (count > 1) {
        const truncated = value.length > 50 ? value.slice(0, 47) + '...' : value;
        console.log(`  ×${count}  ${chalk.cyan(truncated)}`);
      }
    });
  }
}

function printComparison(result: ReturnType<typeof compareStringReports>): void {
  const { comparison } = result;
  console.log(chalk.bold('\n--- String Comparison ---'));
  if (comparison.addedStrings.length > 0) {
    console.log(chalk.red(`Added strings: +${comparison.addedStrings.length}`));
    comparison.addedStrings.slice(0, 10).forEach((s) => {
      const t = s.value.length > 50 ? s.value.slice(0, 47) + '...' : s.value;
      console.log(`  + ${chalk.cyan(t)}`);
    });
  }
  if (comparison.removedStrings.length > 0) {
    console.log(chalk.green(`Removed strings: -${comparison.removedStrings.length}`));
    comparison.removedStrings.slice(0, 10).forEach((s) => {
      const t = s.value.length > 50 ? s.value.slice(0, 47) + '...' : s.value;
      console.log(`  - ${chalk.cyan(t)}`);
    });
  }
  if (comparison.changedOccurrenceCounts.length > 0) {
    console.log(chalk.yellow(`Changed occurrence counts: ${comparison.changedOccurrenceCounts.length}`));
    comparison.changedOccurrenceCounts.slice(0, 5).forEach(({ value, before, after }) => {
      const t = value.length > 40 ? value.slice(0, 37) + '...' : value;
      console.log(`  ~ ${chalk.cyan(t)}: ${before} → ${after}`);
    });
  }
  if (comparison.addedStrings.length === 0 && comparison.removedStrings.length === 0 && comparison.changedOccurrenceCounts.length === 0) {
    console.log(chalk.green('No string changes detected between artifacts.'));
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export function parseWasmStringsArgs(args: string[]): {
  wasmFile?: string;
  compareFile?: string;
  json: boolean;
  csv: boolean;
  options: WasmStringAnalysisOptions;
} {
  const json = args.includes('--json') || args.includes('--json=true');
  const csv = args.includes('--csv') || args.includes('--csv=true');

  const minLengthIdx = args.findIndex((a) => a === '--min-length');
  const minLength = minLengthIdx !== -1 ? parseInt(args[minLengthIdx + 1] ?? '4', 10) : undefined;

  const maxLengthIdx = args.findIndex((a) => a === '--max-length');
  const maxLength = maxLengthIdx !== -1 ? parseInt(args[maxLengthIdx + 1] ?? '', 10) : undefined;

  const searchIdx = args.findIndex((a) => a === '--search');
  const searchPattern = searchIdx !== -1 ? args[searchIdx + 1] : undefined;

  const flags = ['--json', '--json=true', '--csv', '--csv=true', '--min-length', '--max-length', '--search', '--case-insensitive'];
  const caseInsensitive = args.includes('--case-insensitive');

  const files = args.filter((a) => {
    if (flags.includes(a)) return false;
    const prev = args[args.indexOf(a) - 1] ?? '';
    if (prev === '--min-length' || prev === '--max-length' || prev === '--search') return false;
    return !a.startsWith('--');
  });

  return {
    wasmFile: files[0],
    compareFile: files[1],
    json,
    csv,
    options: {
      minLength: isNaN(minLength as number) ? undefined : minLength,
      maxLength: isNaN(maxLength as number) ? undefined : maxLength,
      searchPattern,
      caseInsensitive,
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
    minLength?: number;
    maxLength?: number;
    searchPattern?: string;
    caseInsensitive?: boolean;
  } = {},
): Promise<void> {
  const wasmFile = params.wasmFile ?? process.env.WASM_FILE;
  if (!wasmFile) {
    throw new Error(
      'Usage: stellar-api-inspector wasm-strings <wasmFile> [compareFile] [--json] [--csv] [--min-length <n>] [--search <pattern>]',
    );
  }

  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const csv = params.csv === true || process.env.CSV_OUTPUT === 'true';
  const compareFile = params.compareFile ?? process.env.COMPARE_WASM_FILE;

  const options: WasmStringAnalysisOptions = {
    minLength: params.minLength ?? (process.env.MIN_LENGTH ? parseInt(process.env.MIN_LENGTH, 10) : undefined),
    maxLength: params.maxLength ?? (process.env.MAX_LENGTH ? parseInt(process.env.MAX_LENGTH, 10) : undefined),
    searchPattern: params.searchPattern ?? process.env.SEARCH_PATTERN,
    caseInsensitive: params.caseInsensitive ?? process.env.CASE_INSENSITIVE === 'true',
  };

  if (compareFile) {
    const result = compareStringReports(wasmFile, compareFile, options);
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

  const report = analyzeStrings(wasmFile, options);

  if (csv) {
    console.log(toCsv(report.strings));
    return;
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printReport(report);
}
