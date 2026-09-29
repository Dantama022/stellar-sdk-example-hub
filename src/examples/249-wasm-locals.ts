import chalk from 'chalk';

import {
  analyzeLocals,
  compareLocalsFiles,
  WasmFunctionLocalsInfo,
  WasmLocalsComparison,
  WasmLocalsReport,
} from '../utils/wasm-locals-analysis';

function formatRecord(record: Record<string, number>): string {
  const entries = Object.entries(record);
  return entries.length === 0 ? '(none)' : entries.map(([k, v]) => `${k}=${v}`).join(', ');
}

function formatIndices(indices: number[]): string {
  return indices.length === 0 ? '(none)' : indices.join(', ');
}

function functionLabel(fn: { functionIndex: number; exportName: string | null }): string {
  return fn.exportName
    ? `func[${fn.functionIndex}] "${fn.exportName}"`
    : `func[${fn.functionIndex}]`;
}

function printFunction(fn: WasmFunctionLocalsInfo): void {
  console.log(
    `\n  ${chalk.cyan(functionLabel(fn))} type=${fn.typeIndex} params=${fn.paramCount} locals=${fn.declaredLocalCount} total=${fn.totalLocalCount}`,
  );
  console.log(`    Params by type:  ${formatRecord(fn.paramsByValueType)}`);
  console.log(`    Locals by type:  ${formatRecord(fn.localsByValueType)}`);
  fn.declarationGroups.forEach((group) => {
    console.log(
      `    Group ${group.groupIndex}: ${group.count} x ${group.valueType} (indices ${group.startIndex}..${group.endIndex})`,
    );
  });
  console.log(
    `    Accesses:        reads=${fn.readCount} writes=${fn.writeCount} tees=${fn.teeCount}`,
  );
  fn.locals.forEach((local) => {
    const flags = [
      !local.referenced ? chalk.yellow('unused') : null,
      local.writeOnly ? chalk.yellow('write-only') : null,
    ].filter(Boolean);
    console.log(
      `    [${local.index}] ${local.kind.padEnd(5)} ${local.valueType.padEnd(9)} get=${local.reads} set=${local.writes} tee=${local.tees}${flags.length ? ` ${flags.join(' ')}` : ''}`,
    );
  });
  console.log(`    Unused locals:   ${formatIndices(fn.unusedLocals)}`);
  console.log(`    Unused params:   ${formatIndices(fn.unusedParams)}`);
}

export function printLocalsReport(report: WasmLocalsReport): void {
  const s = report.statistics;
  console.log(chalk.bold('\n=== WASM Local Variable Analysis ==='));
  console.log(`${chalk.bold('File:')} ${report.file}`);
  console.log(`${chalk.bold('Imported functions:')} ${s.importedFunctionCount}`);
  console.log(`${chalk.bold('Defined functions:')} ${s.definedFunctionCount}`);
  console.log(
    `${chalk.bold('Parameters:')} ${s.totalParams} (${formatRecord(s.paramsByValueType)})`,
  );
  console.log(
    `${chalk.bold('Declared locals:')} ${s.totalDeclaredLocals} (${formatRecord(s.localsByValueType)})`,
  );
  console.log(`${chalk.bold('Declaration groups:')} ${s.totalDeclarationGroups}`);
  console.log(
    `${chalk.bold('Average locals/function:')} ${s.averageDeclaredLocalsPerFunction.toFixed(2)} (max ${s.maxDeclaredLocalsPerFunction})`,
  );
  console.log(
    `${chalk.bold('Accesses:')} reads=${s.totalReads} writes=${s.totalWrites} tees=${s.totalTees}`,
  );
  console.log(
    `${chalk.bold('Unused:')} locals=${s.unusedLocalCount} params=${s.unusedParamCount} write-only locals=${s.writeOnlyLocalCount}`,
  );

  console.log(chalk.bold('\nFunctions with the most locals:'));
  s.functionsWithMostLocals.forEach((fn) => {
    console.log(
      `  ${functionLabel(fn)}: ${fn.declaredLocalCount} locals (${fn.totalLocalCount} incl. params)`,
    );
  });

  console.log(chalk.bold('\nMost frequently accessed locals:'));
  if (s.mostAccessedLocals.length === 0) console.log('  (none)');
  s.mostAccessedLocals.forEach((ref) => {
    console.log(
      `  ${functionLabel(ref)} ${ref.kind} ${ref.localIndex} (${ref.valueType}): ${ref.accessCount} accesses`,
    );
  });

  console.log(chalk.bold('\nPer-function details:'));
  report.functions.forEach(printFunction);
}

export function printLocalsComparison(output: WasmLocalsComparison): void {
  printLocalsReport(output.before);
  printLocalsReport(output.after);
  const { functions, deltas, identical } = output.comparison;
  console.log(chalk.bold('\n--- Comparison ---'));
  console.log(`Identical local usage:   ${identical ? 'yes' : 'no'}`);
  console.log(`Defined function delta:  ${deltas.definedFunctionCount}`);
  console.log(`Parameter delta:         ${deltas.totalParams}`);
  console.log(`Declared local delta:    ${deltas.totalDeclaredLocals}`);
  console.log(`Read delta:              ${deltas.totalReads}`);
  console.log(`Write delta:             ${deltas.totalWrites}`);
  console.log(`Tee delta:               ${deltas.totalTees}`);
  console.log(`Unused local delta:      ${deltas.unusedLocalCount}`);
  console.log(`Locals by type delta:    ${formatRecord(deltas.localsByValueType)}`);
  functions.added.forEach((fn) => console.log(chalk.green(`  + ${functionLabel(fn)}`)));
  functions.removed.forEach((fn) => console.log(chalk.red(`  - ${functionLabel(fn)}`)));
  functions.changed.forEach(({ before, after, changes }) => {
    console.log(
      chalk.yellow(
        `  ~ ${functionLabel(after)} (was ${functionLabel(before)}): ${changes.join(', ')}`,
      ),
    );
  });
  console.log(`Unchanged functions:     ${functions.unchanged.length}`);
}

export async function run(
  params: { wasmFile?: string; compareFile?: string; json?: boolean } = {},
): Promise<void> {
  if (!params.wasmFile) {
    throw new Error('Usage: stellar-api-inspector wasm-locals <wasmFile> [compareFile] [--json]');
  }
  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const output = params.compareFile
    ? compareLocalsFiles(params.wasmFile, params.compareFile)
    : analyzeLocals(params.wasmFile);
  if (json) console.log(JSON.stringify(output, null, 2));
  else if ('comparison' in output) printLocalsComparison(output);
  else printLocalsReport(output);
}
