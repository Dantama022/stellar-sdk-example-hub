import fs from 'fs';

export class WasmMemoryAliasValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WasmMemoryAliasValidationError';
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
      throw new WasmMemoryAliasValidationError('Unexpected end of WASM data');
    }
    return this.data[this.offset++];
  }

  bytes(length: number): Buffer {
    if (length < 0 || this.offset + length > this.data.length) {
      throw new WasmMemoryAliasValidationError('Section length exceeds remaining WASM data');
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
    throw new WasmMemoryAliasValidationError('Invalid unsigned LEB128 value');
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
}

function parseSections(wasm: Buffer): Section[] {
  if (wasm.length < 8) {
    throw new WasmMemoryAliasValidationError('Invalid WASM binary: file is too short');
  }
  if (wasm.subarray(0, 4).compare(Buffer.from([0x00, 0x61, 0x73, 0x6d])) !== 0) {
    throw new WasmMemoryAliasValidationError(
      'Invalid WASM binary: missing WebAssembly magic header',
    );
  }
  if (wasm.subarray(4, 8).compare(Buffer.from([0x01, 0x00, 0x00, 0x00])) !== 0) {
    throw new WasmMemoryAliasValidationError('Unsupported WASM binary: expected version 1');
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
    if (error instanceof WasmMemoryAliasValidationError) throw error;
    throw new WasmMemoryAliasValidationError(
      `Unable to read WASM file "${file}": ${(error as Error).message}`,
    );
  }
}

function importedFunctionCount(importSection: Section | undefined): number {
  if (!importSection) return 0;
  const reader = new Reader(importSection.payload);
  const count = reader.varuint32();
  let functions = 0;
  for (let i = 0; i < count; i += 1) {
    const moduleLength = reader.varuint32();
    reader.bytes(moduleLength);
    const nameLength = reader.varuint32();
    reader.bytes(nameLength);
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

function skipLimits(reader: Reader): void {
  const flags = reader.varuint32();
  reader.varuint32();
  if ((flags & 0x01) === 0x01) reader.varuint32();
}

export type MemoryAccessType = 'load' | 'store';
export type MemoryAddressClass = 'exact' | 'range' | 'symbolic' | 'unknown';
export type MemoryAliasClassification = 'must-alias' | 'may-alias' | 'no-alias' | 'unknown';
export type MemoryAccessRelationship = 'read-read' | 'read-write' | 'write-write';

export interface MemoryAddressInfo {
  kind: MemoryAddressClass;
  expression: string;
  staticOffset: number;
  exactAddress: number | null;
  rangeMin: number | null;
  rangeMax: number | null;
  baseSymbol: string | null;
  baseAddend: number | null;
}

export interface MemoryAccessRecord {
  id: string;
  functionIndex: number;
  blockIndex: number;
  instructionIndex: number;
  instructionOffset: number;
  opcode: string;
  accessType: MemoryAccessType;
  width: number;
  alignment: number;
  alignmentExponent: number;
  staticOffset: number;
  memoryIndex: number;
  loopContext: boolean;
  address: MemoryAddressInfo;
}

export interface MemoryAliasPair {
  key: string;
  accessA: MemoryAccessRecord;
  accessB: MemoryAccessRecord;
  relationship: MemoryAccessRelationship;
  alias: MemoryAliasClassification;
  sameBlock: boolean;
  sameFunction: boolean;
  overlappingBytes: number;
  potentialConflict: boolean;
  reason: string;
}

export interface MemoryAliasFunctionSummary {
  functionIndex: number;
  totalAccesses: number;
  totalPairsCompared: number;
  mustAliasPairs: number;
  mayAliasPairs: number;
  noAliasPairs: number;
  unknownPairs: number;
  potentialConflicts: number;
  aliasingAccesses: number;
  aliasDensity: number;
}

export interface MemoryAliasFilters {
  functionIndex: number | null;
  accessType: MemoryAccessType | null;
  minAddress: number | null;
  maxAddress: number | null;
  aliasClassification: MemoryAliasClassification | null;
  maxPairComparisons: number;
}

export interface MemoryAliasAnalysisOptions {
  functionIndex?: number;
  accessType?: MemoryAccessType;
  minAddress?: number;
  maxAddress?: number;
  aliasClassification?: MemoryAliasClassification;
  maxPairComparisons?: number;
}

export interface MemoryAliasReport {
  file: string;
  valid: true;
  accesses: MemoryAccessRecord[];
  pairs: MemoryAliasPair[];
  functions: MemoryAliasFunctionSummary[];
  relationshipsByFunctionPair: Record<
    string,
    {
      totalPairs: number;
      mustAlias: number;
      mayAlias: number;
      noAlias: number;
      unknown: number;
      potentialConflicts: number;
    }
  >;
  relationshipsByMemoryRegion: Record<string, number>;
  statistics: {
    totalMemoryAccesses: number;
    totalAccessPairsCompared: number;
    pairComparisonsPerformed: number;
    mustAliasPairs: number;
    mayAliasPairs: number;
    noAliasPairs: number;
    unknownRelationships: number;
    potentialReadWriteConflicts: number;
    maxAliasDensity: number;
    maxAliasDensityFunction: { functionIndex: number; aliasDensity: number } | null;
    functionsWithLargestAliasingAccessSets: Array<{
      functionIndex: number;
      aliasingAccesses: number;
      aliasPairs: number;
      aliasDensity: number;
    }>;
    pairComparisonsTruncated: boolean;
    pairComparisonLimit: number;
    addressClassCounts: Record<MemoryAddressClass, number>;
    accessTypeCounts: Record<MemoryAccessType, number>;
  };
  filters: MemoryAliasFilters;
  warnings: string[];
}

interface MemoryOpcodeInfo {
  opcode: string;
  accessType: MemoryAccessType;
  width: number;
}

const MEMORY_OPCODES: Record<number, MemoryOpcodeInfo> = {
  0x28: { opcode: 'i32.load', accessType: 'load', width: 4 },
  0x29: { opcode: 'i64.load', accessType: 'load', width: 8 },
  0x2a: { opcode: 'f32.load', accessType: 'load', width: 4 },
  0x2b: { opcode: 'f64.load', accessType: 'load', width: 8 },
  0x2c: { opcode: 'i32.load8_s', accessType: 'load', width: 1 },
  0x2d: { opcode: 'i32.load8_u', accessType: 'load', width: 1 },
  0x2e: { opcode: 'i32.load16_s', accessType: 'load', width: 2 },
  0x2f: { opcode: 'i32.load16_u', accessType: 'load', width: 2 },
  0x30: { opcode: 'i64.load8_s', accessType: 'load', width: 1 },
  0x31: { opcode: 'i64.load8_u', accessType: 'load', width: 1 },
  0x32: { opcode: 'i64.load16_s', accessType: 'load', width: 2 },
  0x33: { opcode: 'i64.load16_u', accessType: 'load', width: 2 },
  0x34: { opcode: 'i64.load32_s', accessType: 'load', width: 4 },
  0x35: { opcode: 'i64.load32_u', accessType: 'load', width: 4 },
  0x36: { opcode: 'i32.store', accessType: 'store', width: 4 },
  0x37: { opcode: 'i64.store', accessType: 'store', width: 8 },
  0x38: { opcode: 'f32.store', accessType: 'store', width: 4 },
  0x39: { opcode: 'f64.store', accessType: 'store', width: 8 },
  0x3a: { opcode: 'i32.store8', accessType: 'store', width: 1 },
  0x3b: { opcode: 'i32.store16', accessType: 'store', width: 2 },
  0x3c: { opcode: 'i64.store8', accessType: 'store', width: 1 },
  0x3d: { opcode: 'i64.store16', accessType: 'store', width: 2 },
  0x3e: { opcode: 'i64.store32', accessType: 'store', width: 4 },
};

type AbstractValue =
  | { kind: 'const'; value: number }
  | { kind: 'symbol'; symbol: string; addend: number }
  | { kind: 'range'; min: number; max: number }
  | { kind: 'unknown' };

interface MemoryImmediate {
  alignmentExponent: number;
  alignment: number;
  memoryIndex: number;
  offset: number;
}

function readBlockType(reader: Reader): void {
  let byte = reader.byte();
  let consumed = 1;
  while ((byte & 0x80) !== 0 && consumed < 5) {
    byte = reader.byte();
    consumed += 1;
  }
}

function skipVarint(reader: Reader): void {
  let byte = reader.byte();
  let consumed = 1;
  while ((byte & 0x80) !== 0 && consumed < 10) {
    byte = reader.byte();
    consumed += 1;
  }
}

function readMemoryImmediate(reader: Reader): MemoryImmediate {
  const rawAlignment = reader.varuint32();
  let memoryIndex = 0;
  if ((rawAlignment & 0x40) !== 0) {
    memoryIndex = reader.varuint32();
  }
  const alignmentExponent = rawAlignment & ~0x40;
  const alignment = alignmentExponent >= 31 ? 0x80000000 : 2 ** alignmentExponent;
  const offset = reader.varuint32();
  return { alignmentExponent, alignment, memoryIndex, offset };
}

function pushValue(stack: AbstractValue[], value: AbstractValue): void {
  stack.push(value);
}

function popValue(stack: AbstractValue[], state: { reliable: boolean }): AbstractValue {
  if (stack.length === 0) {
    state.reliable = false;
    stack.length = 0;
    return { kind: 'unknown' };
  }
  return stack.pop() as AbstractValue;
}

function unsigned32(value: number): number {
  return value >>> 0;
}

function abstractConst(value: number): AbstractValue {
  return { kind: 'const', value: unsigned32(value) };
}

function normalizeAddend(value: number): number | null {
  if (!Number.isFinite(value) || value < -2147483648 || value > 4294967296) return null;
  return value;
}

function makeSymbolAddend(symbol: string, addend: number): AbstractValue {
  const normalized = normalizeAddend(addend);
  if (normalized === null) return { kind: 'unknown' };
  return { kind: 'symbol', symbol, addend: normalized };
}

function makeRange(min: number, max: number): AbstractValue {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
    return { kind: 'unknown' };
  }
  if (min > 4294967296 || max > 4294967296) return { kind: 'unknown' };
  return { kind: 'range', min, max };
}

function evalI32Unary(opcode: number, value: AbstractValue): AbstractValue {
  if (opcode === 0x45) {
    if (value.kind === 'const') return abstractConst(value.value === 0 ? 1 : 0);
    return { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}

function evalI32Comparison(opcode: number, a: AbstractValue, b: AbstractValue): AbstractValue {
  if (a.kind !== 'const' || b.kind !== 'const') return { kind: 'unknown' };
  const av = a.value;
  const bv = b.value;
  let result = false;
  if (opcode === 0x46) result = av === bv;
  else if (opcode === 0x47) result = av !== bv;
  else if (opcode === 0x48) result = (av | 0) < (bv | 0);
  else if (opcode === 0x49) result = av < bv;
  else if (opcode === 0x4a) result = (av | 0) > (bv | 0);
  else if (opcode === 0x4b) result = av > bv;
  else if (opcode === 0x4c) result = (av | 0) <= (bv | 0);
  else if (opcode === 0x4d) result = av <= bv;
  else if (opcode === 0x4e) result = (av | 0) >= (bv | 0);
  else if (opcode === 0x4f) result = av >= bv;
  return abstractConst(result ? 1 : 0);
}

function evalI32Binary(opcode: number, a: AbstractValue, b: AbstractValue): AbstractValue {
  if (a.kind === 'const' && b.kind === 'const') {
    const av = a.value;
    const bv = b.value;
    if (opcode === 0x6a) return abstractConst(av + bv);
    if (opcode === 0x6b) return abstractConst(av - bv);
    if (opcode === 0x6c) return abstractConst(Math.imul(av, bv));
    if (opcode === 0x6d) {
      if (bv === 0) return { kind: 'unknown' };
      const signedA = av | 0;
      const signedB = bv | 0;
      if (signedB === 0 || (signedA === -2147483648 && signedB === -1)) {
        return { kind: 'unknown' };
      }
      return abstractConst(signedA / signedB);
    }
    if (opcode === 0x6e) return bv === 0 ? { kind: 'unknown' } : abstractConst(Math.floor(av / bv));
    if (opcode === 0x6f) {
      if (bv === 0) return { kind: 'unknown' };
      return abstractConst((av | 0) % (bv | 0));
    }
    if (opcode === 0x70) return bv === 0 ? { kind: 'unknown' } : abstractConst(av % bv);
    if (opcode === 0x71) return abstractConst(av & bv);
    if (opcode === 0x72) return abstractConst(av | bv);
    if (opcode === 0x73) return abstractConst(av ^ bv);
    if (opcode === 0x74) return abstractConst(av << (bv & 31));
    if (opcode === 0x75) return abstractConst((av | 0) >> (bv & 31));
    if (opcode === 0x76) return abstractConst(av >>> (bv & 31));
    if (opcode === 0x77) {
      const shift = bv & 31;
      return abstractConst((av << shift) | (av >>> (32 - shift)));
    }
    if (opcode === 0x78) {
      const shift = bv & 31;
      return abstractConst((av >>> shift) | (av << (32 - shift)));
    }
    return { kind: 'unknown' };
  }

  if (opcode === 0x6a) {
    if (a.kind === 'const' && b.kind === 'symbol') {
      return makeSymbolAddend(b.symbol, b.addend + (a.value | 0));
    }
    if (a.kind === 'symbol' && b.kind === 'const') {
      return makeSymbolAddend(a.symbol, a.addend + (b.value | 0));
    }
    if (a.kind === 'const' && b.kind === 'range') {
      return makeRange(b.min + a.value, b.max + a.value);
    }
    if (a.kind === 'range' && b.kind === 'const') {
      return makeRange(a.min + b.value, a.max + b.value);
    }
    if (a.kind === 'range' && b.kind === 'range') {
      return makeRange(a.min + b.min, a.max + b.max);
    }
    return { kind: 'unknown' };
  }

  if (opcode === 0x6b) {
    if (a.kind === 'symbol' && b.kind === 'const') {
      return makeSymbolAddend(a.symbol, a.addend - (b.value | 0));
    }
    if (a.kind === 'range' && b.kind === 'const') {
      return makeRange(a.min - b.value, a.max - b.value);
    }
    if (a.kind === 'const' && b.kind === 'range') {
      return makeRange(a.value - b.max, a.value - b.min);
    }
    return { kind: 'unknown' };
  }

  if (opcode === 0x6c) {
    if (a.kind === 'const' && a.value === 0) return abstractConst(0);
    if (b.kind === 'const' && b.value === 0) return abstractConst(0);
    if (a.kind === 'const' && a.value === 1) return b;
    if (b.kind === 'const' && b.value === 1) return a;
    return { kind: 'unknown' };
  }

  if (opcode === 0x71) {
    if (a.kind === 'const' && b.kind !== 'const') {
      return makeRange(0, Math.min(a.value, b.kind === 'range' ? b.max : a.value));
    }
    if (b.kind === 'const' && a.kind !== 'const') {
      return makeRange(0, Math.min(b.value, a.kind === 'range' ? a.max : b.value));
    }
    return { kind: 'unknown' };
  }

  if (opcode === 0x70 && b.kind === 'const' && b.value > 0 && a.kind !== 'const') {
    return makeRange(0, b.value - 1);
  }

  if (opcode === 0x72 && b.kind === 'const' && b.value === 0) return a;
  if (opcode === 0x72 && a.kind === 'const' && a.value === 0) return b;
  if (opcode === 0x73 && b.kind === 'const' && b.value === 0) return a;
  if (opcode === 0x73 && a.kind === 'const' && a.value === 0) return b;

  return { kind: 'unknown' };
}

function signExtend(value: number, bits: number): number {
  const shift = 32 - bits;
  return ((value << shift) >> shift) >>> 0;
}

function evalSignExtension(opcode: number, value: AbstractValue): AbstractValue {
  if (value.kind !== 'const') return { kind: 'unknown' };
  if (opcode === 0xc0) return abstractConst(signExtend(value.value & 0xff, 8));
  if (opcode === 0xc1) return abstractConst(signExtend(value.value & 0xffff, 16));
  if (opcode === 0xc2) {
    const v = value.value;
    return abstractConst(((v & 0xff) << 24) >> 24);
  }
  if (opcode === 0xc3) {
    const v = value.value;
    return abstractConst(((v & 0xffff) << 16) >> 16);
  }
  if (opcode === 0xc4) {
    const v = value.value;
    return abstractConst(v | 0);
  }
  return { kind: 'unknown' };
}

function addressExpression(value: AbstractValue, staticOffset: number): string {
  if (value.kind === 'const') {
    return `0x${(value.value + staticOffset).toString(16)}`;
  }
  if (value.kind === 'symbol') {
    const addend = value.addend + staticOffset;
    return `${value.symbol}${addend >= 0 ? '+' : ''}${addend}`;
  }
  if (value.kind === 'range') {
    return `range(${value.min + staticOffset}..${value.max + staticOffset})`;
  }
  return 'unknown';
}

function toAddressInfo(value: AbstractValue, staticOffset: number): MemoryAddressInfo {
  if (value.kind === 'const') {
    const exact = value.value + staticOffset;
    return {
      kind: 'exact',
      expression: addressExpression(value, staticOffset),
      staticOffset,
      exactAddress: exact,
      rangeMin: exact,
      rangeMax: exact,
      baseSymbol: null,
      baseAddend: null,
    };
  }
  if (value.kind === 'symbol') {
    const addend = value.addend + staticOffset;
    return {
      kind: 'symbolic',
      expression: addressExpression(value, staticOffset),
      staticOffset,
      exactAddress: null,
      rangeMin: null,
      rangeMax: null,
      baseSymbol: value.symbol,
      baseAddend: addend,
    };
  }
  if (value.kind === 'range') {
    return {
      kind: 'range',
      expression: addressExpression(value, staticOffset),
      staticOffset,
      exactAddress: null,
      rangeMin: value.min + staticOffset,
      rangeMax: value.max + staticOffset,
      baseSymbol: null,
      baseAddend: null,
    };
  }
  return {
    kind: 'unknown',
    expression: 'unknown',
    staticOffset,
    exactAddress: null,
    rangeMin: null,
    rangeMax: null,
    baseSymbol: null,
    baseAddend: null,
  };
}

function absoluteInterval(access: MemoryAccessRecord): { start: number; end: number } | null {
  if (access.address.kind === 'exact' && access.address.exactAddress !== null) {
    const start = access.address.exactAddress;
    return { start, end: start + access.width - 1 };
  }
  if (
    access.address.kind === 'range' &&
    access.address.rangeMin !== null &&
    access.address.rangeMax !== null
  ) {
    return {
      start: access.address.rangeMin,
      end: access.address.rangeMax + access.width - 1,
    };
  }
  return null;
}

function symbolicInterval(access: MemoryAccessRecord): { start: number; end: number } | null {
  if (access.address.kind === 'symbolic' && access.address.baseAddend !== null) {
    const start = access.address.baseAddend;
    return { start, end: start + access.width - 1 };
  }
  return null;
}

function overlapBytes(
  a: { start: number; end: number },
  b: { start: number; end: number },
): number {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end >= start ? end - start + 1 : 0;
}

function classifyAlias(
  a: MemoryAccessRecord,
  b: MemoryAccessRecord,
): {
  alias: MemoryAliasClassification;
  overlappingBytes: number;
  reason: string;
} {
  if (a.memoryIndex !== b.memoryIndex) {
    return { alias: 'no-alias', overlappingBytes: 0, reason: 'different memory index' };
  }

  const loopConstrained = a.loopContext || b.loopContext;
  const absA = absoluteInterval(a);
  const absB = absoluteInterval(b);

  if (absA && absB) {
    const overlap = overlapBytes(absA, absB);
    if (overlap === 0) {
      return { alias: 'no-alias', overlappingBytes: 0, reason: 'disjoint static byte ranges' };
    }
    if (absA.start === absB.start && a.width === b.width) {
      return {
        alias: 'must-alias',
        overlappingBytes: overlap,
        reason: 'identical static byte range',
      };
    }
    return { alias: 'may-alias', overlappingBytes: overlap, reason: 'static byte ranges overlap' };
  }

  const symA = symbolicInterval(a);
  const symB = symbolicInterval(b);
  if (
    symA &&
    symB &&
    a.address.kind === 'symbolic' &&
    b.address.kind === 'symbolic' &&
    a.address.baseSymbol === b.address.baseSymbol
  ) {
    const overlap = overlapBytes(symA, symB);
    if (loopConstrained) {
      return {
        alias: 'may-alias',
        overlappingBytes: overlap,
        reason: 'same symbolic base inside a loop; value may change between accesses',
      };
    }
    if (overlap === 0) {
      return {
        alias: 'no-alias',
        overlappingBytes: 0,
        reason: 'disjoint offsets from the same symbolic base',
      };
    }
    if (symA.start === symB.start && a.width === b.width) {
      return {
        alias: 'must-alias',
        overlappingBytes: overlap,
        reason: 'identical symbolic base and offset',
      };
    }
    return {
      alias: 'may-alias',
      overlappingBytes: overlap,
      reason: 'overlapping offsets from the same symbolic base',
    };
  }

  if ((absA && symB) || (absB && symA)) {
    return {
      alias: 'may-alias',
      overlappingBytes: 0,
      reason: 'one address is symbolic and the other is bounded; overlap cannot be excluded',
    };
  }

  if (a.address.kind === 'unknown' || b.address.kind === 'unknown') {
    return {
      alias: 'unknown',
      overlappingBytes: 0,
      reason: 'address expression cannot be resolved statically',
    };
  }

  return {
    alias: 'unknown',
    overlappingBytes: 0,
    reason: 'different symbolic bases prevent a static relationship',
  };
}

function relationshipFor(a: MemoryAccessRecord, b: MemoryAccessRecord): MemoryAccessRelationship {
  if (a.accessType === 'load' && b.accessType === 'load') return 'read-read';
  if (a.accessType === 'store' && b.accessType === 'store') return 'write-write';
  return 'read-write';
}

function accessLocationKey(access: MemoryAccessRecord): string {
  return `${access.functionIndex}:${access.blockIndex}:${access.instructionIndex}`;
}

function pairKey(a: MemoryAccessRecord, b: MemoryAccessRecord): string {
  return [accessLocationKey(a), accessLocationKey(b)].sort().join('|');
}

function compareAccesses(a: MemoryAccessRecord, b: MemoryAccessRecord): number {
  return (
    a.functionIndex - b.functionIndex ||
    a.blockIndex - b.blockIndex ||
    a.instructionIndex - b.instructionIndex
  );
}

function sortPairs(pairs: MemoryAliasPair[]): MemoryAliasPair[] {
  return [...pairs].sort((a, b) => {
    const first = compareAccesses(a.accessA, b.accessA);
    if (first !== 0) return first;
    return compareAccesses(a.accessB, b.accessB);
  });
}

function regionKey(pair: MemoryAliasPair): string {
  const memoryIndex = pair.accessA.memoryIndex;
  const absA = absoluteInterval(pair.accessA);
  const absB = absoluteInterval(pair.accessB);
  const starts = [absA?.start, absB?.start].filter((value): value is number => value !== undefined);
  if (starts.length === 0) {
    return `memory${memoryIndex}:unknown-region`;
  }
  const regionStart = Math.floor(Math.min(...starts) / 512) * 512;
  return `memory${memoryIndex}:region${regionStart}`;
}

function defaultFilters(options: MemoryAliasAnalysisOptions): MemoryAliasFilters {
  return {
    functionIndex: options.functionIndex ?? null,
    accessType: options.accessType ?? null,
    minAddress: options.minAddress ?? null,
    maxAddress: options.maxAddress ?? null,
    aliasClassification: options.aliasClassification ?? null,
    maxPairComparisons:
      options.maxPairComparisons !== undefined && options.maxPairComparisons > 0
        ? Math.floor(options.maxPairComparisons)
        : 200000,
  };
}

function filterAccesses(
  accesses: MemoryAccessRecord[],
  filters: MemoryAliasFilters,
): MemoryAccessRecord[] {
  return accesses.filter((access) => {
    if (filters.functionIndex !== null && access.functionIndex !== filters.functionIndex) {
      return false;
    }
    if (filters.accessType !== null && access.accessType !== filters.accessType) {
      return false;
    }
    if (filters.minAddress !== null || filters.maxAddress !== null) {
      const interval = absoluteInterval(access);
      if (!interval) return false;
      if (filters.minAddress !== null && interval.end < filters.minAddress) return false;
      if (filters.maxAddress !== null && interval.start > filters.maxAddress) return false;
    }
    return true;
  });
}

function collectAccesses(
  section: Section | undefined,
  importedFunctions: number,
): {
  accesses: MemoryAccessRecord[];
  warnings: string[];
} {
  const accesses: MemoryAccessRecord[] = [];
  const warnings: string[] = [];
  if (!section) return { accesses, warnings };

  const reader = new Reader(section.payload);
  const functionCount = reader.varuint32();

  for (let fi = 0; fi < functionCount; fi += 1) {
    const bodySize = reader.varuint32();
    const body = new Reader(reader.bytes(bodySize));
    const localGroupCount = body.varuint32();
    for (let i = 0; i < localGroupCount; i += 1) {
      const localCount = body.varuint32();
      body.byte();
      for (let j = 0; j < localCount; j += 1) {
        // Local types are not required for address reconstruction.
      }
    }

    const functionIndex = importedFunctions + fi;
    let instructionIndex = 0;
    let currentBlockIndex = 0;
    let nextBlockIndex = 1;
    let startNewBlock = false;
    const controlStack: Array<'block' | 'loop' | 'if'> = [];
    let stack: AbstractValue[] = [];
    let locals = new Map<number, AbstractValue>();
    const state = { reliable: true };
    let stopFunction = false;

    const resetBlock = (): void => {
      currentBlockIndex = nextBlockIndex;
      nextBlockIndex += 1;
      stack = [];
      locals = new Map();
      state.reliable = true;
    };

    while (!body.done && !stopFunction) {
      if (startNewBlock) {
        resetBlock();
        startNewBlock = false;
      }

      const instructionOffset = body.offset;
      const opcode = body.byte();
      const loopContext = controlStack.includes('loop');
      const memoryInfo = MEMORY_OPCODES[opcode];

      if (memoryInfo) {
        const immediate = readMemoryImmediate(body);
        let addressValue: AbstractValue = { kind: 'unknown' };
        if (state.reliable) {
          if (memoryInfo.accessType === 'store') {
            popValue(stack, state);
            addressValue = popValue(stack, state);
          } else {
            addressValue = popValue(stack, state);
          }
        }
        const address = toAddressInfo(addressValue, immediate.offset);
        accesses.push({
          id: `${functionIndex}:${currentBlockIndex}:${instructionIndex}`,
          functionIndex,
          blockIndex: currentBlockIndex,
          instructionIndex,
          instructionOffset,
          opcode: memoryInfo.opcode,
          accessType: memoryInfo.accessType,
          width: memoryInfo.width,
          alignment: immediate.alignment,
          alignmentExponent: immediate.alignmentExponent,
          staticOffset: immediate.offset,
          memoryIndex: immediate.memoryIndex,
          loopContext,
          address,
        });
        if (state.reliable && memoryInfo.accessType === 'load') {
          pushValue(stack, { kind: 'unknown' });
        }
      } else if (opcode === 0x00) {
        state.reliable = false;
        stack = [];
        startNewBlock = true;
      } else if (opcode === 0x01) {
        // nop
      } else if (opcode === 0x02 || opcode === 0x03) {
        readBlockType(body);
        controlStack.push(opcode === 0x02 ? 'block' : 'loop');
        startNewBlock = true;
      } else if (opcode === 0x04) {
        readBlockType(body);
        if (state.reliable) popValue(stack, state);
        controlStack.push('if');
        startNewBlock = true;
      } else if (opcode === 0x05) {
        startNewBlock = true;
      } else if (opcode === 0x0b) {
        if (controlStack.length > 0) controlStack.pop();
        startNewBlock = true;
      } else if (opcode === 0x0c || opcode === 0x0d) {
        body.varuint32();
        if (opcode === 0x0d && state.reliable) popValue(stack, state);
        if (opcode === 0x0c) {
          state.reliable = false;
          stack = [];
          startNewBlock = true;
        }
      } else if (opcode === 0x0e) {
        const count = body.varuint32();
        for (let i = 0; i < count + 1; i += 1) body.varuint32();
        if (state.reliable) popValue(stack, state);
        state.reliable = false;
        stack = [];
        startNewBlock = true;
      } else if (opcode === 0x0f) {
        state.reliable = false;
        stack = [];
        startNewBlock = true;
      } else if (opcode === 0x10) {
        body.varuint32();
        state.reliable = false;
        stack = [];
      } else if (opcode === 0x11) {
        body.varuint32();
        body.varuint32();
        state.reliable = false;
        stack = [];
      } else if (opcode === 0x12) {
        body.varuint32();
        state.reliable = false;
        stack = [];
      } else if (opcode === 0x13) {
        body.varuint32();
        body.varuint32();
        state.reliable = false;
        stack = [];
      } else if (opcode === 0x1a) {
        if (state.reliable) popValue(stack, state);
      } else if (opcode === 0x1b) {
        if (state.reliable) {
          const condition = popValue(stack, state);
          const second = popValue(stack, state);
          const first = popValue(stack, state);
          if (condition.kind === 'const') {
            pushValue(stack, condition.value === 0 ? second : first);
          } else if (JSON.stringify(first) === JSON.stringify(second)) {
            pushValue(stack, first);
          } else {
            pushValue(stack, { kind: 'unknown' });
          }
        }
      } else if (opcode === 0x1c) {
        const count = body.varuint32();
        for (let i = 0; i < count; i += 1) body.byte();
        if (state.reliable) {
          const condition = popValue(stack, state);
          const second = popValue(stack, state);
          const first = popValue(stack, state);
          if (condition.kind === 'const') {
            pushValue(stack, condition.value === 0 ? second : first);
          } else {
            pushValue(stack, { kind: 'unknown' });
          }
        }
      } else if (opcode === 0x20) {
        const localIndex = body.varuint32();
        if (state.reliable) {
          pushValue(
            stack,
            locals.get(localIndex) ?? {
              kind: 'symbol',
              symbol: `local:${localIndex}`,
              addend: 0,
            },
          );
        }
      } else if (opcode === 0x21 || opcode === 0x22) {
        const localIndex = body.varuint32();
        if (state.reliable) {
          const value = popValue(stack, state);
          locals.set(localIndex, value);
          if (opcode === 0x22) pushValue(stack, value);
        }
      } else if (opcode === 0x23) {
        const globalIndex = body.varuint32();
        if (state.reliable) {
          pushValue(stack, {
            kind: 'symbol',
            symbol: `global:${globalIndex}`,
            addend: 0,
          });
        }
      } else if (opcode === 0x24) {
        body.varuint32();
        if (state.reliable) popValue(stack, state);
      } else if (opcode === 0x25) {
        body.varuint32();
        if (state.reliable) {
          popValue(stack, state);
          pushValue(stack, { kind: 'unknown' });
        }
      } else if (opcode === 0x26) {
        body.varuint32();
        if (state.reliable) {
          popValue(stack, state);
          popValue(stack, state);
        }
      } else if (opcode === 0x3f) {
        body.varuint32();
        if (state.reliable) pushValue(stack, { kind: 'unknown' });
      } else if (opcode === 0x40) {
        body.varuint32();
        if (state.reliable) {
          popValue(stack, state);
          pushValue(stack, { kind: 'unknown' });
        }
      } else if (opcode === 0x41) {
        const value = body.varint32();
        if (state.reliable) pushValue(stack, abstractConst(value));
      } else if (opcode === 0x42) {
        skipVarint(body);
        if (state.reliable) pushValue(stack, { kind: 'unknown' });
      } else if (opcode === 0x43) {
        body.bytes(4);
        if (state.reliable) pushValue(stack, { kind: 'unknown' });
      } else if (opcode === 0x44) {
        body.bytes(8);
        if (state.reliable) pushValue(stack, { kind: 'unknown' });
      } else if (opcode >= 0x45 && opcode <= 0x4f) {
        if (state.reliable) {
          const second = popValue(stack, state);
          if (opcode === 0x45) {
            pushValue(stack, evalI32Unary(opcode, second));
          } else {
            const first = popValue(stack, state);
            pushValue(stack, evalI32Comparison(opcode, first, second));
          }
        }
      } else if (opcode >= 0x50 && opcode <= 0x66) {
        if (state.reliable) {
          popValue(stack, state);
          if (opcode !== 0x50) popValue(stack, state);
          pushValue(stack, { kind: 'unknown' });
        }
      } else if (opcode >= 0x67 && opcode <= 0x69) {
        if (state.reliable) {
          popValue(stack, state);
          pushValue(stack, { kind: 'unknown' });
        }
      } else if (opcode >= 0x6a && opcode <= 0x78) {
        if (state.reliable) {
          const second = popValue(stack, state);
          const first = popValue(stack, state);
          pushValue(stack, evalI32Binary(opcode, first, second));
        }
      } else if (opcode >= 0x79 && opcode <= 0x7b) {
        if (state.reliable) {
          popValue(stack, state);
          pushValue(stack, { kind: 'unknown' });
        }
      } else if (opcode >= 0x7c && opcode <= 0x8a) {
        if (state.reliable) {
          popValue(stack, state);
          popValue(stack, state);
          pushValue(stack, { kind: 'unknown' });
        }
      } else if (opcode >= 0x8b && opcode <= 0x91) {
        if (state.reliable) {
          popValue(stack, state);
          pushValue(stack, { kind: 'unknown' });
        }
      } else if (opcode >= 0x92 && opcode <= 0x98) {
        if (state.reliable) {
          popValue(stack, state);
          popValue(stack, state);
          pushValue(stack, { kind: 'unknown' });
        }
      } else if (opcode >= 0x99 && opcode <= 0x9f) {
        if (state.reliable) {
          popValue(stack, state);
          pushValue(stack, { kind: 'unknown' });
        }
      } else if (opcode >= 0xa0 && opcode <= 0xa6) {
        if (state.reliable) {
          popValue(stack, state);
          popValue(stack, state);
          pushValue(stack, { kind: 'unknown' });
        }
      } else if (opcode >= 0xa7 && opcode <= 0xbf) {
        if (state.reliable) {
          popValue(stack, state);
          pushValue(stack, { kind: 'unknown' });
        }
      } else if (opcode >= 0xc0 && opcode <= 0xc4) {
        if (state.reliable) {
          const value = popValue(stack, state);
          pushValue(stack, evalSignExtension(opcode, value));
        }
      } else if (opcode === 0xd0) {
        body.byte();
        if (state.reliable) pushValue(stack, { kind: 'unknown' });
      } else if (opcode === 0xd1) {
        if (state.reliable) {
          popValue(stack, state);
          pushValue(stack, { kind: 'unknown' });
        }
      } else if (opcode === 0xd2) {
        body.varuint32();
        if (state.reliable) pushValue(stack, { kind: 'unknown' });
      } else if (opcode === 0xfc) {
        const subopcode = body.varuint32();
        if (subopcode >= 0x00 && subopcode <= 0x07) {
          if (state.reliable) {
            popValue(stack, state);
            pushValue(stack, { kind: 'unknown' });
          }
        } else if (subopcode === 0x08) {
          body.varuint32();
          body.varuint32();
          if (state.reliable) {
            popValue(stack, state);
            popValue(stack, state);
            popValue(stack, state);
          }
        } else if (subopcode === 0x09) {
          body.varuint32();
        } else if (subopcode === 0x0a) {
          body.varuint32();
          body.varuint32();
          if (state.reliable) {
            popValue(stack, state);
            popValue(stack, state);
            popValue(stack, state);
          }
        } else if (subopcode === 0x0b) {
          body.varuint32();
          if (state.reliable) {
            popValue(stack, state);
            popValue(stack, state);
            popValue(stack, state);
          }
        } else if (subopcode === 0x0c) {
          body.varuint32();
          body.varuint32();
          if (state.reliable) {
            popValue(stack, state);
            popValue(stack, state);
            popValue(stack, state);
          }
        } else if (subopcode === 0x0d) {
          body.varuint32();
        } else if (subopcode === 0x0e) {
          body.varuint32();
          body.varuint32();
          if (state.reliable) {
            popValue(stack, state);
            popValue(stack, state);
            popValue(stack, state);
          }
        } else if (subopcode === 0x0f) {
          body.varuint32();
          if (state.reliable) {
            popValue(stack, state);
            popValue(stack, state);
            pushValue(stack, { kind: 'unknown' });
          }
        } else if (subopcode === 0x10) {
          body.varuint32();
          if (state.reliable) pushValue(stack, { kind: 'unknown' });
        } else if (subopcode === 0x11) {
          body.varuint32();
          if (state.reliable) {
            popValue(stack, state);
            popValue(stack, state);
            popValue(stack, state);
          }
        } else {
          warnings.push(
            `Unsupported 0xfc subopcode ${subopcode} in function ${functionIndex}; remaining instructions in that function were not scanned.`,
          );
          stopFunction = true;
        }
      } else if (opcode === 0xfd || opcode === 0xfe) {
        warnings.push(
          `Unsupported ${opcode === 0xfd ? 'SIMD' : 'atomic'} instruction prefix in function ${functionIndex}; remaining instructions in that function were not scanned.`,
        );
        stopFunction = true;
      } else {
        state.reliable = false;
        stack = [];
      }

      instructionIndex += 1;
    }
  }

  return { accesses, warnings };
}

function buildFunctionSummaries(
  accesses: MemoryAccessRecord[],
  pairs: MemoryAliasPair[],
): MemoryAliasFunctionSummary[] {
  const functionIndices = [...new Set(accesses.map((access) => access.functionIndex))].sort(
    (a, b) => a - b,
  );

  return functionIndices.map((functionIndex) => {
    const functionAccesses = accesses.filter((access) => access.functionIndex === functionIndex);
    const functionPairs = pairs.filter(
      (pair) =>
        pair.accessA.functionIndex === functionIndex ||
        pair.accessB.functionIndex === functionIndex,
    );
    const mustAliasPairs = functionPairs.filter((pair) => pair.alias === 'must-alias').length;
    const mayAliasPairs = functionPairs.filter((pair) => pair.alias === 'may-alias').length;
    const noAliasPairs = functionPairs.filter((pair) => pair.alias === 'no-alias').length;
    const unknownPairs = functionPairs.filter((pair) => pair.alias === 'unknown').length;
    const aliasingIds = new Set<string>();
    for (const pair of functionPairs) {
      if (pair.alias !== 'no-alias') {
        aliasingIds.add(pair.accessA.id);
        aliasingIds.add(pair.accessB.id);
      }
    }
    return {
      functionIndex,
      totalAccesses: functionAccesses.length,
      totalPairsCompared: functionPairs.length,
      mustAliasPairs,
      mayAliasPairs,
      noAliasPairs,
      unknownPairs,
      potentialConflicts: functionPairs.filter((pair) => pair.potentialConflict).length,
      aliasingAccesses: aliasingIds.size,
      aliasDensity:
        functionPairs.length === 0
          ? 0
          : (mustAliasPairs + mayAliasPairs + unknownPairs) / functionPairs.length,
    };
  });
}

export function analyzeMemoryAlias(
  file: string,
  options: MemoryAliasAnalysisOptions = {},
): MemoryAliasReport {
  const filters = defaultFilters(options);
  const sections = loadSections(file);
  const importSection = sections.find((section) => section.id === 2);
  const codeSection = sections.find((section) => section.id === 10);
  const importedCount = importedFunctionCount(importSection);
  const { accesses: allAccesses, warnings } = collectAccesses(codeSection, importedCount);
  const accesses = filterAccesses(allAccesses, filters).sort(compareAccesses);

  const functionsIndex = new Map<number, MemoryAccessRecord[]>();
  for (const access of accesses) {
    const list = functionsIndex.get(access.functionIndex) ?? [];
    list.push(access);
    functionsIndex.set(access.functionIndex, list);
  }

  const pairs: MemoryAliasPair[] = [];
  let pairComparisonsPerformed = 0;
  let truncated = false;

  for (const functionIndex of [...functionsIndex.keys()].sort((a, b) => a - b)) {
    const functionAccesses = functionsIndex.get(functionIndex) ?? [];
    for (let i = 0; i < functionAccesses.length; i += 1) {
      for (let j = i + 1; j < functionAccesses.length; j += 1) {
        if (pairComparisonsPerformed >= filters.maxPairComparisons) {
          truncated = true;
          break;
        }
        const accessA = functionAccesses[i];
        const accessB = functionAccesses[j];
        pairComparisonsPerformed += 1;
        const classification = classifyAlias(accessA, accessB);
        const relationship = relationshipFor(accessA, accessB);
        const potentialConflict =
          classification.alias !== 'no-alias' &&
          (accessA.accessType === 'store' || accessB.accessType === 'store');
        pairs.push({
          key: pairKey(accessA, accessB),
          accessA,
          accessB,
          relationship,
          alias: classification.alias,
          sameBlock: accessA.blockIndex === accessB.blockIndex,
          sameFunction: accessA.functionIndex === accessB.functionIndex,
          overlappingBytes: classification.overlappingBytes,
          potentialConflict,
          reason: classification.reason,
        });
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  const filteredPairs = filters.aliasClassification
    ? pairs.filter((pair) => pair.alias === filters.aliasClassification)
    : pairs;
  const sortedPairs = sortPairs(filteredPairs);
  const functions = buildFunctionSummaries(accesses, sortedPairs);

  const relationshipsByFunctionPair: MemoryAliasReport['relationshipsByFunctionPair'] = {};
  const relationshipsByMemoryRegion: Record<string, number> = {};
  for (const pair of sortedPairs) {
    const functionPairKey = [pair.accessA.functionIndex, pair.accessB.functionIndex]
      .sort((a, b) => a - b)
      .join(':');
    const group = relationshipsByFunctionPair[functionPairKey] ?? {
      totalPairs: 0,
      mustAlias: 0,
      mayAlias: 0,
      noAlias: 0,
      unknown: 0,
      potentialConflicts: 0,
    };
    group.totalPairs += 1;
    if (pair.alias === 'must-alias') group.mustAlias += 1;
    else if (pair.alias === 'may-alias') group.mayAlias += 1;
    else if (pair.alias === 'no-alias') group.noAlias += 1;
    else group.unknown += 1;
    if (pair.potentialConflict) group.potentialConflicts += 1;
    relationshipsByFunctionPair[functionPairKey] = group;

    const region = regionKey(pair);
    relationshipsByMemoryRegion[region] = (relationshipsByMemoryRegion[region] ?? 0) + 1;
  }

  const addressClassCounts: Record<MemoryAddressClass, number> = {
    exact: 0,
    range: 0,
    symbolic: 0,
    unknown: 0,
  };
  const accessTypeCounts: Record<MemoryAccessType, number> = { load: 0, store: 0 };
  for (const access of accesses) {
    addressClassCounts[access.address.kind] += 1;
    accessTypeCounts[access.accessType] += 1;
  }

  const mustAliasPairs = sortedPairs.filter((pair) => pair.alias === 'must-alias').length;
  const mayAliasPairs = sortedPairs.filter((pair) => pair.alias === 'may-alias').length;
  const noAliasPairs = sortedPairs.filter((pair) => pair.alias === 'no-alias').length;
  const unknownRelationships = sortedPairs.filter((pair) => pair.alias === 'unknown').length;
  const potentialReadWriteConflicts = sortedPairs.filter((pair) => pair.potentialConflict).length;

  const maxDensityFunction = functions.reduce<MemoryAliasFunctionSummary | null>(
    (best, summary) => {
      if (!best) return summary;
      if (summary.aliasDensity > best.aliasDensity) return summary;
      if (
        summary.aliasDensity === best.aliasDensity &&
        summary.functionIndex < best.functionIndex
      ) {
        return summary;
      }
      return best;
    },
    null,
  );

  const functionsWithLargestAliasingAccessSets = [...functions]
    .sort(
      (a, b) =>
        b.aliasingAccesses - a.aliasingAccesses ||
        b.totalPairsCompared - a.totalPairsCompared ||
        a.functionIndex - b.functionIndex,
    )
    .slice(0, 5)
    .map((summary) => ({
      functionIndex: summary.functionIndex,
      aliasingAccesses: summary.aliasingAccesses,
      aliasPairs: summary.mustAliasPairs + summary.mayAliasPairs + summary.unknownPairs,
      aliasDensity: summary.aliasDensity,
    }));

  if (truncated) {
    warnings.push(
      `Pair comparison limit of ${filters.maxPairComparisons} reached; results are truncated deterministically. Increase maxPairComparisons to analyze more pairs.`,
    );
  }

  return {
    file,
    valid: true,
    accesses,
    pairs: sortedPairs,
    functions,
    relationshipsByFunctionPair,
    relationshipsByMemoryRegion,
    statistics: {
      totalMemoryAccesses: accesses.length,
      totalAccessPairsCompared: sortedPairs.length,
      pairComparisonsPerformed,
      mustAliasPairs,
      mayAliasPairs,
      noAliasPairs,
      unknownRelationships,
      potentialReadWriteConflicts,
      maxAliasDensity: maxDensityFunction?.aliasDensity ?? 0,
      maxAliasDensityFunction: maxDensityFunction
        ? {
            functionIndex: maxDensityFunction.functionIndex,
            aliasDensity: maxDensityFunction.aliasDensity,
          }
        : null,
      functionsWithLargestAliasingAccessSets,
      pairComparisonsTruncated: truncated,
      pairComparisonLimit: filters.maxPairComparisons,
      addressClassCounts,
      accessTypeCounts,
    },
    filters,
    warnings,
  };
}

function comparePairsByKey(a: MemoryAliasPair, b: MemoryAliasPair): number {
  return compareAccesses(a.accessA, b.accessA) || compareAccesses(a.accessB, b.accessB);
}

export function compareMemoryAliasReports(
  beforeFile: string,
  afterFile: string,
  options: MemoryAliasAnalysisOptions = {},
): {
  before: MemoryAliasReport;
  after: MemoryAliasReport;
  comparison: {
    addedAliasRelationships: MemoryAliasPair[];
    removedAliasRelationships: MemoryAliasPair[];
    changedAliasClassifications: Array<{
      key: string;
      before: MemoryAliasPair;
      after: MemoryAliasPair;
      changes: string[];
    }>;
    newlyIntroducedConflicts: MemoryAliasPair[];
    totalPairDelta: number;
    potentialConflictDelta: number;
  };
} {
  const before = analyzeMemoryAlias(beforeFile, options);
  const after = analyzeMemoryAlias(afterFile, options);
  const beforeMap = new Map(before.pairs.map((pair) => [pair.key, pair]));
  const afterMap = new Map(after.pairs.map((pair) => [pair.key, pair]));

  const addedAliasRelationships = after.pairs
    .filter((pair) => !beforeMap.has(pair.key))
    .sort(comparePairsByKey);
  const removedAliasRelationships = before.pairs
    .filter((pair) => !afterMap.has(pair.key))
    .sort(comparePairsByKey);

  const changedAliasClassifications: Array<{
    key: string;
    before: MemoryAliasPair;
    after: MemoryAliasPair;
    changes: string[];
  }> = [];
  for (const afterPair of after.pairs) {
    const beforePair = beforeMap.get(afterPair.key);
    if (!beforePair) continue;
    if (beforePair.alias !== afterPair.alias) {
      changedAliasClassifications.push({
        key: afterPair.key,
        before: beforePair,
        after: afterPair,
        changes: ['alias'],
      });
    }
  }
  changedAliasClassifications.sort((a, b) => comparePairsByKey(a.after, b.after));

  const newlyIntroducedConflicts = after.pairs
    .filter((pair) => {
      if (!pair.potentialConflict) return false;
      const beforePair = beforeMap.get(pair.key);
      return !beforePair?.potentialConflict;
    })
    .sort(comparePairsByKey);

  return {
    before,
    after,
    comparison: {
      addedAliasRelationships,
      removedAliasRelationships,
      changedAliasClassifications,
      newlyIntroducedConflicts,
      totalPairDelta:
        after.statistics.totalAccessPairsCompared - before.statistics.totalAccessPairsCompared,
      potentialConflictDelta:
        after.statistics.potentialReadWriteConflicts -
        before.statistics.potentialReadWriteConflicts,
    },
  };
}
