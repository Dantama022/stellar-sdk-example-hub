#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { WASMParser } = require('wasmparser');
const { parse } = require('shell-quote');
const { program } = require('commander');

// Main CLI entry point
program
  .name('wasm-slice')
  .description('WASM program slicing analysis tool')
  .version('1.0.0');

program
  .command('analyze')
  .description('Analyze a WASM file and generate a slice')
  .requiredOption('-f, --file <path>', 'Path to WASM file')
  .requiredOption('-t, --target <target>', 'Target to slice (e.g., function:0, instruction:123)')
  .requiredOption('-m, --mode <mode>', 'Slice mode (backward, forward, bidirectional)')
  .option('-o, --output <format>', 'Output format (normal, json, dot)', 'normal')
  .option('--dot-output <path>', 'Path to save DOT output')
  .option('--json-output <path>', 'Path to save JSON output')
  .action(analyzeAction);

program
  .command('compare')
  .description('Compare two WASM files')
  .requiredOption('-f1, --file1 <path>', 'Path to first WASM file')
  .requiredOption('-f2, --file2 <path>', 'Path to second WASM file')
  .requiredOption('-t, --target <target>', 'Target to compare')
  .action(compareAction);

async function analyzeAction(options) {
  try {
    const wasmPath = path.resolve(options.file);
    const wasmBuffer = fs.readFileSync(wasmPath);
    
    const analyzer = new WASMAnalyzer(wasmBuffer);
    const slice = analyzer.generateSlice(options.target, options.mode);
    
    if (options.output === 'json') {
      const output = JSON.stringify(slice, null, 2);
      if (options.jsonOutput) {
        fs.writeFileSync(options.jsonOutput, output);
        console.log(`JSON output saved to ${options.jsonOutput}`);
      } else {
        console.log(output);
      }
    } else if (options.output === 'dot') {
      const dotOutput = analyzer.generateDotGraph(slice);
      if (options.dotOutput) {
        fs.writeFileSync(options.dotOutput, dotOutput);
        console.log(`DOT output saved to ${options.dotOutput}`);
      } else {
        console.log(dotOutput);
      }
    } else {
      printNormalOutput(slice);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

async function compareAction(options) {
  try {
    const wasm1Path = path.resolve(options.file1);
    const wasm2Path = path.resolve(options.file2);
    
    const wasm1Buffer = fs.readFileSync(wasm1Path);
    const wasm2Buffer = fs.readFileSync(wasm2Path);
    
    const analyzer1 = new WASMAnalyzer(wasm1Buffer);
    const analyzer2 = new WASMAnalyzer(wasm2Buffer);
    
    const slice1 = analyzer1.generateSlice(options.target, 'backward');
    const slice2 = analyzer2.generateSlice(options.target, 'backward');
    
    const comparison = compareSlices(slice1, slice2);
    console.log(JSON.stringify(comparison, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

function printNormalOutput(slice) {
  console.log('=== Slice Analysis Results ===');
  console.log(`Original instruction count: ${slice.originalInstructionCount}`);
  console.log(`Slice instruction count: ${slice.sliceInstructionCount}`);
  console.log(`Slice reduction: ${slice.sliceReductionPercentage.toFixed(2)}%`);
  console.log(`Included basic blocks: ${slice.includedBasicBlocks.length}`);
  console.log(`Included functions: ${slice.includedFunctions.length}`);
  console.log(`Cross-function dependencies: ${slice.crossFunctionDependencies}`);
  console.log(`Unresolved dependencies: ${slice.unresolvedDependencies}`);
  console.log(`Control dependencies: ${slice.controlDependencies}`);
  console.log('\n=== Sliced Instructions ===');
  
  slice.instructions.forEach((instr, idx) => {
    console.log(`${idx}: [${instr.functionIndex}][${instr.blockIndex}][${instr.instructionIndex}] ${instr.opcode}`);
  });
}

function compareSlices(slice1, slice2) {
  const set1 = new Set(slice1.instructions.map(i => `${i.functionIndex}:${i.blockIndex}:${i.instructionIndex}`));
  const set2 = new Set(slice2.instructions.map(i => `${i.functionIndex}:${i.blockIndex}:${i.instructionIndex}`));
  
  const added = [...set2].filter(x => !set1.has(x)).length;
  const removed = [...set1].filter(x => !set2.has(x)).length;
  const common = [...set1].filter(x => set2.has(x)).length;
  
  return {
    originalInstructionCount1: slice1.originalInstructionCount,
    originalInstructionCount2: slice2.originalInstructionCount,
    sliceInstructionCount1: slice1.sliceInstructionCount,
    sliceInstructionCount2: slice2.sliceInstructionCount,
    added,
    removed,
    common,
    reductionChange: slice2.sliceReductionPercentage - slice1.sliceReductionPercentage
  };
}

class WASMAnalyzer {
  constructor(wasmBuffer) {
    this.wasmBuffer = wasmBuffer;
    this.module = this.parseWASM(wasmBuffer);
    this.cfg = this.buildControlFlowGraph();
    this.defUse = this.buildDefUseAnalysis();
  }

  parseWASM(buffer) {
    const parser = new WASMParser();
    return parser.parse(buffer);
  }

  buildControlFlowGraph() {
    // Implementation would parse the WASM module and build CFG
    // This is a simplified placeholder
    return {
      functions: [],
      blocks: [],
      edges: []
    };
  }

  buildDefUseAnalysis() {
    // Implementation would perform def-use analysis
    // This is a simplified placeholder
    return {
      defs: new Map(),
      uses: new Map()
    };
  }

  generateSlice(target, mode) {
    // Implementation would perform the actual slicing analysis
    // This is a simplified placeholder that returns mock data
    
    const mockInstructions = [
      { functionIndex: 0, blockIndex: 0, instructionIndex: 0, opcode: 'local.get', args: [0] },
      { functionIndex: 0, blockIndex: 0, instructionIndex: 1, opcode: 'i32.const', args: [10] },
      { functionIndex: 0, blockIndex: 0, instructionIndex: 2, opcode: 'i32.add' },
      { functionIndex: 0, blockIndex: 0, instructionIndex: 3, opcode: 'local.set', args: [1] },
      { functionIndex: 0, blockIndex: 1, instructionIndex: 0, opcode: 'local.get', args: [1] },
      { functionIndex: 0, blockIndex: 1, instructionIndex: 1, opcode: 'return' }
    ];

    return {
      originalInstructionCount: 100,
      sliceInstructionCount: mockInstructions.length,
      sliceReductionPercentage: 95.0,
      includedBasicBlocks: [0, 1],
      includedFunctions: [0],
      crossFunctionDependencies: 0,
      unresolvedDependencies: 0,
      controlDependencies: 2,
      instructions: mockInstructions
    };
  }

  generateDotGraph(slice) {
    let dot = 'digraph G {\n';
    
    slice.instructions.forEach((instr, idx) => {
      const label = `${instr.opcode}\nF:${instr.functionIndex} B:${instr.blockIndex} I:${instr.instructionIndex}`;
      dot += `  ${idx} [label="${label}"];\n`;
    });
    
    slice.instructions.forEach((instr, idx) => {
      if (idx > 0) {
        dot += `  ${idx-1} -> ${idx};\n`;
      }
    });
    
    dot += '}\n';
    return dot;
  }
}

if (require.main === module) {
  program.parse();
}
