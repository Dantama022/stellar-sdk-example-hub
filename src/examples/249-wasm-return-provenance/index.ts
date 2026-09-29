/**
 * Example 249: Soroban Contract WASM Return-Value Provenance Analysis
 *
 * Traces the origin of every return value of every function in a WASM binary
 * backward through supported instructions and control-flow paths — completely
 * offline and without executing any contract code.
 *
 * Usage (CLI):
 *   stellar-api-inspector wasm-return-provenance <wasmFile> [compareFile] [--json] [--dot[=<path>]]
 *
 * Usage (runner):
 *   npm run run-example 249-wasm-return-provenance
 */

import fs from 'fs';
import path from 'path';

import chalk from 'chalk';

import {
  WasmProvenanceError,
  WasmProvenanceReport,
  FunctionProvenanceSummary,
  ReturnSite,
  ProvenanceSource,
  analyzeReturnProvenance,
  compareProvenanceReports,
} from './provenance-engine';

// ---------------------------------------------------------------------------
// Text rendering helpers
// ---------------------------------------------------------------------------

function formatSource(src: ProvenanceSource): string {
  switch (src.kind) {
    case 'parameter':
      return `param[${src.paramIndex}]`;
    case 'local':
      return `local[${src.localIndex}]`;
    case 'const':
      return `const(${src.constValue})`;
    case 'global_immutable':
      return `global[${src.globalIndex}](immutable)`;
    case 'global_mutable':
      return `global[${src.globalIndex}](mutable)`;
    case 'memory':
      return `memory(${src.memoryNote ?? ''})`;
    case 'call':
      return src.calleeName
        ? `call(${src.calleeName}, result[${src.calleeResultPosition}])`
        : `call(func[${src.calleeIndex}], result[${src.calleeResultPosition}])`;
    case 'call_indirect':
      return `call_indirect`;
    case 'unknown':
      return `unknown${src.note ? `(${src.note})` : ''}`;
    default:
      return String(src.kind);
  }
}

function printReturnSite(site: ReturnSite, indent = '    '): void {
  const srcs = site.provenanceSources.map(formatSource).join(', ');
  const classColor =
    site.classification === 'unknown'
      ? chalk.red
      : site.classification === 'state_derived'
        ? chalk.yellow
        : site.classification === 'parameter_derived'
          ? chalk.cyan
          : site.classification === 'constant_derived'
            ? chalk.green
            : chalk.white;
  console.log(
    `${indent}result[${site.resultPosition}] ${chalk.bold(site.resultType)} ← ${srcs} ` +
      `[${classColor(site.classification)}] depth=${site.provenanceDepth}`,
  );
}

function printFunctionSummary(fn: FunctionProvenanceSummary): void {
  const tags: string[] = [];
  if (fn.hasParameterDerivedReturn) tags.push(chalk.cyan('param'));
  if (fn.hasMutableStateDerivedReturn) tags.push(chalk.yellow('state'));
  if (fn.hasConstantDerivedReturn) tags.push(chalk.green('const'));
  if (fn.hasCallDerivedReturn) tags.push(chalk.magenta('call'));
  if (fn.hasMemoryDerivedReturn) tags.push(chalk.blue('memory'));
  if (fn.hasUnknownReturn) tags.push(chalk.red('unknown'));

  console.log(
    chalk.bold(`\n  func[${fn.functionIndex}]`) +
      ` — ${fn.returnCount} return site(s)` +
      (tags.length > 0 ? `  [${tags.join(', ')}]` : ''),
  );

  const groupedBySite = new Map<string, ReturnSite[]>();
  for (const rs of fn.returnSites) {
    const key = `${rs.returnInstructionOffset}`;
    const arr = groupedBySite.get(key) ?? [];
    arr.push(rs);
    groupedBySite.set(key, arr);
  }

  for (const [offset, sites] of groupedBySite) {
    const offStr = offset === '-1' ? 'implicit' : `offset=0x${parseInt(offset).toString(16)}`;
    console.log(`    return @ ${offStr}:`);
    for (const site of sites) printReturnSite(site);
  }
}

function printReport(report: WasmProvenanceReport): void {
  console.log(chalk.bold('\n=== WASM Return-Value Provenance Analysis ==='));
  console.log(`${chalk.bold('File:')}               ${report.file}`);
  console.log(`${chalk.bold('Imported functions:')} ${report.importedFunctionCount}`);
  console.log(`${chalk.bold('Defined functions:')}  ${report.definedFunctionCount}`);

  const s = report.statistics;
  console.log(chalk.bold('\n--- Statistics ---'));
  console.log(`  Total return sites:                ${s.totalReturnSites}`);
  console.log(`  Total return values analyzed:      ${s.totalReturnedValuesAnalyzed}`);
  console.log(`  Single-source returns:             ${s.singleSourceReturns}`);
  console.log(`  Multi-source returns:              ${s.multiSourceReturns}`);
  console.log(`  Parameter-derived results:         ${s.parameterDerivedResults}`);
  console.log(`  Global-derived results:            ${s.globalDerivedResults}`);
  console.log(`  Memory-derived results:            ${s.memoryDerivedResults}`);
  console.log(`  Call-derived results:              ${s.callDerivedResults}`);
  console.log(`  Constant-derived results:          ${s.constantDerivedResults}`);
  console.log(`  Unknown results:                   ${s.unknownResults}`);
  console.log(`  Deepest provenance chain:          ${s.deepestProvenanceChain}`);
  console.log(`  Funcs w/ mutable-state dep:        ${s.functionsWithMutableStateDependency}`);
  console.log(`  Funcs w/ parameter dep:            ${s.functionsWithParameterDependency}`);
  console.log(`  Funcs returning constants:         ${s.functionsReturningConstants}`);
  console.log(`  Funcs w/ call dep:                 ${s.functionsWithCallDependency}`);

  if (report.functions.length === 0) {
    console.log(chalk.dim('\n  (no defined functions with return values)'));
    return;
  }

  console.log(chalk.bold('\n--- Per-Function Provenance ---'));
  for (const fn of report.functions) {
    if (fn.returnSites.length > 0) printFunctionSummary(fn);
  }
}

// ---------------------------------------------------------------------------
// Public run entry point
// ---------------------------------------------------------------------------

export interface WasmReturnProvenanceParams {
  wasmFile?: string;
  compareFile?: string;
  json?: boolean;
  dot?: boolean;
  dotOutput?: string;
}

export async function run(params: WasmReturnProvenanceParams = {}): Promise<void> {
  if (!params.wasmFile) {
    // Fallback to bundled sample WASM when available
    const samplePath = path.resolve(
      __dirname,
      '../../contracts/sample/hello.wasm',
    );
    if (fs.existsSync(samplePath)) {
      params.wasmFile = samplePath;
    } else {
      throw new WasmProvenanceError(
        'Usage: stellar-api-inspector wasm-return-provenance <wasmFile> [compareFile] [--json] [--dot[=<path>]]',
      );
    }
  }

  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const emitDot = params.dot === true || typeof params.dotOutput === 'string';

  if (params.compareFile) {
    const result = compareProvenanceReports(params.wasmFile, params.compareFile);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(chalk.bold('\n=== WASM Return-Provenance Comparison ==='));
      console.log(chalk.bold('--- Before ---'));
      printReport(result.before);
      console.log(chalk.bold('\n--- After ---'));
      printReport(result.after);
      console.log(chalk.bold('\n--- Diff ---'));
      const c = result.comparison;
      console.log(`  Function count delta:    ${c.functionCountDelta >= 0 ? '+' : ''}${c.functionCountDelta}`);
      console.log(`  Return-site delta:       ${c.returnSiteDelta >= 0 ? '+' : ''}${c.returnSiteDelta}`);
      if (c.addedFunctions.length > 0)
        console.log(`  Added functions:         ${c.addedFunctions.join(', ')}`);
      if (c.removedFunctions.length > 0)
        console.log(`  Removed functions:       ${c.removedFunctions.join(', ')}`);
      if (c.newlyStateDerived.length > 0)
        console.log(chalk.yellow(`  Newly state-derived:     ${c.newlyStateDerived.join(', ')}`));
      if (c.newlyParameterDerived.length > 0)
        console.log(chalk.cyan(`  Newly parameter-derived: ${c.newlyParameterDerived.join(', ')}`));
      if (c.changedCallDependencies.length > 0)
        console.log(
          chalk.magenta(`  Call-dep changed:        ${c.changedCallDependencies.join(', ')}`),
        );
      if (c.changedFunctions.length > 0) {
        console.log(`  Changed functions:`);
        for (const cf of c.changedFunctions) {
          console.log(`    func[${cf.functionIndex}]: ${cf.changes.join(', ')}`);
        }
      }
    }
    if (emitDot) {
      const dotContent = result.after.dotGraph ?? '';
      if (params.dotOutput) {
        fs.writeFileSync(params.dotOutput, dotContent, 'utf8');
        console.log(`\nDOT graph written to: ${params.dotOutput}`);
      } else {
        console.log('\n--- DOT Graph (after) ---\n');
        console.log(dotContent);
      }
    }
    return;
  }

  const report = analyzeReturnProvenance(params.wasmFile);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (emitDot) {
    const dotContent = report.dotGraph ?? '';
    if (params.dotOutput) {
      fs.writeFileSync(params.dotOutput, dotContent, 'utf8');
      console.log(`\nDOT graph written to: ${params.dotOutput}`);
    } else {
      console.log('\n--- DOT Graph ---\n');
      console.log(dotContent);
    }
  }
}
