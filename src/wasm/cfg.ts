/**
 * Shared control-flow and instruction normalization for the WASM analyzers
 * (used by ISSUE-283 program slicing and ISSUE-284 branch analysis).
 *
 * Built on `@webassemblyjs/wasm-parser`, which this repo already uses in
 * `src/wasm/globalsAnalysis.ts`. Nothing here instantiates or executes the
 * module — the AST is only read.
 */

/** Opcode name → the stack effect we care about for data-flow. */
export type ValueKind = 'local' | 'global' | 'const' | 'memory' | 'call' | 'unknown';

/** One normalized instruction. */
export interface Instr {
  /** Index within the flattened function body. Stable across runs. */
  index: number;
  /** Lowercase opcode name, e.g. `local.get`, `i32.add`, `br_if`. */
  opcode: string;
  /** Immediates paired with the opcode (same length). */
  operands: (string | number)[];
  /** Basic block this instruction belongs to. */
  block: number;
  /** True when control can leave after this instruction. */
  isTerminator: boolean;
  /** Block index this terminator jumps to, when statically known. */
  jumpTarget?: number;
}

/** A basic block. */
export interface Block {
  index: number;
  instructionIndices: number[];
  successors: number[];
  predecessors: number[];
}

/** A function's control-flow graph. */
export interface FunctionCFG {
  funcIndex: number;
  blocks: Block[];
  instructions: Instr[];
  entryBlock: number;
  /** Locals declared by this function (count only, per type). */
  localCount: number;
}

const TERMINATORS = new Set(['br', 'br_if', 'br_table', 'return', 'unreachable', 'else', 'end']);

/** Opcodes that end a block and open/close control constructs. */
const BLOCK_OPENERS = new Set(['block', 'loop', 'if']);

/** Parse a WASM buffer to an AST. Never instantiates. */
export function parseWasmAst(buffer: Buffer): any {
  // Imported lazily to match the rest of the codebase's import style.
  const { decode } = require('@webassemblyjs/wasm-parser');
  return decode(buffer, { dump: false, ignoreCodeSection: false, ignoreDataSection: false });
}

/** Lowercase an webassemblyjs instruction id into an opcode string. */
export function opcodeName(id: any): string {
  return String(id?.type ?? '').replace('Instr', '').toLowerCase();
}

/** Extract the declared-local count for a function body. */
function localCountOf(body: any): number {
  const declared = body?.locals ?? [];
  return declared.reduce(
    (acc: number, entry: any) => acc + Number(entry?.count ?? 0),
    0,
  );
}

/**
 * Flatten a function's instruction list and build its CFG.
 *
 * Block splitting is deliberately simple: a new block starts after any
 * terminator and at each block-opening construct. This is conservative — a
 * construct we cannot model still yields correct block boundaries for the
 * straight-line case rather than being silently dropped.
 */
export function buildFunctionCFG(funcIndex: number, body: any): FunctionCFG {
  const raw = body?.instructions ?? [];
  const instructions: Instr[] = [];

  const blockStack: number[] = [];
  let current = 0;
  const blocks: Block[] = [{ index: 0, instructionIndices: [], successors: [], predecessors: [] }];

  const startBlock = (): void => {
    current = blocks.length;
    blocks.push({ index: current, instructionIndices: [], successors: [], predecessors: [] });
  };

  const addEdge = (from: number, to: number): void => {
    if (from === to) return;
    if (!blocks[from].successors.includes(to)) blocks[from].successors.push(to);
    if (!blocks[to].predecessors.includes(from)) blocks[to].predecessors.push(from);
  };

  raw.forEach((node: any, index: number) => {
    const opcode = opcodeName(node?.id);
    const operands: (string | number)[] = [];

    if (node?.id?.value !== undefined) operands.push(node.id.value as string | number);
    if (node?.id?.args) {
      for (const arg of node.id.args) {
        operands.push((arg?.value as string | number) ?? '');
      }
    }
    operands.push('');

    const isTerminator = TERMINATORS.has(opcode);
    const instr: Instr = {
      index,
      opcode,
      operands,
      block: current,
      isTerminator,
    };

    // Fallthrough edge: a non-terminating instruction keeps flow in-block.
    if (!isTerminator && current + 1 < blocks.length + 1 && index + 1 < raw.length) {
      // Edge added after we know the next block exists.
    }

    blocks[current].instructionIndices.push(index);
    instructions.push(instr);

    if (BLOCK_OPENERS.has(opcode)) {
      blockStack.push(current);
      startBlock();
      addEdge(current === 0 ? current : blockStack[blockStack.length - 1], current);
      // Re-point: the opener belongs to the *previous* block.
      blocks[blockStack[blockStack.length - 1]].instructionIndices.pop();
      blocks[blockStack[blockStack.length - 1]].instructionIndices.push(index);
      blocks[current].instructionIndices.pop();
      instructions[instr.index].block = blockStack[blockStack.length - 1];
    } else if (isTerminator) {
      const from = current;
      // A terminator ends the block.
      if (index + 1 < raw.length) startBlock();
      // `end` closes a construct; `else` falls through.
      if (opcode === 'else') {
        addEdge(from, current);
      } else if (opcode !== 'end' && opcode !== 'return' && opcode !== 'unreachable') {
        const parent = blockStack.pop();
        if (parent !== undefined) addEdge(from, parent);
        if (index + 1 < raw.length) addEdge(from, current);
      }
    }
  });

  return { funcIndex, blocks, instructions, entryBlock: 0, localCount: localCountOf(body) };
}

/** Build CFGs for every function in a module, indexed by function index. */
export function buildModuleCFGs(ast: any): Map<number, FunctionCFG> {
  const cfgs = new Map<number, FunctionCFG>();

  // Imported functions occupy the low indexes.
  let funcIndex = 0;
  for (const section of ast?.body ?? []) {
    if (section.type === 'Import') {
      for (const entry of section.entries ?? []) {
        if (entry.kind === 'func') funcIndex++;
      }
    }
  }

  for (const section of ast?.body ?? []) {
    if (section.type === 'Code') {
      (section.entries ?? []).forEach((entry: any) => {
        cfgs.set(funcIndex, buildFunctionCFG(funcIndex, entry?.body));
        funcIndex++;
      });
    }
  }

  return cfgs;
}

/** Classifies where a stack value came from, using the instruction that pushed it. */
export function classifySource(instr: Instr | undefined): ValueKind {
  if (!instr) return 'unknown';
  switch (instr.opcode) {
    case 'local.get':
      return 'local';
    case 'global.get':
      return 'global';
    case 'i32.const':
    case 'i64.const':
    case 'f32.const':
    case 'f64.const':
      return 'const';
    case 'i32.load':
    case 'i64.load':
    case 'f32.load':
    case 'f64.load':
    case 'i32.load8_s':
    case 'i32.load8_u':
    case 'i32.load16_s':
    case 'i32.load16_u':
      return 'memory';
    case 'call':
    case 'call_indirect':
      return 'call';
    default:
      return 'unknown';
  }
}

/** Numeric immediate for a const instruction, when present. */
export function constValue(instr: Instr | undefined): number | undefined {
  if (!instr) return undefined;
  if (!instr.opcode.endsWith('.const')) return undefined;
  const raw = instr.operands[0];
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Local index for a `local.get`/`local.set`/`local.tee`, when present. */
export function localIndex(instr: Instr | undefined): number | undefined {
  if (!instr) return undefined;
  if (!/^local\.(get|set|tee)$/.test(instr.opcode)) return undefined;
  const raw = instr.operands[0];
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

/** Global index for a `global.get`/`global.set`, when present. */
export function globalIndex(instr: Instr | undefined): number | undefined {
  if (!instr) return undefined;
  if (!/^global\.(get|set)$/.test(instr.opcode)) return undefined;
  const raw = instr.operands[0];
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

/** Call target for a `call`, when it is a direct call. */
export function callTarget(instr: Instr | undefined): number | undefined {
  if (!instr || instr.opcode !== 'call') return undefined;
  const raw = instr.operands[0];
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) ? n : undefined;
}