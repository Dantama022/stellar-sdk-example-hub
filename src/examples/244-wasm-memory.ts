import chalk from 'chalk';

import {
  WasmMemoryInfo,
  WasmTableInfo,
  analyzeMemoryTables,
  compareBySignature,
} from '../utils/wasm-static-analysis';

export function compareMemoryTableReports(beforeFile: string, afterFile: string) {
  const before = analyzeMemoryTables(beforeFile);
  const after = analyzeMemoryTables(afterFile);
  return {
    before,
    after,
    comparison: {
      memories: compareBySignature(
        before.memories,
        after.memories,
        (item) => String(item.index),
        (item) => JSON.stringify([item.source, item.module, item.name, item.limits]),
        (a, b) => memoryChanges(a, b),
      ),
      tables: compareBySignature(
        before.tables,
        after.tables,
        (item) => String(item.index),
        (item) =>
          JSON.stringify([item.source, item.module, item.name, item.elementType, item.limits]),
        (a, b) => tableChanges(a, b),
      ),
    },
  };
}

function memoryChanges(before: WasmMemoryInfo, after: WasmMemoryInfo): string[] {
  const changes: string[] = [];
  if (before.limits.initial !== after.limits.initial) changes.push('initial_limit');
  if (before.limits.maximum !== after.limits.maximum) changes.push('maximum_limit');
  if (before.source !== after.source) changes.push('source');
  return changes;
}

function tableChanges(before: WasmTableInfo, after: WasmTableInfo): string[] {
  const changes: string[] = [];
  if (before.elementType !== after.elementType) changes.push('element_type');
  if (before.limits.initial !== after.limits.initial) changes.push('initial_limit');
  if (before.limits.maximum !== after.limits.maximum) changes.push('maximum_limit');
  if (before.source !== after.source) changes.push('source');
  return changes;
}

function printReport(report: ReturnType<typeof analyzeMemoryTables>): void {
  console.log(chalk.bold('\n=== WASM Memory and Table Analysis ==='));
  console.log(`${chalk.bold('File:')} ${report.file}`);
  console.log(
    `${chalk.bold('Memories:')} ${report.statistics.memoryCount} (${report.statistics.importedMemoryCount} imported, ${report.statistics.definedMemoryCount} defined)`,
  );
  report.memories.forEach((memory) => {
    console.log(
      `  [${memory.index}] ${memory.source} initial=${memory.limits.initial} max=${memory.limits.maximum ?? 'unbounded'}`,
    );
  });
  console.log(
    `${chalk.bold('Tables:')} ${report.statistics.tableCount} (${report.statistics.importedTableCount} imported, ${report.statistics.definedTableCount} defined)`,
  );
  report.tables.forEach((table) => {
    console.log(
      `  [${table.index}] ${table.source} ${table.elementType} initial=${table.limits.initial} max=${table.limits.maximum ?? 'unbounded'}`,
    );
  });
}

export async function run(
  params: { wasmFile?: string; compareFile?: string; json?: boolean } = {},
): Promise<void> {
  if (!params.wasmFile)
    throw new Error('Usage: stellar-api-inspector wasm-memory <wasmFile> [compareFile] [--json]');
  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const output = params.compareFile
    ? compareMemoryTableReports(params.wasmFile, params.compareFile)
    : analyzeMemoryTables(params.wasmFile);
  if (json) console.log(JSON.stringify(output, null, 2));
  else if ('comparison' in output) {
    printReport(output.before);
    printReport(output.after);
    console.log(chalk.bold('\n--- Comparison ---'));
    console.log(
      `Memory added/removed/changed: ${output.comparison.memories.added.length}/${output.comparison.memories.removed.length}/${output.comparison.memories.changed.length}`,
    );
    console.log(
      `Table added/removed/changed:  ${output.comparison.tables.added.length}/${output.comparison.tables.removed.length}/${output.comparison.tables.changed.length}`,
    );
  } else printReport(output);
}
