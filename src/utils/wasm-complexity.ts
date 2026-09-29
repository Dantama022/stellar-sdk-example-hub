import fs from 'fs';
import { createHash } from 'crypto';

import { WasmValidationError } from './wasm-static-analysis';

export interface ComplexityThresholds {
  score?: number;
  instructionCount?: number;
  bodySize?: number;
  controlFlowCount?: number;
  branchCount?: number;
  callCount?: number;
  memoryOperationCount?: number;
  localAccessCount?: number;
}

export interface WasmFunctionComplexity {
  functionIndex: number;
  definedFunctionIndex: number;
  typeIndex: number;
  exportName?: string;
  bodyFingerprint: string;
  bodySize: number;
  instructionCount: number;
  controlFlowCount: number;
  branchCount: number;
  callCount: number;
  memoryOperationCount: number;
  localAccessCount: number;
  complexityScore: number;
  highlighted: boolean;
  exceededThresholds: string[];
}

export interface WasmComplexityReport {
  file: string;
  valid: true;
  scoring: typeof COMPLEXITY_WEIGHTS;
  thresholds: ComplexityThresholds;
  statistics: {
    importedFunctionCount: number;
    definedFunctionCount: number;
    totalInstructionCount: number;
    totalCodeBodySize: number;
    totalControlFlowCount: number;
    totalBranchCount: number;
    totalCallCount: number;
    totalMemoryOperationCount: number;
    totalLocalAccessCount: number;
    totalComplexityScore: number;
    averageComplexityScore: number;
    maximumComplexityScore: number;
    highlightedFunctionCount: number;
  };
  highestComplexityFunctions: WasmFunctionComplexity[];
  functions: WasmFunctionComplexity[];
}

export interface FunctionComplexityDelta {
  functionIndex: number;
  definedFunctionIndex: number;
  instructionCount: number;
  bodySize: number;
  controlFlowCount: number;
  branchCount: number;
  callCount: number;
  memoryOperationCount: number;
  localAccessCount: number;
  complexityScore: number;
}

export interface WasmComplexityComparison {
  before: WasmComplexityReport;
  after: WasmComplexityReport;
  comparison: {
    aggregateDelta: Omit<FunctionComplexityDelta, 'functionIndex' | 'definedFunctionIndex'> & {
      definedFunctionCount: number;
    };
    increased: FunctionComplexityDelta[];
    decreased: FunctionComplexityDelta[];
    changed: FunctionComplexityDelta[];
    unchanged: number[];
    added: WasmFunctionComplexity[];
    removed: WasmFunctionComplexity[];
  };
}

/**
 * Score = instructions + 2*control + 3*branches + 2*calls + 2*memory + locals.
 * Categories intentionally overlap the base instruction count, but not each other.
 */
export const COMPLEXITY_WEIGHTS = Object.freeze({
  instruction: 1,
  controlFlow: 2,
  branch: 3,
  call: 2,
  memoryOperation: 2,
  localAccess: 1,
});

interface Section {
  id: number;
  payload: Buffer;
}

class Reader {
  offset = 0;

  constructor(private readonly data: Buffer) {}

  get done(): boolean {
    return this.offset === this.data.length;
  }

  byte(): number {
    if (this.offset >= this.data.length)
      throw new WasmValidationError('Unexpected end of WASM data');
    return this.data[this.offset++];
  }

  bytes(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.data.length) {
      throw new WasmValidationError('Section or function body exceeds remaining WASM data');
    }
    const result = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  varuint32(): number {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      if (shift === 28 && (byte & 0xf0) !== 0)
        throw new WasmValidationError('Invalid u32 LEB128 value');
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
    }
    throw new WasmValidationError('Invalid u32 LEB128 value');
  }

  signedLeb(maxBytes: number): void {
    for (let i = 0; i < maxBytes; i += 1) {
      if ((this.byte() & 0x80) === 0) return;
    }
    throw new WasmValidationError('Invalid signed LEB128 value');
  }

  name(): void {
    this.bytes(this.varuint32());
  }

  text(): string {
    return this.bytes(this.varuint32()).toString('utf8');
  }
}

function readSections(file: string): Section[] {
  let wasm: Buffer;
  try {
    wasm = fs.readFileSync(file);
  } catch (error) {
    throw new WasmValidationError(
      `Unable to read WASM file "${file}": ${(error as Error).message}`,
    );
  }
  if (wasm.length < 8) throw new WasmValidationError('Invalid WASM binary: file is too short');
  if (!wasm.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d]))) {
    throw new WasmValidationError('Invalid WASM binary: missing WebAssembly magic header');
  }
  if (!wasm.subarray(4, 8).equals(Buffer.from([1, 0, 0, 0]))) {
    throw new WasmValidationError('Unsupported WASM binary: expected version 1');
  }
  const reader = new Reader(wasm.subarray(8));
  const sections: Section[] = [];
  const seen = new Set<number>();
  let lastRank = 0;
  const sectionRank: Record<number, number> = {
    1: 1,
    2: 2,
    3: 3,
    4: 4,
    5: 5,
    13: 6,
    6: 7,
    7: 8,
    8: 9,
    9: 10,
    12: 11,
    10: 12,
    11: 13,
  };
  while (!reader.done) {
    const id = reader.byte();
    if (id > 13) throw new WasmValidationError(`Unsupported WASM section id ${id}`);
    const payload = reader.bytes(reader.varuint32());
    if (id !== 0 && seen.has(id)) throw new WasmValidationError(`Duplicate WASM section id ${id}`);
    if (id !== 0) {
      const rank = sectionRank[id];
      if (rank < lastRank) throw new WasmValidationError(`WASM section id ${id} is out of order`);
      lastRank = rank;
      seen.add(id);
    }
    sections.push({ id, payload });
  }
  return sections;
}

function skipLimits(reader: Reader): void {
  const flags = reader.varuint32();
  reader.varuint32();
  if ((flags & 1) !== 0) reader.varuint32();
}

function countImportedFunctions(section: Section | undefined): number {
  if (!section) return 0;
  const reader = new Reader(section.payload);
  const count = reader.varuint32();
  let functions = 0;
  for (let i = 0; i < count; i += 1) {
    reader.name();
    reader.name();
    const kind = reader.byte();
    if (kind === 0) {
      functions += 1;
      reader.varuint32();
    } else if (kind === 1) {
      reader.byte();
      skipLimits(reader);
    } else if (kind === 2) skipLimits(reader);
    else if (kind === 3) reader.bytes(2);
    else if (kind === 4) {
      reader.byte();
      reader.varuint32();
    } else throw new WasmValidationError(`Unsupported import kind ${kind}`);
  }
  if (!reader.done) throw new WasmValidationError('Malformed WASM import section');
  return functions;
}

function sectionVectorCount(section: Section | undefined): number {
  if (!section) return 0;
  return new Reader(section.payload).varuint32();
}

function definedFunctionTypeIndices(section: Section | undefined): number[] {
  if (!section) return [];
  const reader = new Reader(section.payload);
  const count = reader.varuint32();
  const result: number[] = [];
  for (let i = 0; i < count; i += 1) result.push(reader.varuint32());
  if (!reader.done) throw new WasmValidationError('Malformed WASM function section');
  return result;
}

function definedFunctionExportNames(
  section: Section | undefined,
  importedFunctions: number,
): Map<number, string> {
  const result = new Map<number, string>();
  if (!section) return result;
  const reader = new Reader(section.payload);
  const count = reader.varuint32();
  for (let i = 0; i < count; i += 1) {
    const name = reader.text();
    const kind = reader.byte();
    const index = reader.varuint32();
    if (kind === 0 && index >= importedFunctions) {
      const definedIndex = index - importedFunctions;
      if (!result.has(definedIndex)) result.set(definedIndex, name);
    }
  }
  if (!reader.done) throw new WasmValidationError('Malformed WASM export section');
  return result;
}

type Category = 'control' | 'branch' | 'call' | 'memory' | 'local' | 'other';

function category(opcode: number, prefix?: number): Category {
  if ([0x02, 0x03, 0x04, 0x05, 0x0b].includes(opcode)) return 'control';
  if ([0x0c, 0x0d, 0x0e, 0x0f, 0xd5, 0xd6].includes(opcode)) return 'branch';
  if ([0x10, 0x11, 0x12, 0x13, 0x14, 0x15].includes(opcode)) return 'call';
  if (
    (opcode >= 0x28 && opcode <= 0x40) ||
    (opcode === 0xfc && prefix !== undefined && [8, 10, 11].includes(prefix))
  )
    return 'memory';
  if (opcode >= 0x20 && opcode <= 0x22) return 'local';
  return 'other';
}

function skipBlockType(reader: Reader): void {
  const first = reader.byte();
  if ([0x40, 0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f].includes(first)) return;
  if ((first & 0x80) !== 0) {
    for (let i = 1; i < 5; i += 1) if ((reader.byte() & 0x80) === 0) return;
    throw new WasmValidationError('Invalid block type');
  }
}

function skipMemArg(reader: Reader): void {
  reader.varuint32();
  reader.varuint32();
}

function skipFcInstruction(subopcode: number, reader: Reader): void {
  if (subopcode <= 7) return;
  if (subopcode === 8) {
    reader.varuint32();
    reader.varuint32();
  } else if ([9, 11, 13, 15, 16, 17].includes(subopcode)) reader.varuint32();
  else if ([10, 12, 14].includes(subopcode)) {
    reader.varuint32();
    reader.varuint32();
  } else throw new WasmValidationError(`Unsupported 0xfc instruction ${subopcode}`);
}

function decodeInstruction(reader: Reader): { opcode: number; prefix?: number } {
  const opcode = reader.byte();
  if ([0x02, 0x03, 0x04].includes(opcode)) skipBlockType(reader);
  else if (
    [
      0x0c, 0x0d, 0x10, 0x12, 0x14, 0x15, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0xd2, 0xd5,
      0xd6,
    ].includes(opcode)
  )
    reader.varuint32();
  else if (opcode === 0x0e) {
    const targets = reader.varuint32();
    for (let i = 0; i <= targets; i += 1) reader.varuint32();
  } else if ([0x11, 0x13].includes(opcode)) {
    reader.varuint32();
    reader.varuint32();
  } else if (opcode === 0x1c) {
    const types = reader.varuint32();
    reader.bytes(types);
  } else if (opcode >= 0x28 && opcode <= 0x3e) skipMemArg(reader);
  else if ([0x3f, 0x40].includes(opcode)) reader.varuint32();
  else if (opcode === 0x41) reader.signedLeb(5);
  else if (opcode === 0x42) reader.signedLeb(10);
  else if (opcode === 0x43) reader.bytes(4);
  else if (opcode === 0x44) reader.bytes(8);
  else if (opcode === 0xd0) reader.signedLeb(5);
  else if (opcode === 0xfc) {
    const prefix = reader.varuint32();
    skipFcInstruction(prefix, reader);
    return { opcode, prefix };
  } else if (opcode === 0xfd || opcode === 0xfe || opcode === 0xfb) {
    throw new WasmValidationError(`Unsupported prefixed instruction 0x${opcode.toString(16)}`);
  } else if (
    !(
      opcode <= 0x05 ||
      (opcode >= 0x0b && opcode <= 0x0f) ||
      (opcode >= 0x1a && opcode <= 0x1b) ||
      (opcode >= 0x45 && opcode <= 0xc4) ||
      [0xd1, 0xd3, 0xd4].includes(opcode)
    )
  )
    throw new WasmValidationError(
      `Unsupported or invalid instruction opcode 0x${opcode.toString(16)}`,
    );
  return { opcode };
}

function exceededThresholds(
  fn: Omit<WasmFunctionComplexity, 'highlighted' | 'exceededThresholds'>,
  thresholds: ComplexityThresholds,
): string[] {
  const values: Array<[keyof ComplexityThresholds, number]> = [
    ['score', fn.complexityScore],
    ['instructionCount', fn.instructionCount],
    ['bodySize', fn.bodySize],
    ['controlFlowCount', fn.controlFlowCount],
    ['branchCount', fn.branchCount],
    ['callCount', fn.callCount],
    ['memoryOperationCount', fn.memoryOperationCount],
    ['localAccessCount', fn.localAccessCount],
  ];
  return values
    .filter(([key, value]) => thresholds[key] !== undefined && value >= thresholds[key]!)
    .map(([key]) => key);
}

function parseFunctions(
  section: Section | undefined,
  importedFunctions: number,
  thresholds: ComplexityThresholds,
  typeIndices: number[],
  exportNames: Map<number, string>,
): WasmFunctionComplexity[] {
  if (!section) return [];
  const reader = new Reader(section.payload);
  const count = reader.varuint32();
  const functions: WasmFunctionComplexity[] = [];
  for (let definedFunctionIndex = 0; definedFunctionIndex < count; definedFunctionIndex += 1) {
    const bodySize = reader.varuint32();
    const bodyBytes = reader.bytes(bodySize);
    const body = new Reader(bodyBytes);
    const localGroups = body.varuint32();
    for (let i = 0; i < localGroups; i += 1) {
      body.varuint32();
      body.byte();
    }
    let instructionCount = 0;
    let controlFlowCount = 0;
    let branchCount = 0;
    let callCount = 0;
    let memoryOperationCount = 0;
    let localAccessCount = 0;
    let depth = 1;
    while (depth > 0) {
      if (body.done)
        throw new WasmValidationError(
          `Function ${definedFunctionIndex} is missing its final end instruction`,
        );
      const instruction = decodeInstruction(body);
      instructionCount += 1;
      const kind = category(instruction.opcode, instruction.prefix);
      if (kind === 'control') controlFlowCount += 1;
      else if (kind === 'branch') branchCount += 1;
      else if (kind === 'call') callCount += 1;
      else if (kind === 'memory') memoryOperationCount += 1;
      else if (kind === 'local') localAccessCount += 1;
      if ([0x02, 0x03, 0x04].includes(instruction.opcode)) depth += 1;
      else if (instruction.opcode === 0x0b) depth -= 1;
    }
    if (!body.done)
      throw new WasmValidationError(
        `Function ${definedFunctionIndex} has bytes after its final end instruction`,
      );
    const base = {
      functionIndex: importedFunctions + definedFunctionIndex,
      definedFunctionIndex,
      typeIndex: typeIndices[definedFunctionIndex],
      exportName: exportNames.get(definedFunctionIndex),
      bodyFingerprint: createHash('sha256').update(bodyBytes).digest('hex'),
      bodySize,
      instructionCount,
      controlFlowCount,
      branchCount,
      callCount,
      memoryOperationCount,
      localAccessCount,
      complexityScore:
        instructionCount * COMPLEXITY_WEIGHTS.instruction +
        controlFlowCount * COMPLEXITY_WEIGHTS.controlFlow +
        branchCount * COMPLEXITY_WEIGHTS.branch +
        callCount * COMPLEXITY_WEIGHTS.call +
        memoryOperationCount * COMPLEXITY_WEIGHTS.memoryOperation +
        localAccessCount * COMPLEXITY_WEIGHTS.localAccess,
    };
    const exceeded = exceededThresholds(base, thresholds);
    functions.push({ ...base, highlighted: exceeded.length > 0, exceededThresholds: exceeded });
  }
  if (!reader.done) throw new WasmValidationError('Malformed WASM code section');
  return functions;
}

function validateThresholds(thresholds: ComplexityThresholds): void {
  for (const [name, value] of Object.entries(thresholds)) {
    if (!Number.isFinite(value) || value < 0)
      throw new WasmValidationError(`Threshold ${name} must be a non-negative number`);
  }
}

function validateWasmStructure(file: string): void {
  const wasm = fs.readFileSync(file);
  if (!WebAssembly.validate(Uint8Array.from(wasm))) {
    throw new WasmValidationError('Invalid WASM binary: structural validation failed');
  }
}

export function analyzeComplexity(
  file: string,
  thresholds: ComplexityThresholds = {},
): WasmComplexityReport {
  validateThresholds(thresholds);
  const sections = readSections(file);
  const importedFunctions = countImportedFunctions(sections.find(({ id }) => id === 2));
  const typeIndices = definedFunctionTypeIndices(sections.find(({ id }) => id === 3));
  const declaredFunctions = typeIndices.length;
  const codeSection = sections.find(({ id }) => id === 10);
  const codeFunctions = sectionVectorCount(codeSection);
  if (declaredFunctions !== codeFunctions) {
    throw new WasmValidationError(
      `Function section declares ${declaredFunctions} functions but code section contains ${codeFunctions} bodies`,
    );
  }
  const exportNames = definedFunctionExportNames(
    sections.find(({ id }) => id === 7),
    importedFunctions,
  );
  const functions = parseFunctions(
    codeSection,
    importedFunctions,
    thresholds,
    typeIndices,
    exportNames,
  );
  validateWasmStructure(file);
  const sum = (key: keyof WasmFunctionComplexity): number =>
    functions.reduce((total, fn) => total + (fn[key] as number), 0);
  const totalScore = sum('complexityScore');
  const maximumComplexityScore = functions.reduce(
    (maximum, fn) => Math.max(maximum, fn.complexityScore),
    0,
  );
  return {
    file,
    valid: true,
    scoring: COMPLEXITY_WEIGHTS,
    thresholds: { ...thresholds },
    statistics: {
      importedFunctionCount: importedFunctions,
      definedFunctionCount: functions.length,
      totalInstructionCount: sum('instructionCount'),
      totalCodeBodySize: sum('bodySize'),
      totalControlFlowCount: sum('controlFlowCount'),
      totalBranchCount: sum('branchCount'),
      totalCallCount: sum('callCount'),
      totalMemoryOperationCount: sum('memoryOperationCount'),
      totalLocalAccessCount: sum('localAccessCount'),
      totalComplexityScore: totalScore,
      averageComplexityScore: functions.length === 0 ? 0 : totalScore / functions.length,
      maximumComplexityScore,
      highlightedFunctionCount: functions.filter((fn) => fn.highlighted).length,
    },
    highestComplexityFunctions: [...functions]
      .sort((a, b) => b.complexityScore - a.complexityScore || a.functionIndex - b.functionIndex)
      .slice(0, 10),
    functions,
  };
}

function delta(
  before: WasmFunctionComplexity,
  after: WasmFunctionComplexity,
): FunctionComplexityDelta {
  return {
    functionIndex: after.functionIndex,
    definedFunctionIndex: after.definedFunctionIndex,
    instructionCount: after.instructionCount - before.instructionCount,
    bodySize: after.bodySize - before.bodySize,
    controlFlowCount: after.controlFlowCount - before.controlFlowCount,
    branchCount: after.branchCount - before.branchCount,
    callCount: after.callCount - before.callCount,
    memoryOperationCount: after.memoryOperationCount - before.memoryOperationCount,
    localAccessCount: after.localAccessCount - before.localAccessCount,
    complexityScore: after.complexityScore - before.complexityScore,
  };
}

export function compareComplexity(
  beforeFile: string,
  afterFile: string,
  thresholds: ComplexityThresholds = {},
): WasmComplexityComparison {
  const before = analyzeComplexity(beforeFile, thresholds);
  const after = analyzeComplexity(afterFile, thresholds);
  const increased: FunctionComplexityDelta[] = [];
  const decreased: FunctionComplexityDelta[] = [];
  const changed: FunctionComplexityDelta[] = [];
  const unchanged: number[] = [];
  const added: WasmFunctionComplexity[] = [];
  const removed: WasmFunctionComplexity[] = [];
  const unmatchedBefore = new Set(before.functions);
  const unmatchedAfter = new Set(after.functions);
  const pairs: Array<[WasmFunctionComplexity, WasmFunctionComplexity]> = [];

  const addToGroup = (
    groups: Map<string, WasmFunctionComplexity[]>,
    value: string,
    fn: WasmFunctionComplexity,
  ): void => {
    const group = groups.get(value);
    if (group) group.push(fn);
    else groups.set(value, [fn]);
  };

  const pairUnique = (key: (fn: WasmFunctionComplexity) => string | undefined): void => {
    const beforeGroups = new Map<string, WasmFunctionComplexity[]>();
    const afterGroups = new Map<string, WasmFunctionComplexity[]>();
    for (const fn of unmatchedBefore) {
      const value = key(fn);
      if (value !== undefined) addToGroup(beforeGroups, value, fn);
    }
    for (const fn of unmatchedAfter) {
      const value = key(fn);
      if (value !== undefined) addToGroup(afterGroups, value, fn);
    }
    for (const [value, oldGroup] of beforeGroups) {
      const newGroup = afterGroups.get(value);
      if (oldGroup.length === 1 && newGroup?.length === 1) {
        const oldFunction = oldGroup[0];
        const newFunction = newGroup[0];
        unmatchedBefore.delete(oldFunction);
        unmatchedAfter.delete(newFunction);
        pairs.push([oldFunction, newFunction]);
      }
    }
  };

  const pairEquivalentGroups = (key: (fn: WasmFunctionComplexity) => string | undefined): void => {
    const beforeGroups = new Map<string, WasmFunctionComplexity[]>();
    const afterGroups = new Map<string, WasmFunctionComplexity[]>();
    for (const fn of unmatchedBefore) {
      const value = key(fn);
      if (value !== undefined) addToGroup(beforeGroups, value, fn);
    }
    for (const fn of unmatchedAfter) {
      const value = key(fn);
      if (value !== undefined) addToGroup(afterGroups, value, fn);
    }
    for (const [value, oldGroup] of beforeGroups) {
      const newGroup = afterGroups.get(value);
      if (!newGroup) continue;
      const count = Math.min(oldGroup.length, newGroup.length);
      for (let i = 0; i < count; i += 1) {
        const oldFunction = oldGroup[i];
        const newFunction = newGroup[i];
        unmatchedBefore.delete(oldFunction);
        unmatchedAfter.delete(newFunction);
        pairs.push([oldFunction, newFunction]);
      }
    }
  };

  pairUnique((fn) => (fn.exportName ? `export:${fn.exportName}` : undefined));
  pairEquivalentGroups((fn) => `body:${fn.bodyFingerprint}:type:${fn.typeIndex}`);
  pairUnique((fn) => `type:${fn.typeIndex}`);

  pairs.sort(([, a], [, b]) => a.functionIndex - b.functionIndex);
  for (const [oldFunction, newFunction] of pairs) {
    const change = delta(oldFunction, newFunction);
    if (change.complexityScore > 0) increased.push(change);
    else if (change.complexityScore < 0) decreased.push(change);
    else if (
      Object.values(change)
        .slice(2)
        .some((value) => value !== 0)
    )
      changed.push(change);
    else unchanged.push(newFunction.functionIndex);
  }
  added.push(...[...unmatchedAfter].sort((a, b) => a.functionIndex - b.functionIndex));
  removed.push(...[...unmatchedBefore].sort((a, b) => a.functionIndex - b.functionIndex));
  const b = before.statistics;
  const a = after.statistics;
  return {
    before,
    after,
    comparison: {
      aggregateDelta: {
        definedFunctionCount: a.definedFunctionCount - b.definedFunctionCount,
        instructionCount: a.totalInstructionCount - b.totalInstructionCount,
        bodySize: a.totalCodeBodySize - b.totalCodeBodySize,
        controlFlowCount: a.totalControlFlowCount - b.totalControlFlowCount,
        branchCount: a.totalBranchCount - b.totalBranchCount,
        callCount: a.totalCallCount - b.totalCallCount,
        memoryOperationCount: a.totalMemoryOperationCount - b.totalMemoryOperationCount,
        localAccessCount: a.totalLocalAccessCount - b.totalLocalAccessCount,
        complexityScore: a.totalComplexityScore - b.totalComplexityScore,
      },
      increased,
      decreased,
      changed,
      unchanged,
      added,
      removed,
    },
  };
}
