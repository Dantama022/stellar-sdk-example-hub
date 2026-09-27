import chalk from 'chalk';

import { WasmGlobalInfo, analyzeGlobals, compareBySignature } from '../utils/wasm-static-analysis';

export function compareGlobalReports(beforeFile: string, afterFile: string) {
  const before = analyzeGlobals(beforeFile);
  const after = analyzeGlobals(afterFile);
  return {
    before,
    after,
    comparison: compareBySignature(
      before.globals,
      after.globals,
      (item) => String(item.index),
      (item) =>
        JSON.stringify([
          item.source,
          item.module,
          item.name,
          item.valueType,
          item.mutable,
          item.initExpression,
        ]),
      (a, b) => globalChanges(a, b),
    ),
  };
}

function globalChanges(before: WasmGlobalInfo, after: WasmGlobalInfo): string[] {
  const changes: string[] = [];
  if (before.valueType !== after.valueType) changes.push('value_type');
  if (before.mutable !== after.mutable) changes.push('mutability');
  if (before.initExpression !== after.initExpression) changes.push('initialization');
  if (before.source !== after.source) changes.push('source');
  return changes;
}

function printReport(report: ReturnType<typeof analyzeGlobals>): void {
  console.log(chalk.bold('\n=== WASM Global Analysis ==='));
  console.log(`${chalk.bold('File:')} ${report.file}`);
  console.log(`${chalk.bold('Globals:')} ${report.statistics.totalGlobalCount}`);
  console.log(`${chalk.bold('Mutable:')} ${report.statistics.mutableGlobalCount}`);
  report.globals.forEach((global) => {
    console.log(
      `  [${global.index}] ${global.source} ${global.valueType} ${global.mutable ? 'mutable' : 'immutable'} init=${global.initExpression ?? 'n/a'}`,
    );
  });
}

export async function run(
  params: { wasmFile?: string; compareFile?: string; json?: boolean } = {},
): Promise<void> {
  if (!params.wasmFile)
    throw new Error('Usage: stellar-api-inspector wasm-globals <wasmFile> [compareFile] [--json]');
  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const output = params.compareFile
    ? compareGlobalReports(params.wasmFile, params.compareFile)
    : analyzeGlobals(params.wasmFile);
  if (json) console.log(JSON.stringify(output, null, 2));
  else if ('comparison' in output) {
    printReport(output.before);
    printReport(output.after);
    console.log(chalk.bold('\n--- Comparison ---'));
    console.log(
      `Added/removed/changed/unchanged: ${output.comparison.added.length}/${output.comparison.removed.length}/${output.comparison.changed.length}/${output.comparison.unchanged.length}`,
    );
  } else printReport(output);
}
