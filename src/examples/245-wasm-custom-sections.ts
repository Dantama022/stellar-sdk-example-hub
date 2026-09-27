import chalk from 'chalk';

import {
  WasmCustomSectionInfo,
  analyzeCustomSections,
  compareBySignature,
} from '../utils/wasm-static-analysis';

export function compareCustomSectionReports(beforeFile: string, afterFile: string) {
  const before = analyzeCustomSections(beforeFile);
  const after = analyzeCustomSections(afterFile);
  return {
    before,
    after,
    comparison: compareBySignature(
      before.sections,
      after.sections,
      (item) => `${item.name}:${item.order}`,
      (item) => JSON.stringify([item.name, item.payloadSize, item.payloadHash]),
      (a, b) => customChanges(a, b),
    ),
  };
}

function customChanges(before: WasmCustomSectionInfo, after: WasmCustomSectionInfo): string[] {
  const changes: string[] = [];
  if (before.payloadSize !== after.payloadSize) changes.push('payload_size');
  if (before.payloadHash !== after.payloadHash) changes.push('payload_hash');
  return changes;
}

function printReport(report: ReturnType<typeof analyzeCustomSections>): void {
  console.log(chalk.bold('\n=== WASM Custom Section Analysis ==='));
  console.log(`${chalk.bold('File:')} ${report.file}`);
  console.log(`${chalk.bold('Sections:')} ${report.statistics.customSectionCount}`);
  console.log(
    `${chalk.bold('Total payload size:')} ${report.statistics.totalCustomSectionSize} bytes`,
  );
  report.sections.forEach((section) => {
    console.log(
      `  [${section.order}] ${section.name} size=${section.payloadSize} sha256=${section.payloadHash}`,
    );
  });
}

export async function run(
  params: { wasmFile?: string; compareFile?: string; json?: boolean } = {},
): Promise<void> {
  if (!params.wasmFile)
    throw new Error(
      'Usage: stellar-api-inspector wasm-custom-sections <wasmFile> [compareFile] [--json]',
    );
  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const output = params.compareFile
    ? compareCustomSectionReports(params.wasmFile, params.compareFile)
    : analyzeCustomSections(params.wasmFile);
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
