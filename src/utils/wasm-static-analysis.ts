import { createHash } from 'crypto';
import fs from 'fs';

export class WasmValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WasmValidationError';
  }
}

export interface WasmLimits {
  initial: number;
  maximum: number | null;
}

export interface WasmMemoryInfo {
  index: number;
  source: 'imported' | 'defined';
  module: string | null;
  name: string | null;
  limits: WasmLimits;
}

export interface WasmTableInfo {
  index: number;
  source: 'imported' | 'defined';
  module: string | null;
  name: string | null;
  elementType: string;
  limits: WasmLimits;
}

export interface WasmGlobalInfo {
  index: number;
  source: 'imported' | 'defined';
  module: string | null;
  name: string | null;
  valueType: string;
  mutable: boolean;
  initExpression: string | null;
}

export interface WasmCustomSectionInfo {
  order: number;
  name: string;
  payloadSize: number;
  payloadHash: string;
}

export interface WasmInstructionFunctionInfo {
  functionIndex: number;
  bodySize: number;
  instructionCount: number;
  categories: string[];
}

export interface WasmInstructionReport {
  file: string;
  valid: true;
  totalDefinedFunctions: number;
  totalInstructionCount: number;
  averageInstructionsPerFunction: number;
  minInstructionsPerFunction: number;
  maxInstructionsPerFunction: number;
  totalCodeBodySize: number;
  instructionFrequencies: Record<string, number>;
  categoryFrequencies: Record<string, number>;
  largestFunctions: WasmInstructionFunctionInfo[];
  functions: WasmInstructionFunctionInfo[];
}

export interface WasmMemoryTableReport {
  file: string;
  valid: true;
  memories: WasmMemoryInfo[];
  tables: WasmTableInfo[];
  statistics: {
    memoryCount: number;
    importedMemoryCount: number;
    definedMemoryCount: number;
    totalInitialMemoryPages: number;
    totalMaximumMemoryPages: number | null;
    tableCount: number;
    importedTableCount: number;
    definedTableCount: number;
    totalInitialTableElements: number;
    totalMaximumTableElements: number | null;
    tablesByElementType: Record<string, number>;
  };
}

export interface WasmGlobalReport {
  file: string;
  valid: true;
  globals: WasmGlobalInfo[];
  statistics: {
    totalGlobalCount: number;
    importedGlobalCount: number;
    definedGlobalCount: number;
    mutableGlobalCount: number;
    immutableGlobalCount: number;
    globalsByValueType: Record<string, number>;
  };
}

export interface WasmCustomSectionReport {
  file: string;
  valid: true;
  sections: WasmCustomSectionInfo[];
  groupedByName: Record<string, WasmCustomSectionInfo[]>;
  statistics: {
    customSectionCount: number;
    totalCustomSectionSize: number;
    largestCustomSections: WasmCustomSectionInfo[];
  };
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

  remaining(): number {
    return this.data.length - this.offset;
  }

  byte(): number {
    if (this.offset >= this.data.length)
      throw new WasmValidationError('Unexpected end of WASM data');
    return this.data[this.offset++];
  }

  bytes(length: number): Buffer {
    if (length < 0 || this.offset + length > this.data.length) {
      throw new WasmValidationError('Section length exceeds remaining WASM data');
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
    throw new WasmValidationError('Invalid unsigned LEB128 value');
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
  if (wasm.length < 8) throw new WasmValidationError('Invalid WASM binary: file is too short');
  if (wasm.subarray(0, 4).compare(Buffer.from([0x00, 0x61, 0x73, 0x6d])) !== 0) {
    throw new WasmValidationError('Invalid WASM binary: missing WebAssembly magic header');
  }
  if (wasm.subarray(4, 8).compare(Buffer.from([0x01, 0x00, 0x00, 0x00])) !== 0) {
    throw new WasmValidationError('Unsupported WASM binary: expected version 1');
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

function typeName(byte: number): string {
  const names: Record<number, string> = {
    0x7f: 'i32',
    0x7e: 'i64',
    0x7d: 'f32',
    0x7c: 'f64',
    0x7b: 'v128',
    0x70: 'funcref',
    0x6f: 'externref',
  };
  return names[byte] ?? `unknown(0x${byte.toString(16)})`;
}

function parseLimits(reader: Reader): WasmLimits {
  const flags = reader.varuint32();
  const initial = reader.varuint32();
  const maximum = (flags & 0x01) === 0x01 ? reader.varuint32() : null;
  return { initial, maximum };
}

function parseImportSection(section: Section | undefined): {
  memories: WasmMemoryInfo[];
  tables: WasmTableInfo[];
  globals: WasmGlobalInfo[];
} {
  const memories: WasmMemoryInfo[] = [];
  const tables: WasmTableInfo[] = [];
  const globals: WasmGlobalInfo[] = [];
  if (!section) return { memories, tables, globals };
  const reader = new Reader(section.payload);
  const count = reader.varuint32();
  for (let i = 0; i < count; i += 1) {
    const module = reader.string();
    const name = reader.string();
    const kind = reader.byte();
    if (kind === 0x00) {
      reader.varuint32();
    } else if (kind === 0x01) {
      tables.push({
        index: tables.length,
        source: 'imported',
        module,
        name,
        elementType: typeName(reader.byte()),
        limits: parseLimits(reader),
      });
    } else if (kind === 0x02) {
      memories.push({
        index: memories.length,
        source: 'imported',
        module,
        name,
        limits: parseLimits(reader),
      });
    } else if (kind === 0x03) {
      globals.push({
        index: globals.length,
        source: 'imported',
        module,
        name,
        valueType: typeName(reader.byte()),
        mutable: reader.byte() === 1,
        initExpression: null,
      });
    } else {
      throw new WasmValidationError(`Unsupported import kind: ${kind}`);
    }
  }
  return { memories, tables, globals };
}

function parseMemorySection(section: Section | undefined, importedCount: number): WasmMemoryInfo[] {
  if (!section) return [];
  const reader = new Reader(section.payload);
  const count = reader.varuint32();
  const memories: WasmMemoryInfo[] = [];
  for (let i = 0; i < count; i += 1) {
    memories.push({
      index: importedCount + i,
      source: 'defined',
      module: null,
      name: null,
      limits: parseLimits(reader),
    });
  }
  return memories;
}

function parseTableSection(section: Section | undefined, importedCount: number): WasmTableInfo[] {
  if (!section) return [];
  const reader = new Reader(section.payload);
  const count = reader.varuint32();
  const tables: WasmTableInfo[] = [];
  for (let i = 0; i < count; i += 1) {
    tables.push({
      index: importedCount + i,
      source: 'defined',
      module: null,
      name: null,
      elementType: typeName(reader.byte()),
      limits: parseLimits(reader),
    });
  }
  return tables;
}

function initExpression(reader: Reader): string {
  const parts: string[] = [];
  while (!reader.done) {
    const opcode = reader.byte();
    if (opcode === 0x0b) return parts.join(' ');
    if (opcode === 0x41) parts.push(`i32.const ${reader.varint32()}`);
    else if (opcode === 0x42) parts.push(`i64.const ${reader.varint32()}`);
    else if (opcode === 0x23) parts.push(`global.get ${reader.varuint32()}`);
    else parts.push(`opcode 0x${opcode.toString(16)}`);
  }
  throw new WasmValidationError('Global initializer is missing end opcode');
}

function parseGlobalSection(section: Section | undefined, importedCount: number): WasmGlobalInfo[] {
  if (!section) return [];
  const reader = new Reader(section.payload);
  const count = reader.varuint32();
  const globals: WasmGlobalInfo[] = [];
  for (let i = 0; i < count; i += 1) {
    globals.push({
      index: importedCount + i,
      source: 'defined',
      module: null,
      name: null,
      valueType: typeName(reader.byte()),
      mutable: reader.byte() === 1,
      initExpression: initExpression(reader),
    });
  }
  return globals;
}

function parseCustomSections(sections: Section[]): WasmCustomSectionInfo[] {
  return sections
    .filter((section) => section.id === 0)
    .map((section) => {
      const reader = new Reader(section.payload);
      const name = reader.string();
      const payload = section.payload.subarray(reader.offset);
      return {
        order: section.order,
        name,
        payloadSize: payload.length,
        payloadHash: createHash('sha256').update(payload).digest('hex'),
      };
    })
    .sort((a, b) => a.order - b.order);
}

const opcodeNames: Record<number, string> = {
  0x00: 'unreachable',
  0x01: 'nop',
  0x02: 'block',
  0x03: 'loop',
  0x04: 'if',
  0x05: 'else',
  0x0b: 'end',
  0x0c: 'br',
  0x0d: 'br_if',
  0x0e: 'br_table',
  0x0f: 'return',
  0x10: 'call',
  0x11: 'call_indirect',
  0x1a: 'drop',
  0x1b: 'select',
  0x20: 'local.get',
  0x21: 'local.set',
  0x22: 'local.tee',
  0x23: 'global.get',
  0x24: 'global.set',
  0x28: 'i32.load',
  0x29: 'i64.load',
  0x2a: 'f32.load',
  0x2b: 'f64.load',
  0x36: 'i32.store',
  0x37: 'i64.store',
  0x38: 'f32.store',
  0x39: 'f64.store',
  0x3f: 'memory.size',
  0x40: 'memory.grow',
  0x41: 'i32.const',
  0x42: 'i64.const',
  0x43: 'f32.const',
  0x44: 'f64.const',
  0x45: 'i32.eqz',
  0x46: 'i32.eq',
  0x6a: 'i32.add',
  0x6b: 'i32.sub',
  0x6c: 'i32.mul',
  0x7c: 'i64.add',
  0x92: 'f32.add',
  0xa7: 'i32.wrap_i64',
  0xac: 'i64.extend_i32_s',
  0xad: 'i64.extend_i32_u',
};

function instructionCategory(name: string): string {
  if (['block', 'loop', 'if', 'else', 'end', 'br', 'br_if', 'br_table', 'return'].includes(name)) {
    return 'control_flow';
  }
  if (name.startsWith('call')) return 'calls';
  if (name.includes('load') || name.includes('store') || name.startsWith('memory.')) {
    return 'memory_operations';
  }
  if (name.startsWith('local.') || name.startsWith('global.')) return 'variable_access';
  if (name.includes('wrap') || name.includes('extend') || name.includes('convert')) {
    return 'conversion_operations';
  }
  if (name.startsWith('i32.') || name.startsWith('i64.')) return 'integer_operations';
  if (name.startsWith('f32.') || name.startsWith('f64.')) return 'floating_point_operations';
  return 'other';
}

function skipInstructionImmediate(opcode: number, reader: Reader): void {
  if ([0x02, 0x03, 0x04].includes(opcode)) reader.byte();
  else if ([0x0c, 0x0d, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24].includes(opcode)) reader.varuint32();
  else if (opcode === 0x0e) {
    const count = reader.varuint32();
    for (let i = 0; i < count + 1; i += 1) reader.varuint32();
  } else if (opcode === 0x11) {
    reader.varuint32();
    reader.byte();
  } else if (opcode >= 0x28 && opcode <= 0x3e) {
    reader.varuint32();
    reader.varuint32();
  } else if (opcode === 0x3f || opcode === 0x40) reader.byte();
  else if (opcode === 0x41 || opcode === 0x42) reader.varint32();
  else if (opcode === 0x43) reader.bytes(4);
  else if (opcode === 0x44) reader.bytes(8);
}

function parseCodeSection(
  section: Section | undefined,
  importedFunctions: number,
): WasmInstructionFunctionInfo[] {
  if (!section) return [];
  const reader = new Reader(section.payload);
  const count = reader.varuint32();
  const functions: WasmInstructionFunctionInfo[] = [];
  for (let i = 0; i < count; i += 1) {
    const bodySize = reader.varuint32();
    const body = new Reader(reader.bytes(bodySize));
    const localGroupCount = body.varuint32();
    for (let j = 0; j < localGroupCount; j += 1) {
      body.varuint32();
      body.byte();
    }
    const frequencies: Record<string, number> = {};
    const categories = new Set<string>();
    while (!body.done) {
      const opcode = body.byte();
      const name = opcodeNames[opcode] ?? `opcode_0x${opcode.toString(16)}`;
      frequencies[name] = (frequencies[name] ?? 0) + 1;
      categories.add(instructionCategory(name));
      skipInstructionImmediate(opcode, body);
    }
    const instructionCount = Object.values(frequencies).reduce((sum, value) => sum + value, 0);
    functions.push({
      functionIndex: importedFunctions + i,
      bodySize,
      instructionCount,
      categories: [...categories].sort(),
    });
  }
  return functions;
}

function addCount(target: Record<string, number>, key: string, amount = 1): void {
  target[key] = (target[key] ?? 0) + amount;
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function loadSections(file: string): Section[] {
  try {
    return parseSections(fs.readFileSync(file));
  } catch (error) {
    if (error instanceof WasmValidationError) throw error;
    throw new WasmValidationError(
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
    reader.string();
    reader.string();
    const kind = reader.byte();
    if (kind === 0x00) {
      functions += 1;
      reader.varuint32();
    } else if (kind === 0x01) {
      reader.byte();
      parseLimits(reader);
    } else if (kind === 0x02) parseLimits(reader);
    else if (kind === 0x03) {
      reader.byte();
      reader.byte();
    }
  }
  return functions;
}

export function analyzeMemoryTables(file: string): WasmMemoryTableReport {
  const sections = loadSections(file);
  const imports = parseImportSection(sections.find((section) => section.id === 2));
  const memories = [
    ...imports.memories,
    ...parseMemorySection(
      sections.find((section) => section.id === 5),
      imports.memories.length,
    ),
  ];
  const tables = [
    ...imports.tables,
    ...parseTableSection(
      sections.find((section) => section.id === 4),
      imports.tables.length,
    ),
  ];
  const tableTypes: Record<string, number> = {};
  tables.forEach((table) => addCount(tableTypes, table.elementType));
  const memoryMaximums = memories.map((memory) => memory.limits.maximum);
  const tableMaximums = tables.map((table) => table.limits.maximum);
  return {
    file,
    valid: true,
    memories,
    tables,
    statistics: {
      memoryCount: memories.length,
      importedMemoryCount: memories.filter((memory) => memory.source === 'imported').length,
      definedMemoryCount: memories.filter((memory) => memory.source === 'defined').length,
      totalInitialMemoryPages: memories.reduce((sum, memory) => sum + memory.limits.initial, 0),
      totalMaximumMemoryPages: memoryMaximums.every((value) => value !== null)
        ? (memoryMaximums as number[]).reduce((sum, value) => sum + value, 0)
        : null,
      tableCount: tables.length,
      importedTableCount: tables.filter((table) => table.source === 'imported').length,
      definedTableCount: tables.filter((table) => table.source === 'defined').length,
      totalInitialTableElements: tables.reduce((sum, table) => sum + table.limits.initial, 0),
      totalMaximumTableElements: tableMaximums.every((value) => value !== null)
        ? (tableMaximums as number[]).reduce((sum, value) => sum + value, 0)
        : null,
      tablesByElementType: sortedRecord(tableTypes),
    },
  };
}

export function analyzeGlobals(file: string): WasmGlobalReport {
  const sections = loadSections(file);
  const imports = parseImportSection(sections.find((section) => section.id === 2));
  const globals = [
    ...imports.globals,
    ...parseGlobalSection(
      sections.find((section) => section.id === 6),
      imports.globals.length,
    ),
  ];
  const byType: Record<string, number> = {};
  globals.forEach((global) => addCount(byType, global.valueType));
  return {
    file,
    valid: true,
    globals,
    statistics: {
      totalGlobalCount: globals.length,
      importedGlobalCount: globals.filter((global) => global.source === 'imported').length,
      definedGlobalCount: globals.filter((global) => global.source === 'defined').length,
      mutableGlobalCount: globals.filter((global) => global.mutable).length,
      immutableGlobalCount: globals.filter((global) => !global.mutable).length,
      globalsByValueType: sortedRecord(byType),
    },
  };
}

export function analyzeCustomSections(file: string): WasmCustomSectionReport {
  const sections = parseCustomSections(loadSections(file));
  const groupedByName: Record<string, WasmCustomSectionInfo[]> = {};
  sections.forEach((section) => {
    groupedByName[section.name] = [...(groupedByName[section.name] ?? []), section];
  });
  return {
    file,
    valid: true,
    sections,
    groupedByName: Object.fromEntries(
      Object.entries(groupedByName).sort(([a], [b]) => a.localeCompare(b)),
    ),
    statistics: {
      customSectionCount: sections.length,
      totalCustomSectionSize: sections.reduce((sum, section) => sum + section.payloadSize, 0),
      largestCustomSections: [...sections]
        .sort((a, b) => b.payloadSize - a.payloadSize || a.order - b.order)
        .slice(0, 5),
    },
  };
}

export function analyzeInstructions(file: string): WasmInstructionReport {
  const sections = loadSections(file);
  const imports = sections.find((section) => section.id === 2);
  const functions = parseCodeSection(
    sections.find((section) => section.id === 10),
    importedFunctionCount(imports),
  );
  const instructionFrequencies: Record<string, number> = {};
  const categoryFrequencies: Record<string, number> = {};
  functions.forEach((fn) => {
    fn.categories.forEach((category) => addCount(categoryFrequencies, category));
  });
  const codeSection = sections.find((section) => section.id === 10);
  if (codeSection) {
    const reader = new Reader(codeSection.payload);
    const count = reader.varuint32();
    for (let i = 0; i < count; i += 1) {
      const body = new Reader(reader.bytes(reader.varuint32()));
      const locals = body.varuint32();
      for (let j = 0; j < locals; j += 1) {
        body.varuint32();
        body.byte();
      }
      while (!body.done) {
        const opcode = body.byte();
        const name = opcodeNames[opcode] ?? `opcode_0x${opcode.toString(16)}`;
        addCount(instructionFrequencies, name);
        skipInstructionImmediate(opcode, body);
      }
    }
  }
  const counts = functions.map((fn) => fn.instructionCount);
  const total = counts.reduce((sum, count) => sum + count, 0);
  return {
    file,
    valid: true,
    totalDefinedFunctions: functions.length,
    totalInstructionCount: total,
    averageInstructionsPerFunction: functions.length === 0 ? 0 : total / functions.length,
    minInstructionsPerFunction: counts.length === 0 ? 0 : Math.min(...counts),
    maxInstructionsPerFunction: counts.length === 0 ? 0 : Math.max(...counts),
    totalCodeBodySize: functions.reduce((sum, fn) => sum + fn.bodySize, 0),
    instructionFrequencies: sortedRecord(instructionFrequencies),
    categoryFrequencies: sortedRecord(categoryFrequencies),
    largestFunctions: [...functions]
      .sort((a, b) => b.instructionCount - a.instructionCount || a.functionIndex - b.functionIndex)
      .slice(0, 10),
    functions,
  };
}

export interface ComparisonResult<T> {
  added: T[];
  removed: T[];
  changed: Array<{ before: T; after: T; changes: string[] }>;
  unchanged: T[];
}

export function compareBySignature<T>(
  before: T[],
  after: T[],
  identity: (item: T) => string,
  signature: (item: T) => string,
  changes: (before: T, after: T) => string[],
): ComparisonResult<T> {
  const beforeMap = new Map(before.map((item) => [identity(item), item]));
  const afterMap = new Map(after.map((item) => [identity(item), item]));
  const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  const result: ComparisonResult<T> = { added: [], removed: [], changed: [], unchanged: [] };
  keys.forEach((key) => {
    const oldItem = beforeMap.get(key);
    const newItem = afterMap.get(key);
    if (!oldItem && newItem) result.added.push(newItem);
    else if (oldItem && !newItem) result.removed.push(oldItem);
    else if (oldItem && newItem && signature(oldItem) !== signature(newItem)) {
      result.changed.push({ before: oldItem, after: newItem, changes: changes(oldItem, newItem) });
    } else if (oldItem) result.unchanged.push(oldItem);
  });
  return result;
}
