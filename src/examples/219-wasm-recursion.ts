import chalk from 'chalk';

import {
  WasmRecursionReport,
  WasmScc,
  analyzeRecursion,
  compareRecursionReports,
} from '../utils/wasm-static-analysis';

/**
 * Example 219: Soroban Contract WASM Recursion and Call-Cycle Analysis
 *
 * Analyses recursive call patterns in a Soroban contract WASM artifact
 * without executing the contract. The analysis is completely offline.
 *
 * What it detects:
 *  - Direct self-recursion: a function that calls itself.
 *  - Mutual recursion: two or more functions that call each other in a cycle.
 *  - Multi-function recursive cycles (strongly connected components of 3+ nodes).
 *  - Conservatively resolved indirect-call cycles (call_indirect with element-
 *    section candidates), clearly distinguished from definite direct-call cycles.
 *
 * Analysis model:
 *  - Builds a normalised function call graph from statically resolvable call sites.
 *  - Detects strongly connected components (SCCs) using Tarjan's algorithm.
 *  - An SCC of size ≥ 2, or a single node with a self-edge, is recursive.
 *  - Unresolved indirect calls (no element-section candidates) are preserved
 *    separately and NOT treated as definite recursion.
 *  - Results are deterministic for the same input artifact.
 *
 * Limitations:
 *  - Dynamic dispatch (indirect calls with runtime table writes) may not be
 *    fully resolvable from static analysis alone.
 *  - Only the first active element segment per table slot is used for
 *    conservative resolution of call_indirect candidates.
 *  - Imported functions have no bodies; edges from them are not analysed.
 */

// ---------------------------------------------------------------------------
// DOT output
// ---------------------------------------------------------------------------

function generateDot(report: WasmRecursionReport): string {
  const lines: string[] = ['digraph wasm_recursion {', '  rankdir=LR;'];

  for (const scc of report.recursiveSccs) {
    const label = scc.kind.replace(/_/g, ' ');
    lines.push(`  subgraph cluster_scc${scc.id} {`);
    lines.push(`    label="${label} (SCC ${scc.id})";`);
    lines.push('    style=filled; color=lightyellow;');
    for (const m of scc.members) {
      lines.push(`    fn${m} [label="fn${m}"];`);
    }
    lines.push('  }');
  }

  // Emit intra-SCC edges
  for (const scc of report.recursiveSccs) {
    for (const e of scc.internalEdges) {
      const style = e.callType === 'indirect' ? 'dashed' : 'solid';
      lines.push(
        `  fn${e.callerIndex} -> fn${e.calleeIndex} [style=${style} label="@${e.instructionOffset}"];`,
      );
    }
  }

  lines.push('}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Human-readable output helpers
// ---------------------------------------------------------------------------

function printScc(scc: WasmScc, index: number): void {
  const kindLabel: Record<string, string> = {
    direct_self_recursion: chalk.red('direct self-recursion'),
    mutual_recursion_two: chalk.yellow('mutual recursion (2 functions)'),
    multi_function_cycle: chalk.magenta('multi-function cycle'),
    non_recursive: chalk.dim('non-recursive'),
  };

  console.log(
    `  ${chalk.bold(`[SCC ${index}]`)} ${kindLabel[scc.kind] ?? scc.kind}  ` +
      `members: [${scc.members.join(', ')}]  ` +
      `edges: ${scc.internalEdges.length}  ` +
      (scc.shortestCycleLength !== null
        ? `shortest-cycle: ${scc.shortestCycleLength}`
        : 'no cycle (non-recursive)') +
      (scc.hasIndirectCycle ? chalk.cyan('  [+indirect candidate]') : ''),
  );

  for (const e of scc.internalEdges) {
    const typeLabel = e.callType === 'indirect' ? chalk.cyan(' [indirect]') : '';
    console.log(
      `    fn${e.callerIndex} → fn${e.calleeIndex}${typeLabel}  offset: 0x${e.instructionOffset.toString(16)}`,
    );
  }
}

function printReport(report: WasmRecursionReport): void {
  console.log(chalk.bold('\n=== WASM Recursion & Call-Cycle Analysis ==='));
  console.log(`${chalk.bold('File:')} ${report.file}`);

  const s = report.statistics;
  console.log(`${chalk.bold('Total functions:')} ${s.totalFunctions}`);
  console.log(`${chalk.bold('Direct call edges:')} ${s.totalDirectCallEdges}`);
  console.log(`${chalk.bold('Indirect call sites:')} ${s.totalIndirectCallSites}`);
  if (s.totalUnresolvedIndirectCalls > 0) {
    console.log(
      chalk.dim(
        `  (${s.totalUnresolvedIndirectCalls} indirect call site(s) could not be resolved — not treated as definite recursion)`,
      ),
    );
  }

  if (s.recursiveFunctionCount === 0) {
    console.log(chalk.green('\nNo recursive functions detected.'));
  } else {
    console.log(
      chalk.yellow(`\nRecursive functions: ${s.recursiveFunctionCount}`) +
        `  (in ${s.recursiveComponentCount} component(s))`,
    );
    console.log(
      `  Self-recursive:     ${s.directSelfRecursiveFunctionCount}  ` +
        `Multi-function cycles: ${s.mutualRecursionComponentCount}`,
    );
    console.log(`  Largest component:  ${s.largestRecursiveComponentSize} functions`);
    console.log(
      `  Min cycle length:   ${s.minimumCycleLength ?? 'n/a'}  ` +
        `Avg component size: ${s.averageRecursiveComponentSize.toFixed(2)}`,
    );

    console.log(chalk.bold('\nRecursive strongly connected components:'));
    report.recursiveSccs.forEach((scc, i) => printScc(scc, i));

    if (report.mostConnectedRecursiveFunctions.length > 0) {
      console.log(chalk.bold('\nMost connected recursive functions:'));
      report.mostConnectedRecursiveFunctions.slice(0, 10).forEach(({ functionIndex, edgeCount }) =>
        console.log(`  fn${functionIndex}: ${edgeCount} recursive edge(s)`),
      );
    }
  }

  if (report.indirectCallCandidates.length > 0) {
    console.log(chalk.bold('\nIndirect call sites (conservative resolution):'));
    for (const c of report.indirectCallCandidates.slice(0, 20)) {
      const resolved =
        c.candidateCallees.length > 0
          ? `→ [${c.candidateCallees.join(', ')}]`
          : chalk.red('unresolved');
      console.log(
        `  fn${c.callerIndex}  call_indirect (table ${c.tableIndex}, type ${c.typeIndex})  offset: 0x${c.instructionOffset.toString(16)}  ${resolved}`,
      );
    }
    if (report.indirectCallCandidates.length > 20) {
      console.log(chalk.dim(`  … and ${report.indirectCallCandidates.length - 20} more`));
    }
  }
}

function printComparison(
  result: ReturnType<typeof compareRecursionReports>,
): void {
  const { comparison } = result;
  console.log(chalk.bold('\n--- Recursion Comparison ---'));

  if (comparison.newlyRecursiveFunctions.length > 0) {
    console.log(
      chalk.red(`Newly recursive functions (+${comparison.newlyRecursiveFunctions.length}): `) +
        comparison.newlyRecursiveFunctions.map((f) => `fn${f}`).join(', '),
    );
  }
  if (comparison.removedRecursiveFunctions.length > 0) {
    console.log(
      chalk.green(`Removed recursion (-${comparison.removedRecursiveFunctions.length}): `) +
        comparison.removedRecursiveFunctions.map((f) => `fn${f}`).join(', '),
    );
  }
  if (comparison.introducedSccs.length > 0) {
    console.log(chalk.red(`Introduced SCCs: ${comparison.introducedSccs.length}`));
    comparison.introducedSccs.forEach((s) =>
      console.log(`  + [${s.members.join(', ')}]  ${s.kind}`),
    );
  }
  if (comparison.removedSccs.length > 0) {
    console.log(chalk.green(`Removed SCCs: ${comparison.removedSccs.length}`));
    comparison.removedSccs.forEach((s) =>
      console.log(`  - [${s.members.join(', ')}]  ${s.kind}`),
    );
  }
  if (comparison.changedSccs.length > 0) {
    console.log(chalk.yellow(`Changed SCCs: ${comparison.changedSccs.length}`));
    comparison.changedSccs.forEach(({ before, after, changes }) =>
      console.log(
        `  ~ [${before.members.join(', ')}]  changes: ${changes.join(', ')}  ` +
          `cycle: ${before.shortestCycleLength ?? '?'} → ${after.shortestCycleLength ?? '?'}`,
      ),
    );
  }
  if (
    comparison.newlyRecursiveFunctions.length === 0 &&
    comparison.removedRecursiveFunctions.length === 0 &&
    comparison.introducedSccs.length === 0 &&
    comparison.removedSccs.length === 0 &&
    comparison.changedSccs.length === 0
  ) {
    console.log(chalk.green('No recursion changes detected between artifacts.'));
  } else {
    console.log(
      `\nRecursive-component count delta: ${comparison.recursiveComponentCountDelta >= 0 ? '+' : ''}${comparison.recursiveComponentCountDelta}`,
    );
    console.log(
      `Recursive-function count delta:  ${comparison.recursiveFunctionCountDelta >= 0 ? '+' : ''}${comparison.recursiveFunctionCountDelta}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function run(
  params: {
    wasmFile?: string;
    compareFile?: string;
    json?: boolean;
    dot?: boolean;
    maxCycles?: number;
  } = {},
): Promise<void> {
  const wasmFile = params.wasmFile ?? process.env.WASM_FILE;
  if (!wasmFile) {
    throw new Error(
      'Usage: stellar-api-inspector wasm-recursion <wasmFile> [compareFile] [--json] [--dot] [--max-cycles <n>]',
    );
  }

  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const dot = params.dot === true;
  const maxCycles = params.maxCycles ?? Number(process.env.MAX_CYCLES ?? '0');
  const compareFile = params.compareFile ?? process.env.COMPARE_WASM_FILE;

  if (compareFile) {
    const result = compareRecursionReports(wasmFile, compareFile, { maxCycles });
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

  const report = analyzeRecursion(wasmFile, { maxCycles });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (dot) {
    console.log(generateDot(report));
    return;
  }

  printReport(report);
}
