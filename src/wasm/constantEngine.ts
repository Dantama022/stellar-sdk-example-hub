/**
 * Constant propagation engine for WebAssembly functions.
 *
 * The engine performs a conservative, offline data-flow analysis over the
 * decoded instruction stream of a function:
 *
 * - it tracks which locals hold a statically known integer value,
 * - it evaluates arithmetic, bitwise, comparison and conversion operators
 *   whose operands are all known,
 * - it recognises branch conditions whose outcome is known in advance,
 * - it models control-flow merge points and reports conflicting values as
 *   *unknown* instead of picking one of them,
 * - it bounds the number of iterations so loops always terminate.
 *
 * Nothing is executed: every value is derived by evaluating the operator
 * tables in this file.
 */

import type { BasicBlock } from './functionCfg';

/** An abstract value: either a known integer constant or unknown. */
export interface AbstractValue {
  /** True when the value is statically known. */
  known: boolean;
  /** The constant, when known. */
  value?: bigint;
  /**
   * Propagation depth: 1 for a literal, `n + 1` for a value derived from
   * operands of depth `n`.
   */
  depth: number;
}

/** The unknown value. */
export const UNKNOWN: AbstractValue = { known: false, depth: 0 };

/** Creates a known abstract value. */
export function known(value: bigint, depth = 1): AbstractValue {
  return { known: true, value, depth };
}

/** A local holding a statically known value. */
export interface LocalValue {
  value: bigint;
  depth: number;
}

/** State of a basic block: the constants known for every local on entry. */
export interface BlockState {
  locals: Map<number, LocalValue>;
}

/** Static information about the operand stack at a given instruction. */
export interface FunctionContext {
  /** Operand stack height *before* each instruction. */
  heightBefore: number[];
  /**
   * Structured control frames enclosing each instruction. Every entry holds
   * the operand stack height at the point where the frame was opened.
   */
  framesBefore: number[][];
  /** Number of results produced by a block type. */
  blockResults: (blockType: string | undefined) => number;
  /**
   * Resolves the number of parameters and results of a callee so that the
   * operand stack height of `call` instructions can be modelled.
   */
  callArity?: (funcIndex: number) => { params: number; results: number };
}

/** A single constant-related observation recorded for an instruction. */
export interface InstructionObservation {
  /** Index of the basic block the instruction belongs to. */
  blockIndex: number;
  /** Index of the instruction inside the function. */
  instructionIndex: number;
  /** Mnemonic of the instruction. */
  opcode: string;
  /** Value of the top of the operand stack before the instruction. */
  stackTop?: AbstractValue;
  /** Value of the second operand on the stack before the instruction. */
  stackSecond?: AbstractValue;
  /** Condition value for `br_if` and `if`. */
  condition?: AbstractValue;
  /** Local index written by the instruction, when it writes one. */
  localIndex?: number;
  /** Value written into the local. */
  writtenValue?: AbstractValue;
  /** Value produced by the instruction. */
  result?: AbstractValue;
}

/** A constant-related finding. */
export interface ConstantFinding {
  /** Kind of the finding. */
  type:
    'constant' | 'derived' | 'propagated-local' | 'local-read' | 'comparison' | 'branch-condition';
  /** Index of the function in the module function index space. */
  functionIndex: number;
  /** Display name of the function. */
  functionName: string;
  /** Index of the basic block. */
  blockIndex: number;
  /** Index of the instruction inside the function. */
  instructionIndex: number;
  /** Mnemonic of the instruction. */
  opcode: string;
  /** Decimal representation of the constant, when there is one. */
  value?: string;
  /** Value type of the constant. */
  valueType?: 'i32' | 'i64';
  /** Propagation depth of the constant. */
  depth?: number;
  /** Additional detail, e.g. `always_true` or `always_false`. */
  detail?: string;
}

/** A control-flow merge point where incoming values disagreed. */
export interface MergeConflict {
  functionIndex: number;
  functionName: string;
  /** Index of the merged block. */
  blockIndex: number;
  /** Locals whose incoming values disagreed. */
  locals: number[];
}

/** Result of the constant analysis of one function. */
export interface FunctionConstantResult {
  functionIndex: number;
  functionName: string;
  /** Findings, ordered by instruction index. */
  findings: ConstantFinding[];
  /** Merge points with conflicting incoming values. */
  merges: MergeConflict[];
  /** Per-instruction observations from the final iteration. */
  observations: InstructionObservation[];
  /** Locals that are statically known on entry to the function. */
  constantLocals: number[];
}

// ─── Integer helpers ────────────────────────────────────────────────────────

const asI32 = (value: bigint): bigint => BigInt.asIntN(32, value);
const asU32 = (value: bigint): bigint => BigInt.asUintN(32, value);
const asI64 = (value: bigint): bigint => BigInt.asIntN(64, value);
const asU64 = (value: bigint): bigint => BigInt.asUintN(64, value);

function popCount(value: bigint): bigint {
  let v = BigInt.asUintN(64, value);
  let count = 0n;
  while (v !== 0n) {
    v &= v - 1n;
    count += 1n;
  }
  return count;
}

function countLeadingZeros(value: bigint, bits: 32 | 64): bigint {
  const width = BigInt(bits);
  const masked = BigInt.asUintN(bits, value);
  if (masked === 0n) return width;
  let count = 0n;
  for (let bit = width - 1n; bit >= 0n; bit--) {
    if ((masked >> bit) & 1n) break;
    count += 1n;
  }
  return count;
}

function countTrailingZeros(value: bigint, bits: 32 | 64): bigint {
  const masked = BigInt.asUintN(bits, value);
  if (masked === 0n) return BigInt(bits);
  let count = 0n;
  while (((masked >> count) & 1n) === 0n) count += 1n;
  return count;
}

function rotateLeft(value: bigint, amount: bigint, bits: 32 | 64): bigint {
  const width = BigInt(bits);
  const mask = (1n << width) - 1n;
  const shift = BigInt.asUintN(bits, amount) % width;
  const masked = BigInt.asUintN(bits, value);
  if (shift === 0n) return BigInt.asIntN(bits, masked);
  const left = (masked << shift) & mask;
  const right = masked >> (width - shift);
  return BigInt.asIntN(bits, left | right);
}

function rotateRight(value: bigint, amount: bigint, bits: 32 | 64): bigint {
  const width = BigInt(bits);
  const mask = (1n << width) - 1n;
  const shift = BigInt.asUintN(bits, amount) % width;
  const masked = BigInt.asUintN(bits, value);
  if (shift === 0n) return BigInt.asIntN(bits, masked);
  const right = masked >> shift;
  const left = (masked << (width - shift)) & mask;
  return BigInt.asIntN(bits, right | left);
}

// ─── Operator evaluation ────────────────────────────────────────────────────

type BinaryEval = (a: bigint, b: bigint) => bigint | undefined;
type UnaryEval = (a: bigint) => bigint | undefined;

const I32_ARITH: Record<string, BinaryEval> = {
  'i32.add': (a, b) => asI32(a + b),
  'i32.sub': (a, b) => asI32(a - b),
  'i32.mul': (a, b) => asI32(a * b),
  'i32.div_s': (a, b) => {
    if (b === 0n) return undefined;
    if (asI32(a) === -2147483648n && asI32(b) === -1n) return undefined; // Traps.
    return asI32(asI32(a) / asI32(b));
  },
  'i32.div_u': (a, b) => {
    if (b === 0n) return undefined;
    return asI32(asU32(a) / asU32(b));
  },
  'i32.rem_s': (a, b) => {
    if (b === 0n) return undefined;
    if (asI32(a) === -2147483648n && asI32(b) === -1n) return undefined; // Traps.
    return asI32(asI32(a) % asI32(b));
  },
  'i32.rem_u': (a, b) => {
    if (b === 0n) return undefined;
    return asI32(asU32(a) % asU32(b));
  },
  'i32.and': (a, b) => asI32(a & b),
  'i32.or': (a, b) => asI32(a | b),
  'i32.xor': (a, b) => asI32(a ^ b),
  'i32.shl': (a, b) => asI32(a << (asU32(b) & 31n)),
  'i32.shr_s': (a, b) => asI32(a >> (asU32(b) & 31n)),
  'i32.shr_u': (a, b) => asI32(asU32(a) >> (asU32(b) & 31n)),
  'i32.rotl': (a, b) => rotateLeft(a, b, 32),
  'i32.rotr': (a, b) => rotateRight(a, b, 32),
};

const I64_ARITH: Record<string, BinaryEval> = {
  'i64.add': (a, b) => asI64(a + b),
  'i64.sub': (a, b) => asI64(a - b),
  'i64.mul': (a, b) => asI64(a * b),
  'i64.div_s': (a, b) => {
    if (b === 0n) return undefined;
    return asI64(asI64(a) / asI64(b));
  },
  'i64.div_u': (a, b) => {
    if (b === 0n) return undefined;
    return asI64(asU64(a) / asU64(b));
  },
  'i64.rem_s': (a, b) => {
    if (b === 0n) return undefined;
    return asI64(asI64(a) % asI64(b));
  },
  'i64.rem_u': (a, b) => {
    if (b === 0n) return undefined;
    return asI64(asU64(a) % asU64(b));
  },
  'i64.and': (a, b) => asI64(a & b),
  'i64.or': (a, b) => asI64(a | b),
  'i64.xor': (a, b) => asI64(a ^ b),
  'i64.shl': (a, b) => asI64(a << (asU64(b) & 63n)),
  'i64.shr_s': (a, b) => asI64(a >> (asU64(b) & 63n)),
  'i64.shr_u': (a, b) => asI64(asU64(a) >> (asU64(b) & 63n)),
  'i64.rotl': (a, b) => rotateLeft(a, b, 64),
  'i64.rotr': (a, b) => rotateRight(a, b, 64),
};

const I32_COMPARE: Record<string, (a: bigint, b: bigint) => boolean> = {
  'i32.eq': (a, b) => asI32(a) === asI32(b),
  'i32.ne': (a, b) => asI32(a) !== asI32(b),
  'i32.lt_s': (a, b) => asI32(a) < asI32(b),
  'i32.lt_u': (a, b) => asU32(a) < asU32(b),
  'i32.gt_s': (a, b) => asI32(a) > asI32(b),
  'i32.gt_u': (a, b) => asU32(a) > asU32(b),
  'i32.le_s': (a, b) => asI32(a) <= asI32(b),
  'i32.le_u': (a, b) => asU32(a) <= asU32(b),
  'i32.ge_s': (a, b) => asI32(a) >= asI32(b),
  'i32.ge_u': (a, b) => asU32(a) >= asU32(b),
};

const I64_COMPARE: Record<string, (a: bigint, b: bigint) => boolean> = {
  'i64.eq': (a, b) => asI64(a) === asI64(b),
  'i64.ne': (a, b) => asI64(a) !== asI64(b),
  'i64.lt_s': (a, b) => asI64(a) < asI64(b),
  'i64.lt_u': (a, b) => asU64(a) < asU64(b),
  'i64.gt_s': (a, b) => asI64(a) > asI64(b),
  'i64.gt_u': (a, b) => asU64(a) > asU64(b),
  'i64.le_s': (a, b) => asI64(a) <= asI64(b),
  'i64.le_u': (a, b) => asU64(a) <= asU64(b),
  'i64.ge_s': (a, b) => asI64(a) >= asI64(b),
  'i64.ge_u': (a, b) => asU64(a) >= asU64(b),
};

const UNARY_OPS: Record<string, UnaryEval> = {
  'i32.eqz': (a) => (asI32(a) === 0n ? 0n : 1n),
  'i64.eqz': (a) => (asI64(a) === 0n ? 0n : 1n),
  'i32.clz': (a) => countLeadingZeros(a, 32),
  'i32.ctz': (a) => countTrailingZeros(a, 32),
  'i32.popcnt': (a) => popCount(a),
  'i64.clz': (a) => countLeadingZeros(a, 64),
  'i64.ctz': (a) => countTrailingZeros(a, 64),
  'i64.popcnt': (a) => popCount(a),
  'i32.wrap_i64': (a) => asI32(a),
  'i64.extend_i32_s': (a) => asI64(asI32(a)),
  'i64.extend_i32_u': (a) => asI64(asU32(a)),
  'i32.extend8_s': (a) => BigInt.asIntN(8, a),
  'i32.extend16_s': (a) => BigInt.asIntN(16, a),
  'i64.extend8_s': (a) => BigInt.asIntN(8, a),
  'i64.extend16_s': (a) => BigInt.asIntN(16, a),
  'i64.extend32_s': (a) => BigInt.asIntN(32, a),
};

/** Evaluates a binary operator on two abstract values. */
export function evaluateBinary(opcode: string, a: AbstractValue, b: AbstractValue): AbstractValue {
  if (!a.known || !b.known || a.value === undefined || b.value === undefined) return UNKNOWN;

  const depth = Math.max(a.depth, b.depth) + 1;

  const compare = I32_COMPARE[opcode] ?? I64_COMPARE[opcode];
  if (compare) {
    return known(compare(a.value, b.value) ? 1n : 0n, depth);
  }

  const arith = I32_ARITH[opcode] ?? I64_ARITH[opcode];
  if (arith) {
    const result = arith(a.value, b.value);
    return result === undefined ? UNKNOWN : known(result, depth);
  }

  return UNKNOWN;
}

/** Evaluates a unary operator on an abstract value. */
export function evaluateUnary(opcode: string, a: AbstractValue): AbstractValue {
  if (!a.known || a.value === undefined) return UNKNOWN;
  const unary = UNARY_OPS[opcode];
  if (!unary) return UNKNOWN;
  const result = unary(a.value);
  return result === undefined ? UNKNOWN : known(result, a.depth + 1);
}

/** True when the opcode produces an i32 result. */
export function isComparisonOpcode(opcode: string): boolean {
  return (
    opcode in I32_COMPARE || opcode in I64_COMPARE || opcode === 'i32.eqz' || opcode === 'i64.eqz'
  );
}

// ─── Static stack-height pass ───────────────────────────────────────────────

/**
 * Computes the operand stack height in front of every instruction.
 *
 * The pass is purely structural: it uses the block type of the function and
 * the block types of structured control frames to know how many values each
 * frame yields.
 */
export function computeFunctionContext(
  instructions: {
    index: number;
    name: string;
    blockType?: string;
    args?: (number | string | bigint)[];
  }[],
  blockResults: (blockType: string | undefined) => number,
  callArity?: (funcIndex: number) => { params: number; results: number },
): FunctionContext {
  const heightBefore: number[] = new Array(instructions.length).fill(0);
  const framesBefore: number[][] = new Array(instructions.length).fill([]);

  let height = 0;
  const frames: number[] = [];

  for (const instr of instructions) {
    heightBefore[instr.index] = height;
    framesBefore[instr.index] = [...frames];

    switch (instr.name) {
      case 'i32.const':
      case 'i64.const':
      case 'f32.const':
      case 'f64.const':
      case 'local.get':
      case 'global.get':
        height += 1;
        break;
      case 'local.set':
      case 'global.set':
        height = Math.max(0, height - 1);
        break;
      case 'local.tee':
        break;
      case 'drop':
        height = Math.max(0, height - 1);
        break;
      case 'select':
        height = Math.max(0, height - 2);
        break;
      case 'if':
        height = Math.max(0, height - 1);
        frames.push(height);
        break;
      case 'block':
      case 'loop':
        frames.push(height);
        break;
      case 'else':
        if (frames.length > 0) height = frames[frames.length - 1];
        break;
      case 'end': {
        const marker = frames.pop();
        if (marker !== undefined) {
          height = marker;
          const results = blockResults(instr.blockType);
          height += results;
        }
        break;
      }
      case 'br':
      case 'br_table':
      case 'return':
      case 'unreachable':
        break;
      case 'br_if':
        height = Math.max(0, height - 1);
        break;
      case 'call': {
        const callee = Number(instr.args?.[0] ?? 0);
        const arity = callArity?.(callee);
        if (!arity) break;
        height = Math.max(0, height - arity.params) + arity.results;
        break;
      }
      case 'call_indirect': {
        const callee = Number(instr.args?.[0] ?? 0);
        const arity = callArity?.(callee);
        const params = arity ? arity.params : 0;
        const results = arity ? arity.results : 0;
        height = Math.max(0, height - params - 1) + results;
        break;
      }
      default: {
        const memoryEffect = MEMORY_POP_PUSH[instr.name];
        if (memoryEffect) {
          height = Math.max(0, height - memoryEffect.pops) + memoryEffect.pushes;
          break;
        }
        const pops = POPS[instr.name] ?? 0;
        const pushes = PUSHES[instr.name] ?? 0;
        height = Math.max(0, height - pops) + pushes;
        break;
      }
    }
  }

  return { heightBefore, framesBefore, blockResults, callArity };
}

/** Number of operands consumed by the operators the engine understands. */
const POPS: Record<string, number> = {
  'i32.eqz': 1,
  'i64.eqz': 1,
  'i32.add': 2,
  'i32.sub': 2,
  'i32.mul': 2,
  'i32.div_s': 2,
  'i32.div_u': 2,
  'i32.rem_s': 2,
  'i32.rem_u': 2,
  'i32.and': 2,
  'i32.or': 2,
  'i32.xor': 2,
  'i32.shl': 2,
  'i32.shr_s': 2,
  'i32.shr_u': 2,
  'i32.rotl': 2,
  'i32.rotr': 2,
  'i32.eq': 2,
  'i32.ne': 2,
  'i32.lt_s': 2,
  'i32.lt_u': 2,
  'i32.gt_s': 2,
  'i32.gt_u': 2,
  'i32.le_s': 2,
  'i32.le_u': 2,
  'i32.ge_s': 2,
  'i32.ge_u': 2,
  'i64.add': 2,
  'i64.sub': 2,
  'i64.mul': 2,
  'i64.div_s': 2,
  'i64.div_u': 2,
  'i64.rem_s': 2,
  'i64.rem_u': 2,
  'i64.and': 2,
  'i64.or': 2,
  'i64.xor': 2,
  'i64.shl': 2,
  'i64.shr_s': 2,
  'i64.shr_u': 2,
  'i64.rotl': 2,
  'i64.rotr': 2,
  'i64.eq': 2,
  'i64.ne': 2,
  'i64.lt_s': 2,
  'i64.lt_u': 2,
  'i64.gt_s': 2,
  'i64.gt_u': 2,
  'i64.le_s': 2,
  'i64.le_u': 2,
  'i64.ge_s': 2,
  'i64.ge_u': 2,
  'i32.wrap_i64': 1,
  'i64.extend_i32_s': 1,
  'i64.extend_i32_u': 1,
  'i32.extend8_s': 1,
  'i32.extend16_s': 1,
  'i64.extend8_s': 1,
  'i64.extend16_s': 1,
  'i64.extend32_s': 1,
  'i32.clz': 1,
  'i32.ctz': 1,
  'i32.popcnt': 1,
  'i64.clz': 1,
  'i64.ctz': 1,
  'i64.popcnt': 1,
};

/** Number of operands produced by the operators the engine understands. */
const PUSHES: Record<string, number> = {
  'i32.eqz': 1,
  'i64.eqz': 1,
  'i32.add': 1,
  'i32.sub': 1,
  'i32.mul': 1,
  'i32.div_s': 1,
  'i32.div_u': 1,
  'i32.rem_s': 1,
  'i32.rem_u': 1,
  'i32.and': 1,
  'i32.or': 1,
  'i32.xor': 1,
  'i32.shl': 1,
  'i32.shr_s': 1,
  'i32.shr_u': 1,
  'i32.rotl': 1,
  'i32.rotr': 1,
  'i32.eq': 1,
  'i32.ne': 1,
  'i32.lt_s': 1,
  'i32.lt_u': 1,
  'i32.gt_s': 1,
  'i32.gt_u': 1,
  'i32.le_s': 1,
  'i32.le_u': 1,
  'i32.ge_s': 1,
  'i32.ge_u': 1,
  'i64.add': 1,
  'i64.sub': 1,
  'i64.mul': 1,
  'i64.div_s': 1,
  'i64.div_u': 1,
  'i64.rem_s': 1,
  'i64.rem_u': 1,
  'i64.and': 1,
  'i64.or': 1,
  'i64.xor': 1,
  'i64.shl': 1,
  'i64.shr_s': 1,
  'i64.shr_u': 1,
  'i64.rotl': 1,
  'i64.rotr': 1,
  'i64.eq': 1,
  'i64.ne': 1,
  'i64.lt_s': 1,
  'i64.lt_u': 1,
  'i64.gt_s': 1,
  'i64.gt_u': 1,
  'i64.le_s': 1,
  'i64.le_u': 1,
  'i64.ge_s': 1,
  'i64.ge_u': 1,
  'i32.wrap_i64': 1,
  'i64.extend_i32_s': 1,
  'i64.extend_i32_u': 1,
  'i32.extend8_s': 1,
  'i32.extend16_s': 1,
  'i64.extend8_s': 1,
  'i64.extend16_s': 1,
  'i64.extend32_s': 1,
  'i32.clz': 1,
  'i32.ctz': 1,
  'i32.popcnt': 1,
  'i64.clz': 1,
  'i64.ctz': 1,
  'i64.popcnt': 1,
};

/** Memory access operators: loads pop the address, stores pop address and value. */
const MEMORY_POP_PUSH: Record<string, { pops: number; pushes: number }> = {
  'i32.load': { pops: 1, pushes: 1 },
  'i64.load': { pops: 1, pushes: 1 },
  'f32.load': { pops: 1, pushes: 1 },
  'f64.load': { pops: 1, pushes: 1 },
  'i32.load8_s': { pops: 1, pushes: 1 },
  'i32.load8_u': { pops: 1, pushes: 1 },
  'i32.load16_s': { pops: 1, pushes: 1 },
  'i32.load16_u': { pops: 1, pushes: 1 },
  'i64.load8_s': { pops: 1, pushes: 1 },
  'i64.load8_u': { pops: 1, pushes: 1 },
  'i64.load16_s': { pops: 1, pushes: 1 },
  'i64.load16_u': { pops: 1, pushes: 1 },
  'i64.load32_s': { pops: 1, pushes: 1 },
  'i64.load32_u': { pops: 1, pushes: 1 },
  'i32.store': { pops: 2, pushes: 0 },
  'i64.store': { pops: 2, pushes: 0 },
  'f32.store': { pops: 2, pushes: 0 },
  'f64.store': { pops: 2, pushes: 0 },
  'i32.store8': { pops: 2, pushes: 0 },
  'i32.store16': { pops: 2, pushes: 0 },
  'i64.store8': { pops: 2, pushes: 0 },
  'i64.store16': { pops: 2, pushes: 0 },
  'i64.store32': { pops: 2, pushes: 0 },
};

// ─── Data-flow analysis ─────────────────────────────────────────────────────

/** Maximum number of fix-point iterations per function. */
const MAX_ITERATIONS = 64;

/** Result of transferring a block. */
interface TransferResult {
  locals: Map<number, LocalValue>;
  observations: InstructionObservation[];
  findings: ConstantFinding[];
}

/**
 * Runs the constant propagation analysis over a single function.
 *
 * @param functionIndex index of the function in the module.
 * @param functionName display name of the function.
 * @param blocks basic blocks of the function.
 * @param context static stack-height information.
 */
export function analyzeFunctionConstants(
  functionIndex: number,
  functionName: string,
  blocks: BasicBlock[],
  context: FunctionContext,
): FunctionConstantResult {
  const outStates = new Map<number, Map<number, LocalValue>>();
  const findings = new Map<string, ConstantFinding>();
  const merges = new Map<number, MergeConflict>();
  const observationMap = new Map<number, InstructionObservation[]>();

  const recordFinding = (finding: ConstantFinding) => {
    const key = `${finding.blockIndex}:${finding.instructionIndex}:${finding.type}`;
    findings.set(key, finding);
  };

  const mergeStates = (
    blockIndex: number,
  ): { locals: Map<number, LocalValue>; conflicts: number[] } => {
    const block = blocks.find((b) => b.index === blockIndex);
    const locals = new Map<number, LocalValue>();
    const conflicts: number[] = [];
    if (!block) return { locals, conflicts };

    const preds = block.predecessors ?? [];
    if (preds.length === 0) return { locals, conflicts };

    const predecessorStates = preds.map((p) => outStates.get(p));
    const candidateLocals = new Set<number>();
    for (const state of predecessorStates) {
      if (!state) continue;
      for (const key of state.keys()) candidateLocals.add(key);
    }

    for (const local of Array.from(candidateLocals).sort((a, b) => a - b)) {
      let value: bigint | undefined;
      let depth = Number.MAX_SAFE_INTEGER;
      let conflict = false;
      let missing = false;

      for (const state of predecessorStates) {
        if (!state) {
          missing = true;
          break;
        }
        const entry = state.get(local);
        if (!entry) {
          missing = true;
          break;
        }
        if (value === undefined) {
          value = entry.value;
          depth = entry.depth;
        } else if (entry.value !== value) {
          conflict = true;
          break;
        } else {
          depth = Math.min(depth, entry.depth);
        }
      }

      if (conflict) {
        conflicts.push(local);
        continue;
      }
      if (missing || value === undefined) continue;
      locals.set(local, { value, depth });
    }

    return { locals, conflicts };
  };

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let changed = false;

    for (const block of blocks) {
      const { locals: inLocals, conflicts } = mergeStates(block.index);

      if (conflicts.length > 0) {
        const key = block.index;
        const existing = merges.get(key);
        merges.set(key, {
          functionIndex,
          functionName,
          blockIndex: block.index,
          locals: Array.from(new Set([...(existing?.locals ?? []), ...conflicts])).sort(
            (a, b) => a - b,
          ),
        });
      }

      const transfer = transferBlock(
        block,
        inLocals,
        context,
        functionIndex,
        functionName,
        recordFinding,
      );

      const previous = outStates.get(block.index);
      if (!statesEqual(previous, transfer.locals)) {
        changed = true;
      }
      outStates.set(block.index, transfer.locals);
      observationMap.set(block.index, transfer.observations);
    }

    if (!changed) break;
  }

  const observations: InstructionObservation[] = [];
  for (const block of blocks) {
    const blockObservations = observationMap.get(block.index);
    if (blockObservations) observations.push(...blockObservations);
  }
  observations.sort((a, b) => a.instructionIndex - b.instructionIndex);

  const entryState = blocks.length > 0 ? outStates.get(blocks[0].index) : undefined;
  const constantLocals = entryState ? Array.from(entryState.keys()).sort((a, b) => a - b) : [];

  return {
    functionIndex,
    functionName,
    findings: Array.from(findings.values()).sort((a, b) =>
      a.instructionIndex === b.instructionIndex
        ? a.type.localeCompare(b.type)
        : a.instructionIndex - b.instructionIndex,
    ),
    merges: Array.from(merges.values()).sort((a, b) => a.blockIndex - b.blockIndex),
    observations,
    constantLocals,
  };
}

/** Compares two local states. */
function statesEqual(a: Map<number, LocalValue> | undefined, b: Map<number, LocalValue>): boolean {
  if (!a) return b.size === 0;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other?.value !== value.value) return false;
  }
  return true;
}

/** Runs the instruction sequence of a block on top of the incoming state. */
function transferBlock(
  block: BasicBlock,
  inLocals: Map<number, LocalValue>,
  context: FunctionContext,
  functionIndex: number,
  functionName: string,
  recordFinding: (finding: ConstantFinding) => void,
): TransferResult {
  const locals = new Map<number, LocalValue>(inLocals);
  const observations: InstructionObservation[] = [];

  const startHeight = context.heightBefore[block.startPc] ?? 0;
  const stack: AbstractValue[] = new Array(startHeight).fill(UNKNOWN);
  const frames: number[] = [...(context.framesBefore[block.startPc] ?? [])];

  const push = (value: AbstractValue) => {
    stack.push(value);
  };
  const pop = (): AbstractValue => {
    if (stack.length === 0) return UNKNOWN;
    return stack.pop() as AbstractValue;
  };

  for (const instr of block.instructions) {
    const observation: InstructionObservation = {
      blockIndex: block.index,
      instructionIndex: instr.index,
      opcode: instr.name,
    };

    if (stack.length > 0) observation.stackTop = stack[stack.length - 1];
    if (stack.length > 1) observation.stackSecond = stack[stack.length - 2];

    switch (instr.name) {
      case 'i32.const':
      case 'i64.const': {
        const raw = instr.args[0];
        const value = typeof raw === 'bigint' ? raw : BigInt(raw ?? 0);
        const result = known(value, 1);
        push(result);
        observation.result = result;
        recordFinding({
          type: 'constant',
          functionIndex,
          functionName,
          blockIndex: block.index,
          instructionIndex: instr.index,
          opcode: instr.name,
          value: value.toString(),
          valueType: instr.name === 'i32.const' ? 'i32' : 'i64',
          depth: 1,
        });
        break;
      }
      case 'f32.const':
      case 'f64.const':
        push(UNKNOWN);
        break;
      case 'local.get': {
        const index = Number(instr.args[0] ?? 0);
        const entry = locals.get(index);
        const result = entry ? known(entry.value, entry.depth) : UNKNOWN;
        push(result);
        observation.result = result;
        if (result.known && result.value !== undefined) {
          recordFinding({
            type: 'local-read',
            functionIndex,
            functionName,
            blockIndex: block.index,
            instructionIndex: instr.index,
            opcode: instr.name,
            value: result.value.toString(),
            depth: result.depth,
            detail: `local ${index}`,
          });
        }
        break;
      }
      case 'local.set': {
        const index = Number(instr.args[0] ?? 0);
        const value = pop();
        observation.localIndex = index;
        observation.writtenValue = value;
        if (value.known && value.value !== undefined) {
          locals.set(index, { value: value.value, depth: value.depth });
          recordFinding({
            type: 'propagated-local',
            functionIndex,
            functionName,
            blockIndex: block.index,
            instructionIndex: instr.index,
            opcode: instr.name,
            value: value.value.toString(),
            depth: value.depth,
          });
        } else {
          locals.delete(index);
        }
        break;
      }
      case 'local.tee': {
        const index = Number(instr.args[0] ?? 0);
        const value = pop();
        observation.localIndex = index;
        observation.writtenValue = value;
        if (value.known && value.value !== undefined) {
          locals.set(index, { value: value.value, depth: value.depth });
        } else {
          locals.delete(index);
        }
        push(value);
        observation.result = value;
        break;
      }
      case 'global.get':
        push(UNKNOWN);
        break;
      case 'global.set':
        pop();
        break;
      case 'drop':
        pop();
        break;
      case 'select': {
        const condition = pop();
        const alternative = pop();
        const consequent = pop();
        let result = UNKNOWN;
        if (condition.known && condition.value !== undefined) {
          result = condition.value !== 0n ? consequent : alternative;
        }
        push(result);
        observation.result = result;
        break;
      }
      case 'block':
      case 'loop':
        frames.push(stack.length);
        break;
      case 'if': {
        const condition = pop();
        observation.condition = condition;
        frames.push(stack.length);
        if (condition.known && condition.value !== undefined) {
          recordFinding({
            type: 'branch-condition',
            functionIndex,
            functionName,
            blockIndex: block.index,
            instructionIndex: instr.index,
            opcode: instr.name,
            value: condition.value.toString(),
            detail: condition.value !== 0n ? 'always_true' : 'always_false',
            depth: condition.depth,
          });
        }
        break;
      }
      case 'else': {
        if (frames.length > 0) stack.length = frames[frames.length - 1];
        break;
      }
      case 'end': {
        const marker = frames.pop();
        if (marker !== undefined) {
          const results = context.blockResults(instr.blockType);
          if (results > 0 && stack.length > marker) {
            const value = stack[stack.length - 1];
            stack.length = marker;
            push(value);
          } else {
            stack.length = marker;
          }
        }
        break;
      }
      case 'br_if': {
        const condition = pop();
        observation.condition = condition;
        if (condition.known && condition.value !== undefined) {
          recordFinding({
            type: 'branch-condition',
            functionIndex,
            functionName,
            blockIndex: block.index,
            instructionIndex: instr.index,
            opcode: instr.name,
            value: condition.value.toString(),
            detail: condition.value !== 0n ? 'always_true' : 'always_false',
            depth: condition.depth,
          });
        }
        break;
      }
      case 'br':
      case 'br_table':
      case 'return':
      case 'unreachable':
        break;
      case 'call':
      case 'call_indirect': {
        // The callee may modify memory and locals conservatively; the values
        // on the operand stack become unknown.
        for (let i = 0; i < stack.length; i++) stack[i] = UNKNOWN;
        const callee = Number(instr.args[0] ?? 0);
        const arity = context.callArity?.(callee);
        if (arity) {
          for (let i = 0; i < arity.params; i++) pop();
          for (let i = 0; i < arity.results; i++) push(UNKNOWN);
        }
        break;
      }
      default: {
        if (isComparisonOpcode(instr.name)) {
          const right = pop();
          const left = pop();
          const result = evaluateBinary(instr.name, left, right);
          push(result);
          observation.result = result;
          if (result.known && result.value !== undefined) {
            recordFinding({
              type: 'comparison',
              functionIndex,
              functionName,
              blockIndex: block.index,
              instructionIndex: instr.index,
              opcode: instr.name,
              value: result.value.toString(),
              valueType: 'i32',
              depth: result.depth,
            });
          }
          break;
        }

        if (instr.name in UNARY_OPS) {
          const operand = pop();
          const result = evaluateUnary(instr.name, operand);
          push(result);
          observation.result = result;
          if (result.known && result.value !== undefined) {
            recordFinding({
              type: 'derived',
              functionIndex,
              functionName,
              blockIndex: block.index,
              instructionIndex: instr.index,
              opcode: instr.name,
              value: result.value.toString(),
              valueType: instr.name.startsWith('i64') ? 'i64' : 'i32',
              depth: result.depth,
            });
          }
          break;
        }

        if (instr.name in I32_ARITH || instr.name in I64_ARITH) {
          const right = pop();
          const left = pop();
          const result = evaluateBinary(instr.name, left, right);
          push(result);
          observation.result = result;
          if (result.known && result.value !== undefined) {
            recordFinding({
              type: 'derived',
              functionIndex,
              functionName,
              blockIndex: block.index,
              instructionIndex: instr.index,
              opcode: instr.name,
              value: result.value.toString(),
              valueType: instr.name.startsWith('i64') ? 'i64' : 'i32',
              depth: result.depth,
            });
          }
          break;
        }

        // Unknown or unsupported operator: invalidate the affected stack slots.
        const memoryEffect = MEMORY_POP_PUSH[instr.name];
        if (memoryEffect) {
          for (let i = 0; i < memoryEffect.pops; i++) pop();
          for (let i = 0; i < memoryEffect.pushes; i++) push(UNKNOWN);
          break;
        }

        const pops = POPS[instr.name] ?? 0;
        const pushes = PUSHES[instr.name] ?? 0;
        for (let i = 0; i < pops; i++) pop();
        for (let i = 0; i < pushes; i++) push(UNKNOWN);
        break;
      }
    }

    observations.push(observation);
  }

  return { locals, observations, findings: [] };
}
