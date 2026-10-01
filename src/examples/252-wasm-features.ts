import {
  analyzeWasmFeatureFile,
  compareWasmFeatureProfiles,
  WasmFeatureName,
  WasmFeatureProfile,
} from '../utils/wasm-feature-analysis';

const featureNames: WasmFeatureName[] = [
  'atomic-instructions',
  'bulk-memory',
  'element-initialization',
  'exceptions',
  'indirect-calls',
  'memory-initialization',
  'memory64',
  'multiple-memories',
  'multiple-tables',
  'reference-types',
  'shared-memory',
  'simd',
  'tail-calls',
  'table-instructions',
  'typed-function-references',
];

export function parseWasmFeatureArgs(args: string[]): {
  wasmFile?: string;
  compareFile?: string;
  json: boolean;
} {
  const json = args.includes('--json') || args.includes('--json=true');
  const files = args.filter((arg) => arg !== '--json' && arg !== '--json=true');
  if (files.length > 2) throw new Error('Usage: wasm-features <wasmFile> [compareFile] [--json].');
  return { wasmFile: files[0], compareFile: files[1], json };
}

function printProfile(title: string, profile: WasmFeatureProfile): void {
  console.log(`${title}${profile.file ? ` (${profile.file})` : ''}`);
  console.log(
    `Functions scanned: ${profile.functionsScanned}; instruction scan: ${profile.instructionScanComplete ? 'complete' : 'partial'}`,
  );
  for (const name of featureNames) {
    const feature = profile.features[name];
    console.log(
      `${name}: ${feature.status} (${feature.occurrenceCount} occurrences; ${feature.functionsUsing.length} functions)`,
    );
    for (const occurrence of feature.occurrences) {
      const location =
        occurrence.functionIndex === null
          ? occurrence.section
          : `${occurrence.section}, function ${occurrence.functionIndex}${occurrence.instructionOffset === null ? '' : `+0x${occurrence.instructionOffset.toString(16)}`}`;
      console.log(`  ${location}: ${occurrence.detail}`);
    }
  }
  for (const warning of profile.warnings) console.log(`Warning: ${warning}`);
}

export function run(options: { wasmFile?: string; compareFile?: string; json?: boolean }): void {
  if (!options.wasmFile) throw new Error('Usage: wasm-features <wasmFile> [compareFile] [--json].');
  const before = analyzeWasmFeatureFile(options.wasmFile);
  const result = options.compareFile
    ? compareWasmFeatureProfiles(before, analyzeWasmFeatureFile(options.compareFile))
    : before;

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!('before' in result)) {
    printProfile('WASM feature profile', result);
    return;
  }
  printProfile('Before', result.before);
  printProfile('After', result.after);
  console.log(`New features: ${result.newlyIntroducedFeatures.join(', ') || 'none'}`);
  console.log(`Removed features: ${result.removedFeatures.join(', ') || 'none'}`);
  for (const change of result.changedUsageCounts) {
    console.log(`Changed count: ${change.feature} ${change.beforeCount} -> ${change.afterCount}`);
  }
  for (const change of result.functionsNewlyUsingFeatures) {
    console.log(`Newly using ${change.feature}: ${change.newlyUsingFunctions.join(', ')}`);
  }
  for (const change of result.functionsNoLongerUsingFeatures) {
    console.log(`No longer using ${change.feature}: ${change.noLongerUsingFunctions.join(', ')}`);
  }
}
