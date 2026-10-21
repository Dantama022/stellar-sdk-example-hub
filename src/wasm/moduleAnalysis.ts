/**
 * Shared plumbing for the offline WASM analyses.
 *
 * Both the memory-access analysis (ISSUE-267) and the constant-propagation
 * analysis (ISSUE-268) need the same preparation steps: decode the module,
 * build the control-flow graph of every function, compute the static operand
 * stack shape and run the constant-propagation engine.
 *
 * This module wires those steps together so both analyses stay consistent
 * with each other.
 */

import {
  analyzeFunctionConstants,
  computeFunctionContext,
  type FunctionConstantResult,
  type FunctionContext,
  type InstructionObservation,
} from './constantEngine';
import { buildFunctionCfg, type FunctionCfg } from './functionCfg';
import type { WasmFunction, WasmModule } from './wasmBinary';

/** A function that has been prepared for analysis. */
export interface AnalyzedFunction {
  /** The decoded function. */
  func: WasmFunction;
  /** Control-flow graph of the function. */
  cfg: FunctionCfg;
  /** Static operand-stack information. */
  context: FunctionContext;
  /** Result of the constant-propagation analysis. */
  constants: FunctionConstantResult;
  /** Observations of the instructions, indexed by instruction index. */
  observations: Map<number, InstructionObservation>;
}

/**
 * Builds the resolver that maps a block type to the number of results it
 * yields.
 */
export function makeBlockResultsResolver(module: WasmModule): (blockType?: string) => number {
  return (blockType?: string): number => {
    if (!blockType || blockType === 'empty') return 0;
    if (blockType.startsWith('type:')) {
      const typeIndex = Number(blockType.slice('type:'.length));
      const signature = module.types[typeIndex];
      return signature ? signature.results.length : 1;
    }
    return 1;
  };
}

/**
 * Builds the resolver that maps a function index to the arity of its type.
 */
export function makeCallArityResolver(
  module: WasmModule,
): (funcIndex: number) => { params: number; results: number } {
  return (funcIndex: number): { params: number; results: number } => {
    const typeIndex = module.functionTypeIndices[funcIndex];
    if (typeIndex === undefined) return { params: 0, results: 0 };
    const signature = module.types[typeIndex];
    if (!signature) return { params: 0, results: 0 };
    return { params: signature.params.length, results: signature.results.length };
  };
}

/** Prepares every function of a module for analysis. */
export function analyzeModuleFunctions(module: WasmModule): AnalyzedFunction[] {
  const blockResults = makeBlockResultsResolver(module);
  const callArity = makeCallArityResolver(module);

  return module.functions.map((func) => {
    const cfg = buildFunctionCfg(func);
    const context = computeFunctionContext(func.instructions, blockResults, callArity);
    const constants = analyzeFunctionConstants(
      func.index,
      func.name ?? `func_${func.index}`,
      cfg.blocks,
      context,
    );
    const observations = new Map<number, InstructionObservation>();
    for (const observation of constants.observations) {
      observations.set(observation.instructionIndex, observation);
    }

    return { func, cfg, context, constants, observations };
  });
}
