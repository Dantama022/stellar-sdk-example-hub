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

export type WasmElementMode = 'active' | 'passive' | 'declarative';

export interface WasmElementSegmentInfo {
  index: number;
  mode: WasmElementMode;
  elementType: string;
  tableIndex: number | null;
  offsetExpression: string | null;
  elementCount: number;
  elements: number[];
  elementContentHash: string;
}

export interface WasmElementReport {
  file: string;
  valid: true;
  segments: WasmElementSegmentInfo[];
  statistics: {
    totalSegmentCount: number;
    activeSegmentCount: number;
    passiveSegmentCount: number;
    declarativeSegmentCount: number;
    totalElementCount: number;
    averageSegmentSize: number;
    largestSegment: { index: number; elementCount: number } | null;
    segmentsByMode: Record<WasmElementMode, number>;
    segmentsByElementType: Record<string, number>;
  };
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

function parseElementSection(section: Section | undefined): WasmElementSegmentInfo[] {
  if (!section) return [];
  const reader = new Reader(section.payload);
  const count = reader.varuint32();
  const segments: WasmElementSegmentInfo[] = [];
  for (let i = 0; i < count; i += 1) {
    const flags = reader.varuint32();
    const hasElemType = (flags & 0x01) !== 0;
    const hasTable = (flags & 0x02) !== 0;
    const isDeclarative = (flags & 0x04) !== 0;

    let elementType = 'funcref';
    if (hasElemType) {
      elementType = typeName(reader.byte());
    }

    let mode: WasmElementMode;
    let tableIndex: number | null = null;
    let offsetExpression: string | null = null;

    if (!hasTable) {
      mode = 'passive';
    } else if (isDeclarative) {
      mode = 'declarative';
    } else {
      mode = 'active';
    }

    if (hasTable) {
      tableIndex = reader.varuint32();
      offsetExpression = initExpression(reader);
    }

    const elementCount = reader.varuint32();
    const elements: number[] = [];
    for (let j = 0; j < elementCount; j += 1) {
      elements.push(reader.varuint32());
    }

    const elementBuffer = Buffer.from(elements.flatMap((idx) => {
      const bytes: number[] = [];
      let current = idx >>> 0;
      do {
        let byte = current & 0x7f;
        current >>>= 7;
        if (current !== 0) byte |= 0x80;
        bytes.push(byte);
      } while (current !== 0);
      return bytes;
    }));
    const elementContentHash = createHash('sha256').update(elementBuffer).digest('hex');

    segments.push({
      index: i,
      mode,
      elementType,
      tableIndex,
      offsetExpression,
      elementCount,
      elements,
      elementContentHash,
    });
  }
  return segments;
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

export function analyzeElements(file: string): WasmElementReport {
  const sections = loadSections(file);
  const segments = parseElementSection(sections.find((section) => section.id === 9));

  const modeCounts: Record<WasmElementMode, number> = {
    active: 0,
    passive: 0,
    declarative: 0,
  };
  const typeCounts: Record<string, number> = {};

  segments.forEach((segment) => {
    modeCounts[segment.mode] = (modeCounts[segment.mode] ?? 0) + 1;
    typeCounts[segment.elementType] = (typeCounts[segment.elementType] ?? 0) + 1;
  });

  const totalElementCount = segments.reduce((sum, segment) => sum + segment.elementCount, 0);
  const averageSegmentSize = segments.length === 0 ? 0 : totalElementCount / segments.length;

  const largestSegment = segments.length === 0
    ? null
    : segments.reduce((max, segment) =>
        segment.elementCount > max.elementCount ? segment : max,
      { index: -1, elementCount: -1 });

  return {
    file,
    valid: true,
    segments,
    statistics: {
      totalSegmentCount: segments.length,
      activeSegmentCount: modeCounts.active,
      passiveSegmentCount: modeCounts.passive,
      declarativeSegmentCount: modeCounts.declarative,
      totalElementCount,
      averageSegmentSize,
      largestSegment: largestSegment ? { index: largestSegment.index, elementCount: largestSegment.elementCount } : null,
      segmentsByMode: modeCounts,
      segmentsByElementType: sortedRecord(typeCounts),
    },
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

export function compareElementReports(beforeFile: string, afterFile: string) {
  const before = analyzeElements(beforeFile);
  const after = analyzeElements(afterFile);
  return {
    before,
    after,
    comparison: compareBySignature(
      before.segments,
      after.segments,
      (item) => String(item.index),
      (item) =>
        JSON.stringify([
          item.mode,
          item.elementType,
          item.tableIndex,
          item.offsetExpression,
          item.elementCount,
          item.elementContentHash,
        ]),
      (a, b) => elementChanges(a, b),
    ),
  };
}

function elementChanges(before: WasmElementSegmentInfo, after: WasmElementSegmentInfo): string[] {
  const changes: string[] = [];
  if (before.mode !== after.mode) changes.push('mode');
  if (before.elementType !== after.elementType) changes.push('element_type');
  if (before.tableIndex !== after.tableIndex) changes.push('table_index');
  if (before.offsetExpression !== after.offsetExpression) changes.push('offset_expression');
  if (before.elementCount !== after.elementCount) changes.push('element_count');
  if (before.elementContentHash !== after.elementContentHash) changes.push('element_content');
  return changes;
}

// ============================================================
// WASM Function Side-Effect Analysis (ISSUE-280)
// ============================================================

/**
 * Classification categories for WASM functions.
 *
 * Rules:
 *   pure          – No reads/writes of mutable state; no imports; no trapping
 *                   ops; only local variables, immutable globals, arithmetic.
 *   read_only     – Reads mutable globals or linear memory (loads) but never
 *                   writes them; no imported calls.
 *   state_mutating– Directly writes linear memory (stores) or writes a mutable
 *                   global; OR transitively calls a state_mutating function.
 *   externally_dependent – Directly calls an imported function; OR transitively
 *                   calls an externally_dependent function.
 *   effectful     – Both state_mutating AND externally_dependent (or has both
 *                   sets of evidence).
 *   unknown       – Contains call_indirect (unresolved indirect call) that
 *                   could resolve to any classification; falls back here if
 *                   conservatism demands it.
 *
 * Conservative rules:
 *   - unreachable instruction is a potential trap; flagged in evidence but does
 *     NOT by itself upgrade classification (it is listed under trapping_ops).
 *   - call_indirect always produces unknown unless the function is otherwise
 *     classified as something stronger through direct evidence.
 *   - Recursive calls are resolved via fixed-point iteration; initially assume
 *     the function is pure and upgrade as evidence accumulates.
 *   - A function classified unknown remains unknown; it does not become pure.
 */
export type SideEffectClassification =
  | 'pure'
  | 'read_only'
  | 'state_mutating'
  | 'externally_dependent'
  | 'effectful'
  | 'unknown';

export interface SideEffectEvidence {
  /** Indices of memory-store instructions found in the function body. */
  memoryStores: string[];
  /** Indices of global.set instructions found in the function body. */
  globalWrites: number[];
  /** Indices of mutable globals read by global.get. */
  mutableGlobalReads: number[];
  /** Indices of immutable globals read by global.get. */
  immutableGlobalReads: number[];
  /** Indices of memory-load instructions found in the function body. */
  memoryLoads: string[];
  /** Indices of imported functions that are directly called. */
  importedCalls: number[];
  /** Indices of defined functions that are directly called. */
  directCalls: number[];
  /** Whether the function body contains call_indirect. */
  hasIndirectCall: boolean;
  /** Whether the function body contains the unreachable (0x00) instruction. */
  hasUnreachable: boolean;
  /** Indices of table.set / table.fill / table.copy instructions (if present). */
  tableMutations: string[];
  /** Callees that transitively introduce state mutation. */
  transitiveMutatingCallees: number[];
  /** Callees that transitively introduce external dependencies. */
  transitiveExternalCallees: number[];
}

export interface FunctionSideEffectInfo {
  /** Absolute function index (imports + defined offset). */
  functionIndex: number;
  /** 'imported' | 'defined'. */
  source: 'imported' | 'defined';
  /** Optional export name if exported. */
  exportName: string | null;
  /** The assigned classification. */
  classification: SideEffectClassification;
  /** Evidence that led to this classification. */
  evidence: SideEffectEvidence;
  /** Whether any side effects are transitive (i.e. via callees). */
  hasTransitiveEffects: boolean;
}

export interface WasmSideEffectReport {
  file: string;
  valid: true;
  functions: FunctionSideEffectInfo[];
  statistics: {
    totalAnalyzedFunctions: number;
    pureFunctions: number;
    readOnlyFunctions: number;
    stateMutatingFunctions: number;
    externallyDependentFunctions: number;
    effectfulFunctions: number;
    unknownFunctions: number;
    functionsWithTransitiveEffects: number;
    importedFunctionCount: number;
    definedFunctionCount: number;
  };
  /** Normalized call-dependency graph: functionIndex → set of callee indices. */
  callGraph: Record<number, number[]>;
}

// ---------------------------------------------------------------------------
// Internal helpers for side-effect analysis
// ---------------------------------------------------------------------------

interface ImportedFuncInfo {
  index: number;
  module: string;
  name: string;
}

/** Parse the import section to collect all imported function entries. */
function parseImportedFunctions(section: Section | undefined): ImportedFuncInfo[] {
  const fns: ImportedFuncInfo[] = [];
  if (!section) return fns;
  const reader = new Reader(section.payload);
  const count = reader.varuint32();
  let fnIdx = 0;
  for (let i = 0; i < count; i++) {
    const module = reader.string();
    const name = reader.string();
    const kind = reader.byte();
    if (kind === 0x00) {
      reader.varuint32(); // type index
      fns.push({ index: fnIdx++, module, name });
    } else if (kind === 0x01) {
      reader.byte(); // elem type
      parseLimits(reader);
    } else if (kind === 0x02) {
      parseLimits(reader);
    } else if (kind === 0x03) {
      reader.byte();
      reader.byte();
    }
  }
  return fns;
}

/** Parse export section and return functionIndex → exportName map. */
function parseExportedFunctions(section: Section | undefined): Map<number, string> {
  const map = new Map<number, string>();
  if (!section) return map;
  const reader = new Reader(section.payload);
  const count = reader.varuint32();
  for (let i = 0; i < count; i++) {
    const name = reader.string();
    const kind = reader.byte();
    const idx = reader.varuint32();
    if (kind === 0x00) map.set(idx, name);
  }
  return map;
}

/** True if globalIndex refers to a mutable global. */
function isMutableGlobal(globalIndex: number, globals: WasmGlobalInfo[]): boolean {
  const g = globals.find((g) => g.index === globalIndex);
  return g?.mutable ?? false;
}

/**
 * Scan a single function body and collect direct side-effect evidence.
 * Returns the raw evidence object (transitive fields are populated later).
 */
function scanFunctionBody(
  bodyBuf: Buffer,
  _functionIndex: number,
  importedFunctionCount: number,
  globals: WasmGlobalInfo[],
): Omit<SideEffectEvidence, 'transitiveMutatingCallees' | 'transitiveExternalCallees'> {
  const reader = new Reader(bodyBuf);
  // Skip local declarations
  const localGroupCount = reader.varuint32();
  for (let i = 0; i < localGroupCount; i++) {
    reader.varuint32();
    reader.byte();
  }

  const memoryStores: string[] = [];
  const globalWrites: number[] = [];
  const mutableGlobalReads: number[] = [];
  const immutableGlobalReads: number[] = [];
  const memoryLoads: string[] = [];
  const importedCalls: number[] = [];
  const directCalls: number[] = [];
  let hasIndirectCall = false;
  let hasUnreachable = false;
  const tableMutations: string[] = [];

  // Track reachability: after unreachable or br/return we consider code unreachable
  // until we see the matching end opcode. We use a depth counter approach.
  // For conservatism: we track ALL instructions (reachable or not), but mark
  // unreachable ones separately so callers can exclude them from "reachable" stats.
  // Per the spec: we record evidence only for reachable instructions.
  let unreachableDepth = 0; // >0 means we're in dead code

  const memStoreNames: Record<number, string> = {
    0x36: 'i32.store', 0x37: 'i64.store', 0x38: 'f32.store', 0x39: 'f64.store',
    0x3a: 'i32.store8', 0x3b: 'i32.store16', 0x3c: 'i64.store8', 0x3d: 'i64.store16',
    0x3e: 'i64.store32',
  };
  const memLoadNames: Record<number, string> = {
    0x28: 'i32.load', 0x29: 'i64.load', 0x2a: 'f32.load', 0x2b: 'f64.load',
    0x2c: 'i32.load8_s', 0x2d: 'i32.load8_u', 0x2e: 'i32.load16_s', 0x2f: 'i32.load16_u',
    0x30: 'i64.load8_s', 0x31: 'i64.load8_u', 0x32: 'i64.load16_s', 0x33: 'i64.load16_u',
    0x34: 'i64.load32_s', 0x35: 'i64.load32_u',
  };

  while (!reader.done) {
    const opcode = reader.byte();

    // Handle structured control flow depth for dead-code tracking
    if (unreachableDepth > 0) {
      // Within dead code: track block/loop/if nesting to find the matching end
      if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) {
        unreachableDepth++;
        reader.byte(); // block type
      } else if (opcode === 0x05) {
        // else: at depth 1 this resumes reachability
        if (unreachableDepth === 1) unreachableDepth = 0;
      } else if (opcode === 0x0b) {
        unreachableDepth--;
      } else {
        // skip immediates for dead-code instructions
        skipInstructionImmediate(opcode, reader);
      }
      continue;
    }

    // Reachable instruction processing
    if (opcode === 0x00) {
      // unreachable trap
      hasUnreachable = true;
      // After unreachable, code is dead until matching end
      unreachableDepth = 1;
    } else if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) {
      reader.byte(); // block type
    } else if (opcode === 0x05) {
      // else — continues in if block, reachable from else branch
    } else if (opcode === 0x0b) {
      // end — no-op for our analysis
    } else if (opcode === 0x0c || opcode === 0x0d) {
      reader.varuint32(); // br / br_if label
    } else if (opcode === 0x0e) {
      // br_table
      const count = reader.varuint32();
      for (let i = 0; i <= count; i++) reader.varuint32();
    } else if (opcode === 0x0f) {
      // return — after return, code is dead
      unreachableDepth = 1;
    } else if (opcode === 0x10) {
      // call
      const callee = reader.varuint32();
      if (callee < importedFunctionCount) {
        if (!importedCalls.includes(callee)) importedCalls.push(callee);
      } else {
        if (!directCalls.includes(callee)) directCalls.push(callee);
      }
    } else if (opcode === 0x11) {
      // call_indirect
      hasIndirectCall = true;
      reader.varuint32(); // type index
      reader.byte();      // table index
    } else if (opcode === 0x20 || opcode === 0x21 || opcode === 0x22) {
      reader.varuint32(); // local.get/set/tee
    } else if (opcode === 0x23) {
      // global.get
      const gidx = reader.varuint32();
      if (isMutableGlobal(gidx, globals)) {
        if (!mutableGlobalReads.includes(gidx)) mutableGlobalReads.push(gidx);
      } else {
        if (!immutableGlobalReads.includes(gidx)) immutableGlobalReads.push(gidx);
      }
    } else if (opcode === 0x24) {
      // global.set
      const gidx = reader.varuint32();
      if (!globalWrites.includes(gidx)) globalWrites.push(gidx);
    } else if (opcode in memLoadNames) {
      reader.varuint32(); reader.varuint32(); // alignment, offset
      memoryLoads.push(memLoadNames[opcode]);
    } else if (opcode in memStoreNames) {
      reader.varuint32(); reader.varuint32(); // alignment, offset
      memoryStores.push(memStoreNames[opcode]);
    } else if (opcode === 0x3f || opcode === 0x40) {
      reader.byte(); // memory.size / memory.grow
    } else if (opcode === 0x26) {
      // table.set
      reader.varuint32();
      tableMutations.push('table.set');
    } else if (opcode === 0xfc) {
      // multi-byte opcodes
      const subop = reader.varuint32();
      if (subop === 0x0e) {
        // table.copy
        reader.varuint32(); reader.varuint32();
        tableMutations.push('table.copy');
      } else if (subop === 0x11) {
        // table.fill
        reader.varuint32();
        tableMutations.push('table.fill');
      } else if (subop === 0x08 || subop === 0x09) {
        // memory.init / memory.drop
        reader.varuint32();
        if (subop === 0x08) reader.byte();
        memoryStores.push(subop === 0x08 ? 'memory.init' : 'data.drop');
      } else if (subop === 0x0a || subop === 0x0b) {
        // memory.copy / memory.fill
        if (subop === 0x0a) { reader.byte(); reader.byte(); }
        else reader.byte();
        memoryStores.push(subop === 0x0a ? 'memory.copy' : 'memory.fill');
      } else if (subop === 0x0c || subop === 0x0d) {
        // table.init / elem.drop
        reader.varuint32();
        if (subop === 0x0c) reader.varuint32();
        tableMutations.push(subop === 0x0c ? 'table.init' : 'elem.drop');
      } else if (subop === 0x0f || subop === 0x10) {
        // table.grow / table.size
        reader.varuint32();
      } else {
        // unknown FC subop — skip 0 immediates conservatively (best effort)
      }
    } else if (opcode === 0x41) {
      reader.varint32();
    } else if (opcode === 0x42) {
      // i64.const — use varint32 twice (high/low) as approximation or skip 10 bytes LEB
      // Actually read as varint64 via varint32 iteration
      let shift = 0;
      let b: number;
      do { b = reader.byte(); shift += 7; } while ((b & 0x80) !== 0 && shift < 70);
    } else if (opcode === 0x43) {
      reader.bytes(4);
    } else if (opcode === 0x44) {
      reader.bytes(8);
    } else if (opcode === 0x25) {
      reader.varuint32(); // table.get
    } else if (opcode === 0x1a || opcode === 0x1b) {
      // drop, select — no immediates
    } else if (opcode === 0x27) {
      reader.varuint32(); // table index for table.grow? Actually 0x27 is not used standard
      // 0x27 is not a standard opcode; skip varuint32 conservatively
    } else {
      // All other opcodes: skip immediates using the existing helper
      skipInstructionImmediate(opcode, reader);
    }
  }

  return {
    memoryStores,
    globalWrites,
    mutableGlobalReads,
    immutableGlobalReads,
    memoryLoads,
    importedCalls,
    directCalls,
    hasIndirectCall,
    hasUnreachable,
    tableMutations,
  };
}

/**
 * Classify a function based only on its own (direct) evidence,
 * ignoring transitive callees.
 */
function classifyDirect(
  ev: Omit<SideEffectEvidence, 'transitiveMutatingCallees' | 'transitiveExternalCallees'>,
): SideEffectClassification {
  const mutates =
    ev.memoryStores.length > 0 || ev.globalWrites.length > 0 || ev.tableMutations.length > 0;
  const readsExternal = ev.importedCalls.length > 0;

  if (ev.hasIndirectCall) return 'unknown';
  if (mutates && readsExternal) return 'effectful';
  if (mutates) return 'state_mutating';
  if (readsExternal) return 'externally_dependent';
  if (ev.mutableGlobalReads.length > 0 || ev.memoryLoads.length > 0) return 'read_only';
  return 'pure';
}

/**
 * Merge two classifications conservatively: return the "worse" of the two.
 * Order (from least to most effectful):
 *   pure < read_only < state_mutating < externally_dependent < effectful < unknown
 */
function mergeClassification(
  a: SideEffectClassification,
  b: SideEffectClassification,
): SideEffectClassification {
  const order: Record<SideEffectClassification, number> = {
    pure: 0,
    read_only: 1,
    state_mutating: 2,
    externally_dependent: 3,
    effectful: 4,
    unknown: 5,
  };
  // Special merge rules:
  // state_mutating + externally_dependent = effectful
  if (
    (a === 'state_mutating' && b === 'externally_dependent') ||
    (a === 'externally_dependent' && b === 'state_mutating')
  ) return 'effectful';
  return order[a] >= order[b] ? a : b;
}

/**
 * Main analysis function: parse WASM, scan all function bodies,
 * propagate side effects through the call graph.
 */
export function analyzeSideEffects(file: string): WasmSideEffectReport {
  const sections = loadSections(file);
  const importSection = sections.find((s) => s.id === 2);
  const codeSection = sections.find((s) => s.id === 10);
  const exportSection = sections.find((s) => s.id === 7);
  const globalSection = sections.find((s) => s.id === 6);

  // Collect globals (imported + defined) for mutability checks
  const importedInfo = parseImportSection(importSection);
  const definedGlobals = parseGlobalSection(globalSection, importedInfo.globals.length);
  const allGlobals = [...importedInfo.globals, ...definedGlobals];

  // Collect imported functions
  const importedFuncs = parseImportedFunctions(importSection);
  const numImported = importedFuncs.length;

  // Export names
  const exportNames = parseExportedFunctions(exportSection);

  // Build placeholder entries for imported functions
  // Imported functions are conservatively marked externally_dependent
  const results: FunctionSideEffectInfo[] = importedFuncs.map((fn) => ({
    functionIndex: fn.index,
    source: 'imported' as const,
    exportName: exportNames.get(fn.index) ?? null,
    classification: 'externally_dependent' as SideEffectClassification,
    evidence: {
      memoryStores: [],
      globalWrites: [],
      mutableGlobalReads: [],
      immutableGlobalReads: [],
      memoryLoads: [],
      importedCalls: [],
      directCalls: [],
      hasIndirectCall: false,
      hasUnreachable: false,
      tableMutations: [],
      transitiveMutatingCallees: [],
      transitiveExternalCallees: [],
    },
    hasTransitiveEffects: false,
  }));

  // Parse code section for defined functions
  const callGraph: Record<number, number[]> = {};
  const directEvidences: Map<number, ReturnType<typeof scanFunctionBody>> = new Map();

  if (codeSection) {
    const reader = new Reader(codeSection.payload);
    const count = reader.varuint32();
    for (let i = 0; i < count; i++) {
      const bodySize = reader.varuint32();
      const bodyBuf = reader.bytes(bodySize);
      const fnIdx = numImported + i;
      const ev = scanFunctionBody(bodyBuf, fnIdx, numImported, allGlobals);
      directEvidences.set(fnIdx, ev);
      callGraph[fnIdx] = [...ev.directCalls];
      const directClass = classifyDirect(ev);
      results.push({
        functionIndex: fnIdx,
        source: 'defined',
        exportName: exportNames.get(fnIdx) ?? null,
        classification: directClass,
        evidence: {
          ...ev,
          transitiveMutatingCallees: [],
          transitiveExternalCallees: [],
        },
        hasTransitiveEffects: false,
      });
    }
  }

  // Also add imported functions to call graph (no outgoing calls)
  importedFuncs.forEach((fn) => {
    callGraph[fn.index] = [];
  });

  // Fixed-point propagation of side effects through call graph
  // Iterate until classifications stabilize
  let changed = true;
  const maxIterations = results.length * 2 + 10;
  let iterations = 0;
  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;
    for (const fn of results) {
      if (fn.source === 'imported') continue;
      const ev = directEvidences.get(fn.functionIndex)!;
      let cls = classifyDirect(ev);
      const newTransitiveMutating: number[] = [];
      const newTransitiveExternal: number[] = [];

      for (const calleeIdx of ev.directCalls) {
        const calleeFn = results.find((r) => r.functionIndex === calleeIdx);
        if (!calleeFn) continue;
        const calleeCls = calleeFn.classification;
        if (
          calleeCls === 'state_mutating' ||
          calleeCls === 'effectful'
        ) {
          if (!newTransitiveMutating.includes(calleeIdx))
            newTransitiveMutating.push(calleeIdx);
        }
        if (
          calleeCls === 'externally_dependent' ||
          calleeCls === 'effectful'
        ) {
          if (!newTransitiveExternal.includes(calleeIdx))
            newTransitiveExternal.push(calleeIdx);
        }
        cls = mergeClassification(cls, calleeCls);
      }

      const hasTransitive =
        newTransitiveMutating.length > 0 || newTransitiveExternal.length > 0;

      if (
        fn.classification !== cls ||
        JSON.stringify(fn.evidence.transitiveMutatingCallees.sort()) !==
          JSON.stringify(newTransitiveMutating.sort()) ||
        JSON.stringify(fn.evidence.transitiveExternalCallees.sort()) !==
          JSON.stringify(newTransitiveExternal.sort())
      ) {
        fn.classification = cls;
        fn.evidence.transitiveMutatingCallees = newTransitiveMutating.sort((a, b) => a - b);
        fn.evidence.transitiveExternalCallees = newTransitiveExternal.sort((a, b) => a - b);
        fn.hasTransitiveEffects = hasTransitive;
        changed = true;
      }
    }
  }

  // Build statistics
  const stats = {
    totalAnalyzedFunctions: results.length,
    pureFunctions: results.filter((f) => f.classification === 'pure').length,
    readOnlyFunctions: results.filter((f) => f.classification === 'read_only').length,
    stateMutatingFunctions: results.filter((f) => f.classification === 'state_mutating').length,
    externallyDependentFunctions: results.filter(
      (f) => f.classification === 'externally_dependent',
    ).length,
    effectfulFunctions: results.filter((f) => f.classification === 'effectful').length,
    unknownFunctions: results.filter((f) => f.classification === 'unknown').length,
    functionsWithTransitiveEffects: results.filter((f) => f.hasTransitiveEffects).length,
    importedFunctionCount: numImported,
    definedFunctionCount: results.filter((f) => f.source === 'defined').length,
  };

  // Normalize call graph: sort callee lists
  const normalizedCallGraph: Record<number, number[]> = {};
  Object.entries(callGraph).forEach(([k, v]) => {
    normalizedCallGraph[Number(k)] = [...v].sort((a, b) => a - b);
  });

  return {
    file,
    valid: true,
    functions: results,
    statistics: stats,
    callGraph: normalizedCallGraph,
  };
}

/** Compare two side-effect reports for two-artifact comparison mode. */
export function compareSideEffectReports(
  beforeFile: string,
  afterFile: string,
): {
  before: WasmSideEffectReport;
  after: WasmSideEffectReport;
  comparison: {
    becameEffectful: number[];
    becameSideEffectFree: number[];
    newMemoryWrites: number[];
    newGlobalWrites: number[];
    newImportedDependencies: number[];
    changedTransitiveEffects: number[];
    classificationChanges: Array<{
      functionIndex: number;
      before: SideEffectClassification;
      after: SideEffectClassification;
    }>;
  };
} {
  const before = analyzeSideEffects(beforeFile);
  const after = analyzeSideEffects(afterFile);

  const sideEffectFreeClasses: SideEffectClassification[] = ['pure', 'read_only'];
  const effectfulClasses: SideEffectClassification[] = [
    'state_mutating', 'externally_dependent', 'effectful', 'unknown',
  ];

  const beforeMap = new Map(before.functions.map((f) => [f.functionIndex, f]));
  const afterMap = new Map(after.functions.map((f) => [f.functionIndex, f]));
  const allIndices = [
    ...new Set([...beforeMap.keys(), ...afterMap.keys()]),
  ].sort((a, b) => a - b);

  const becameEffectful: number[] = [];
  const becameSideEffectFree: number[] = [];
  const newMemoryWrites: number[] = [];
  const newGlobalWrites: number[] = [];
  const newImportedDependencies: number[] = [];
  const changedTransitiveEffects: number[] = [];
  const classificationChanges: Array<{
    functionIndex: number;
    before: SideEffectClassification;
    after: SideEffectClassification;
  }> = [];

  for (const idx of allIndices) {
    const bfn = beforeMap.get(idx);
    const afn = afterMap.get(idx);
    if (!bfn || !afn) continue;
    if (bfn.classification !== afn.classification) {
      classificationChanges.push({
        functionIndex: idx,
        before: bfn.classification,
        after: afn.classification,
      });
      if (
        sideEffectFreeClasses.includes(bfn.classification) &&
        effectfulClasses.includes(afn.classification)
      ) {
        becameEffectful.push(idx);
      }
      if (
        effectfulClasses.includes(bfn.classification) &&
        sideEffectFreeClasses.includes(afn.classification)
      ) {
        becameSideEffectFree.push(idx);
      }
    }
    // New memory writes
    const bStores = new Set(bfn.evidence.memoryStores);
    const newStores = afn.evidence.memoryStores.filter((s) => !bStores.has(s));
    if (newStores.length > 0 && !newMemoryWrites.includes(idx)) newMemoryWrites.push(idx);
    // New global writes
    const bGlobals = new Set(bfn.evidence.globalWrites);
    const newGlobals = afn.evidence.globalWrites.filter((g) => !bGlobals.has(g));
    if (newGlobals.length > 0 && !newGlobalWrites.includes(idx)) newGlobalWrites.push(idx);
    // New imported dependencies
    const bImports = new Set(bfn.evidence.importedCalls);
    const newImports = afn.evidence.importedCalls.filter((c) => !bImports.has(c));
    if (newImports.length > 0 && !newImportedDependencies.includes(idx))
      newImportedDependencies.push(idx);
    // Changed transitive effects
    const bTransitive = JSON.stringify([
      ...bfn.evidence.transitiveMutatingCallees,
      ...bfn.evidence.transitiveExternalCallees,
    ].sort());
    const aTransitive = JSON.stringify([
      ...afn.evidence.transitiveMutatingCallees,
      ...afn.evidence.transitiveExternalCallees,
    ].sort());
    if (bTransitive !== aTransitive && !changedTransitiveEffects.includes(idx))
      changedTransitiveEffects.push(idx);
  }

  return {
    before,
    after,
    comparison: {
      becameEffectful,
      becameSideEffectFree,
      newMemoryWrites,
      newGlobalWrites,
      newImportedDependencies,
      changedTransitiveEffects,
      classificationChanges,
    },
  };
}
