import chalk from 'chalk';

import {
  SideEffectClassification,
  FunctionSideEffectInfo,
  WasmSideEffectReport,
  analyzeSideEffects,
  compareSideEffectReports,
} from '../utils/wasm-static-analysis';

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const CLASSIFICATION_COLORS: Record<SideEffectClassification, (s: string) => string> = {
  pure: chalk.green,
  read_only: chalk.cyan,
  state_mutating: chalk.yellow,
  externally_dependent: chalk.magenta,
  effectful: chalk.red,
  unknown: chalk.gray,
};

function labelFor(cls: SideEffectClassification): string {
  const labels: Record<SideEffectClassification, string> = {
    pure: 'pure',
    read_only: 'read-only',
    state_mutating: 'state-mutating',
    externally_dependent: 'externally-dependent',
    effectful: 'effectful',
    unknown: 'unknown',
  };
  return labels[cls];
}

function printFunctionRow(fn: FunctionSideEffectInfo): void {
  const color = CLASSIFICATION_COLORS[fn.classification];
  const label = color(labelFor(fn.classification).padEnd(22));
  const name = fn.exportName ? ` (${fn.exportName})` : '';
  const transitive = fn.hasTransitiveEffects ? chalk.dim(' [transitive]') : '';
  console.log(`  fn[${String(fn.functionIndex).padStart(3)}]${name} ${label}${transitive}`);
}

function printReport(report: WasmSideEffectReport): void {
  console.log(chalk.bold('\n=== WASM Function Side-Effect Analysis ==='));
  console.log(`${chalk.bold('File:')} ${report.file}`);
  const s = report.statistics;
  console.log(`${chalk.bold('Total functions analyzed:')} ${s.totalAnalyzedFunctions}`);
  console.log(`  ${chalk.green('pure')}:                 ${s.pureFunctions}`);
  console.log(`  ${chalk.cyan('read-only')}:            ${s.readOnlyFunctions}`);
  console.log(`  ${chalk.yellow('state-mutating')}:       ${s.stateMutatingFunctions}`);
  console.log(`  ${chalk.magenta('externally-dependent')}: ${s.externallyDependentFunctions}`);
  console.log(`  ${chalk.red('effectful')}:            ${s.effectfulFunctions}`);
  console.log(`  ${chalk.gray('unknown')}:              ${s.unknownFunctions}`);
  console.log(
    `${chalk.bold('Functions with transitive effects:')} ${s.functionsWithTransitiveEffects}`,
  );
  console.log(`${chalk.bold('Imported functions:')} ${s.importedFunctionCount}`);
  console.log(`${chalk.bold('Defined functions:')}  ${s.definedFunctionCount}`);

  console.log(chalk.bold('\n--- Per-function classification ---'));
  report.functions.forEach(printFunctionRow);
}

// ---------------------------------------------------------------------------
// CSV output
// ---------------------------------------------------------------------------

export function reportToCsv(report: WasmSideEffectReport): string {
  const lines = [
    'functionIndex,source,exportName,classification,hasTransitiveEffects,memoryStores,globalWrites,mutableGlobalReads,memoryLoads,importedCalls,hasIndirectCall,hasUnreachable,tableMutations,transitiveMutatingCallees,transitiveExternalCallees',
  ];
  for (const fn of report.functions) {
    const ev = fn.evidence;
    lines.push(
      [
        fn.functionIndex,
        fn.source,
        fn.exportName ?? '',
        fn.classification,
        fn.hasTransitiveEffects,
        ev.memoryStores.join('|'),
        ev.globalWrites.join('|'),
        ev.mutableGlobalReads.join('|'),
        ev.memoryLoads.join('|'),
        ev.importedCalls.join('|'),
        ev.hasIndirectCall,
        ev.hasUnreachable,
        ev.tableMutations.join('|'),
        ev.transitiveMutatingCallees.join('|'),
        ev.transitiveExternalCallees.join('|'),
      ].join(','),
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// DOT output
// ---------------------------------------------------------------------------

export function reportToDot(report: WasmSideEffectReport): string {
  const lines = ['digraph side_effects {', '  rankdir=LR;'];
  const nodeColors: Record<SideEffectClassification, string> = {
    pure: 'green',
    read_only: 'cyan',
    state_mutating: 'yellow',
    externally_dependent: 'magenta',
    effectful: 'red',
    unknown: 'gray',
  };
  for (const fn of report.functions) {
    const label = fn.exportName
      ? `fn[${fn.functionIndex}]\\n${fn.exportName}\\n${fn.classification}`
      : `fn[${fn.functionIndex}]\\n${fn.classification}`;
    const color = nodeColors[fn.classification];
    lines.push(
      `  fn${fn.functionIndex} [label="${label}" style=filled fillcolor=${color}];`,
    );
  }
  for (const [caller, callees] of Object.entries(report.callGraph)) {
    for (const callee of callees) {
      lines.push(`  fn${caller} -> fn${callee};`);
    }
  }
  lines.push('}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI run function
// ---------------------------------------------------------------------------

export async function run(
  params: {
    wasmFile?: string;
    compareFile?: string;
    json?: boolean;
    csv?: boolean;
    dot?: boolean;
  } = {},
): Promise<void> {
  if (!params.wasmFile) {
    throw new Error(
      'Usage: stellar-api-inspector wasm-side-effects <wasmFile> [compareFile] [--json] [--csv] [--dot]',
    );
  }

  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const csv = params.csv === true || process.env.CSV_OUTPUT === 'true';
  const dot = params.dot === true || process.env.DOT_OUTPUT === 'true';

  if (params.compareFile) {
    const result = compareSideEffectReports(params.wasmFile, params.compareFile);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printReport(result.before);
      printReport(result.after);
      console.log(chalk.bold('\n--- Artifact Comparison ---'));
      const c = result.comparison;
      if (c.classificationChanges.length === 0) {
        console.log('  No classification changes detected.');
      } else {
        c.classificationChanges.forEach((change) => {
          const arrow = `${labelFor(change.before)} → ${labelFor(change.after)}`;
          console.log(`  fn[${change.functionIndex}]: ${arrow}`);
        });
      }
      if (c.becameEffectful.length > 0)
        console.log(`${chalk.red('Became effectful:')} fn[${c.becameEffectful.join(', ')}]`);
      if (c.becameSideEffectFree.length > 0)
        console.log(
          `${chalk.green('Became side-effect-free:')} fn[${c.becameSideEffectFree.join(', ')}]`,
        );
      if (c.newMemoryWrites.length > 0)
        console.log(
          `${chalk.yellow('New memory writes:')} fn[${c.newMemoryWrites.join(', ')}]`,
        );
      if (c.newGlobalWrites.length > 0)
        console.log(
          `${chalk.yellow('New global writes:')} fn[${c.newGlobalWrites.join(', ')}]`,
        );
      if (c.newImportedDependencies.length > 0)
        console.log(
          `${chalk.magenta('New imported dependencies:')} fn[${c.newImportedDependencies.join(', ')}]`,
        );
      if (c.changedTransitiveEffects.length > 0)
        console.log(
          `${chalk.cyan('Changed transitive effects:')} fn[${c.changedTransitiveEffects.join(', ')}]`,
        );
    }
  } else {
    const report = analyzeSideEffects(params.wasmFile);
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else if (csv) {
      console.log(reportToCsv(report));
    } else if (dot) {
      console.log(reportToDot(report));
    } else {
      printReport(report);
    }
  }
}
