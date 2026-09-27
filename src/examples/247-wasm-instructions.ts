import chalk from 'chalk';

import { analyzeInstructions } from '../utils/wasm-static-analysis';

export function compareInstructionReports(beforeFile: string, afterFile: string) {
  const before = analyzeInstructions(beforeFile);
  const after = analyzeInstructions(afterFile);
  return {
    before,
    after,
    comparison: {
      definedFunctionDelta: after.totalDefinedFunctions - before.totalDefinedFunctions,
      instructionCountDelta: after.totalInstructionCount - before.totalInstructionCount,
      codeBodySizeDelta: after.totalCodeBodySize - before.totalCodeBodySize,
      frequencyDelta: Object.fromEntries(
        [
          ...new Set([
            ...Object.keys(before.instructionFrequencies),
            ...Object.keys(after.instructionFrequencies),
          ]),
        ]
          .sort()
          .map((name) => [
            name,
            (after.instructionFrequencies[name] ?? 0) - (before.instructionFrequencies[name] ?? 0),
          ]),
      ),
    },
  };
}

function printReport(report: ReturnType<typeof analyzeInstructions>): void {
  console.log(chalk.bold('\n=== WASM Instruction Statistics ==='));
  console.log(`${chalk.bold('File:')} ${report.file}`);
  console.log(`${chalk.bold('Defined functions:')} ${report.totalDefinedFunctions}`);
  console.log(`${chalk.bold('Instructions:')} ${report.totalInstructionCount}`);
  console.log(
    `${chalk.bold('Average/function:')} ${report.averageInstructionsPerFunction.toFixed(2)}`,
  );
  console.log(`${chalk.bold('Code body size:')} ${report.totalCodeBodySize} bytes`);
  Object.entries(report.instructionFrequencies).forEach(([name, count]) => {
    console.log(`  ${name}: ${count}`);
  });
}

export async function run(
  params: { wasmFile?: string; compareFile?: string; json?: boolean } = {},
): Promise<void> {
  if (!params.wasmFile)
    throw new Error(
      'Usage: stellar-api-inspector wasm-instructions <wasmFile> [compareFile] [--json]',
    );
  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const output = params.compareFile
    ? compareInstructionReports(params.wasmFile, params.compareFile)
    : analyzeInstructions(params.wasmFile);
  if (json) console.log(JSON.stringify(output, null, 2));
  else if ('comparison' in output) {
    printReport(output.before);
    printReport(output.after);
    console.log(chalk.bold('\n--- Comparison ---'));
    console.log(`Defined function delta: ${output.comparison.definedFunctionDelta}`);
    console.log(`Instruction delta:      ${output.comparison.instructionCountDelta}`);
    console.log(`Code body size delta:   ${output.comparison.codeBodySizeDelta}`);
  } else printReport(output);
}
