import chalk from 'chalk';

import {
  analyzeWasmProvenance,
  WasmProducerInfo,
  WasmProvenanceReport,
} from '../utils/wasm-static-analysis';

export interface WasmProvenanceComparison {
  before: WasmProvenanceReport;
  after: WasmProvenanceReport;
  comparison: {
    addedProducers: WasmProducerInfo[];
    removedProducers: WasmProducerInfo[];
    versionChanges: Array<{ before: WasmProducerInfo; after: WasmProducerInfo }>;
    categoryChanges: Array<{ before: WasmProducerInfo; after: WasmProducerInfo }>;
    fieldChanges: Array<{ before: WasmProducerInfo; after: WasmProducerInfo }>;
    unchangedProvenance: boolean;
    evidenceSufficient: boolean;
    materiallyDifferentProducerChains: boolean;
  };
}

export function compareProvenanceReports(
  beforeFile: string,
  afterFile: string,
): WasmProvenanceComparison {
  const before = analyzeWasmProvenance(beforeFile);
  const after = analyzeWasmProvenance(afterFile);
  const unmatchedAfter = [...after.producers];
  const addedProducers: WasmProducerInfo[] = [];
  const removedProducers: WasmProducerInfo[] = [];
  const versionChanges: WasmProvenanceComparison['comparison']['versionChanges'] = [];
  const categoryChanges: WasmProvenanceComparison['comparison']['categoryChanges'] = [];
  const fieldChanges: WasmProvenanceComparison['comparison']['fieldChanges'] = [];

  before.producers.forEach((producer) => {
    const matchIndex = unmatchedAfter.findIndex((candidate) => candidate.name === producer.name);
    if (matchIndex === -1) {
      removedProducers.push(producer);
      return;
    }
    const [match] = unmatchedAfter.splice(matchIndex, 1);
    if (producer.version !== match.version) versionChanges.push({ before: producer, after: match });
    if (producer.category !== match.category)
      categoryChanges.push({ before: producer, after: match });
    if (producer.field !== match.field) fieldChanges.push({ before: producer, after: match });
  });
  addedProducers.push(...unmatchedAfter);

  const unchangedProvenance = before.fingerprint === after.fingerprint;
  const evidenceSufficient =
    before.provenanceStatus === 'available' &&
    after.provenanceStatus === 'available' &&
    before.producers.length > 0 &&
    after.producers.length > 0;
  return {
    before,
    after,
    comparison: {
      addedProducers,
      removedProducers,
      versionChanges,
      categoryChanges,
      fieldChanges,
      unchangedProvenance,
      evidenceSufficient,
      materiallyDifferentProducerChains:
        evidenceSufficient &&
        (addedProducers.length > 0 ||
          removedProducers.length > 0 ||
          versionChanges.length > 0 ||
          categoryChanges.length > 0 ||
          fieldChanges.length > 0),
    },
  };
}

function printReport(report: WasmProvenanceReport): void {
  console.log(chalk.bold('\n=== WASM Compiler Provenance ==='));
  console.log(`${chalk.bold('File:')} ${report.file}`);
  console.log(`${chalk.bold('Provenance:')} ${report.provenanceStatus}`);
  console.log(
    `${chalk.bold('Module:')} WASM v${report.module.wasmVersion}, ${report.module.functionCount} functions, ${report.module.importCount} imports, ${report.module.exportCount} exports, ${report.module.codeSize} code bytes`,
  );
  console.log(
    `${chalk.bold('Custom sections:')} ${report.module.customSections.present ? report.module.customSections.names.join(', ') : 'none'}`,
  );
  if (report.producers.length === 0) console.log('  No producer records found');
  report.producers.forEach((producer) => {
    console.log(
      `  [${producer.order}] ${producer.category} (${producer.field}): ${producer.name}${producer.version ? ` ${producer.version}` : ''}`,
    );
  });
  report.warnings.forEach((warning) => console.log(chalk.yellow(`Warning: ${warning}`)));
  console.log(`${chalk.bold('Fingerprint:')} ${report.fingerprint}`);
}

export async function run(
  params: { wasmFile?: string; compareFile?: string; json?: boolean } = {},
): Promise<void> {
  if (!params.wasmFile) {
    throw new Error(
      'Usage: stellar-api-inspector wasm-provenance <wasmFile> [compareFile] [--json]',
    );
  }
  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const output = params.compareFile
    ? compareProvenanceReports(params.wasmFile, params.compareFile)
    : analyzeWasmProvenance(params.wasmFile);
  if (json) console.log(JSON.stringify(output, null, 2));
  else if ('comparison' in output) {
    printReport(output.before);
    printReport(output.after);
    console.log(chalk.bold('\n--- Provenance Comparison ---'));
    console.log(`Added producers: ${output.comparison.addedProducers.length}`);
    console.log(`Removed producers: ${output.comparison.removedProducers.length}`);
    console.log(`Version changes: ${output.comparison.versionChanges.length}`);
    console.log(`Category changes: ${output.comparison.categoryChanges.length}`);
    console.log(`Unchanged provenance: ${output.comparison.unchangedProvenance}`);
    console.log(
      `Materially different chains: ${output.comparison.materiallyDifferentProducerChains}`,
    );
  } else printReport(output);
}
