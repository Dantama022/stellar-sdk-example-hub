const fs = require('fs');
const { parseWasmModule, detectFeatures, compareFeatures } = require('../lib/wasm-features');

async function run() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: stellar-sdk-example-hub wasm-features <wasmFile> [--compare <wasmFile2>] [--json]');
    process.exit(1);
  }

  const wasmFile = args[0];
  const compareIndex = args.indexOf('--compare');
  const jsonOutput = args.includes('--json');
  const wasmFile2 = compareIndex !== -1 ? args[compareIndex + 1] : null;

  try {
    const buffer = fs.readFileSync(wasmFile);
    const module = parseWasmModule(buffer);
    const features = detectFeatures(module);

    if (wasmFile2) {
      const buffer2 = fs.readFileSync(wasmFile2);
      const module2 = parseWasmModule(buffer2);
      const features2 = detectFeatures(module2);
      const comparison = compareFeatures(features, features2);

      if (jsonOutput) {
        console.log(JSON.stringify(comparison, null, 2));
      } else {
        console.log('Comparison Results:');
        console.log(`New features: ${comparison.newFeatures.join(', ') || 'None'}`);
        console.log(`Removed features: ${comparison.removedFeatures.join(', ') || 'None'}`);
        console.log('Changed counts:');
        for (const [feature, change] of Object.entries(comparison.changedCounts)) {
          console.log(`  ${feature}: ${change.old} -> ${change.new}`);
        }
      }
    } else {
      if (jsonOutput) {
        console.log(JSON.stringify(features, null, 2));
      } else {
        console.log('WASM Feature Analysis:');
        console.log('Detected Features:');
        for (const [feature, data] of Object.entries(features.detected)) {
          console.log(`  ${feature}:`);
          console.log(`    Occurrences: ${data.count}`);
          console.log(`    Functions: ${data.functions.join(', ') || 'None'}`);
          console.log(`    Locations: ${data.locations.join(', ') || 'None'}`);
        }
        console.log('\nUndetected Features:');
        console.log(features.undetected.join(', '));
        console.log('\nUnknown Features:');
        console.log(features.unknown.join(', '));
      }
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

run();