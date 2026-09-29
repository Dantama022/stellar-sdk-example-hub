#!/usr/bin/env node

import { Command } from 'commander';
import { analyzeWasmFile } from '../src/wasm-analyzer.js';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const program = new Command();

program
  .name('wasm-branches')
  .description('Analyze WASM branch conditions in Soroban contracts')
  .version('1.0.0')
  .argument('<wasmFile>', 'Path to WASM file')
  .option('-j, --json', 'Output JSON format')
  .option('-c, --csv', 'Output CSV format')
  .option('-d, --dot', 'Output DOT format')
  .option('-o, --output <file>', 'Output file path')
  .action(async (wasmFile, options) => {
    try {
      const result = await analyzeWasmFile(wasmFile);

      let output;
      if (options.json) {
        output = JSON.stringify(result, null, 2);
      } else if (options.csv) {
        output = resultToCsv(result);
      } else if (options.dot) {
        output = resultToDot(result);
      } else {
        output = formatHumanReadable(result);
      }

      if (options.output) {
        writeFileSync(resolve(options.output), output);
        console.log(`Analysis saved to ${options.output}`);
      } else {
        console.log(output);
      }
    } catch (error) {
      console.error('Error analyzing WASM file:', error);
      process.exit(1);
    }
  });

function resultToCsv(result) {
  const headers = [
    'Function Index',
    'Basic Block',
    'Instruction Index',
    'Opcode',
    'Branch Targets',
    'Condition Type',
    'Condition Source',
    'Static Outcome'
  ];

  const rows = result.branches.map(branch => [
    branch.functionIndex,
    branch.basicBlock,
    branch.instructionIndex,
    branch.opcode,
    branch.branchTargets.join(','),
    branch.conditionType,
    branch.conditionSource,
    branch.staticOutcome || ''
  ]);

  return [headers, ...rows].map(row => row.join(',')).join('\n');
}

function resultToDot(result) {
  let dot = 'digraph ControlFlowGraph {\n';
  dot += '  node [shape=box];\n';

  // Add nodes for each basic block
  for (const func of result.functions) {
    for (const block of func.basicBlocks) {
      dot += `  block_${func.index}_${block.id} [label="Function ${func.index}\nBlock ${block.id}\n${block.instructions.length} instructions"];\n`;
    }

    // Add edges for branches
    for (const branch of func.branches) {
      for (const target of branch.branchTargets) {
        dot += `  block_${func.index}_${branch.basicBlock} -> block_${func.index}_${target} [label="${branch.opcode}"];\n`;
      }
    }
  }

  dot += '}\n';
  return dot;
}

function formatHumanReadable(result) {
  let output = '';

  output += '=== WASM Branch Analysis Report ===\n\n';

  output += 'Summary Statistics:\n';
  output += `Total Functions: ${result.summary.totalFunctions}\n`;
  output += `Total Branches: ${result.summary.totalBranches}\n`;
  output += `Conditional Branches: ${result.summary.conditionalBranches}\n`;
  output += `Constant Branches: ${result.summary.constantBranches}\n`;
  output += `Parameter-derived: ${result.summary.parameterDerived}\n`;
  output += `Global-derived: ${result.summary.globalDerived}\n`;
  output += `Memory-derived: ${result.summary.memoryDerived}\n`;
  output += `Call-derived: ${result.summary.callDerived}\n`;
  output += `Composite: ${result.summary.composite}\n`;
  output += `Unknown: ${result.summary.unknown}\n\n`;

  output += 'Top Branching Functions:\n';
  result.topBranchingFunctions.forEach(func => {
    output += `- Function ${func.index}: ${func.branchCount} branches (density: ${func.density.toFixed(2)})\n`;
  });

  output += '\nDetailed Branch Analysis:\n';
  for (const func of result.functions) {
    output += `\nFunction ${func.index} (${func.name || 'anonymous'}):\n`;
    output += `  Basic Blocks: ${func.basicBlocks.length}\n`;
    output += `  Branches: ${func.branches.length}\n`;

    for (const branch of func.branches) {
      output += `  - Block ${branch.basicBlock}, Instr ${branch.instructionIndex}: ${branch.opcode}\n`;
      output += `    Targets: ${branch.branchTargets.join(', ')}\n`;
      output += `    Condition: ${branch.conditionType} (${branch.conditionSource})\n`;
      if (branch.staticOutcome) {
        output += `    Static Outcome: ${branch.staticOutcome}\n`;
      }
    }
  }

  return output;
}

program.parse(process.argv);
