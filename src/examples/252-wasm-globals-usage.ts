/**
 * 252-wasm-globals-usage
 *
 * Offline Soroban contract WASM global mutation analysis.
 *
 * Tracks global.get and global.set usage across all functions, classifies
 * each global as read-only / write-only / read-write / never-accessed, and
 * reports per-function and module-level data-flow statistics.
 *
 * No WASM code is executed. The analysis is completely offline.
 *
 * Usage (CLI):
 *   stellar-api-inspector wasm-globals-usage <wasmFile> [compareFile] [--json] [--csv]
 *
 * Usage (programmatic):
 *   import { run } from './252-wasm-globals-usage';
 *   await run({ wasmFile: 'hello.wasm', json: true });
 */

import chalk from 'chalk';

import {
  GlobalUsageClassification,
  WasmGlobalAccessRecord,
  WasmGlobalFunctionSummary,
  WasmGlobalMutationReport,
  WasmGlobalUsageSummary,
  analyzeGlobalMutation,
  compareGlobalMutationReports,
} from '../utils/wasm-static-analysis';

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

const CSV_HEADER =
  'globalIndex,functionIndex,blockIndex,instructionIndex,opcode';

function toCsvRow(rec: WasmGlobalAccessRecord): string {
  return [rec.globalIndex, rec.functionIndex, rec.blockIndex, rec.instructionIndex, rec.opcode].join(',');
}

export function toCsv(records: WasmGlobalAccessRecord[]): string {
  return [CSV_HEADER, ...records.map(toCsvRow)].join('\n');
}

// ---------------------------------------------------------------------------
// Human-readable printer
// ---------------------------------------------------------------------------

const CLASSIFICATION_LABELS: Record<GlobalUsageClassification, string> = {
  read_only: chalk.cyan('read-only'),
  write_only: chalk.yellow('write-only'),
  read_write: chalk.magenta('read/write'),
  never_accessed: chalk.dim('never accessed'),
};

function printGlobalSummary(g: WasmGlobalUsageSummary): void {
  const importTag = g.source === 'imported' ? chalk.dim(` [import: ${g.importModule}.${g.importName}]`) : '';
  const mutTag = g.mutable ? chalk.yellow(' [mutable]') : chalk.dim(' [immutable]');
  console.log(
    `  global[${g.globalIndex}]  ${g.valueType}${mutTag}  ${CLASSIFICATION_LABELS[g.classification]}` +
    (g.totalReads > 0 ? `  reads=${g.totalReads}` : '') +
    (g.totalWrites > 0 ? `  writes=${g.totalWrites}` : '') +
    (g.accessedByMultipleFunctions ? chalk.blue('  [multi-fn]') : '') +
    importTag,
  );
  if (g.readingFunctions.length > 0) {
    console.log(chalk.dim(`    Reading functions: [${g.readingFunctions.join(', ')}]`));
  }
  if (g.writingFunctions.length > 0) {
    console.log(chalk.dim(`    Writing functions: [${g.writingFunctions.join(', ')}]`));
  }
}

function printFuncSummary(fn: WasmGlobalFunctionSummary): void {
  if (fn.totalGlobalReads === 0 && fn.totalGlobalWrites === 0) return;
  console.log(
    `  [fn${fn.functionIndex}]  reads=${fn.totalGlobalReads}  writes=${fn.totalGlobalWrites}` +
    `  unique globals=${fn.uniqueGlobalsAccessed}` +
    (fn.mutableGlobalsModified > 0 ? chalk.yellow(`  mutates=${fn.mutableGlobalsModified}`) : ''),
  );
}

function printReport(report: WasmGlobalMutationReport): void {
  const s = report.statistics;
  console.log(chalk.bold('\n=== WASM Global Mutation Analysis ==='));
  console.log(`${chalk.bold('File:')}                             ${report.file}`);
  console.log(`${chalk.bold('Total globals:')}                    ${s.totalGlobals}`);
  console.log(`${chalk.bold('  Imported globals:')}               ${s.importedGlobals}`);
  console.log(`${chalk.bold('  Local globals:')}                  ${s.localGlobals}`);
  console.log(`${chalk.bold('  Mutable globals:')}                ${s.mutableGlobals}`);
  console.log(`${chalk.bold('  Immutable globals:')}              ${s.immutableGlobals}`);
  console.log(`${chalk.bold('Total reads:')}                      ${s.totalReads}`);
  console.log(`${chalk.bold('Total writes:')}                     ${s.totalWrites}`);
  console.log(`${chalk.bold('Globals never accessed:')}           ${s.globalsNeverAccessed}`);
  console.log(`${chalk.bold('Globals accessed by multiple fns:')} ${s.globalsAccessedByMultipleFunctions}`);
  console.log(`${chalk.bold('Globals written by multiple fns:')}  ${s.globalsWrittenByMultipleFunctions}`);

  if (report.globals.length === 0) {
    console.log(chalk.dim('\nNo globals defined.'));
    return;
  }

  console.log(chalk.bold('\n--- Global Inventory ---'));
  report.globals.forEach(printGlobalSummary);

  const activeFuncs = report.functionSummaries.filter(
    (f) => f.totalGlobalReads > 0 || f.totalGlobalWrites > 0,
  );
  if (activeFuncs.length > 0) {
    console.log(chalk.bold('\n--- Per-Function Global Access Summary ---'));
    activeFuncs.forEach(printFuncSummary);
  }

  // Detect functions that read a global before and after writing (read-write-read pattern)
  const rwrFunctions = new Set<number>();
  const funcAccessMap = new Map<number, WasmGlobalAccessRecord[]>();
  for (const acc of report.accesses) {
    const list = funcAccessMap.get(acc.functionIndex) ?? [];
    list.push(acc);
    funcAccessMap.set(acc.functionIndex, list);
  }
  for (const [fnIdx, accesses] of funcAccessMap) {
    const sorted = [...accesses].sort((a, b) => a.instructionIndex - b.instructionIndex);
    const globalsSeen = new Map<number, { hadRead: boolean; hadWrite: boolean }>();
    for (const acc of sorted) {
      const state = globalsSeen.get(acc.globalIndex) ?? { hadRead: false, hadWrite: false };
      if (acc.opcode === 'global.get') {
        if (state.hadWrite) rwrFunctions.add(fnIdx);
        state.hadRead = true;
      } else {
        if (state.hadRead) state.hadWrite = true;
      }
      globalsSeen.set(acc.globalIndex, state);
    }
  }
  if (rwrFunctions.size > 0) {
    console.log(chalk.bold('\n--- Functions Reading a Global Before and After Writing ---'));
    [...rwrFunctions].sort((a, b) => a - b).forEach((fnIdx) => {
      console.log(`  fn${fnIdx}`);
    });
  }
}

function printComparison(result: ReturnType<typeof compareGlobalMutationReports>): void {
  const { comparison } = result;
  console.log(chalk.bold('\n--- Global Mutation Comparison ---'));
  if (comparison.addedGlobals.length > 0) {
    console.log(chalk.red(`Added globals: +${comparison.addedGlobals.length}`));
    comparison.addedGlobals.forEach((g) => console.log(`  + global[${g.globalIndex}] ${g.valueType} ${g.classification}`));
  }
  if (comparison.removedGlobals.length > 0) {
    console.log(chalk.green(`Removed globals: -${comparison.removedGlobals.length}`));
    comparison.removedGlobals.forEach((g) => console.log(`  - global[${g.globalIndex}] ${g.valueType}`));
  }
  if (comparison.changedUsageClassification.length > 0) {
    console.log(chalk.yellow(`Changed usage classification: ${comparison.changedUsageClassification.length}`));
    comparison.changedUsageClassification.forEach(({ globalIndex, before, after }) => {
      console.log(`  ~ global[${globalIndex}]: ${before} → ${after}`);
    });
  }
  if (comparison.newMutatedGlobals.length > 0) {
    console.log(chalk.yellow(`Newly mutated globals: ${comparison.newMutatedGlobals.length}`));
    comparison.newMutatedGlobals.forEach((g) => console.log(`  ! global[${g.globalIndex}]`));
  }
  if (comparison.globalsBecomingUnused.length > 0) {
    console.log(chalk.dim(`Globals becoming unused: ${comparison.globalsBecomingUnused.length}`));
    comparison.globalsBecomingUnused.forEach((g) => console.log(`  - global[${g.globalIndex}]`));
  }
  const noChanges =
    comparison.addedGlobals.length === 0 &&
    comparison.removedGlobals.length === 0 &&
    comparison.changedUsageClassification.length === 0 &&
    comparison.newMutatedGlobals.length === 0 &&
    comparison.globalsBecomingUnused.length === 0;
  if (noChanges) console.log(chalk.green('No global mutation changes detected between artifacts.'));
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
      'Usage: stellar-api-inspector wasm-globals-usage <wasmFile> [compareFile] [--json] [--csv]',
    );
  }

  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const csv = params.csv === true || process.env.CSV_OUTPUT === 'true';
  const compareFile = params.compareFile ?? process.env.COMPARE_WASM_FILE;

  if (compareFile) {
    const result = compareGlobalMutationReports(wasmFile, compareFile);
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

  const report = analyzeGlobalMutation(wasmFile);

  if (csv) {
    console.log(toCsv(report.accesses));
    return;
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printReport(report);
}
