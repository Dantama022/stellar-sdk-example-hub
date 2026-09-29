/**
 * 248-wasm-float-ops
 *
 * Offline Soroban contract WASM floating-point operation analysis.
 *
 * Inventories every f32 and f64 instruction in the code section, classifies
 * each one into arithmetic / comparison / conversion / rounding / min-max /
 * absolute-sign / reinterpretation / constant categories, and reports
 * per-function and module-level statistics.
 *
 * No WASM code is executed. The analysis is completely offline.
 *
 * Usage (CLI):
 *   stellar-api-inspector wasm-float-ops <wasmFile> [compareFile] [--json] [--csv]
 *
 * Usage (programmatic):
 *   import { run } from './248-wasm-float-ops';
 *   await run({ wasmFile: 'hello.wasm', json: true });
 */

import chalk from 'chalk';

import {
  FloatOpCategory,
  FloatOpRecord,
  WasmFloatOpsReport,
  analyzeFloatOps,
  compareFloatOpsReports,
} from '../utils/wasm-static-analysis';

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function toCsvRow(record: FloatOpRecord): string {
  return [
    record.functionIndex,
    record.blockIndex,
    record.instructionIndex,
    record.opcode,
    record.valueType,
    record.category,
  ].join(',');
}

const CSV_HEADER =
  'functionIndex,blockIndex,instructionIndex,opcode,valueType,category';

export function toCsv(records: FloatOpRecord[]): string {
  return [CSV_HEADER, ...records.map(toCsvRow)].join('\n');
}

// ---------------------------------------------------------------------------
// Comparison helper (re-exported so tests can import it directly)
// ---------------------------------------------------------------------------

export function compareFloatOpsFiles(beforeFile: string, afterFile: string) {
  return compareFloatOpsReports(beforeFile, afterFile);
}

// ---------------------------------------------------------------------------
// Human-readable printer
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<FloatOpCategory, string> = {
  arithmetic: 'Arithmetic',
  comparison: 'Comparison',
  conversion: 'Conversion',
  rounding: 'Rounding',
  minmax: 'Min/Max',
  absolute_sign: 'Absolute/Sign',
  reinterpretation: 'Reinterpretation',
  constant: 'Constant',
};

function printReport(report: WasmFloatOpsReport): void {
  const s = report.statistics;
  console.log(chalk.bold('\n=== WASM Floating-Point Operation Analysis ==='));
  console.log(`${chalk.bold('File:')}                    ${report.file}`);
  console.log(`${chalk.bold('Total float instructions:')} ${s.totalFloatInstructions}`);
  console.log(`${chalk.bold('  f32 instructions:')}       ${s.totalF32Instructions}`);
  console.log(`${chalk.bold('  f64 instructions:')}       ${s.totalF64Instructions}`);
  console.log(`${chalk.bold('Functions using float:')}   ${s.functionsUsingFloat}`);

  if (s.totalFloatInstructions === 0) {
    console.log(chalk.dim('\nNo floating-point instructions found.'));
    return;
  }

  console.log(chalk.bold('\n--- Category Breakdown ---'));
  const categories: FloatOpCategory[] = [
    'arithmetic',
    'comparison',
    'conversion',
    'rounding',
    'minmax',
    'absolute_sign',
    'reinterpretation',
    'constant',
  ];
  categories.forEach((cat) => {
    const count =
      cat === 'arithmetic'
        ? s.arithmeticCount
        : cat === 'comparison'
          ? s.comparisonCount
          : cat === 'conversion'
            ? s.conversionCount
            : cat === 'rounding'
              ? s.roundingCount
              : cat === 'minmax'
                ? s.minmaxCount
                : cat === 'absolute_sign'
                  ? s.absoluteSignCount
                  : cat === 'reinterpretation'
                    ? s.reinterpretationCount
                    : s.constantCount;
    if (count > 0) {
      console.log(`  ${CATEGORY_LABELS[cat].padEnd(18)}: ${count}`);
    }
  });

  if (s.highestDensityFunction) {
    console.log(chalk.bold('\n--- Highest Float Density ---'));
    console.log(
      `  Function ${s.highestDensityFunction.functionIndex}: ` +
        `${(s.highestDensityFunction.floatDensity * 100).toFixed(1)}% float instructions`,
    );
  }

  if (s.floatConcentrated) {
    console.log(
      chalk.yellow('\n⚠ Float usage is concentrated in a small subset of functions.'),
    );
  }

  const mixedFns = report.functions.filter((f) => f.hasMixedPrecision);
  if (mixedFns.length > 0) {
    console.log(chalk.bold('\n--- Mixed f32/f64 Functions ---'));
    mixedFns.forEach((f) => {
      console.log(`  Function ${f.functionIndex}: ${f.f32Count} f32, ${f.f64Count} f64`);
    });
  }

  const roundtripFns = report.functions.filter((f) => f.hasIntFloatIntRoundtrip);
  if (roundtripFns.length > 0) {
    console.log(chalk.bold('\n--- Int↔Float Roundtrip Functions ---'));
    roundtripFns.forEach((f) => {
      console.log(`  Function ${f.functionIndex}`);
    });
  }

  console.log(chalk.bold('\n--- Per-Function Summary (float ops > 0) ---'));
  report.functions
    .filter((f) => f.totalFloatOps > 0)
    .sort((a, b) => b.totalFloatOps - a.totalFloatOps)
    .forEach((f) => {
      console.log(
        `  [${f.functionIndex}] total=${f.totalFloatOps} ` +
          `f32=${f.f32Count} f64=${f.f64Count} ` +
          `density=${(f.floatDensity * 100).toFixed(1)}%`,
      );
    });
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
  if (!params.wasmFile) {
    throw new Error(
      'Usage: stellar-api-inspector wasm-float-ops <wasmFile> [compareFile] [--json] [--csv]',
    );
  }

  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const csv = params.csv === true || process.env.CSV_OUTPUT === 'true';

  if (params.compareFile) {
    const output = compareFloatOpsFiles(params.wasmFile, params.compareFile);
    if (json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      printReport(output.before);
      printReport(output.after);
      const c = output.comparison;
      console.log(chalk.bold('\n--- Comparison ---'));
      console.log(`  Total float delta : ${c.totalFloatDelta >= 0 ? '+' : ''}${c.totalFloatDelta}`);
      console.log(`  f32 delta         : ${c.f32Delta >= 0 ? '+' : ''}${c.f32Delta}`);
      console.log(`  f64 delta         : ${c.f64Delta >= 0 ? '+' : ''}${c.f64Delta}`);
      if (c.addedOpcodes.length > 0)
        console.log(`  Added opcodes     : ${c.addedOpcodes.join(', ')}`);
      if (c.removedOpcodes.length > 0)
        console.log(`  Removed opcodes   : ${c.removedOpcodes.join(', ')}`);
      if (c.newF32Usage) console.log(chalk.yellow('  New f32 usage detected'));
      if (c.newF64Usage) console.log(chalk.yellow('  New f64 usage detected'));
      if (c.newlyFloatFunctions.length > 0)
        console.log(
          `  Newly float functions : ${c.newlyFloatFunctions.join(', ')}`,
        );
      if (c.removedFloatFunctions.length > 0)
        console.log(
          `  No-longer float fns   : ${c.removedFloatFunctions.join(', ')}`,
        );
    }
    return;
  }

  const output = analyzeFloatOps(params.wasmFile);

  if (csv) {
    console.log(toCsv(output.records));
    return;
  }

  if (json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  printReport(output);
}
