/**
 * Control-flow graph construction for a decoded WASM function.
 *
 * The builder works on the structured instruction stream produced by
 * {@link decodeInstructions}. WebAssembly uses *structured* control flow:
 * `block`, `loop` and `if` introduce a label, `br`/`br_if`/`br_table` leave
 * one by depth. This module resolves those depths into concrete target
 * blocks so the result can be used by the constant-propagation and
 * memory-access analyses.
 *
 * The graph is built purely from the decoded bytes — nothing is executed.
 */

import type { WasmFunction, WasmInstruction } from './wasmBinary';

/** A basic block of a function. */
export interface BasicBlock {
  /** Index of the block inside the function. */
  index: number;
  /** Index of the first instruction of the block. */
  startPc: number;
  /** Index of the last instruction of the block (inclusive). */
  endPc: number;
  /** Instructions of the block. */
  instructions: WasmInstruction[];
  /** Indices of the successor blocks. */
  successors: number[];
  /** Indices of the predecessor blocks. */
  predecessors: number[];
  /** Name of the instruction that terminates the block, when there is one. */
  terminator?: string;
}

/** Control-flow graph of a single function. */
export interface FunctionCfg {
  /** Index of the function in the module function index space. */
  functionIndex: number;
  /** Display name of the function. */
  functionName: string;
  /** Blocks of the function, in program order. */
  blocks: BasicBlock[];
  /** Total number of blocks. */
  blockCount: number;
}

/** Instructions that end a basic block. */
const TERMINATORS = new Set([
  'block',
  'loop',
  'if',
  'else',
  'end',
  'br',
  'br_if',
  'br_table',
  'return',
  'unreachable',
]);

interface ControlFrame {
  kind: 'function' | 'block' | 'loop' | 'if';
  headerPc: number;
  elsePc?: number;
  endPc?: number;
}

/**
 * Builds the control-flow graph of a function.
 *
 * @returns the blocks of the function, or an empty graph when the body
 *          contains no instructions.
 */
export function buildFunctionCfg(func: WasmFunction): FunctionCfg {
  const instructions = func.instructions;

  if (instructions.length === 0) {
    return {
      functionIndex: func.index,
      functionName: func.name ?? `func_${func.index}`,
      blocks: [],
      blockCount: 0,
    };
  }

  // ─── Pass 1: block leaders ────────────────────────────────────────────────
  const leaders = new Set<number>([0]);
  for (const instr of instructions) {
    const next = instr.index + 1;
    switch (instr.name) {
      case 'block':
      case 'loop':
      case 'if':
      case 'else':
      case 'end':
      case 'br':
      case 'br_if':
      case 'br_table':
      case 'return':
      case 'unreachable':
        if (next < instructions.length) leaders.add(next);
        break;
      default:
        break;
    }
  }

  const sortedLeaders = Array.from(leaders).sort((a, b) => a - b);
  const blockOfPc = new Map<number, number>();
  sortedLeaders.forEach((pc, index) => blockOfPc.set(pc, index));

  const blocks: BasicBlock[] = sortedLeaders.map((startPc, index) => {
    const endPc =
      index + 1 < sortedLeaders.length ? sortedLeaders[index + 1] - 1 : instructions.length - 1;
    return {
      index,
      startPc,
      endPc,
      instructions: instructions.slice(startPc, endPc + 1),
      successors: [],
      predecessors: [],
      terminator: instructions[endPc].name,
    };
  });

  // ─── Pass 2: structured control frames ────────────────────────────────────
  const functionFrame: ControlFrame = { kind: 'function', headerPc: -1 };
  const stack: ControlFrame[] = [functionFrame];
  const framesAt: ControlFrame[][] = [];
  const frameCreatedAt = new Map<number, ControlFrame>();
  const frameEndedAt = new Map<number, ControlFrame>();

  for (const instr of instructions) {
    framesAt[instr.index] = [...stack];
    switch (instr.name) {
      case 'block':
      case 'loop':
      case 'if': {
        const frame: ControlFrame = {
          kind: instr.name as ControlFrame['kind'],
          headerPc: instr.index,
        };
        stack.push(frame);
        frameCreatedAt.set(instr.index, frame);
        break;
      }
      case 'else': {
        const top = stack[stack.length - 1];
        if (top) top.elsePc = instr.index;
        break;
      }
      case 'end': {
        const frame = stack.pop();
        if (frame) {
          frame.endPc = instr.index;
          frameEndedAt.set(instr.index, frame);
        }
        break;
      }
      default:
        break;
    }
  }

  /** Resolves the target block of a branch of the given depth. */
  const resolveBranch = (pc: number, depth: number): number | undefined => {
    const frames = framesAt[pc] ?? [];
    // The innermost frame is addressed by depth 0.
    const target = frames[frames.length - 1 - depth];
    if (!target) return undefined;
    if (target.kind === 'function') return undefined; // Branch out of the function.
    if (target.kind === 'loop') {
      return blockOfPc.get(target.headerPc + 1);
    }
    const endPc = target.endPc;
    if (endPc === undefined) return undefined;
    return blockOfPc.get(endPc + 1);
  };

  const nextBlock = (blockIndex: number): number | undefined =>
    blockIndex + 1 < blocks.length ? blockIndex + 1 : undefined;

  // ─── Pass 3: successors ───────────────────────────────────────────────────
  for (const block of blocks) {
    const last = block.instructions[block.instructions.length - 1];
    const successors: number[] = [];

    const add = (target: number | undefined) => {
      if (target !== undefined && !successors.includes(target)) successors.push(target);
    };

    switch (last.name) {
      case 'block':
      case 'loop':
        add(nextBlock(block.index));
        break;
      case 'if': {
        const frame = frameCreatedAt.get(last.index);
        add(nextBlock(block.index)); // then-branch
        if (frame) {
          if (frame.elsePc !== undefined) {
            add(blockOfPc.get(frame.elsePc + 1));
          } else if (frame.endPc !== undefined) {
            add(blockOfPc.get(frame.endPc + 1));
          }
        }
        break;
      }
      case 'else': {
        const frames = framesAt[last.index] ?? [];
        const frame = frames[frames.length - 1];
        add(nextBlock(block.index)); // else-branch
        if (frame?.endPc !== undefined) add(blockOfPc.get(frame.endPc + 1));
        break;
      }
      case 'end': {
        const frame = frameEndedAt.get(last.index);
        if (frame && frame.kind !== 'function' && frame.endPc !== undefined) {
          add(blockOfPc.get(frame.endPc + 1));
        }
        break;
      }
      case 'br': {
        const depth = Number(last.args[0] ?? 0);
        add(resolveBranch(last.index, depth));
        break;
      }
      case 'br_if': {
        const depth = Number(last.args[0] ?? 0);
        add(resolveBranch(last.index, depth));
        add(nextBlock(block.index));
        break;
      }
      case 'br_table': {
        const depths = last.args.map((a) => Number(a));
        for (const depth of depths) add(resolveBranch(last.index, depth));
        break;
      }
      case 'return':
      case 'unreachable':
        break;
      default:
        add(nextBlock(block.index));
        break;
    }

    block.successors = successors;
  }

  for (const block of blocks) {
    for (const successor of block.successors) {
      const target = blocks[successor];
      if (target && !target.predecessors.includes(block.index)) {
        target.predecessors.push(block.index);
      }
    }
  }

  return {
    functionIndex: func.index,
    functionName: func.name ?? `func_${func.index}`,
    blocks,
    blockCount: blocks.length,
  };
}

/**
 * Resolves the type of an instruction's operands and results.
 *
 * The table is intentionally conservative: it covers the operators that the
 * constant propagation engine can evaluate. Unknown operators invalidate the
 * affected stack slot instead of producing a wrong value.
 */
export const STACK_EFFECTS: Record<string, { pops: number; pushes: number }> = {
  'i32.const': { pops: 0, pushes: 1 },
  'i64.const': { pops: 0, pushes: 1 },
  'f32.const': { pops: 0, pushes: 1 },
  'f64.const': { pops: 0, pushes: 1 },
  'local.get': { pops: 0, pushes: 1 },
  'local.set': { pops: 1, pushes: 0 },
  'local.tee': { pops: 1, pushes: 1 },
  'global.get': { pops: 0, pushes: 1 },
  'global.set': { pops: 1, pushes: 0 },
  'i32.eqz': { pops: 1, pushes: 1 },
  'i64.eqz': { pops: 1, pushes: 1 },
  'i32.add': { pops: 2, pushes: 1 },
  'i32.sub': { pops: 2, pushes: 1 },
  'i32.mul': { pops: 2, pushes: 1 },
  'i32.div_s': { pops: 2, pushes: 1 },
  'i32.div_u': { pops: 2, pushes: 1 },
  'i32.rem_s': { pops: 2, pushes: 1 },
  'i32.rem_u': { pops: 2, pushes: 1 },
  'i32.and': { pops: 2, pushes: 1 },
  'i32.or': { pops: 2, pushes: 1 },
  'i32.xor': { pops: 2, pushes: 1 },
  'i32.shl': { pops: 2, pushes: 1 },
  'i32.shr_s': { pops: 2, pushes: 1 },
  'i32.shr_u': { pops: 2, pushes: 1 },
  'i32.rotl': { pops: 2, pushes: 1 },
  'i32.rotr': { pops: 2, pushes: 1 },
  'i32.eq': { pops: 2, pushes: 1 },
  'i32.ne': { pops: 2, pushes: 1 },
  'i32.lt_s': { pops: 2, pushes: 1 },
  'i32.lt_u': { pops: 2, pushes: 1 },
  'i32.gt_s': { pops: 2, pushes: 1 },
  'i32.gt_u': { pops: 2, pushes: 1 },
  'i32.le_s': { pops: 2, pushes: 1 },
  'i32.le_u': { pops: 2, pushes: 1 },
  'i32.ge_s': { pops: 2, pushes: 1 },
  'i32.ge_u': { pops: 2, pushes: 1 },
  'i64.add': { pops: 2, pushes: 1 },
  'i64.sub': { pops: 2, pushes: 1 },
  'i64.mul': { pops: 2, pushes: 1 },
  'i64.div_s': { pops: 2, pushes: 1 },
  'i64.div_u': { pops: 2, pushes: 1 },
  'i64.rem_s': { pops: 2, pushes: 1 },
  'i64.rem_u': { pops: 2, pushes: 1 },
  'i64.and': { pops: 2, pushes: 1 },
  'i64.or': { pops: 2, pushes: 1 },
  'i64.xor': { pops: 2, pushes: 1 },
  'i64.shl': { pops: 2, pushes: 1 },
  'i64.shr_s': { pops: 2, pushes: 1 },
  'i64.shr_u': { pops: 2, pushes: 1 },
  'i64.rotl': { pops: 2, pushes: 1 },
  'i64.rotr': { pops: 2, pushes: 1 },
  'i64.eq': { pops: 2, pushes: 1 },
  'i64.ne': { pops: 2, pushes: 1 },
  'i64.lt_s': { pops: 2, pushes: 1 },
  'i64.lt_u': { pops: 2, pushes: 1 },
  'i64.gt_s': { pops: 2, pushes: 1 },
  'i64.gt_u': { pops: 2, pushes: 1 },
  'i64.le_s': { pops: 2, pushes: 1 },
  'i64.le_u': { pops: 2, pushes: 1 },
  'i64.ge_s': { pops: 2, pushes: 1 },
  'i64.ge_u': { pops: 2, pushes: 1 },
  'i32.wrap_i64': { pops: 1, pushes: 1 },
  'i64.extend_i32_s': { pops: 1, pushes: 1 },
  'i64.extend_i32_u': { pops: 1, pushes: 1 },
  'i32.extend8_s': { pops: 1, pushes: 1 },
  'i32.extend16_s': { pops: 1, pushes: 1 },
  'i64.extend8_s': { pops: 1, pushes: 1 },
  'i64.extend16_s': { pops: 1, pushes: 1 },
  'i64.extend32_s': { pops: 1, pushes: 1 },
  'i32.reinterpret_f32': { pops: 1, pushes: 1 },
  'i64.reinterpret_f64': { pops: 1, pushes: 1 },
  'f32.reinterpret_i32': { pops: 1, pushes: 1 },
  'f64.reinterpret_i64': { pops: 1, pushes: 1 },
  'i32.trunc_sat_f32_s': { pops: 1, pushes: 1 },
  'i32.trunc_sat_f32_u': { pops: 1, pushes: 1 },
  'i32.trunc_sat_f64_s': { pops: 1, pushes: 1 },
  'i32.trunc_sat_f64_u': { pops: 1, pushes: 1 },
  'i64.trunc_sat_f32_s': { pops: 1, pushes: 1 },
  'i64.trunc_sat_f32_u': { pops: 1, pushes: 1 },
  'i64.trunc_sat_f64_s': { pops: 1, pushes: 1 },
  'i64.trunc_sat_f64_u': { pops: 1, pushes: 1 },
  drop: { pops: 1, pushes: 0 },
  select: { pops: 3, pushes: 1 },
  nop: { pops: 0, pushes: 0 },
  unreachable: { pops: 0, pushes: 0 },
  return: { pops: 0, pushes: 0 },
};

/** Instructions that never fall through to the next instruction. */
export const IS_TERMINATOR = TERMINATORS;
