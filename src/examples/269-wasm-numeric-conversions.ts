/**
 * 269-wasm-numeric-conversions
 *
 * Offline Soroban contract WASM numeric conversion analysis.
 *
 * Parses WASM function bodies and inventories instructions that convert values
 * between integer widths, floating-point precisions, signed/unsigned
 * representations, and bit patterns. The analysis is structural only: no WASM
 * code is instantiated or executed, and no runtime value is claimed as known.
 *
 * Usage (CLI):
 *   wasm-numeric-conversions <wasmFile> [compareFile] [--json] [--csv]
 *
 * Usage (programmatic):
 *   import { run } from './269-wasm-numeric-conversions';
 *   await run({ wasmFile: 'hello.wasm', json: true });
 */

import chalk from 'chalk';

import {
  NUMERIC_CONVERSION_CATEGORIES,
  NumericConversionChain,
  NumericConversionCategory,
  NumericConversionRecord,
  WasmNumericConversionsReport,
  analyzeNumericConversions,
  compareNumericConversionsReports,
} from '../utils/wasm-static-analysis';

const CSV_HEADER = [
  'functionIndex',
  'blockIndex',
  'instructionIndex',
  'instructionOffset',
  'opcode',
  'sourceType',
  'destinationType',
  'category',
  'sourceSignedness',
  'destinationSignedness',
  'widening',
  'narrowing',
  'mayDiscardHighOrderBits',
  'mayLosePrecision',
  'trapping',
  'saturating',
  'diagnostics',
].join(',');

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(record: NumericConversionRecord): string {
  return [
    record.functionIndex,
    record.blockIndex,
    record.instructionIndex,
    record.instructionOffset,
    record.opcode,
    record.sourceType,
    record.destinationType,
    record.category,
    record.sourceSignedness,
    record.destinationSignedness,
    record.widening,
    record.narrowing,
    record.mayDiscardHighOrderBits,
    record.mayLosePrecision,
    record.trapping,
    record.saturating,
    record.diagnostics.join('|'),
  ]
    .map((value) => csvEscape(String(value)))
    .join(',');
}

export function toCsv(records: NumericConversionRecord[]): string {
  return [CSV_HEADER, ...records.map(toCsvRow)].join('\n');
}

export function compareNumericConversionsFiles(beforeFile: string, afterFile: string) {
  return compareNumericConversionsReports(beforeFile, afterFile);
}

function printChain(chain: NumericConversionChain): void {
  const pattern = chain.patterns.length > 0 ? chain.patterns.join(', ') : 'conversion run';
  const flags = [
    chain.suspicious ? 'suspicious' : null,
    chain.redundant ? 'redundant' : null,
    chain.precisionLoss ? 'precision-loss' : null,
  ]
    .filter((value): value is string => value !== null)
    .join(', ');
  console.log(
    `  fn[${chain.functionIndex}] insn ${chain.startInstructionIndex}-${chain.endInstructionIndex}: ` +
      `${chain.opcodes.join(' -> ')} (${pattern}${flags ? `; ${flags}` : ''})`,
  );
  for (const reason of chain.reasons) {
    console.log(chalk.dim(`    - ${reason}`));
  }
}

function printReport(report: WasmNumericConversionsReport): void {
  const s = report.statistics;
  console.log(chalk.bold('\n=== WASM Numeric Conversion Analysis ==='));
  console.log(`${chalk.bold('File:')} ${report.file}`);
  console.log(`${chalk.bold('Total numeric conversions:')} ${s.totalNumericConversions}`);
  console.log(`  ${chalk.bold('Narrowing:')}                 ${s.narrowingConversions}`);
  console.log(`  ${chalk.bold('Widening:')}                  ${s.wideningConversions}`);
  console.log(
    `  ${chalk.bold('Potential precision loss:')}  ${s.potentialPrecisionLossConversions}`,
  );
  console.log(`  ${chalk.bold('High-order bit discard:')}    ${s.highOrderBitDiscardConversions}`);
  console.log(`  ${chalk.bold('Signedness-sensitive:')}      ${s.signednessSensitiveConversions}`);
  console.log(`  ${chalk.bold('Trapping:')}                  ${s.trappingConversions}`);
  console.log(`  ${chalk.bold('Saturating:')}                ${s.saturatingConversions}`);
  console.log(`${chalk.bold('Conversion chains:')} ${s.conversionChainCount}`);
  console.log(`  ${chalk.bold('Suspicious chains:')} ${s.suspiciousChainCount}`);
  console.log(`  ${chalk.bold('Redundant chains:')}  ${s.redundantChainCount}`);
  console.log(`${chalk.bold('Functions with conversions:')} ${s.functionsWithConversions}`);

  if (s.totalNumericConversions === 0) {
    console.log(chalk.dim('\nNo numeric conversion instructions found.'));
    return;
  }

  console.log(chalk.bold('\n--- Conversions by Category ---'));
  viaCategory(s);

  if (s.highestConversionDensityFunctions.length > 0) {
    console.log(chalk.bold('\n--- Highest Conversion Density ---'));
    for (const entry of s.highestConversionDensityFunctions) {
      console.log(
        `  Function ${entry.functionIndex}: ${(entry.conversionDensity * 100).toFixed(1)}% ` +
          `(${entry.totalConversions} conversions)`,
      );
    }
  }

  if (report.chains.length > 0) {
    console.log(chalk.bold('\n--- Conversion Chains ---'));
    for (const chain of report.chains) printChain(chain);
  }

  console.log(chalk.bold('\n--- Per-Function Summary (conversions > 0) ---'));
  report.functions
    .filter((summary) => summary.totalConversions > 0)
    .sort((a, b) => b.totalConversions - a.totalConversions || a.functionIndex - b.functionIndex)
    .forEach((summary) => {
      console.log(
        `  [${summary.functionIndex}] conversions=${summary.totalConversions} ` +
          `density=${(summary.conversionDensity * 100).toFixed(1)}% ` +
          `narrowing=${summary.narrowingConversions} ` +
          `widening=${summary.wideningConversions} ` +
          `precisionLoss=${summary.precisionLossConversions} ` +
          `chains=${summary.chainCount}`,
      );
    });

  if (report.warnings.length > 0) {
    console.log(chalk.yellow('\n--- Warnings ---'));
    for (const warning of report.warnings) console.log(`  ${warning}`);
  }
}

function viaCategory(s: WasmNumericConversionsReport['statistics']): void {
  const labels: Record<NumericConversionCategory, string> = {
    'integer-extension': 'Integer extension',
    'integer-truncation': 'Integer truncation',
    'sign-extension': 'Sign extension',
    'int-to-float': 'Integer to float',
    'float-to-int': 'Float to integer',
    'float-widening': 'Float widening',
    'float-narrowing': 'Float narrowing',
    reinterpretation: 'Reinterpretation',
    'saturating-conversion': 'Saturating conversion',
  };
  for (const category of NUMERIC_CONVERSION_CATEGORIES) {
    const count = s.conversionsByCategory[category];
    if (count > 0) {
      console.log(`  ${labels[category].padEnd(24)}: ${count}`);
    }
  }
}

function printComparison(result: ReturnType<typeof compareNumericConversionsReports>): void {
  printReport(result.before);
  printReport(result.after);

  const c = result.comparison;
  console.log(chalk.bold('\n--- Artifact Comparison ---'));
  console.log(`  Total conversion delta : ${formatDelta(c.totalConversionDelta)}`);
  console.log(`  Narrowing delta        : ${formatDelta(c.narrowingDelta)}`);
  console.log(`  Precision-loss delta   : ${formatDelta(c.precisionLossDelta)}`);
  console.log(`  Added conversions      : ${c.addedConversions.length}`);
  console.log(`  Removed conversions    : ${c.removedConversions.length}`);
  console.log(`  Changed conversions    : ${c.changedConversions.length}`);

  if (c.addedConversions.length > 0) {
    console.log(chalk.yellow('\n  Added conversions:'));
    for (const record of c.addedConversions) {
      console.log(
        `    fn[${record.functionIndex}] insn ${record.instructionIndex}: ${record.opcode}`,
      );
    }
  }

  if (c.removedConversions.length > 0) {
    console.log(chalk.yellow('\n  Removed conversions:'));
    for (const record of c.removedConversions) {
      console.log(
        `    fn[${record.functionIndex}] insn ${record.instructionIndex}: ${record.opcode}`,
      );
    }
  }

  if (c.changedConversions.length > 0) {
    console.log(chalk.yellow('\n  Changed conversions:'));
    for (const change of c.changedConversions) {
      console.log(
        `    fn[${change.functionIndex}] insn ${change.instructionIndex}: ` +
          `${change.before.opcode} -> ${change.after.opcode} ` +
          `(${change.changes.join(', ')})`,
      );
    }
  }

  if (c.newlyIntroducedNarrowing.length > 0) {
    console.log(chalk.yellow('\n  Newly introduced narrowing conversions:'));
    for (const record of c.newlyIntroducedNarrowing) {
      console.log(
        `    fn[${record.functionIndex}] insn ${record.instructionIndex}: ${record.opcode}`,
      );
    }
  }

  if (c.newlyIntroducedPrecisionLoss.length > 0) {
    console.log(chalk.yellow('\n  Newly introduced precision-loss conversions:'));
    for (const record of c.newlyIntroducedPrecisionLoss) {
      console.log(
        `    fn[${record.functionIndex}] insn ${record.instructionIndex}: ${record.opcode}`,
      );
    }
  }

  if (c.newSuspiciousChains.length > 0) {
    console.log(chalk.yellow('\n  Newly introduced suspicious conversion chains:'));
    for (const chain of c.newSuspiciousChains) {
      console.log(
        `    fn[${chain.functionIndex}] insn ${chain.startInstructionIndex}-${chain.endInstructionIndex}: ` +
          chain.opcodes.join(' -> '),
      );
    }
  }

  if (
    c.addedConversions.length === 0 &&
    c.removedConversions.length === 0 &&
    c.changedConversions.length === 0 &&
    c.newSuspiciousChains.length === 0
  ) {
    console.log(chalk.dim('\n  No meaningful numeric conversion changes detected.'));
  }
}

function formatDelta(value: number): string {
  return `${value >= 0 ? '+' : ''}${value}`;
}

export function parseNumericConversionArgs(args: string[]): {
  wasmFile?: string;
  compareFile?: string;
  json: boolean;
  csv: boolean;
} {
  const json = args.includes('--json') || args.includes('--json=true');
  const csv = args.includes('--csv') || args.includes('--csv=true');
  const files = args.filter(
    (arg) => arg !== '--json' && arg !== '--json=true' && arg !== '--csv' && arg !== '--csv=true',
  );
  if (files.length > 2) {
    throw new Error('Usage: wasm-numeric-conversions <wasmFile> [compareFile] [--json] [--csv]');
  }
  return { wasmFile: files[0], compareFile: files[1], json, csv };
}

export async function run(
  params: {
    wasmFile?: string;
    compareFile?: string;
    json?: boolean;
    csv?: boolean;
  } = {},
): Promise<void> {
  if (!params.wasmFile) {
    throw new Error('Usage: wasm-numeric-conversions <wasmFile> [compareFile] [--json] [--csv]');
  }

  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const csv = params.csv === true || process.env.CSV_OUTPUT === 'true';

  if (params.compareFile) {
    const result = compareNumericConversionsFiles(params.wasmFile, params.compareFile);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printComparison(result);
    }
    return;
  }

  const report = analyzeNumericConversions(params.wasmFile);

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
