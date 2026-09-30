import { readFileSync } from 'fs';
import { argv } from 'process';
import { computeFingerprints, compareFingerprints } from './src/wasm-fingerprint';

function printUsage() {
  console.log('Usage: npm run example wasm-fingerprint <wasmFile> [wasmFile2] [--json]');
  console.log('');
  console.log('Examples:');
  console.log('  npm run example wasm-fingerprint ./contract.wasm');
  console.log('  npm run example wasm-fingerprint ./contract1.wasm ./contract2.wasm');
  console.log('  npm run example wasm-fingerprint ./contract.wasm --json');
}

async function main() {
  const args = argv.slice(2);
  
  if (args.length === 0 || args.includes('--help')) {
    printUsage();
    process.exit(1);
  }

  const jsonOutput = args.includes('--json');
  const files = args.filter(arg => !arg.startsWith('--'));

  if (files.length < 1 || files.length > 2) {
    console.error('Error: Expected 1 or 2 WASM files');
    printUsage();
    process.exit(1);
  }

  try {
    if (files.length === 1) {
      const wasmBuffer = readFileSync(files[0]);
      const fingerprints = computeFingerprints(wasmBuffer);
      
      if (jsonOutput) {
        console.log(JSON.stringify(fingerprints, null, 2));
      } else {
        console.log('Raw Binary Fingerprint:', fingerprints.rawBinaryFingerprint);
        console.log('Semantic Module Fingerprint:', fingerprints.semanticModuleFingerprint);
        console.log('Type Fingerprint:', fingerprints.typeFingerprint);
        console.log('Import/Export Fingerprint:', fingerprints.importExportFingerprint);
        console.log('Code Fingerprint:', fingerprints.codeFingerprint);
        console.log('Memory/Table Fingerprint:', fingerprints.memoryTableFingerprint);
        console.log('Global Fingerprint:', fingerprints.globalFingerprint);
        console.log('Data/Element Fingerprint:', fingerprints.dataElementFingerprint);
      }
    } else {
      const wasmBuffer1 = readFileSync(files[0]);
      const wasmBuffer2 = readFileSync(files[1]);
      const comparison = compareFingerprints(wasmBuffer1, wasmBuffer2);
      
      if (jsonOutput) {
        console.log(JSON.stringify(comparison, null, 2));
      } else {
        console.log('Comparison Results:');
        console.log('File 1:', files[0]);
        console.log('File 2:', files[1]);
        console.log('Binary Match:', comparison.binaryMatch ? 'Yes' : 'No');
        console.log('Semantic Match:', comparison.semanticMatch ? 'Yes' : 'No');
        console.log('Difference Type:', comparison.differenceType);
        
        if (comparison.changedComponents.length > 0) {
          console.log('Changed Components:', comparison.changedComponents.join(', '));
        }
      }
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
