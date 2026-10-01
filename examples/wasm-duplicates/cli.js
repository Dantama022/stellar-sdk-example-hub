#!/usr/bin/env node

const { program } = require('commander');
const fs = require('fs');
const path = require('path');
const { analyzeWasm } = require('./analyzer');
const { compareAnalyses } = require('./comparator');
const { outputJson, outputCsv, outputDot } = require('./output');

program
  .name('wasm-duplicates')
  .description('Analyze Soroban contract WASM files for duplicate function bodies')
  .argument('<wasmFile>', 'Path to WASM file')
  .option('-o, --output <format>', 'Output format: json, csv, dot', 'json')
  .option('-c, --compare <file>', 'Compare with another WASM file')
  .option('-m, --min-size <n>', 'Minimum function size in bytes', parseInt)
  .option('--exact-only', 'Only report exact duplicates')
  .option('--normalized', 'Include normalized instruction matches')
  .option('-t, --threshold <n>', 'Similarity threshold (0-100)', parseInt, 95)
  .option('--no-metadata', 'Skip non-semantic metadata normalization')
  .action(async (wasmFile, options) => {
    try {
      const wasmPath = path.resolve(wasmFile);
      const wasmBuffer = fs.readFileSync(wasmPath);

      const analysis = await analyzeWasm(wasmBuffer, {
        minSize: options.minSize,
        exactOnly: options.exactOnly,
        includeNormalized: options.normalized,
        similarityThreshold: options.threshold,
        normalizeMetadata: options.metadata
      });

      if (options.compare) {
        const comparePath = path.resolve(options.compare);
        const compareBuffer = fs.readFileSync(comparePath);
        const compareAnalysis = await analyzeWasm(compareBuffer, {
          minSize: options.minSize,
          exactOnly: options.exactOnly,
          includeNormalized: options.normalized,
          similarityThreshold: options.threshold,
          normalizeMetadata: options.metadata
        });

        const comparison = compareAnalyses(analysis, compareAnalysis);
        outputResult(comparison, options.output);
      } else {
        outputResult(analysis, options.output);
      }
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

function outputResult(analysis, format) {
  switch (format.toLowerCase()) {
    case 'csv':
      console.log(outputCsv(analysis));
      break;
    case 'dot':
      console.log(outputDot(analysis));
      break;
    case 'json':
    default:
      console.log(JSON.stringify(outputJson(analysis), null, 2));
  }
}

program.parse(process.argv);
