/**
 * 273-wasm-unreachable
 *
 * Offline Soroban contract WASM unreachable-path analysis.
 *
 * Reconstructs structured control-flow graphs for every function, computes
 * reachability from each function entry, and reports unreachable blocks,
 * instructions, ranges, and termination reasons. No WASM code is executed.
 *
 * Usage (CLI):
 *   wasm-unreachable <wasmFile> [compareFile] [--json] [--csv]
 */

import chalk from 'chalk';

import {
  UnreachableRangeRecord,
  UnreachableReason,
  WasmUnreachableReport,
  analyzeWasmUnreachable,
  compareUnreachableReports,
} from '../utils/wasm-unreachable';

const CSV_HEADER = [
  'functionIndex',
  'blockIndex',
  'startInstructionIndex',
  'endInstructionIndex',
  'startOffset',
  'endOffset',
  'instructionCount',
  'reason',
].join(',');

const REASON_LABELS: Record<UnreachableReason, string> = {
  'unconditional-branch': 'unconditional branch',
  return: 'return',
  'unreachable-trap': 'unreachable/trap',
  'structured-termination': 'structured termination',
  other: 'other',
  none: 'none',
};

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(range: UnreachableRangeRecord): string {
  return [
    range.functionIndex,
    range.blockIndex,
    range.startInstructionIndex,
    range.endInstructionIndex,
    range.startOffset,
    range.endOffset,
    range.instructionCount,
    range.reason,
  ]
    .map((value) => csvEscape(String(value)))
    .join(',');
}

export function toCsv(ranges: UnreachableRangeRecord[]): string {
  return [CSV_HEADER, ...ranges.map(toCsvRow)].join('\n');
}

export function compareUnreachableFiles(beforeFile: string, afterFile: string) {
  return compareUnreachableReports(beforeFile, afterFile);
}

function printReport(report: WasmUnreachableReport): void {
  const s = report.statistics;
  console.log(chalk.bold('\n=== WASM Unreachable Path Analysis ==='));
  console.log(`${chalk.bold('File:')} ${report.file}`);
  console.log(`${chalk.bold('Functions analyzed:')} ${s.totalFunctions}`);
  console.log(`${chalk.bold('Reachable blocks:')} ${s.totalReachableBlocks}`);
  console.log(`${chalk.bold('Unreachable blocks:')} ${s.totalUnreachableBlocks}`);
  console.log(`${chalk.bold('Reachable instructions:')} ${s.totalReachableInstructions}`);
  console.log(`${chalk.bold('Unreachable instructions:')} ${s.totalUnreachableInstructions}`);
  console.log(
    `${chalk.bold('Unreachable-code percentage:')} ${(s.unreachableCodePercentage * 100).toFixed(1)}%`,
  );
  console.log(
    `${chalk.bold('Functions containing unreachable regions:')} ${s.functionsContainingUnreachableRegions}`,
  );
  if (s.largestUnreachableRegion) {
    console.log(
      `${chalk.bold('Largest unreachable region:')} fn[${s.largestUnreachableRegion.functionIndex}] ` +
        `block[${s.largestUnreachableRegion.blockIndex}] ` +
        `${s.largestUnreachableRegion.instructionCount} instruction(s)`,
    );
  }
  if (s.entirelyUnreachableFunctions.length > 0) {
    console.log(
      `${chalk.bold('Entirely unreachable functions:')} ${s.entirelyUnreachableFunctions.join(', ')}`,
    );
  }

  const interestingFunctions = report.functions.filter(
    (summary) => summary.hasUnreachableCode || summary.entirelyUnreachable,
  );
  if (interestingFunctions.length > 0) {
    console.log(chalk.bold('\n--- Functions With Unreachable Code ---'));
    for (const summary of interestingFunctions) {
      console.log(
        `  fn[${summary.functionIndex}] blocks=${summary.unreachableBlocks}/${summary.totalBlocks} ` +
          `instructions=${summary.unreachableInstructions}/${summary.totalInstructions} ` +
          `density=${(summary.unreachablePercentage * 100).toFixed(1)}%` +
          `${summary.entirelyUnreachable ? ' [module-unreachable]' : ''}`,
      );
    }
  }

  if (report.unreachableRanges.length > 0) {
    console.log(chalk.bold('\n--- Unreachable Ranges ---'));
    for (const range of report.unreachableRanges.slice(0, 30)) {
      console.log(
        `  fn[${range.functionIndex}] block[${range.blockIndex}] ` +
          `insn ${range.startInstructionIndex}-${range.endInstructionIndex} ` +
          `(${range.instructionCount} instruction(s), ${REASON_LABELS[range.reason]})`,
      );
    }
    if (report.unreachableRanges.length > 30) {
      console.log(chalk.dim(`  ... ${report.unreachableRanges.length - 30} more range(s)`));
    }
  } else {
    console.log(chalk.dim('\nNo unreachable code detected.'));
  }

  if (report.warnings.length > 0) {
    console.log(chalk.yellow('\n--- Warnings ---'));
    for (const warning of report.warnings) console.log(`  ${warning}`);
  }
}

function printComparison(result: ReturnType<typeof compareUnreachableReports>): void {
  printReport(result.before);
  printReport(result.after);
  const c = result.comparison;
  console.log(chalk.bold('\n--- Artifact Comparison ---'));
  console.log(
    `  Unreachable instruction delta : ${c.totalUnreachableInstructionDelta >= 0 ? '+' : ''}${c.totalUnreachableInstructionDelta}`,
  );
  console.log(
    `  Unreachable percentage delta  : ${c.unreachablePercentageDelta >= 0 ? '+' : ''}${(c.unreachablePercentageDelta * 100).toFixed(1)}%`,
  );
  console.log(`  Newly unreachable regions     : ${c.newlyUnreachableRegions.length}`);
  console.log(`  Regions that became reachable : ${c.regionsThatBecameReachable.length}`);
  console.log(`  Changed range boundaries      : ${c.changedRangeBoundaries.length}`);
  console.log(
    `  Functions with new unreachable code: ${c.functionsWithNewUnreachableCode.join(', ') || 'none'}`,
  );

  if (c.newlyUnreachableRegions.length > 0) {
    console.log(chalk.yellow('\n  Newly unreachable regions:'));
    for (const range of c.newlyUnreachableRegions.slice(0, 20)) {
      console.log(
        `    fn[${range.functionIndex}] block[${range.blockIndex}] ` +
          `insn ${range.startInstructionIndex}-${range.endInstructionIndex} (${range.reason})`,
      );
    }
  }
}

export function parseUnreachableArgs(args: string[]): {
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
    throw new Error('Usage: wasm-unreachable <wasmFile> [compareFile] [--json] [--csv]');
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
    throw new Error('Usage: wasm-unreachable <wasmFile> [compareFile] [--json] [--csv]');
  }

  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const csv = params.csv === true || process.env.CSV_OUTPUT === 'true';

  if (params.compareFile) {
    const result = compareUnreachableFiles(params.wasmFile, params.compareFile);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printComparison(result);
    }
    return;
  }

  const report = analyzeWasmUnreachable(params.wasmFile);

  if (csv) {
    console.log(toCsv(report.unreachableRanges));
    return;
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printReport(report);
}
