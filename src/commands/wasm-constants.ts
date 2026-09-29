import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { analyzeConstants, ConstantAnalysisResult, ComparisonResult } from '../analysis/wasm-constants.js';
import { formatJsonOutput, formatCsvOutput, formatComparisonOutput } from '../formatters/output.js';

export function createWasmConstantsCommand(program: Command) {
  const command = program
    .command('wasm-constants')
    .description('Analyze WASM for constant propagation opportunities')
    .argument('<wasmFile>', 'Path to WASM file')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output in JSON format')
    .option('--csv', 'Output in CSV format')
    .option('--compare <wasmFile2>', 'Compare with second WASM file')
    .option('--depth', 'Include maximum propagation depth in output');

  command.action(async (wasmFile: string, options: {
    output?: string;
    json?: boolean;
    csv?: boolean;
    compare?: string;
    depth?: boolean;
  }) => {
    try {
      const wasmPath = path.resolve(wasmFile);
      if (!fs.existsSync(wasmPath)) {
        throw new Error(`WASM file not found: ${wasmPath}`);
      }

      const wasmBuffer = fs.readFileSync(wasmPath);

      if (options.compare) {
        const comparePath = path.resolve(options.compare);
        if (!fs.existsSync(comparePath)) {
          throw new Error(`Comparison WASM file not found: ${comparePath}`);
        }
        const compareBuffer = fs.readFileSync(comparePath);
        const result = analyzeConstants(wasmBuffer);
        const compareResult = analyzeConstants(compareBuffer);
        const comparison = compareConstantResults(result, compareResult);

        const output = formatComparisonOutput(comparison, options.depth);
        handleOutput(output, options);
      } else {
        const result = analyzeConstants(wasmBuffer);
        const output = options.json
          ? formatJsonOutput(result, options.depth)
          : options.csv
            ? formatCsvOutput(result)
            : formatJsonOutput(result, options.depth);

        handleOutput(output, options);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

  return command;
}

function compareConstantResults(
  result1: ConstantAnalysisResult,
  result2: ConstantAnalysisResult
): ComparisonResult {
  const comparison: ComparisonResult = {
    newlyPropagated: [],
    removedPropagated: [],
    changedValues: [],
    newConstantBranches: [],
    lostConstantBranches: []
  };

  // Implement comparison logic
  const funcs1 = new Map(result1.functions.map(f => [f.index, f]));
  const funcs2 = new Map(result2.functions.map(f => [f.index, f]));

  // Compare functions present in both
  for (const [index, func1] of funcs1) {
    const func2 = funcs2.get(index);
    if (!func2) continue;

    // Compare constants
    const constants1 = new Map(func1.constants.map(c => [c.instructionIndex, c]));
    const constants2 = new Map(func2.constants.map(c => [c.instructionIndex, c]));

    for (const [instIndex, const1] of constants1) {
      const const2 = constants2.get(instIndex);
      if (!const2) {
        comparison.removedPropagated.push({
          functionIndex: index,
          instructionIndex: instIndex,
          value: const1.value
        });
      } else if (const1.value !== const2.value) {
        comparison.changedValues.push({
          functionIndex: index,
          instructionIndex: instIndex,
          oldValue: const1.value,
          newValue: const2.value
        });
      }
    }

    for (const [instIndex, const2] of constants2) {
      if (!constants1.has(instIndex)) {
        comparison.newlyPropagated.push({
          functionIndex: index,
          instructionIndex: instIndex,
          value: const2.value
        });
      }
    }

    // Compare branches
    const branches1 = new Set(func1.constantBranches);
    const branches2 = new Set(func2.constantBranches);

    for (const branch of branches1) {
      if (!branches2.has(branch)) {
        comparison.lostConstantBranches.push({
          functionIndex: index,
          instructionIndex: branch
        });
      }
    }

    for (const branch of branches2) {
      if (!branches1.has(branch)) {
        comparison.newConstantBranches.push({
          functionIndex: index,
          instructionIndex: branch
        });
      }
    }
  }

  return comparison;
}

function handleOutput(output: string, options: { output?: string; json?: boolean; csv?: boolean }) {
  if (options.output) {
    fs.writeFileSync(options.output, output);
  } else {
    console.log(output);
  }
}