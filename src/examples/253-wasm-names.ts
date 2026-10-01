import chalk from 'chalk';

import { analyzeWasmNames } from '../utils/wasm-static-analysis';

type NameReport = ReturnType<typeof analyzeWasmNames>;
type NamedEntry = { index: number; name: string; status: 'named' };

function displayName(entry: { name: string | null; status: string }): string {
  if (entry.status === 'explicitly-unnamed') return '<explicitly unnamed>';
  return entry.name === null ? `<${entry.status}>` : JSON.stringify(entry.name);
}

function isNamed(entry: {
  index: number;
  name: string | null;
  status: string;
}): entry is NamedEntry {
  return entry.status === 'named' && entry.name !== null;
}

export function compareWasmNameReports(beforeFile: string, afterFile: string) {
  const before = analyzeWasmNames(beforeFile);
  const after = analyzeWasmNames(afterFile);
  const beforeFunctions = new Map(before.functions.map((fn) => [fn.functionIndex, fn]));
  const afterFunctions = new Map(after.functions.map((fn) => [fn.functionIndex, fn]));
  const functionIndexes = [...new Set([...beforeFunctions.keys(), ...afterFunctions.keys()])].sort(
    (a, b) => a - b,
  );
  const addedFunctionNames: Array<{ functionIndex: number; name: string }> = [];
  const removedFunctionNames: Array<{ functionIndex: number; name: string }> = [];
  const renamedFunctions: Array<{ functionIndex: number; before: string; after: string }> = [];
  const addedLocalNames: Array<{ functionIndex: number; localIndex: number; name: string }> = [];
  const removedLocalNames: Array<{ functionIndex: number; localIndex: number; name: string }> = [];
  const changedLocalNames: Array<{
    functionIndex: number;
    localIndex: number;
    before: string;
    after: string;
  }> = [];

  functionIndexes.forEach((functionIndex) => {
    const beforeFunction = beforeFunctions.get(functionIndex);
    const afterFunction = afterFunctions.get(functionIndex);
    const wasNamed = beforeFunction ? isNamed(beforeFunction) : false;
    const isNowNamed = afterFunction ? isNamed(afterFunction) : false;
    if (!wasNamed && afterFunction && isNamed(afterFunction)) {
      addedFunctionNames.push({ functionIndex, name: afterFunction.name });
    } else if (beforeFunction && isNamed(beforeFunction) && !isNowNamed) {
      removedFunctionNames.push({ functionIndex, name: beforeFunction.name });
    } else if (
      beforeFunction &&
      afterFunction &&
      isNamed(beforeFunction) &&
      isNamed(afterFunction) &&
      beforeFunction.name !== afterFunction.name
    ) {
      renamedFunctions.push({
        functionIndex,
        before: beforeFunction.name,
        after: afterFunction.name,
      });
    }

    const beforeLocals = new Map(
      (beforeFunction?.locals ?? []).filter(isNamed).map((local) => [local.index, local.name]),
    );
    const afterLocals = new Map(
      (afterFunction?.locals ?? []).filter(isNamed).map((local) => [local.index, local.name]),
    );
    const localIndexes = [...new Set([...beforeLocals.keys(), ...afterLocals.keys()])].sort(
      (a, b) => a - b,
    );
    localIndexes.forEach((localIndex) => {
      const beforeName = beforeLocals.get(localIndex);
      const afterName = afterLocals.get(localIndex);
      if (beforeName === undefined && afterName !== undefined) {
        addedLocalNames.push({ functionIndex, localIndex, name: afterName });
      } else if (beforeName !== undefined && afterName === undefined) {
        removedLocalNames.push({ functionIndex, localIndex, name: beforeName });
      } else if (beforeName !== undefined && afterName !== undefined && beforeName !== afterName) {
        changedLocalNames.push({ functionIndex, localIndex, before: beforeName, after: afterName });
      }
    });
  });

  return {
    before,
    after,
    comparison: {
      addedFunctionNames,
      removedFunctionNames,
      renamedFunctions,
      addedLocalNames,
      removedLocalNames,
      changedLocalNames,
    },
  };
}

function printReport(report: NameReport): void {
  console.log(chalk.bold('\n=== WASM Name Section Analysis ==='));
  console.log(`${chalk.bold('File:')} ${report.file}`);
  console.log(
    `${chalk.bold('Name section:')} ${report.nameSection.present ? `present (${report.nameSection.count})` : 'absent'}`,
  );
  console.log(`${chalk.bold('Named functions:')} ${report.statistics.totalNamedFunctions}`);
  console.log(`${chalk.bold('Unnamed functions:')} ${report.statistics.totalUnnamedFunctions}`);
  console.log(
    `${chalk.bold('Functions with local-name metadata:')} ${report.statistics.totalFunctionsWithLocalNameMetadata}`,
  );
  console.log(`${chalk.bold('Named locals:')} ${report.statistics.totalNamedLocals}`);
  report.nameSection.subsections.forEach(({ id, name }) =>
    console.log(`  Subsection ${id}: ${name}`),
  );
  report.functions.forEach((fn) => {
    console.log(
      `  function[${fn.functionIndex}] ${fn.name === null ? `<${fn.status}>` : JSON.stringify(fn.name)}`,
    );
    fn.locals.forEach((local) => {
      console.log(`    local[${local.index}] ${displayName(local)}`);
    });
    fn.unnamedLocalRanges.forEach(({ startIndex, endIndex }) =>
      console.log(
        `    local[${startIndex}${endIndex === startIndex ? '' : `..${endIndex}`}] <unmapped>`,
      ),
    );
  });
  if (report.statistics.functionsWithMostNamedLocals.length > 0) {
    console.log(`${chalk.bold('Functions with the most named locals:')}`);
    report.statistics.functionsWithMostNamedLocals.forEach(({ functionIndex, name, count }) =>
      console.log(`  function[${functionIndex}] ${name ?? '<unnamed>'}: ${count}`),
    );
  }
  report.functionsWithIncompleteLocalNames.forEach((functionIndex) =>
    console.log(`  Incomplete local naming: function[${functionIndex}]`),
  );
  report.warnings.forEach((warning) => console.log(`${chalk.yellow('Warning:')} ${warning}`));
}

export async function run(
  params: { wasmFile?: string; compareFile?: string; json?: boolean } = {},
): Promise<void> {
  if (!params.wasmFile) throw new Error('Usage: wasm-names <wasmFile> [compareFile] [--json]');
  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const output = params.compareFile
    ? compareWasmNameReports(params.wasmFile, params.compareFile)
    : analyzeWasmNames(params.wasmFile);
  if (json) console.log(JSON.stringify(output, null, 2));
  else if ('comparison' in output) {
    printReport(output.before);
    printReport(output.after);
    console.log(chalk.bold('\n--- Name Comparison ---'));
    Object.entries(output.comparison).forEach(([name, entries]) => {
      console.log(`${name}: ${entries.length}`);
      entries.forEach((entry) => console.log(`  ${JSON.stringify(entry)}`));
    });
  } else printReport(output);
}
