/**
 * 251-wasm-stack-types
 *
 * Offline Soroban contract WASM operand-stack type analysis.
 *
 * Reconstructs the statically expected stack type state for each instruction,
 * identifies stack underflows, and reports type-flow statistics across all
 * functions.
 *
 * No WASM code is executed. The analysis is completely offline.
 *
 * Usage (CLI):
 *   stellar-api-inspector wasm-stack-types <wasmFile> [compareFile] [--json] [--csv]
 *
 * Usage (programmatic):
 *   import { run } from './251-wasm-stack-types';
 *   await run({ wasmFile: 'hello.wasm', json: true });
 */

import chalk from 'chalk';

import {
  WasmStackStateRecord,
  WasmStackTypeFunctionSummary,
  WasmStackTypeIssue,
  WasmStackTypesReport,
  analyzeStackTypes,
  compareStackTypesReports,
} from '../utils/wasm-static-analysis';

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

const CSV_HEADER =
  'functionIndex,blockIndex,instructionIndex,opcode,inputTypes,outputTypes,stackDepthBefore,stackDepthAfter,isUnreachable';

function toCsvRow(rec: WasmStackStateRecord): string {
  return [
    rec.functionIndex,
    rec.blockIndex,
    rec.instructionIndex,
    rec.opcode,
    `"${rec.inputTypes.join('|')}"`,
    `"${rec.outputTypes.join('|')}"`,
    rec.stackDepthBefore,
    rec.stackDepthAfter,
    rec.isUnreachable,
  ].join(',');
}

export function toCsv(records: WasmStackStateRecord[]): string {
  return [CSV_HEADER, ...records.map(toCsvRow)].join('\n');
}

// ---------------------------------------------------------------------------
// Human-readable printer
// ---------------------------------------------------------------------------

function printIssue(issue: WasmStackTypeIssue): void {
  const kindLabel: Record<WasmStackTypeIssue['kind'], string> = {
    stack_underflow: chalk.red('stack underflow'),
    type_mismatch: chalk.yellow('type mismatch'),
    impossible_merge: chalk.magenta('impossible merge'),
  };
  console.log(
    `    ${kindLabel[issue.kind]}  fn${issue.functionIndex}  block=${issue.blockIndex}  instr=${issue.instructionIndex}  op=${issue.opcode}`,
  );
  console.log(chalk.dim(`      ${issue.description}`));
}

function printFuncSummary(fn: WasmStackTypeFunctionSummary): void {
  console.log(
    `  [fn${fn.functionIndex}] instrs=${fn.totalInstructions}  maxDepth=${fn.maxStackDepth}  transitions=${fn.typeTransitions}` +
    (fn.polymorphicStateCount > 0 ? `  polymorphic=${fn.polymorphicStateCount}` : '') +
    (fn.issueCount > 0 ? chalk.red(`  issues=${fn.issueCount}`) : ''),
  );
}

function printReport(report: WasmStackTypesReport): void {
  const s = report.statistics;
  console.log(chalk.bold('\n=== WASM Operand-Stack Type Analysis ==='));
  console.log(`${chalk.bold('File:')}                     ${report.file}`);
  console.log(`${chalk.bold('Total functions:')}          ${s.totalFunctions}`);
  console.log(`${chalk.bold('Total instructions:')}       ${s.totalInstructions}`);
  console.log(`${chalk.bold('Total type transitions:')}   ${s.totalTypeTransitions}`);
  console.log(`${chalk.bold('Polymorphic states:')}       ${s.totalPolymorphicStates}`);
  console.log(`${chalk.bold('Maximum stack depth:')}      ${s.maxStackDepth}`);

  if (s.totalIssues > 0) {
    console.log(chalk.red(`${chalk.bold('Issues detected:')}          ${s.totalIssues}`));
    console.log(chalk.bold('\n--- Issues ---'));
    report.issues.slice(0, 20).forEach(printIssue);
    if (report.issues.length > 20) {
      console.log(chalk.dim(`  … and ${report.issues.length - 20} more issues`));
    }
  } else {
    console.log(chalk.green('\nNo stack type issues detected.'));
  }

  if (s.functionsWithHighestTransitions.length > 0) {
    console.log(chalk.bold('\n--- Functions with Most Type Transitions ---'));
    s.functionsWithHighestTransitions.slice(0, 10).forEach(({ functionIndex, transitions }) => {
      console.log(`  fn${functionIndex}: ${transitions} transitions`);
    });
  }

  console.log(chalk.bold('\n--- Per-Function Summary ---'));
  report.functions.forEach(printFuncSummary);

  const topTransitions = Object.entries(s.typeTransitionFrequencies)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);
  if (topTransitions.length > 0) {
    console.log(chalk.bold('\n--- Most Frequent Type Transitions ---'));
    topTransitions.forEach(([key, count]) => {
      console.log(`  ${count.toString().padStart(5)}  ${key}`);
    });
  }
}

function printComparison(result: ReturnType<typeof compareStackTypesReports>): void {
  const { comparison } = result;
  console.log(chalk.bold('\n--- Stack Types Comparison ---'));
  if (comparison.addedTransitions.length > 0) {
    console.log(chalk.red(`New type transitions: +${comparison.addedTransitions.length}`));
    comparison.addedTransitions.slice(0, 5).forEach((t) => console.log(`  + ${t}`));
  }
  if (comparison.removedTransitions.length > 0) {
    console.log(chalk.green(`Removed type transitions: -${comparison.removedTransitions.length}`));
    comparison.removedTransitions.slice(0, 5).forEach((t) => console.log(`  - ${t}`));
  }
  console.log(`Max stack depth delta: ${comparison.maxStackDepthDelta >= 0 ? '+' : ''}${comparison.maxStackDepthDelta}`);
  if (comparison.newIssues !== 0) {
    const label = comparison.newIssues > 0 ? chalk.red(`+${comparison.newIssues}`) : chalk.green(`${comparison.newIssues}`);
    console.log(`Issues delta: ${label}`);
  }
  if (comparison.addedTransitions.length === 0 && comparison.removedTransitions.length === 0 && comparison.newIssues === 0) {
    console.log(chalk.green('No meaningful stack-type changes detected.'));
  }
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
  } = {},
): Promise<void> {
  const wasmFile = params.wasmFile ?? process.env.WASM_FILE;
  if (!wasmFile) {
    throw new Error(
      'Usage: stellar-api-inspector wasm-stack-types <wasmFile> [compareFile] [--json] [--csv]',
    );
  }

  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const csv = params.csv === true || process.env.CSV_OUTPUT === 'true';
  const compareFile = params.compareFile ?? process.env.COMPARE_WASM_FILE;

  if (compareFile) {
    const result = compareStackTypesReports(wasmFile, compareFile);
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

  const report = analyzeStackTypes(wasmFile);

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
