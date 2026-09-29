import { readFileSync } from 'fs';
import { WASMParser } from 'wasmparser';
import { parse } from 'path';

interface BranchSite {
  functionIndex: number;
  basicBlock: number;
  instructionIndex: number;
  opcode: string;
  branchTargets: number[];
  conditionType: 'constant' | 'parameter' | 'local' | 'global' | 'memory' | 'call' | 'composite' | 'unknown';
  conditionSource: string;
  staticOutcome?: 'always-true' | 'always-false';
  dependencies: {
    constants?: any[];
    parameters?: number[];
    locals?: number[];
    globals?: number[];
    memory?: { address: number; offset: number; size: number }[];
    calls?: { functionIndex: number; resultIndex?: number }[];
  };
}

interface BasicBlock {
  id: number;
  instructions: any[];
  predecessors: number[];
  successors: number[];
}

interface FunctionAnalysis {
  index: number;
  name?: string;
  basicBlocks: BasicBlock[];
  branches: BranchSite[];
  parameterCount: number;
  localCount: number;
}

interface AnalysisResult {
  functions: FunctionAnalysis[];
  summary: {
    totalFunctions: number;
    totalBranches: number;
    conditionalBranches: number;
    constantBranches: number;
    parameterDerived: number;
    globalDerived: number;
    memoryDerived: number;
    callDerived: number;
    composite: number;
    unknown: number;
  };
  topBranchingFunctions: Array<{ index: number; branchCount: number; density: number }>;
}

export async function analyzeWasmFile(filePath: string): Promise<AnalysisResult> {
  const wasmBytes = readFileSync(filePath);
  const parser = new WASMParser();

  const functions: FunctionAnalysis[] = [];
  let currentFunction: FunctionAnalysis | null = null;
  let currentBlock: BasicBlock | null = null;
  let blockId = 0;

  parser.on('function', (func) => {
    currentFunction = {
      index: func.index,
      name: func.name,
      basicBlocks: [],
      branches: [],
      parameterCount: func.type.params.length,
      localCount: func.locals.length,
    };
    functions.push(currentFunction);
    blockId = 0;
  });

  parser.on('code', (code) => {
    if (!currentFunction) return;

    const body = code.body;
    const instructions = parseInstructions(body);

    // Simple block-based CFG construction
    const blocks = buildBasicBlocks(instructions);
    currentFunction.basicBlocks = blocks;

    // Identify branch sites
    currentFunction.branches = identifyBranchSites(blocks);
  });

  parser.on('end', () => {
    // Post-processing
    functions.forEach(analyzeFunctionBranches);
  });

  parser.parse(wasmBytes);

  return generateAnalysisReport(functions);
}

function parseInstructions(bytes: Uint8Array): any[] {
  const instructions: any[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const opcode = bytes[offset++];
    const instruction = { opcode, offset: offset - 1 };

    // Parse operands based on opcode
    switch (opcode) {
      case 0x0c: // br_if
      case 0x0d: // br_table
        instruction.target = readLEB128(bytes, offset);
        offset += instruction.target.bytesRead;
        break;
      case 0x0f: // return
      case 0x10: // call
        instruction.index = readLEB128(bytes, offset);
        offset += instruction.index.bytesRead;
        break;
    }

    instructions.push(instruction);
  }

  return instructions;
}

function readLEB128(bytes: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;

  while (true) {
    const byte = bytes[offset++];
    bytesRead++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }

  return { value: result, bytesRead };
}

function buildBasicBlocks(instructions: any[]): BasicBlock[] {
  const blocks: BasicBlock[] = [];
  let currentBlock: BasicBlock | null = null;
  let blockId = 0;

  for (let i = 0; i < instructions.length; i++) {
    const instr = instructions[i];

    if (isControlFlowOpcode(instr.opcode) || i === 0) {
      if (currentBlock) {
        blocks.push(currentBlock);
      }
      currentBlock = {
        id: blockId++,
        instructions: [],
        predecessors: [],
        successors: [],
      };
    }

    if (currentBlock) {
      currentBlock.instructions.push(instr);
    }

    // Update successors for control flow
    if (currentBlock && isControlFlowOpcode(instr.opcode)) {
      if (instr.opcode === 0x0c) { // br_if
        currentBlock.successors.push(instr.target);
      } else if (instr.opcode === 0x0d) { // br_table
        // br_table has multiple targets
      }
    }
  }

  if (currentBlock) {
    blocks.push(currentBlock);
  }

  return blocks;
}

function isControlFlowOpcode(opcode: number): boolean {
  return [
    0x0c, // br_if
    0x0d, // br_table
    0x0f, // return
    0x10, // call
    0x04, // if
    0x05, // else
  ].includes(opcode);
}

function identifyBranchSites(blocks: BasicBlock[]): BranchSite[] {
  const branches: BranchSite[] = [];

  for (const block of blocks) {
    for (let i = 0; i < block.instructions.length; i++) {
      const instr = block.instructions[i];

      if (instr.opcode === 0x0c) { // br_if
        branches.push({
          functionIndex: 0, // Will be set later
          basicBlock: block.id,
          instructionIndex: i,
          opcode: 'br_if',
          branchTargets: [instr.target],
          conditionType: 'unknown',
          conditionSource: 'unknown',
          dependencies: {},
        });
      } else if (instr.opcode === 0x04) { // if
        branches.push({
          functionIndex: 0,
          basicBlock: block.id,
          instructionIndex: i,
          opcode: 'if',
          branchTargets: [i + 1, instr.target], // true and false paths
          conditionType: 'unknown',
          conditionSource: 'unknown',
          dependencies: {},
        });
      }
    }
  }

  return branches;
}

function analyzeFunctionBranches(func: FunctionAnalysis) {
  func.branches.forEach(branch => {
    branch.functionIndex = func.index;

    // Conservative analysis - mark as unknown for now
    // In a real implementation, we would trace the condition operand
    branch.conditionType = 'unknown';
    branch.conditionSource = 'conservative-analysis';
  });
}

function generateAnalysisReport(functions: FunctionAnalysis[]): AnalysisResult {
  const totalBranches = functions.reduce((sum, f) => sum + f.branches.length, 0);

  // Count branch types
  let conditionalBranches = 0;
  let constantBranches = 0;
  let parameterDerived = 0;
  let globalDerived = 0;
  let memoryDerived = 0;
  let callDerived = 0;
  let composite = 0;
  let unknown = 0;

  functions.forEach(func => {
    func.branches.forEach(branch => {
      switch (branch.conditionType) {
        case 'constant': constantBranches++; break;
        case 'parameter': parameterDerived++; break;
        case 'global': globalDerived++; break;
        case 'memory': memoryDerived++; break;
        case 'call': callDerived++; break;
        case 'composite': composite++; break;
        case 'unknown': unknown++; break;
      }
      if (['br_if', 'if'].includes(branch.opcode)) {
        conditionalBranches++;
      }
    });
  });

  // Calculate branch density
  const topBranchingFunctions = functions
    .map(f => ({
      index: f.index,
      branchCount: f.branches.length,
      density: f.basicBlocks.length > 0 ? f.branches.length / f.basicBlocks.length : 0,
    }))
    .sort((a, b) => b.branchCount - a.branchCount)
    .slice(0, 5);

  return {
    functions,
    summary: {
      totalFunctions: functions.length,
      totalBranches,
      conditionalBranches,
      constantBranches,
      parameterDerived,
      globalDerived,
      memoryDerived,
      callDerived,
      composite,
      unknown,
    },
    topBranchingFunctions,
  };
}
