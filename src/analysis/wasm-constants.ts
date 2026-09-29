import { readWasmModule, WasmModule, WasmFunction, WasmInstruction } from '../parsers/wasm-parser.js';

export interface ConstantValue {
  type: 'i32' | 'i64' | 'f32' | 'f64';
  value: number | bigint;
}

export interface ConstantFinding {
  functionIndex: number;
  instructionIndex: number;
  blockIndex?: number;
  value: ConstantValue;
  depth: number;
}

export interface BranchFinding {
  functionIndex: number;
  instructionIndex: number;
  isAlwaysTrue: boolean;
  isAlwaysFalse: boolean;
}

export interface FunctionAnalysis {
  index: number;
  name?: string;
  constants: ConstantFinding[];
  constantBranches: number[];
  stats: {
    constantProducingInstructions: number;
    propagatedValues: number;
    resolvedComparisons: number;
    constantBranchConditions: number;
    unknownValueMerges: number;
    maxPropagationDepth: number;
  };
}

export interface ConstantAnalysisResult {
  moduleName?: string;
  functions: FunctionAnalysis[];
  stats: {
    totalConstantProducingInstructions: number;
    totalPropagatedValues: number;
    totalResolvedComparisons: number;
    totalConstantBranchConditions: number;
    totalUnknownValueMerges: number;
    maxPropagationDepth: number;
    functionsWithMostConstants: { index: number; count: number }[];
  };
}

export interface ComparisonResult {
  newlyPropagated: {
    functionIndex: number;
    instructionIndex: number;
    value: ConstantValue;
  }[];
  removedPropagated: {
    functionIndex: number;
    instructionIndex: number;
    value: ConstantValue;
  }[];
  changedValues: {
    functionIndex: number;
    instructionIndex: number;
    oldValue: ConstantValue;
    newValue: ConstantValue;
  }[];
  newConstantBranches: {
    functionIndex: number;
    instructionIndex: number;
  }[];
  lostConstantBranches: {
    functionIndex: number;
    instructionIndex: number;
  }[];
}

const MAX_ITERATIONS = 1000;

export function analyzeConstants(wasmBuffer: Buffer): ConstantAnalysisResult {
  const module = readWasmModule(wasmBuffer);
  const functionAnalyses: FunctionAnalysis[] = [];

  for (const [funcIndex, wasmFunc] of module.functions.entries()) {
    const analysis = analyzeFunction(wasmFunc, funcIndex, module);
    functionAnalyses.push(analysis);
  }

  // Calculate global stats
  const globalStats = calculateGlobalStats(functionAnalyses);

  return {
    moduleName: module.name,
    functions: functionAnalyses,
    stats: globalStats
  };
}

function analyzeFunction(wasmFunc: WasmFunction, funcIndex: number, module: WasmModule): FunctionAnalysis {
  const constants: ConstantFinding[] = [];
  const constantBranches: number[] = [];
  const valueMap = new Map<number, Map<number, ConstantValue>>(); // blockIndex -> instructionIndex -> value
  const localValues = new Map<number, ConstantValue>();
  let maxDepth = 0;
  let iterations = 0;

  // Initialize with known constants from the function body
  const initialValues = initializeValueMap(wasmFunc);
  valueMap.set(0, new Map(initialValues.map(v => [v.instructionIndex, v.value])));

  // Track which instructions produce constants
  const constantProducers = new Set<number>();

  // Fixed-point iteration for constant propagation
  let changed = true;
  while (changed && iterations < MAX_ITERATIONS) {
    changed = false;
    iterations++;

    for (const block of wasmFunc.body.blocks) {
      const blockValues = valueMap.get(block.index) || new Map();
      const newBlockValues = new Map(blockValues);

      for (const [instIndex, inst] of block.instructions.entries()) {
        const currentValue = blockValues.get(instIndex);
        const newValue = propagateThroughInstruction(inst, blockValues, localValues, module);

        if (newValue && !deepEqualConstantValue(newValue, currentValue)) {
          newBlockValues.set(instIndex, newValue);
          changed = true;

          // Record constant finding
          constants.push({
            functionIndex: funcIndex,
            instructionIndex: instIndex,
            blockIndex: block.index,
            value: newValue,
            depth: iterations
          });

          constantProducers.add(instIndex);
          maxDepth = Math.max(maxDepth, iterations);

          // Update local if this is a set_local
          if (inst.opcode === 'set_local' && inst.args[0] !== undefined) {
            localValues.set(inst.args[0], newValue);
          }
        }
      }

      valueMap.set(block.index, newBlockValues);
    }

    // Handle control flow merges
    handleControlFlowMerges(wasmFunc, valueMap);
  }

  // Identify constant branches
  for (const [blockIndex, block] of wasmFunc.body.blocks.entries()) {
    for (const [instIndex, inst] of block.instructions.entries()) {
      if (isBranchInstruction(inst)) {
        const blockValues = valueMap.get(blockIndex);
        if (blockValues) {
          const conditionValue = blockValues.get(instIndex);
          if (conditionValue) {
            constantBranches.push(instIndex);
          }
        }
      }
    }
  }

  // Calculate function stats
  const stats = {
    constantProducingInstructions: constantProducers.size,
    propagatedValues: constants.length,
    resolvedComparisons: countResolvedComparisons(constants),
    constantBranchConditions: constantBranches.length,
    unknownValueMerges: countUnknownMerges(valueMap),
    maxPropagationDepth: maxDepth
  };

  return {
    index: funcIndex,
    name: wasmFunc.name,
    constants,
    constantBranches,
    stats
  };
}

function initializeValueMap(wasmFunc: WasmFunction): { instructionIndex: number; value: ConstantValue }[] {
  const initialValues: { instructionIndex: number; value: ConstantValue }[] = [];

  for (const [blockIndex, block] of wasmFunc.body.blocks.entries()) {
    for (const [instIndex, inst] of block.instructions.entries()) {
      const globalInstIndex = blockIndex * 1000 + instIndex; // Simple way to make unique
      if (isConstantInstruction(inst)) {
        const value = getConstantValue(inst);
        if (value) {
          initialValues.push({
            instructionIndex: globalInstIndex,
            value
          });
        }
      }
    }
  }

  return initialValues;
}

function propagateThroughInstruction(
  inst: WasmInstruction,
  blockValues: Map<number, ConstantValue>,
  localValues: Map<number, ConstantValue>,
  module: WasmModule
): ConstantValue | null {
  switch (inst.opcode) {
    case 'i32.const':
    case 'i64.const':
    case 'f32.const':
    case 'f64.const':
      return getConstantValue(inst);

    case 'get_local': {
      const localIndex = inst.args[0];
      return localValues.get(localIndex) || null;
    }

    case 'set_local': {
      const localIndex = inst.args[0];
      const valueIndex = inst.args[1];
      if (valueIndex !== undefined && blockValues.has(valueIndex)) {
        return blockValues.get(valueIndex) || null;
      }
      return null;
    }

    case 'i32.add':
    case 'i32.sub':
    case 'i32.mul':
    case 'i64.add':
    case 'i64.sub':
    case 'i64.mul':
      return propagateArithmetic(inst, blockValues);

    case 'i32.and':
    case 'i32.or':
    case 'i32.xor':
    case 'i64.and':
    case 'i64.or':
    case 'i64.xor':
      return propagateBitwise(inst, blockValues);

    case 'i32.eq':
    case 'i32.ne':
    case 'i32.lt_s':
    case 'i32.lt_u':
    case 'i32.gt_s':
    case 'i32.gt_u':
    case 'i32.le_s':
    case 'i32.le_u':
    case 'i32.ge_s':
    case 'i32.ge_u':
    case 'i64.eq':
    case 'i64.ne':
    case 'i64.lt_s':
    case 'i64.lt_u':
    case 'i64.gt_s':
    case 'i64.gt_u':
    case 'i64.le_s':
    case 'i64.le_u':
    case 'i64.ge_s':
    case 'i64.ge_u':
      return propagateComparison(inst, blockValues);

    case 'i32.trunc_f32_s':
    case 'i32.trunc_f32_u':
    case 'i64.trunc_f64_s':
    case 'i64.trunc_f64_u':
      return propagateConversion(inst, blockValues);

    default:
      // Unsupported instruction - invalidate this path
      return null;
  }
}

function propagateArithmetic(inst: WasmInstruction, blockValues: Map<number, ConstantValue>): ConstantValue | null {
  const leftIndex = inst.args[0];
  const rightIndex = inst.args[1];

  if (leftIndex === undefined || rightIndex === undefined) return null;

  const left = blockValues.get(leftIndex);
  const right = blockValues.get(rightIndex);

  if (!left || !right) return null;
  if (left.type !== right.type) return null;

  try {
    const leftNum = left.type.startsWith('i64') ? Number(BigInt(left.value)) : Number(left.value);
    const rightNum = right.type.startsWith('i64') ? Number(BigInt(right.value)) : Number(right.value);
    let result: number;

    switch (inst.opcode) {
      case 'i32.add': case 'i64.add':
        result = leftNum + rightNum;
        break;
      case 'i32.sub': case 'i64.sub':
        result = leftNum - rightNum;
        break;
      case 'i32.mul': case 'i64.mul':
        result = leftNum * rightNum;
        break;
      default:
        return null;
    }

    return {
      type: left.type,
      value: inst.opcode.startsWith('i64') ? BigInt(result) : result
    };
  } catch {
    return null; // Overflow or other error
  }
}

function propagateBitwise(inst: WasmInstruction, blockValues: Map<number, ConstantValue>): ConstantValue | null {
  const leftIndex = inst.args[0];
  const rightIndex = inst.args[1];

  if (leftIndex === undefined || rightIndex === undefined) return null;

  const left = blockValues.get(leftIndex);
  const right = blockValues.get(rightIndex);

  if (!left || !right) return null;
  if (left.type !== right.type) return null;

  try {
    const leftNum = left.type.startsWith('i64') ? BigInt(left.value) : BigInt(left.value as number);
    const rightNum = right.type.startsWith('i64') ? BigInt(right.value) : BigInt(right.value as number);
    let result: bigint;

    switch (inst.opcode) {
      case 'i32.and': case 'i64.and':
        result = leftNum & rightNum;
        break;
      case 'i32.or': case 'i64.or':
        result = leftNum | rightNum;
        break;
      case 'i32.xor': case 'i64.xor':
        result = leftNum ^ rightNum;
        break;
      default:
        return null;
    }

    return {
      type: left.type,
      value: result
    };
  } catch {
    return null;
  }
}

function propagateComparison(inst: WasmInstruction, blockValues: Map<number, ConstantValue>): ConstantValue | null {
  const leftIndex = inst.args[0];
  const rightIndex = inst.args[1];

  if (leftIndex === undefined || rightIndex === undefined) return null;

  const left = blockValues.get(leftIndex);
  const right = blockValues.get(rightIndex);

  if (!left || !right) return null;
  if (left.type !== right.type) return null;

  try {
    const leftNum = left.type.startsWith('i64') ? BigInt(left.value) : BigInt(left.value as number);
    const rightNum = right.type.startsWith('i64') ? BigInt(right.value) : BigInt(right.value as number);
    let result: boolean;

    switch (inst.opcode) {
      case 'i32.eq': case 'i64.eq':
        result = leftNum === rightNum;
        break;
      case 'i32.ne': case 'i64.ne':
        result = leftNum !== rightNum;
        break;
      case 'i32.lt_s': case 'i64.lt_s':
        result = leftNum < rightNum;
        break;
      case 'i32.lt_u': case 'i64.lt_u':
        result = unsignedLessThan(leftNum, rightNum, left.type.startsWith('i64'));
        break;
      case 'i32.gt_s': case 'i64.gt_s':
        result = leftNum > rightNum;
        break;
      case 'i32.gt_u': case 'i64.gt_u':
        result = unsignedGreaterThan(leftNum, rightNum, left.type.startsWith('i64'));
        break;
      case 'i32.le_s': case 'i64.le_s':
        result = leftNum <= rightNum;
        break;
      case 'i32.le_u': case 'i64.le_u':
        result = unsignedLessThanOrEqual(leftNum, rightNum, left.type.startsWith('i64'));
        break;
      case 'i32.ge_s': case 'i64.ge_s':
        result = leftNum >= rightNum;
        break;
      case 'i32.ge_u': case 'i64.ge_u':
        result = unsignedGreaterThanOrEqual(leftNum, rightNum, left.type.startsWith('i64'));
        break;
      default:
        return null;
    }

    return {
      type: 'i32',
      value: result ? 1 : 0
    };
  } catch {
    return null;
  }
}

function propagateConversion(inst: WasmInstruction, blockValues: Map<number, ConstantValue>): ConstantValue | null {
  const inputIndex = inst.args[0];
  if (inputIndex === undefined) return null;

  const input = blockValues.get(inputIndex);
  if (!input) return null;

  try {
    switch (inst.opcode) {
      case 'i32.trunc_f32_s':
      case 'i32.trunc_f32_u': {
        if (input.type !== 'f32') return null;
        const floatValue = input.value as number;
        // Simple truncation - in reality would need proper float handling
        const intValue = Math.trunc(floatValue);
        return { type: 'i32', value: intValue };
      }
      case 'i64.trunc_f64_s':
      case 'i64.trunc_f64_u': {
        if (input.type !== 'f64') return null;
        const floatValue = input.value as number;
        const intValue = BigInt(Math.trunc(floatValue));
        return { type: 'i64', value: intValue };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function handleControlFlowMerges(wasmFunc: WasmFunction, valueMap: Map<number, Map<number, ConstantValue>>) {
  // For each block that is a merge point (has multiple predecessors)
  for (const block of wasmFunc.body.blocks) {
    if (block.predecessors.length > 1) {
      // Get all incoming values for each instruction
      const mergedValues = new Map<number, ConstantValue | null>();

      for (const predIndex of block.predecessors) {
        const predValues = valueMap.get(predIndex);
        if (!predValues) continue;

        for (const [instIndex, value] of predValues) {
          const existing = mergedValues.get(instIndex);
          if (existing === undefined) {
            mergedValues.set(instIndex, value);
          } else if (existing && !deepEqualConstantValue(existing, value)) {
            // Conflict - mark as unknown
            mergedValues.set(instIndex, null);
          }
        }
      }

      // Update the block's values with merged values
      const blockValues = valueMap.get(block.index) || new Map();
      for (const [instIndex, value] of mergedValues) {
        if (value === null) {
          blockValues.delete(instIndex);
        } else {
          blockValues.set(instIndex, value);
        }
      }
      valueMap.set(block.index, blockValues);
    }
  }
}

function isConstantInstruction(inst: WasmInstruction): boolean {
  return inst.opcode.endsWith('.const');
}

function getConstantValue(inst: WasmInstruction): ConstantValue | null {
  if (!isConstantInstruction(inst)) return null;

  const type = inst.opcode.split('.')[0];
  if (['i32', 'i64', 'f32', 'f64'].includes(type)) {
    return {
      type: type as 'i32' | 'i64' | 'f32' | 'f64',
      value: inst.args[0]
    };
  }
  return null;
}

function isBranchInstruction(inst: WasmInstruction): boolean {
  return ['br', 'br_if', 'br_table'].includes(inst.opcode);
}

function countResolvedComparisons(constants: ConstantFinding[]): number {
  return constants.filter(c => 
    c.value.type === 'i32' && (c.value.value === 0 || c.value.value === 1)
  ).length;
}

function countUnknownMerges(valueMap: Map<number, Map<number, ConstantValue>>): number {
  let count = 0;
  for (const blockValues of valueMap.values()) {
    for (const value of blockValues.values()) {
      if (value === null) count++;
    }
  }
  return count;
}

function calculateGlobalStats(functionAnalyses: FunctionAnalysis[]): ConstantAnalysisResult['stats'] {
  const totalConstantProducing = functionAnalyses.reduce(
    (sum, f) => sum + f.stats.constantProducingInstructions, 0
  );
  const totalPropagated = functionAnalyses.reduce(
    (sum, f) => sum + f.stats.propagatedValues, 0
  );
  const totalResolved = functionAnalyses.reduce(
    (sum, f) => sum + f.stats.resolvedComparisons, 0
  );
  const totalBranches = functionAnalyses.reduce(
    (sum, f) => sum + f.stats.constantBranchConditions, 0
  );
  const totalMerges = functionAnalyses.reduce(
    (sum, f) => sum + f.stats.unknownValueMerges, 0
  );
  const maxDepth = Math.max(...functionAnalyses.map(f => f.stats.maxPropagationDepth), 0);

  // Find functions with most constants
  const functionsWithMostConstants = functionAnalyses
    .map(f => ({ index: f.index, count: f.constants.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totalConstantProducingInstructions: totalConstantProducing,
    totalPropagatedValues: totalPropagated,
    totalResolvedComparisons: totalResolved,
    totalConstantBranchConditions: totalBranches,
    totalUnknownValueMerges: totalMerges,
    maxPropagationDepth: maxDepth,
    functionsWithMostConstants
  };
}

function deepEqualConstantValue(a: ConstantValue | null, b: ConstantValue | null): boolean {
  if (a === null || b === null) return a === b;
  return a.type === b.type && a.value === b.value;
}

// Helper functions for unsigned comparisons
function unsignedLessThan(a: bigint, b: bigint, is64: boolean): boolean {
  const max = is64 ? BigInt('0xFFFFFFFFFFFFFFFF') : BigInt('0xFFFFFFFF');
  const aU = toUnsigned(a, max);
  const bU = toUnsigned(b, max);
  return aU < bU;
}

function unsignedGreaterThan(a: bigint, b: bigint, is64: boolean): boolean {
  const max = is64 ? BigInt('0xFFFFFFFFFFFFFFFF') : BigInt('0xFFFFFFFF');
  const aU = toUnsigned(a, max);
  const bU = toUnsigned(b, max);
  return aU > bU;
}

function unsignedLessThanOrEqual(a: bigint, b: bigint, is64: boolean): boolean {
  return !unsignedGreaterThan(a, b, is64);
}

function unsignedGreaterThanOrEqual(a: bigint, b: bigint, is64: boolean): boolean {
  return !unsignedLessThan(a, b, is64);
}

function toUnsigned(value: bigint, max: bigint): bigint {
  return value >= 0 ? value : max + value + BigInt(1);
}