#!/usr/bin/env node

const { analyzeWasm, compareWasmArtifacts, recordsToCsv } = require('./analyzer');

function printHelp() {
  console.log('Usage: stellar-sdk-example-hub wasm-strings <wasmFile> [options]');
  console.log('       stellar-sdk-example-hub wasm-strings --compare <wasmFile1> <wasmFile2> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --min-len <n>         Minimum string length (default: 4)');
  console.log('  --max-len <n>         Maximum string length');
  console.log('  --section <type>      Filter by section type');
  console.log('  --encoding <enc>      Filter by encoding (ASCII, UTF-8)');
  console.log('  --search <pattern>    Search pattern');
  console.log('  --case-sensitive      Case-sensitive search');
  console.log('  --json                Output as JSON');
  console.log('  --csv                 Output as CSV');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const isCompare = args.includes('--compare');
  const jsonMode = args.includes('--json');
  const csvMode = args.includes('--csv');
  const caseSensitive = args.includes('--case-sensitive');

  let minLength = 4;
  let maxLength = Infinity;
  let sectionType = null;
  let encoding = null;
  let search = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--min-len' && args[i + 1]) minLength = parseInt(args[i + 1], 10);
    if (args[i] === '--max-len' && args[i + 1]) maxLength = parseInt(args[i + 1], 10);
    if (args[i] === '--section' && args[i + 1]) sectionType = args[i + 1];
    if (args[i] === '--encoding' && args[i + 1]) encoding = args[i + 1];
    if (args[i] === '--search' && args[i + 1]) search = args[i + 1];
  }

  if (isCompare) {
    const compareIndex = args.indexOf('--compare');
    const file1 = args[compareIndex + 1];
    const file2 = args[compareIndex + 2];
    if (!file1 || !file2) {
      console.error('Error: --compare requires two WASM files');
      process.exit(1);
    }
    const result = compareWasmArtifacts(file1, file2, { minLength, maxLength, sectionType, encoding, search, caseSensitive });
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  const wasmFile = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--min-len' && args[args.indexOf(arg) - 1] !== '--max-len' && args[args.indexOf(arg) - 1] !== '--section' && args[args.indexOf(arg) - 1] !== '--encoding' && args[args.indexOf(arg) - 1] !== '--search');

  if (!wasmFile) {
    console.error('Error: No WASM file specified');
    printHelp();
    process.exit(1);
  }

  try {
    const report = analyzeWasm(wasmFile, { minLength, maxLength, sectionType, encoding, search, caseSensitive });
    if (csvMode) {
      console.log(recordsToCsv(report.strings));
    } else if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(JSON.stringify(report, null, 2));
    }
  } catch (err) {
    console.error(`Error analyzing WASM: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
