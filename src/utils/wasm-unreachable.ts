import fs from 'fs';

export class WasmUnreachableValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WasmUnreachableValidationError';
  }
}

interface Section {
  id: number;
  order: number;
  payload: Buffer;
}

class Reader {
  offset = 0;

  constructor(private readonly data: Buffer) {}

  get done(): boolean {
    return this.offset >= this.data.length;
  }

  byte(): number {
    if (this.offset >= this.data.length) {
      throw new WasmUnreachableValidationError('Unexpected end of WASM data');
    }
    return this.data[this.offset++];
  }

  bytes(length: number): Buffer {
    if (length < 0 || this.offset + length > this.data.length) {
      throw new WasmUnreachableValidationError('Section length exceeds remaining WASM data');
    }
    const out = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  varuint32(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i += 1) {
      const byte = this.byte();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
    throw new WasmUnreachableValidationError('Invalid unsigned LEB128 value');
  }

  varint32(): number {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = this.byte();
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while ((byte & 0x80) !== 0 && shift < 35);
    if (shift < 32 && (byte & 0x40) !== 0) result |= ~0 << shift;
    return result;
  }

  string(): string {
    const length = this.varuint32();
    return this.bytes(length).toString('utf8');
  }
}

function parseSections(wasm: Buffer): Section[] {
  if (wasm.length < 8) {
    throw new WasmUnreachableValidationError('Invalid WASM binary: file is too short');
  }
  if (wasm.subarray(0, 4).compare(Buffer.from([0x00, 0x61, 0x73, 0x6d])) !== 0) {
    throw new WasmUnreachableValidationError(
      'Invalid WASM binary: missing WebAssembly magic header',
    );
  }
  if (wasm.subarray(4, 8).compare(Buffer.from([0x01, 0x00, 0x00, 0x00])) !== 0) {
    throw new WasmUnreachableValidationError('Unsupported WASM binary: expected version 1');
  }

  const reader = new Reader(wasm.subarray(8));
  const sections: Section[] = [];
  let order = 0;
  while (!reader.done) {
    const id = reader.byte();
    const size = reader.varuint32();
    sections.push({ id, order, payload: reader.bytes(size) });
    order += 1;
  }
  return sections;
}

function loadSections(file: string): Section[] {
  try {
    return parseSections(fs.readFileSync(file));
  } catch (error) {
    if (error instanceof WasmUnreachableValidationError) throw error;
    throw new WasmUnreachableValidationError(
      `Unable to read WASM file "${file}": ${(error as Error).message}`,
    );
  }
}

function skipLimits(reader: Reader): void {
  const flags = reader.varuint32();
  reader.varuint32();
  if ((flags & 0x01) === 0x01) reader.varuint32();
}

function importedFunctionCount(importSection: Section | undefined): number {
  if (!importSection) return 0;
  const reader = new Reader(importSection.payload);
  const count = reader.varuint32();
  let functions = 0;
  for (let i = 0; i < count; i += 1) {
    reader.string();
    reader.string();
    const kind = reader.byte();
    if (kind === 0x00) {
      functions += 1;
      reader.varuint32();
    } else if (kind === 0x01) {
      reader.byte();
      skipLimits(reader);
    } else if (kind === 0x02) {
      skipLimits(reader);
    } else if (kind === 0x03) {
      reader.byte();
      reader.byte();
    }
  }
  return functions;
}

function parseFunctionExports(section: Section | undefined): number[] {
  if (!section) return [];
  const reader = new Reader(section.payload);
  const count = reader.varuint32();
  const exports: number[] = [];
  for (let i = 0; i < count; i += 1) {
    reader.string();
    const kind = reader.byte();
    const index = reader.varuint32();
    if (kind === 0x00) exports.push(index);
  }
  return exports;
}

function parseStartFunction(section: Section | undefined): number | null {
  if (!section) return null;
  const reader = new Reader(section.payload);
  return reader.varuint32();
}

export type UnreachableReason =
  | 'unconditional-branch'
  | 'return'
  | 'unreachable-trap'
  | 'structured-termination'
  | 'other'
  | 'none';

export interface UnreachableInstructionRecord {
  functionIndex: number;
  blockIndex: number;
  instructionIndex: number;
  instructionOffset: number;
  opcode: string;
  reason: UnreachableReason;
}

export interface UnreachableBlockRecord {
  functionIndex: number;
  blockIndex: number;
  startInstructionIndex: number;
  endInstructionIndex: number;
  instructionCount: number;
  reason: UnreachableReason;
}

export interface UnreachableRangeRecord {
  functionIndex: number;
  blockIndex: number;
  startInstructionIndex: number;
  endInstructionIndex: number;
  startOffset: number;
  endOffset: number;
  instructionCount: number;
  reason: UnreachableReason;
}

export interface UnreachableFunctionSummary {
  functionIndex: number;
  totalBlocks: number;
  reachableBlocks: number;
  unreachableBlocks: number;
  totalInstructions: number;
  reachableInstructions: number;
  unreachableInstructions: number;
  unreachablePercentage: number;
  largestUnreachableRegionSize: number;
  hasUnreachableCode: boolean;
  moduleReachable: boolean;
  entirelyUnreachable: boolean;
}

export interface WasmUnreachableReport {
  file: string;
  valid: true;
  functions: UnreachableFunctionSummary[];
  unreachableBlocks: UnreachableBlockRecord[];
  unreachableInstructions: UnreachableInstructionRecord[];
  unreachableRanges: UnreachableRangeRecord[];
  statistics: {
    totalFunctions: number;
    totalReachableBlocks: number;
    totalUnreachableBlocks: number;
    totalReachableInstructions: number;
    totalUnreachableInstructions: number;
    unreachableCodePercentage: number;
    functionsContainingUnreachableRegions: number;
    largestUnreachableRegion: {
      functionIndex: number;
      blockIndex: number;
      instructionCount: number;
    } | null;
    entirelyUnreachableFunctions: number[];
  };
  warnings: string[];
}

interface ParsedInstruction {
  index: number;
  offset: number;
  endOffset: number;
  opcode: number;
  name: string;
  blockType?: number;
  branchDepths?: number[];
  callTarget?: number;
}

const CONTROL_OPCODES: Record<number, string> = {
  0x00: 'unreachable',
  0x01: 'nop',
  0x02: 'block',
  0x03: 'loop',
  0x04: 'if',
  0x05: 'else',
  0x06: 'try',
  0x07: 'catch',
  0x08: 'throw',
  0x09: 'rethrow',
  0x0b: 'end',
  0x0c: 'br',
  0x0d: 'br_if',
  0x0e: 'br_table',
  0x0f: 'return',
  0x10: 'call',
  0x11: 'call_indirect',
  0x12: 'return_call',
  0x13: 'return_call_indirect',
  0x18: 'delegate',
  0x19: 'catch_all',
  0x1f: 'try_table',
};

function opcodeName(opcode: number): string {
  return CONTROL_OPCODES[opcode] ?? `opcode_0x${opcode.toString(16)}`;
}

function readBlockType(reader: Reader): number {
  let byte = reader.byte();
  let result = byte & 0x7f;
  let shift = 7;
  let consumed = 1;
  while ((byte & 0x80) !== 0 && consumed < 5) {
    byte = reader.byte();
    result |= (byte & 0x7f) << shift;
    shift += 7;
    consumed += 1;
  }
  return result;
}

function skipVarint(reader: Reader): void {
  let byte = reader.byte();
  let consumed = 1;
  while ((byte & 0x80) !== 0 && consumed < 10) {
    byte = reader.byte();
    consumed += 1;
  }
}

function skipFcImmediate(subopcode: number, reader: Reader): void {
  if (subopcode <= 0x07) return;
  if (subopcode === 0x08) {
    reader.varuint32();
    reader.varuint32();
  } else if (subopcode === 0x0a || subopcode === 0x0c || subopcode === 0x0e) {
    reader.varuint32();
    reader.varuint32();
  } else if (
    subopcode === 0x09 ||
    subopcode === 0x0b ||
    subopcode === 0x0d ||
    subopcode === 0x0f ||
    subopcode === 0x10 ||
    subopcode === 0x11
  ) {
    reader.varuint32();
  }
}

function skipMemoryImmediate(reader: Reader): void {
  const alignment = reader.varuint32();
  if ((alignment & 0x40) !== 0) reader.varuint32();
  reader.varuint32();
}

function parseFunctionBody(
  body: Buffer,
  functionIndex: number,
  warnings: string[],
): { instructions: ParsedInstruction[]; calls: number[] } {
  const reader = new Reader(body);
  const instructions: ParsedInstruction[] = [];
  const calls: number[] = [];

  const localGroupCount = reader.varuint32();
  for (let i = 0; i < localGroupCount; i += 1) {
    const count = reader.varuint32();
    reader.byte();
    for (let j = 0; j < count; j += 1) {
      // Local types do not affect reachability.
    }
  }

  let stop = false;
  while (!reader.done && !stop) {
    const offset = reader.offset;
    const opcode = reader.byte();
    const instruction: ParsedInstruction = {
      index: instructions.length,
      offset,
      endOffset: offset + 1,
      opcode,
      name: opcodeName(opcode),
    };

    if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04 || opcode === 0x06) {
      instruction.blockType = readBlockType(reader);
    } else if (opcode === 0x05 || opcode === 0x0b || opcode === 0x0f || opcode === 0x00) {
      // no immediates
    } else if (opcode === 0x07) {
      reader.varuint32();
    } else if (opcode === 0x08) {
      reader.varuint32();
    } else if (opcode === 0x09) {
      reader.varuint32();
    } else if (opcode === 0x0c || opcode === 0x0d) {
      const depth = reader.varuint32();
      instruction.branchDepths = [depth];
    } else if (opcode === 0x0e) {
      const count = reader.varuint32();
      const depths: number[] = [];
      for (let i = 0; i < count + 1; i += 1) depths.push(reader.varuint32());
      instruction.branchDepths = depths;
    } else if (opcode === 0x10 || opcode === 0x12) {
      const target = reader.varuint32();
      instruction.callTarget = target;
      calls.push(target);
    } else if (opcode === 0x11 || opcode === 0x13) {
      reader.varuint32();
      reader.varuint32();
    } else if (opcode === 0x18) {
      reader.varuint32();
    } else if (opcode === 0x19) {
      // no immediate
    } else if (opcode === 0x1f) {
      warnings.push(
        `Unsupported try_table instruction in function ${functionIndex}; remaining instructions were not scanned.`,
      );
      stop = true;
    } else if (opcode === 0x1a || opcode === 0x1b) {
      // drop / select
    } else if (opcode === 0x1c) {
      const count = reader.varuint32();
      for (let i = 0; i < count; i += 1) reader.byte();
    } else if (opcode === 0x20 || opcode === 0x21 || opcode === 0x22) {
      reader.varuint32();
    } else if (opcode === 0x23 || opcode === 0x24) {
      reader.varuint32();
    } else if (opcode === 0x25 || opcode === 0x26) {
      reader.varuint32();
    } else if (opcode >= 0x28 && opcode <= 0x3e) {
      skipMemoryImmediate(reader);
    } else if (opcode === 0x3f || opcode === 0x40) {
      reader.varuint32();
    } else if (opcode === 0x41) {
      reader.varint32();
    } else if (opcode === 0x42) {
      skipVarint(reader);
    } else if (opcode === 0x43) {
      reader.bytes(4);
    } else if (opcode === 0x44) {
      reader.bytes(8);
    } else if (opcode === 0xd0) {
      reader.byte();
    } else if (opcode === 0xd1) {
      // no immediate
    } else if (opcode === 0xd2) {
      reader.varuint32();
    } else if (opcode === 0xfc) {
      const subopcode = reader.varuint32();
      if (subopcode > 0x11) {
        warnings.push(
          `Unsupported 0xfc subopcode ${subopcode} in function ${functionIndex}; remaining instructions were not scanned.`,
        );
        stop = true;
      } else {
        skipFcImmediate(subopcode, reader);
      }
    } else if (opcode === 0xfd || opcode === 0xfe) {
      warnings.push(
        `Unsupported ${opcode === 0xfd ? 'SIMD' : 'atomic'} instruction prefix in function ${functionIndex}; remaining instructions were not scanned.`,
      );
      stop = true;
    }

    instruction.endOffset = reader.offset;
    instructions.push(instruction);
  }

  return { instructions, calls };
}

interface MutableBlock {
  id: number;
  instructionIndices: number[];
  successors: number[];
  predecessors: number[];
  kind: 'entry' | 'normal' | 'merge' | 'exit';
  creationReason: UnreachableReason | null;
  terminated: boolean;
}

interface LabelFrame {
  kind: 'function' | 'block' | 'loop' | 'if' | 'try';
  breakTarget: number;
  continueTarget: number;
  after: number;
  header?: number;
  thenBlock?: number;
  elseBlock?: number | null;
  conditionBlock?: number;
  catchBlocks?: number[];
}

interface FunctionCfg {
  functionIndex: number;
  blocks: MutableBlock[];
  entryBlockId: number;
  exitBlockId: number;
  warnings: string[];
}

function buildFunctionCfg(functionIndex: number, instructions: ParsedInstruction[]): FunctionCfg {
  const blocks: MutableBlock[] = [];
  const warnings: string[] = [];
  let nextBlockId = 0;

  const newBlock = (
    kind: MutableBlock['kind'],
    creationReason: UnreachableReason | null = null,
  ): MutableBlock => {
    const block: MutableBlock = {
      id: nextBlockId,
      instructionIndices: [],
      successors: [],
      predecessors: [],
      kind,
      creationReason,
      terminated: false,
    };
    nextBlockId += 1;
    blocks.push(block);
    return block;
  };

  const addEdge = (from: MutableBlock, to: number): void => {
    if (!from.successors.includes(to)) from.successors.push(to);
  };

  const entry = newBlock('entry');
  const exit = newBlock('exit');
  exit.terminated = true;
  let current = entry;
  let ended = false;

  const labelStack: LabelFrame[] = [
    {
      kind: 'function',
      breakTarget: exit.id,
      continueTarget: exit.id,
      after: exit.id,
    },
  ];

  const resolveTarget = (depth: number): number | null => {
    const targetIndex = labelStack.length - 1 - depth;
    if (targetIndex < 0) return null;
    const frame = labelStack[targetIndex];
    return frame.kind === 'loop' ? frame.continueTarget : frame.breakTarget;
  };

  const startUnreachable = (reason: UnreachableReason): void => {
    current.terminated = true;
    current = newBlock('normal', reason);
  };

  for (const instruction of instructions) {
    if (ended) {
      warnings.push(
        `Function ${functionIndex} contains instructions after its final end; they were ignored.`,
      );
      break;
    }

    current.instructionIndices.push(instruction.index);
    const name = instruction.name;

    if (name === 'block') {
      const bodyBlock = newBlock('normal');
      const mergeBlock = newBlock('merge');
      addEdge(current, bodyBlock.id);
      labelStack.push({
        kind: 'block',
        breakTarget: mergeBlock.id,
        continueTarget: mergeBlock.id,
        after: mergeBlock.id,
      });
      current = bodyBlock;
    } else if (name === 'loop') {
      const header = newBlock('normal');
      const mergeBlock = newBlock('merge');
      addEdge(current, header.id);
      labelStack.push({
        kind: 'loop',
        breakTarget: mergeBlock.id,
        continueTarget: header.id,
        after: mergeBlock.id,
        header: header.id,
      });
      current = header;
    } else if (name === 'if') {
      const thenBlock = newBlock('normal');
      const mergeBlock = newBlock('merge');
      addEdge(current, thenBlock.id);
      addEdge(current, mergeBlock.id);
      labelStack.push({
        kind: 'if',
        breakTarget: mergeBlock.id,
        continueTarget: mergeBlock.id,
        after: mergeBlock.id,
        thenBlock: thenBlock.id,
        elseBlock: null,
        conditionBlock: current.id,
      });
      current = thenBlock;
    } else if (name === 'try') {
      const tryBody = newBlock('normal');
      const mergeBlock = newBlock('merge');
      addEdge(current, tryBody.id);
      labelStack.push({
        kind: 'try',
        breakTarget: mergeBlock.id,
        continueTarget: mergeBlock.id,
        after: mergeBlock.id,
        thenBlock: tryBody.id,
        elseBlock: null,
        conditionBlock: current.id,
        catchBlocks: [],
      });
      current = tryBody;
    } else if (name === 'else') {
      const frame = labelStack[labelStack.length - 1];
      if (frame?.kind !== 'if') {
        warnings.push(
          `Function ${functionIndex}: else without a matching if at instruction ${instruction.index}.`,
        );
        current = newBlock('normal', 'other');
        continue;
      }
      if (!current.terminated) addEdge(current, frame.after);
      const elseBlock = newBlock('normal');
      frame.elseBlock = elseBlock.id;
      if (frame.conditionBlock !== undefined) {
        const conditionBlock = blocks[frame.conditionBlock];
        conditionBlock.successors = conditionBlock.successors.map((successor) =>
          successor === frame.after ? elseBlock.id : successor,
        );
      }
      current = elseBlock;
    } else if (name === 'catch' || name === 'catch_all') {
      const frame = labelStack[labelStack.length - 1];
      if (frame?.kind !== 'try') {
        warnings.push(
          `Function ${functionIndex}: ${name} without a matching try at instruction ${instruction.index}.`,
        );
        current = newBlock('normal', 'other');
        continue;
      }
      if (!current.terminated) addEdge(current, frame.after);
      const catchBlock = newBlock('normal');
      frame.catchBlocks = frame.catchBlocks ?? [];
      frame.catchBlocks.push(catchBlock.id);
      if (frame.conditionBlock !== undefined) {
        addEdge(blocks[frame.conditionBlock], catchBlock.id);
      }
      current = catchBlock;
    } else if (name === 'end') {
      if (labelStack.length <= 1) {
        if (!current.terminated) addEdge(current, exit.id);
        current = exit;
        ended = true;
        continue;
      }
      const frame = labelStack.pop() as LabelFrame;
      if (!current.terminated) addEdge(current, frame.after);
      current = blocks[frame.after];
    } else if (name === 'br') {
      const depth = instruction.branchDepths?.[0] ?? 0;
      const target = resolveTarget(depth);
      if (target === null) {
        warnings.push(
          `Function ${functionIndex}: invalid branch depth ${depth} at instruction ${instruction.index}.`,
        );
      } else {
        addEdge(current, target);
      }
      startUnreachable('unconditional-branch');
    } else if (name === 'br_if') {
      const depth = instruction.branchDepths?.[0] ?? 0;
      const target = resolveTarget(depth);
      if (target === null) {
        warnings.push(
          `Function ${functionIndex}: invalid branch depth ${depth} at instruction ${instruction.index}.`,
        );
      } else {
        addEdge(current, target);
      }
      const fallthrough = newBlock('normal');
      addEdge(current, fallthrough.id);
      current = fallthrough;
    } else if (name === 'br_table') {
      for (const depth of instruction.branchDepths ?? []) {
        const target = resolveTarget(depth);
        if (target === null) {
          warnings.push(
            `Function ${functionIndex}: invalid branch-table depth ${depth} at instruction ${instruction.index}.`,
          );
        } else {
          addEdge(current, target);
        }
      }
      startUnreachable('unconditional-branch');
    } else if (name === 'return' || name === 'return_call' || name === 'return_call_indirect') {
      addEdge(current, exit.id);
      startUnreachable('return');
    } else if (name === 'unreachable') {
      startUnreachable('unreachable-trap');
    } else if (name === 'throw' || name === 'rethrow' || name === 'delegate') {
      for (const frame of labelStack) {
        if (frame.kind === 'try') {
          for (const catchBlock of frame.catchBlocks ?? []) {
            addEdge(current, catchBlock);
          }
        }
      }
      startUnreachable('other');
    }
  }

  if (!ended) {
    warnings.push(`Function ${functionIndex}: control-flow stack did not terminate with end.`);
    if (current.id !== exit.id && !current.terminated) addEdge(current, exit.id);
  }

  for (const block of blocks) {
    for (const successor of block.successors) {
      const target = blocks[successor];
      if (target && !target.predecessors.includes(block.id)) {
        target.predecessors.push(block.id);
      }
    }
  }

  return {
    functionIndex,
    blocks,
    entryBlockId: entry.id,
    exitBlockId: exit.id,
    warnings,
  };
}

function reachableBlockIds(cfg: FunctionCfg): Set<number> {
  const reachable = new Set<number>();
  const queue = [cfg.entryBlockId];
  while (queue.length > 0) {
    const id = queue.shift() as number;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const block = cfg.blocks[id];
    if (!block) continue;
    for (const successor of block.successors) {
      if (!reachable.has(successor)) queue.push(successor);
    }
  }
  return reachable;
}

function propagateReasons(
  cfg: FunctionCfg,
  reachable: Set<number>,
): Map<number, UnreachableReason> {
  const reasons = new Map<number, UnreachableReason>();
  for (const block of cfg.blocks) {
    if (!reachable.has(block.id) && block.creationReason) {
      reasons.set(block.id, block.creationReason);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const block of cfg.blocks) {
      if (reachable.has(block.id) || reasons.has(block.id)) continue;
      for (const predecessor of block.predecessors) {
        const inherited = reasons.get(predecessor);
        if (inherited) {
          reasons.set(block.id, inherited);
          changed = true;
          break;
        }
      }
    }
  }

  for (const block of cfg.blocks) {
    if (reachable.has(block.id) || reasons.has(block.id)) continue;
    reasons.set(block.id, block.kind === 'merge' ? 'structured-termination' : 'other');
  }

  return reasons;
}

function moduleReachableFunctions(
  definedFunctionIndices: number[],
  callGraph: Map<number, number[]>,
  roots: number[],
): Set<number> {
  const reachable = new Set<number>();
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift() as number;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const callee of callGraph.get(id) ?? []) {
      if (definedFunctionIndices.includes(callee) && !reachable.has(callee)) {
        queue.push(callee);
      }
    }
  }
  return reachable;
}

export function analyzeWasmUnreachable(file: string): WasmUnreachableReport {
  const sections = loadSections(file);
  const importSection = sections.find((section) => section.id === 2);
  const exportSection = sections.find((section) => section.id === 7);
  const startSection = sections.find((section) => section.id === 8);
  const codeSection = sections.find((section) => section.id === 10);
  const importedCount = importedFunctionCount(importSection);

  const warnings: string[] = [];
  const functionSummaries: UnreachableFunctionSummary[] = [];
  const unreachableBlocks: UnreachableBlockRecord[] = [];
  const unreachableInstructions: UnreachableInstructionRecord[] = [];
  const unreachableRanges: UnreachableRangeRecord[] = [];
  const callGraph = new Map<number, number[]>();
  const definedFunctionIndices: number[] = [];

  if (codeSection) {
    const reader = new Reader(codeSection.payload);
    const functionCount = reader.varuint32();
    for (let i = 0; i < functionCount; i += 1) {
      const bodySize = reader.varuint32();
      const body = reader.bytes(bodySize);
      const functionIndex = importedCount + i;
      definedFunctionIndices.push(functionIndex);
      const { instructions, calls } = parseFunctionBody(body, functionIndex, warnings);
      callGraph.set(functionIndex, calls);

      const cfg = buildFunctionCfg(functionIndex, instructions);
      warnings.push(...cfg.warnings);
      const reachable = reachableBlockIds(cfg);
      const reasons = propagateReasons(cfg, reachable);

      const meaningfulBlocks = cfg.blocks.filter(
        (block) => block.id !== cfg.exitBlockId && block.instructionIndices.length > 0,
      );
      const reachableBlocks = meaningfulBlocks.filter((block) => reachable.has(block.id));
      const unreachableBlockList = meaningfulBlocks.filter((block) => !reachable.has(block.id));

      const totalInstructions = instructions.length;
      const reachableInstructionCount = reachableBlocks.reduce(
        (sum, block) => sum + block.instructionIndices.length,
        0,
      );
      const unreachableInstructionCount = totalInstructions - reachableInstructionCount;

      let largestRegionSize = 0;
      for (const block of unreachableBlockList) {
        if (block.instructionIndices.length === 0) continue;
        const reason = reasons.get(block.id) ?? 'other';
        const firstInstruction = instructions[block.instructionIndices[0]];
        const lastInstruction =
          instructions[block.instructionIndices[block.instructionIndices.length - 1]];
        if (!firstInstruction || !lastInstruction) continue;

        unreachableBlocks.push({
          functionIndex,
          blockIndex: block.id,
          startInstructionIndex: firstInstruction.index,
          endInstructionIndex: lastInstruction.index,
          instructionCount: block.instructionIndices.length,
          reason,
        });

        unreachableRanges.push({
          functionIndex,
          blockIndex: block.id,
          startInstructionIndex: firstInstruction.index,
          endInstructionIndex: lastInstruction.index,
          startOffset: firstInstruction.offset,
          endOffset: lastInstruction.endOffset,
          instructionCount: block.instructionIndices.length,
          reason,
        });

        for (const instructionIndex of block.instructionIndices) {
          const instruction = instructions[instructionIndex];
          if (!instruction) continue;
          unreachableInstructions.push({
            functionIndex,
            blockIndex: block.id,
            instructionIndex: instruction.index,
            instructionOffset: instruction.offset,
            opcode: instruction.name,
            reason,
          });
        }

        largestRegionSize = Math.max(largestRegionSize, block.instructionIndices.length);
      }

      functionSummaries.push({
        functionIndex,
        totalBlocks: meaningfulBlocks.length,
        reachableBlocks: reachableBlocks.length,
        unreachableBlocks: unreachableBlockList.length,
        totalInstructions,
        reachableInstructions: reachableInstructionCount,
        unreachableInstructions: unreachableInstructionCount,
        unreachablePercentage:
          totalInstructions === 0 ? 0 : unreachableInstructionCount / totalInstructions,
        largestUnreachableRegionSize: largestRegionSize,
        hasUnreachableCode: unreachableInstructionCount > 0,
        moduleReachable: true,
        entirelyUnreachable: false,
      });
    }
  }

  const exportedFunctions = parseFunctionExports(exportSection);
  const startFunction = parseStartFunction(startSection);
  const definedSet = new Set(definedFunctionIndices);
  let roots = exportedFunctions.filter((index) => definedSet.has(index));
  if (startFunction !== null && definedSet.has(startFunction)) roots.push(startFunction);
  if (roots.length === 0) roots = [...definedFunctionIndices];
  const reachableFunctions = moduleReachableFunctions(definedFunctionIndices, callGraph, roots);

  for (const summary of functionSummaries) {
    summary.moduleReachable = reachableFunctions.has(summary.functionIndex);
    summary.entirelyUnreachable = !summary.moduleReachable;
  }

  const totalReachableBlocks = functionSummaries.reduce(
    (sum, summary) => sum + summary.reachableBlocks,
    0,
  );
  const totalUnreachableBlocks = functionSummaries.reduce(
    (sum, summary) => sum + summary.unreachableBlocks,
    0,
  );
  const totalReachableInstructions = functionSummaries.reduce(
    (sum, summary) => sum + summary.reachableInstructions,
    0,
  );
  const totalUnreachableInstructions = functionSummaries.reduce(
    (sum, summary) => sum + summary.unreachableInstructions,
    0,
  );
  const totalInstructions = totalReachableInstructions + totalUnreachableInstructions;
  const largestUnreachableRegion = unreachableRanges.reduce<{
    functionIndex: number;
    blockIndex: number;
    instructionCount: number;
  } | null>((best, range) => {
    if (!best) return range;
    if (range.instructionCount > best.instructionCount) return range;
    if (
      range.instructionCount === best.instructionCount &&
      (range.functionIndex < best.functionIndex ||
        (range.functionIndex === best.functionIndex && range.blockIndex < best.blockIndex))
    ) {
      return range;
    }
    return best;
  }, null);

  return {
    file,
    valid: true,
    functions: functionSummaries,
    unreachableBlocks,
    unreachableInstructions,
    unreachableRanges,
    statistics: {
      totalFunctions: functionSummaries.length,
      totalReachableBlocks,
      totalUnreachableBlocks,
      totalReachableInstructions,
      totalUnreachableInstructions,
      unreachableCodePercentage:
        totalInstructions === 0 ? 0 : totalUnreachableInstructions / totalInstructions,
      functionsContainingUnreachableRegions: functionSummaries.filter(
        (summary) => summary.hasUnreachableCode,
      ).length,
      largestUnreachableRegion: largestUnreachableRegion
        ? {
            functionIndex: largestUnreachableRegion.functionIndex,
            blockIndex: largestUnreachableRegion.blockIndex,
            instructionCount: largestUnreachableRegion.instructionCount,
          }
        : null,
      entirelyUnreachableFunctions: functionSummaries
        .filter((summary) => summary.entirelyUnreachable)
        .map((summary) => summary.functionIndex),
    },
    warnings,
  };
}

function compareRangeRecords(a: UnreachableRangeRecord, b: UnreachableRangeRecord): number {
  return (
    a.functionIndex - b.functionIndex ||
    a.startInstructionIndex - b.startInstructionIndex ||
    a.endInstructionIndex - b.endInstructionIndex
  );
}

export function compareUnreachableReports(
  beforeFile: string,
  afterFile: string,
): {
  before: WasmUnreachableReport;
  after: WasmUnreachableReport;
  comparison: {
    newlyUnreachableRegions: UnreachableRangeRecord[];
    regionsThatBecameReachable: UnreachableRangeRecord[];
    changedRangeBoundaries: Array<{
      before: UnreachableRangeRecord;
      after: UnreachableRangeRecord;
      changes: string[];
    }>;
    functionsWithNewUnreachableCode: number[];
    totalUnreachableInstructionDelta: number;
    unreachablePercentageDelta: number;
  };
} {
  const before = analyzeWasmUnreachable(beforeFile);
  const after = analyzeWasmUnreachable(afterFile);

  const rangeKey = (range: UnreachableRangeRecord): string =>
    `${range.functionIndex}:${range.blockIndex}:${range.startInstructionIndex}:${range.endInstructionIndex}`;
  const beforeMap = new Map(before.unreachableRanges.map((range) => [rangeKey(range), range]));
  const afterMap = new Map(after.unreachableRanges.map((range) => [rangeKey(range), range]));

  const newlyUnreachableRegions = after.unreachableRanges
    .filter((range) => !beforeMap.has(rangeKey(range)))
    .sort(compareRangeRecords);
  const regionsThatBecameReachable = before.unreachableRanges
    .filter((range) => !afterMap.has(rangeKey(range)))
    .sort(compareRangeRecords);

  const changedRangeBoundaries: Array<{
    before: UnreachableRangeRecord;
    after: UnreachableRangeRecord;
    changes: string[];
  }> = [];
  const beforeByBlock = new Map(
    before.unreachableRanges.map((range) => [`${range.functionIndex}:${range.blockIndex}`, range]),
  );
  for (const afterRange of after.unreachableRanges) {
    const beforeRange = beforeByBlock.get(`${afterRange.functionIndex}:${afterRange.blockIndex}`);
    if (!beforeRange) continue;
    const changes: string[] = [];
    if (beforeRange.startInstructionIndex !== afterRange.startInstructionIndex) {
      changes.push('startInstructionIndex');
    }
    if (beforeRange.endInstructionIndex !== afterRange.endInstructionIndex) {
      changes.push('endInstructionIndex');
    }
    if (beforeRange.reason !== afterRange.reason) changes.push('reason');
    if (changes.length > 0) {
      changedRangeBoundaries.push({ before: beforeRange, after: afterRange, changes });
    }
  }
  changedRangeBoundaries.sort((a, b) => compareRangeRecords(a.after, b.after));

  const beforeUnreachableByFunction = new Map(
    before.functions.map((summary) => [summary.functionIndex, summary.unreachableInstructions]),
  );
  const functionsWithNewUnreachableCode = after.functions
    .filter(
      (summary) =>
        summary.unreachableInstructions >
        (beforeUnreachableByFunction.get(summary.functionIndex) ?? 0),
    )
    .map((summary) => summary.functionIndex)
    .sort((a, b) => a - b);

  return {
    before,
    after,
    comparison: {
      newlyUnreachableRegions,
      regionsThatBecameReachable,
      changedRangeBoundaries,
      functionsWithNewUnreachableCode,
      totalUnreachableInstructionDelta:
        after.statistics.totalUnreachableInstructions -
        before.statistics.totalUnreachableInstructions,
      unreachablePercentageDelta:
        after.statistics.unreachableCodePercentage - before.statistics.unreachableCodePercentage,
    },
  };
}
