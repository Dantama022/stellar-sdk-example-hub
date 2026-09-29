import chalk from 'chalk';

import {
  analyzeComplexity,
  compareComplexity,
  ComplexityThresholds,
  WasmComplexityReport,
} from '../utils/wasm-complexity';

export interface WasmComplexityParams {
  wasmFile?: string;
  compareFile?: string;
  json?: boolean;
  thresholds?: ComplexityThresholds;
}

function printReport(report: WasmComplexityReport): void {
  const stats = report.statistics;
  console.log(chalk.bold('\n=== WASM Function Complexity Analysis ==='));
  console.log(`${chalk.bold('File:')} ${report.file}`);
  console.log(`${chalk.bold('Defined functions:')} ${stats.definedFunctionCount}`);
  console.log(
    `${chalk.bold('Instructions / body bytes:')} ${stats.totalInstructionCount} / ${stats.totalCodeBodySize}`,
  );
  console.log(
    `${chalk.bold('Control / branches / calls:')} ${stats.totalControlFlowCount} / ${stats.totalBranchCount} / ${stats.totalCallCount}`,
  );
  console.log(
    `${chalk.bold('Memory operations / local accesses:')} ${stats.totalMemoryOperationCount} / ${stats.totalLocalAccessCount}`,
  );
  console.log(
    `${chalk.bold('Complexity score:')} ${stats.totalComplexityScore} (average ${stats.averageComplexityScore.toFixed(2)}, maximum ${stats.maximumComplexityScore})`,
  );
  if (Object.keys(report.thresholds).length > 0) {
    console.log(`${chalk.bold('Highlighted functions:')} ${stats.highlightedFunctionCount}`);
  }
  console.log(chalk.bold('\nFunctions (deterministic index order):'));
  report.functions.forEach((fn) => {
    const marker = fn.highlighted ? chalk.yellow(' !') : '';
    console.log(
      `  [${fn.functionIndex}] score=${fn.complexityScore} instructions=${fn.instructionCount} bytes=${fn.bodySize} control=${fn.controlFlowCount} branches=${fn.branchCount} calls=${fn.callCount} memory=${fn.memoryOperationCount} locals=${fn.localAccessCount}${marker}`,
    );
    if (fn.exceededThresholds.length > 0) {
      console.log(chalk.yellow(`      thresholds: ${fn.exceededThresholds.join(', ')}`));
    }
  });
  if (report.highestComplexityFunctions.length > 0) {
    console.log(chalk.bold('\nHighest structural complexity:'));
    report.highestComplexityFunctions.forEach((fn) => {
      console.log(`  [${fn.functionIndex}] score=${fn.complexityScore}`);
    });
  }
}

function printDelta(
  prefix: string,
  change: {
    functionIndex: number;
    complexityScore: number;
    instructionCount: number;
    bodySize: number;
    controlFlowCount: number;
    branchCount: number;
    callCount: number;
    memoryOperationCount: number;
    localAccessCount: number;
  },
): void {
  console.log(
    `${prefix} [${change.functionIndex}] score=${change.complexityScore} instructions=${change.instructionCount} bytes=${change.bodySize} control=${change.controlFlowCount} branches=${change.branchCount} calls=${change.callCount} memory=${change.memoryOperationCount} locals=${change.localAccessCount}`,
  );
}

export async function run(params: WasmComplexityParams = {}): Promise<void> {
  if (!params.wasmFile) {
    throw new Error(
      'Usage: stellar-api-inspector wasm-complexity <wasmFile> [compareFile] [--json] [--threshold <score>]',
    );
  }
  const output = params.compareFile
    ? compareComplexity(params.wasmFile, params.compareFile, params.thresholds)
    : analyzeComplexity(params.wasmFile, params.thresholds);
  if (params.json === true || process.env.JSON_OUTPUT === 'true') {
    console.log(JSON.stringify(output, null, 2));
  } else if ('comparison' in output) {
    printReport(output.before);
    printReport(output.after);
    console.log(chalk.bold('\n--- Complexity Changes ---'));
    const aggregate = output.comparison.aggregateDelta;
    console.log(
      `Aggregate delta: functions=${aggregate.definedFunctionCount} score=${aggregate.complexityScore} instructions=${aggregate.instructionCount} bytes=${aggregate.bodySize} control=${aggregate.controlFlowCount} branches=${aggregate.branchCount} calls=${aggregate.callCount} memory=${aggregate.memoryOperationCount} locals=${aggregate.localAccessCount}`,
    );
    output.comparison.increased.forEach((change) => printDelta(chalk.yellow('  ↑'), change));
    output.comparison.decreased.forEach((change) => printDelta(chalk.green('  ↓'), change));
    output.comparison.changed.forEach((change) => printDelta(chalk.cyan('  ~'), change));
    output.comparison.added.forEach((fn) =>
      console.log(chalk.yellow(`  + [${fn.functionIndex}] added (score ${fn.complexityScore})`)),
    );
    output.comparison.removed.forEach((fn) =>
      console.log(chalk.green(`  - [${fn.functionIndex}] removed (score ${fn.complexityScore})`)),
    );
    console.log(`Unchanged functions: ${output.comparison.unchanged.length}`);
  } else printReport(output);
}
