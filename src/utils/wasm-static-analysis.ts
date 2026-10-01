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

export interface WasmNameEntry {
  index: number;
  name: string | null;
  status: 'named' | 'explicitly-unnamed' | 'unmapped';
}

export interface WasmFunctionNameInfo extends WasmNameEntry {
  functionIndex: number;
  defined: boolean;
  locals: WasmNameEntry[];
  unnamedLocalRanges: Array<{ startIndex: number; endIndex: number }>;
  localNameMetadataPresent: boolean;
  expectedLocalCount: number | null;
  namedLocalCount: number;
  unnamedLocalCount: number | null;
}

export interface WasmNameReport {
  file: string;
  valid: true;
  nameSection: {
    present: boolean;
    count: number;
    subsections: Array<{ id: number; name: string }>;
  };
  functions: WasmFunctionNameInfo[];
  functionsWithIncompleteLocalNames: number[];
  statistics: {
    totalFunctionCount: number;
    totalNamedFunctions: number;
    totalUnnamedFunctions: number;
    totalFunctionsWithLocalNameMetadata: number;
    totalNamedLocals: number;
    functionsWithMostNamedLocals: Array<{
      functionIndex: number;
      name: string | null;
      count: number;
    }>;
  };
  warnings: string[];
}

export type WasmProducerCategory = 'language' | 'compiler' | 'linker' | 'binary-tool' | 'other';

export interface WasmProducerInfo {
  order: number;
  field: string;
  category: WasmProducerCategory;
  name: string;
  version: string;
  values: { name: string; version: string };
}

export interface WasmProvenanceReport {
  file: string;
  valid: true;
  provenanceStatus: 'available' | 'partial' | 'absent' | 'malformed';
  producers: WasmProducerInfo[];
  rawProducerMetadata: Array<{
    sectionOrder: number;
    payloadBase64: string;
    fields: Array<{ name: string; producers: Array<{ name: string; version: string }> }> | null;
    error?: string;
  }>;
  warnings: string[];
  module: {
    wasmVersion: number;
    functionCount: number;
    importCount: number;
    exportCount: number;
    codeSize: number;
    customSections: { present: boolean; count: number; names: string[] };
  };
  fingerprint: string;
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

function producerCategory(field: string, name: string): WasmProducerCategory {
  if (field.toLowerCase() === 'language') return 'language';
  const value = `${field} ${name}`.toLowerCase();
  if (/linker|wasm-ld|rust-lld|\blld\b/.test(value)) return 'linker';
  if (/objcopy|objdump|strip|wasm-tools|binaryen|wasm-opt/.test(value)) return 'binary-tool';
  if (/compiler|rustc|clang|\bgcc\b|swiftc|emscripten|tinygo|\bzig\b/.test(value)) {
    return 'compiler';
  }
  return 'other';
}

function parseProducerSection(section: Section): {
  fields: Array<{ name: string; producers: Array<{ name: string; version: string }> }>;
  producers: WasmProducerInfo[];
} {
  const reader = new Reader(section.payload);
  if (reader.string() !== 'producers') throw new WasmValidationError('Not a producers section');
  const fieldCount = reader.varuint32();
  const fields: Array<{ name: string; producers: Array<{ name: string; version: string }> }> = [];
  const producers: WasmProducerInfo[] = [];
  for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex += 1) {
    const field = reader.string();
    const producerCount = reader.varuint32();
    const fieldProducers: Array<{ name: string; version: string }> = [];
    for (let producerIndex = 0; producerIndex < producerCount; producerIndex += 1) {
      const name = reader.string();
      const version = reader.string();
      fieldProducers.push({ name, version });
      producers.push({
        order: producers.length,
        field,
        category: producerCategory(field, name),
        name,
        version,
        values: { name, version },
      });
    }
    fields.push({ name: field, producers: fieldProducers });
  }
  if (!reader.done) throw new WasmValidationError('Trailing bytes in producers section');
  return { fields, producers };
}

export function analyzeWasmProvenance(file: string): WasmProvenanceReport {
  const sections = loadSections(file);
  const customSections = sections.filter((section) => section.id === 0);
  const warnings: string[] = [];
  const rawProducerMetadata: WasmProvenanceReport['rawProducerMetadata'] = [];
  const producers: WasmProducerInfo[] = [];
  let malformedCount = 0;
  let incompleteRecordCount = 0;
  let malformedCustomSectionCount = 0;
  let foundProducerSection = false;
  const customSectionNames: string[] = [];

  customSections.forEach((section) => {
    const reader = new Reader(section.payload);
    let name: string;
    try {
      name = reader.string();
      customSectionNames.push(name);
    } catch (error) {
      malformedCustomSectionCount += 1;
      warnings.push(
        `Custom section ${section.order} has an invalid name: ${(error as Error).message}`,
      );
      return;
    }
    if (name !== 'producers') return;
    foundProducerSection = true;
    const raw = {
      sectionOrder: section.order,
      payloadBase64: section.payload.toString('base64'),
      fields: null as WasmProvenanceReport['rawProducerMetadata'][number]['fields'],
    };
    try {
      const parsed = parseProducerSection(section);
      raw.fields = parsed.fields;
      incompleteRecordCount += parsed.producers.filter(
        (producer) => !producer.name || !producer.version,
      ).length;
      producers.push(
        ...parsed.producers.map((producer) => ({
          ...producer,
          order: producers.length + producer.order,
        })),
      );
      if (parsed.producers.length === 0) {
        warnings.push(`Producer section ${section.order} contains no producer records`);
      }
      if (parsed.producers.some((producer) => !producer.name || !producer.version)) {
        warnings.push(
          `Producer section ${section.order} contains records with an empty name or version`,
        );
      }
      rawProducerMetadata.push(raw);
    } catch (error) {
      malformedCount += 1;
      rawProducerMetadata.push({
        ...raw,
        error: error instanceof Error ? error.message : String(error),
      });
      warnings.push(
        `Producer section ${section.order} is malformed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  const importSection = sections.find((section) => section.id === 2);
  const functionSection = sections.find((section) => section.id === 3);
  const exportSection = sections.find((section) => section.id === 7);
  const codeSection = sections.find((section) => section.id === 10);
  const importReader = importSection ? new Reader(importSection.payload) : null;
  const exportReader = exportSection ? new Reader(exportSection.payload) : null;
  const functionReader = functionSection ? new Reader(functionSection.payload) : null;
  const validProducerSections = rawProducerMetadata.filter((metadata) => metadata.fields !== null);
  const status: WasmProvenanceReport['provenanceStatus'] = !foundProducerSection
    ? malformedCustomSectionCount > 0
      ? 'partial'
      : 'absent'
    : malformedCount > 0
      ? validProducerSections.length > 0
        ? 'partial'
        : 'malformed'
      : producers.length === 0 || incompleteRecordCount > 0
        ? 'partial'
        : 'available';
  if (!foundProducerSection) warnings.push('No standard producers custom section was found');
  if (malformedCustomSectionCount > 0) {
    warnings.push('One or more custom section names could not be decoded');
  }
  if (malformedCount > 0 && validProducerSections.length > 0) {
    warnings.push('Some producer metadata was parsed, but one or more producer sections were malformed');
  }

  const normalized = producers.map(({ field, category, name, version }) => ({
    field,
    category,
    name,
    version,
  }));
  const normalizedSections = rawProducerMetadata.flatMap((metadata) =>
    metadata.fields === null
      ? []
      : [{ sectionOrder: metadata.sectionOrder, fields: metadata.fields }],
  );
  return {
    file,
    valid: true,
    provenanceStatus: status,
    producers,
    rawProducerMetadata,
    warnings,
    module: {
      wasmVersion: 1,
      functionCount: importedFunctionCount(importSection) + (functionReader?.varuint32() ?? 0),
      importCount: importReader?.varuint32() ?? 0,
      exportCount: exportReader?.varuint32() ?? 0,
      codeSize: codeSection?.payload.length ?? 0,
      customSections: {
        present: customSections.length > 0,
        count: customSections.length,
        names: customSectionNames,
      },
    },
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ producers: normalized, sections: normalizedSections }))
      .digest('hex'),
  };
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

const nameSubsectionNames: Record<number, string> = {
  0: 'module',
  1: 'function',
  2: 'local',
  3: 'label',
  4: 'type',
  5: 'table',
  6: 'memory',
  7: 'global',
  8: 'element',
  9: 'data',
  10: 'field',
  11: 'tag',
};

function readNameMap(reader: Reader): Map<number, string> {
  const names = new Map<number, string>();
  const count = reader.varuint32();
  for (let i = 0; i < count; i += 1) names.set(reader.varuint32(), reader.string());
  return names;
}

function parseNameSection(
  section: Section,
  functionNames: Map<number, string>,
  localNames: Map<number, Map<number, string>>,
  subsections: Array<{ id: number; name: string }>,
  warnings: string[],
): void {
  try {
    const reader = new Reader(section.payload);
    if (reader.string() !== 'name') return;
    while (!reader.done) {
      const id = reader.byte();
      const subsection = new Reader(reader.bytes(reader.varuint32()));
      subsections.push({ id, name: nameSubsectionNames[id] ?? 'unknown' });
      try {
        if (id === 1) {
          readNameMap(subsection).forEach((name, index) => functionNames.set(index, name));
        } else if (id === 2) {
          const functionCount = subsection.varuint32();
          for (let i = 0; i < functionCount; i += 1) {
            const functionIndex = subsection.varuint32();
            const names = readNameMap(subsection);
            const current = localNames.get(functionIndex) ?? new Map<number, string>();
            names.forEach((name, index) => current.set(index, name));
            localNames.set(functionIndex, current);
          }
        }
        if ((id === 1 || id === 2) && !subsection.done) {
          warnings.push(`Name subsection ${id} contains trailing bytes`);
        }
      } catch (error) {
        warnings.push(
          `Unable to parse name subsection ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    warnings.push(
      `Unable to parse name custom section: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function functionLayout(sections: Section[]): {
  importedFunctionCount: number;
  definedTypeIndexes: number[];
  parameterCounts: number[] | null;
  declaredLocalCounts: number[] | null;
} {
  const importSection = sections.find((section) => section.id === 2);
  const importedTypeIndexes: number[] = [];
  if (importSection) {
    const reader = new Reader(importSection.payload);
    const count = reader.varuint32();
    for (let i = 0; i < count; i += 1) {
      reader.string();
      reader.string();
      const kind = reader.byte();
      if (kind === 0) importedTypeIndexes.push(reader.varuint32());
      else if (kind === 1) {
        reader.byte();
        parseLimits(reader);
      } else if (kind === 2) parseLimits(reader);
      else if (kind === 3) {
        reader.byte();
        reader.byte();
      } else if (kind === 4) {
        reader.byte();
        reader.varuint32();
      } else throw new WasmValidationError(`Unsupported import kind: ${kind}`);
    }
  }

  const functionSection = sections.find((section) => section.id === 3);
  const definedTypeIndexes: number[] = [];
  if (functionSection) {
    const reader = new Reader(functionSection.payload);
    const count = reader.varuint32();
    for (let i = 0; i < count; i += 1) definedTypeIndexes.push(reader.varuint32());
  }

  let parameterCounts: number[] | null = null;
  const typeSection = sections.find((section) => section.id === 1);
  if (typeSection) {
    const reader = new Reader(typeSection.payload);
    const count = reader.varuint32();
    parameterCounts = [];
    for (let i = 0; i < count; i += 1) {
      if (reader.byte() !== 0x60) throw new WasmValidationError('Unsupported function type form');
      const parameterCount = reader.varuint32();
      reader.bytes(parameterCount);
      const resultCount = reader.varuint32();
      reader.bytes(resultCount);
      parameterCounts.push(parameterCount);
    }
  }

  let declaredLocalCounts: number[] | null = null;
  const codeSection = sections.find((section) => section.id === 10);
  if (codeSection) {
    const reader = new Reader(codeSection.payload);
    const count = reader.varuint32();
    declaredLocalCounts = [];
    for (let i = 0; i < count; i += 1) {
      const body = new Reader(reader.bytes(reader.varuint32()));
      const groupCount = body.varuint32();
      let localCount = 0;
      for (let group = 0; group < groupCount; group += 1) {
        localCount += body.varuint32();
        body.byte();
      }
      declaredLocalCounts.push(localCount);
    }
  }

  return {
    importedFunctionCount: importedTypeIndexes.length,
    definedTypeIndexes,
    parameterCounts,
    declaredLocalCounts,
  };
}

function nameEntry(index: number, name: string | undefined): WasmNameEntry {
  return {
    index,
    name: name ?? null,
    status: name === undefined ? 'unmapped' : name.length === 0 ? 'explicitly-unnamed' : 'named',
  };
}

export function analyzeWasmNames(file: string): WasmNameReport {
  const sections = loadSections(file);
  const nameSections = sections.filter(
    (section) =>
      section.id === 0 &&
      (() => {
        try {
          return new Reader(section.payload).string() === 'name';
        } catch {
          return false;
        }
      })(),
  );
  const functionNames = new Map<number, string>();
  const localNames = new Map<number, Map<number, string>>();
  const subsections: Array<{ id: number; name: string }> = [];
  const warnings: string[] = [];
  nameSections.forEach((section) =>
    parseNameSection(section, functionNames, localNames, subsections, warnings),
  );

  const layout = functionLayout(sections);
  const functionCount = layout.importedFunctionCount + layout.definedTypeIndexes.length;
  const functions = Array.from({ length: functionCount }, (_, functionIndex) => {
    const defined = functionIndex >= layout.importedFunctionCount;
    const definitionIndex = functionIndex - layout.importedFunctionCount;
    const typeIndex = layout.definedTypeIndexes[definitionIndex];
    const parameterCount =
      typeIndex === undefined ? undefined : layout.parameterCounts?.[typeIndex];
    const declaredLocalCount = layout.declaredLocalCounts?.[definitionIndex];
    const expectedLocalCount =
      defined && parameterCount !== undefined && declaredLocalCount !== undefined
        ? parameterCount + declaredLocalCount
        : null;
    const mappedLocals = localNames.get(functionIndex) ?? new Map<number, string>();
    const locals = [...mappedLocals.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, name]) => nameEntry(index, name));
    const name = functionNames.get(functionIndex);
    const mappedLocalIndexes = [...mappedLocals.keys()]
      .filter((index) => expectedLocalCount !== null && index < expectedLocalCount)
      .sort((a, b) => a - b);
    const unnamedLocalRanges: Array<{ startIndex: number; endIndex: number }> = [];
    if (expectedLocalCount !== null) {
      let nextIndex = 0;
      for (const index of mappedLocalIndexes) {
        if (index > nextIndex) {
          unnamedLocalRanges.push({ startIndex: nextIndex, endIndex: index - 1 });
        }
        nextIndex = index + 1;
      }
      if (nextIndex < expectedLocalCount) {
        unnamedLocalRanges.push({ startIndex: nextIndex, endIndex: expectedLocalCount - 1 });
      }
    }
    const namedLocalCount = [...mappedLocals.values()].filter(
      (localName) => localName.length > 0,
    ).length;
    return {
      ...nameEntry(functionIndex, name),
      functionIndex,
      defined,
      locals,
      unnamedLocalRanges,
      localNameMetadataPresent: localNames.has(functionIndex),
      expectedLocalCount,
      namedLocalCount,
      unnamedLocalCount:
        expectedLocalCount === null ? null : Math.max(0, expectedLocalCount - namedLocalCount),
    };
  });

  const namedFunctions = functions.filter((fn) => fn.status === 'named');
  const localMetadataFunctions = functions.filter((fn) => fn.localNameMetadataPresent);
  const localNameCounts = functions
    .filter((fn) => fn.namedLocalCount > 0)
    .sort((a, b) => b.namedLocalCount - a.namedLocalCount || a.functionIndex - b.functionIndex)
    .slice(0, 5)
    .map(({ functionIndex, name, namedLocalCount }) => ({
      functionIndex,
      name,
      count: namedLocalCount,
    }));
  const functionsWithIncompleteLocalNames = functions
    .filter(
      (fn) =>
        nameSections.length > 0 &&
        fn.defined &&
        fn.status === 'named' &&
        fn.expectedLocalCount !== null &&
        fn.namedLocalCount < fn.expectedLocalCount,
    )
    .map((fn) => fn.functionIndex);

  return {
    file,
    valid: true,
    nameSection: {
      present: nameSections.length > 0,
      count: nameSections.length,
      subsections,
    },
    functions,
    functionsWithIncompleteLocalNames,
    statistics: {
      totalFunctionCount: functionCount,
      totalNamedFunctions: namedFunctions.length,
      totalUnnamedFunctions: functionCount - namedFunctions.length,
      totalFunctionsWithLocalNameMetadata: localMetadataFunctions.length,
      totalNamedLocals: functions.reduce((sum, fn) => sum + fn.namedLocalCount, 0),
      functionsWithMostNamedLocals: localNameCounts,
    },
    warnings,
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

// ---------------------------------------------------------------------------
// Floating-point operation analysis
// ---------------------------------------------------------------------------

/** Broad classification of a floating-point instruction. */
export type FloatOpCategory =
  | 'arithmetic'
  | 'comparison'
  | 'conversion'
  | 'rounding'
  | 'minmax'
  | 'absolute_sign'
  | 'reinterpretation'
  | 'constant';

/** The precision of a floating-point instruction. */
export type FloatPrecision = 'f32' | 'f64';

/** One normalized floating-point instruction record. */
export interface FloatOpRecord {
  /** Index of the function (including imported functions). */
  functionIndex: number;
  /** Sequential index of the basic block within the function (0-based). */
  blockIndex: number;
  /** Sequential position of this instruction within the function body (0-based). */
  instructionIndex: number;
  /** WebAssembly opcode name, e.g. "f32.add". */
  opcode: string;
  /** Operand / result value type. */
  valueType: FloatPrecision;
  /** Broad operation category. */
  category: FloatOpCategory;
}

/** Per-function floating-point usage summary. */
export interface FloatFunctionSummary {
  functionIndex: number;
  totalFloatOps: number;
  f32Count: number;
  f64Count: number;
  categoryCounts: Record<FloatOpCategory, number>;
  hasArithmetic: boolean;
  hasComparison: boolean;
  hasConversion: boolean;
  hasReinterpretation: boolean;
  hasMixedPrecision: boolean;
  /** True when this function both converts ints→float AND float→ints. */
  hasIntFloatIntRoundtrip: boolean;
  /** Density = totalFloatOps / totalInstructions, or 0 for empty bodies. */
  floatDensity: number;
}

/** A common two-instruction sequence detected in a function body. */
export interface FloatSequence {
  functionIndex: number;
  instructionIndex: number;
  opcodes: [string, string];
}

/** Module-level floating-point analysis report. */
export interface WasmFloatOpsReport {
  file: string;
  valid: true;
  records: FloatOpRecord[];
  functions: FloatFunctionSummary[];
  sequences: FloatSequence[];
  statistics: {
    totalFloatInstructions: number;
    totalF32Instructions: number;
    totalF64Instructions: number;
    arithmeticCount: number;
    comparisonCount: number;
    conversionCount: number;
    roundingCount: number;
    reinterpretationCount: number;
    minmaxCount: number;
    absoluteSignCount: number;
    constantCount: number;
    functionsUsingFloat: number;
    highestDensityFunction: { functionIndex: number; floatDensity: number } | null;
    floatConcentrated: boolean;
  };
}

// ---------------------------------------------------------------------------
// Complete floating-point opcode table (WebAssembly MVP + bulk-memory is not
// needed here; only f32/f64 instructions).
// ---------------------------------------------------------------------------

interface FloatOpcodeInfo {
  opcode: string;
  valueType: FloatPrecision;
  category: FloatOpCategory;
}

const FLOAT_OPCODES: Record<number, FloatOpcodeInfo> = {
  // f32 load / store are not float ops, skip
  // --- f32 constants ---
  0x43: { opcode: 'f32.const', valueType: 'f32', category: 'constant' },
  // --- f64 constants ---
  0x44: { opcode: 'f64.const', valueType: 'f64', category: 'constant' },
  // --- f32 comparisons ---
  0x5b: { opcode: 'f32.eq', valueType: 'f32', category: 'comparison' },
  0x5c: { opcode: 'f32.ne', valueType: 'f32', category: 'comparison' },
  0x5d: { opcode: 'f32.lt', valueType: 'f32', category: 'comparison' },
  0x5e: { opcode: 'f32.gt', valueType: 'f32', category: 'comparison' },
  0x5f: { opcode: 'f32.le', valueType: 'f32', category: 'comparison' },
  0x60: { opcode: 'f32.ge', valueType: 'f32', category: 'comparison' },
  // --- f64 comparisons ---
  0x61: { opcode: 'f64.eq', valueType: 'f64', category: 'comparison' },
  0x62: { opcode: 'f64.ne', valueType: 'f64', category: 'comparison' },
  0x63: { opcode: 'f64.lt', valueType: 'f64', category: 'comparison' },
  0x64: { opcode: 'f64.gt', valueType: 'f64', category: 'comparison' },
  0x65: { opcode: 'f64.le', valueType: 'f64', category: 'comparison' },
  0x66: { opcode: 'f64.ge', valueType: 'f64', category: 'comparison' },
  // --- f32 arithmetic ---
  0x92: { opcode: 'f32.add', valueType: 'f32', category: 'arithmetic' },
  0x93: { opcode: 'f32.sub', valueType: 'f32', category: 'arithmetic' },
  0x94: { opcode: 'f32.mul', valueType: 'f32', category: 'arithmetic' },
  0x95: { opcode: 'f32.div', valueType: 'f32', category: 'arithmetic' },
  // --- f32 min/max ---
  0x96: { opcode: 'f32.min', valueType: 'f32', category: 'minmax' },
  0x97: { opcode: 'f32.max', valueType: 'f32', category: 'minmax' },
  // --- f32 absolute / sign ---
  0x8b: { opcode: 'f32.abs', valueType: 'f32', category: 'absolute_sign' },
  0x8c: { opcode: 'f32.neg', valueType: 'f32', category: 'absolute_sign' },
  0x98: { opcode: 'f32.copysign', valueType: 'f32', category: 'absolute_sign' },
  // --- f32 rounding ---
  0x8d: { opcode: 'f32.ceil', valueType: 'f32', category: 'rounding' },
  0x8e: { opcode: 'f32.floor', valueType: 'f32', category: 'rounding' },
  0x8f: { opcode: 'f32.trunc', valueType: 'f32', category: 'rounding' },
  0x90: { opcode: 'f32.nearest', valueType: 'f32', category: 'rounding' },
  // --- f32 sqrt (arithmetic) ---
  0x91: { opcode: 'f32.sqrt', valueType: 'f32', category: 'arithmetic' },
  // --- f64 arithmetic ---
  0xa0: { opcode: 'f64.add', valueType: 'f64', category: 'arithmetic' },
  0xa1: { opcode: 'f64.sub', valueType: 'f64', category: 'arithmetic' },
  0xa2: { opcode: 'f64.mul', valueType: 'f64', category: 'arithmetic' },
  0xa3: { opcode: 'f64.div', valueType: 'f64', category: 'arithmetic' },
  // --- f64 min/max ---
  0xa4: { opcode: 'f64.min', valueType: 'f64', category: 'minmax' },
  0xa5: { opcode: 'f64.max', valueType: 'f64', category: 'minmax' },
  // --- f64 absolute / sign ---
  0x99: { opcode: 'f64.abs', valueType: 'f64', category: 'absolute_sign' },
  0x9a: { opcode: 'f64.neg', valueType: 'f64', category: 'absolute_sign' },
  0xa6: { opcode: 'f64.copysign', valueType: 'f64', category: 'absolute_sign' },
  // --- f64 rounding ---
  0x9b: { opcode: 'f64.ceil', valueType: 'f64', category: 'rounding' },
  0x9c: { opcode: 'f64.floor', valueType: 'f64', category: 'rounding' },
  0x9d: { opcode: 'f64.trunc', valueType: 'f64', category: 'rounding' },
  0x9e: { opcode: 'f64.nearest', valueType: 'f64', category: 'rounding' },
  // --- f64 sqrt (arithmetic) ---
  0x9f: { opcode: 'f64.sqrt', valueType: 'f64', category: 'arithmetic' },
  // --- int→float conversions ---
  0xb2: { opcode: 'f32.convert_i32_s', valueType: 'f32', category: 'conversion' },
  0xb3: { opcode: 'f32.convert_i32_u', valueType: 'f32', category: 'conversion' },
  0xb4: { opcode: 'f32.convert_i64_s', valueType: 'f32', category: 'conversion' },
  0xb5: { opcode: 'f32.convert_i64_u', valueType: 'f32', category: 'conversion' },
  0xb7: { opcode: 'f64.convert_i32_s', valueType: 'f64', category: 'conversion' },
  0xb8: { opcode: 'f64.convert_i32_u', valueType: 'f64', category: 'conversion' },
  0xb9: { opcode: 'f64.convert_i64_s', valueType: 'f64', category: 'conversion' },
  0xba: { opcode: 'f64.convert_i64_u', valueType: 'f64', category: 'conversion' },
  // --- float→int conversions (truncation) ---
  0xa8: { opcode: 'i32.trunc_f32_s', valueType: 'f32', category: 'conversion' },
  0xa9: { opcode: 'i32.trunc_f32_u', valueType: 'f32', category: 'conversion' },
  0xaa: { opcode: 'i32.trunc_f64_s', valueType: 'f64', category: 'conversion' },
  0xab: { opcode: 'i32.trunc_f64_u', valueType: 'f64', category: 'conversion' },
  0xae: { opcode: 'i64.trunc_f32_s', valueType: 'f32', category: 'conversion' },
  0xaf: { opcode: 'i64.trunc_f32_u', valueType: 'f32', category: 'conversion' },
  0xb0: { opcode: 'i64.trunc_f64_s', valueType: 'f64', category: 'conversion' },
  0xb1: { opcode: 'i64.trunc_f64_u', valueType: 'f64', category: 'conversion' },
  // --- f32↔f64 promotion / demotion ---
  0xb6: { opcode: 'f32.demote_f64', valueType: 'f32', category: 'conversion' },
  0xbb: { opcode: 'f64.promote_f32', valueType: 'f64', category: 'conversion' },
  // --- bit reinterpretation ---
  0xbc: { opcode: 'i32.reinterpret_f32', valueType: 'f32', category: 'reinterpretation' },
  0xbd: { opcode: 'i64.reinterpret_f64', valueType: 'f64', category: 'reinterpretation' },
  0xbe: { opcode: 'f32.reinterpret_i32', valueType: 'f32', category: 'reinterpretation' },
  0xbf: { opcode: 'f64.reinterpret_i64', valueType: 'f64', category: 'reinterpretation' },
};

/** Opcodes that produce or consume float values (used for int-to-float conversion detection). */
const INT_TO_FLOAT_OPCODES = new Set([
  0xb2, 0xb3, 0xb4, 0xb5, 0xb7, 0xb8, 0xb9, 0xba,
]);

/** Opcodes that produce or consume float values for float-to-int conversion detection. */
const FLOAT_TO_INT_OPCODES = new Set([
  0xa8, 0xa9, 0xaa, 0xab, 0xae, 0xaf, 0xb0, 0xb1,
]);

function zeroCategoryCounts(): Record<FloatOpCategory, number> {
  return {
    arithmetic: 0,
    comparison: 0,
    conversion: 0,
    rounding: 0,
    minmax: 0,
    absolute_sign: 0,
    reinterpretation: 0,
    constant: 0,
  };
}

function addFloatCategoryCount(
  target: Record<FloatOpCategory, number>,
  category: FloatOpCategory,
): void {
  target[category] = (target[category] ?? 0) + 1;
}

function parseFloatOpsFromCode(
  section: Section | undefined,
  importedFunctions: number,
): {
  records: FloatOpRecord[];
  functionSummaries: FloatFunctionSummary[];
  sequences: FloatSequence[];
} {
  const records: FloatOpRecord[] = [];
  const functionSummaries: FloatFunctionSummary[] = [];
  const sequences: FloatSequence[] = [];

  if (!section) return { records, functionSummaries, sequences };

  const reader = new Reader(section.payload);
  const count = reader.varuint32();

  for (let fi = 0; fi < count; fi += 1) {
    const bodySize = reader.varuint32();
    const body = new Reader(reader.bytes(bodySize));

    // Skip local declarations
    const localGroupCount = body.varuint32();
    for (let j = 0; j < localGroupCount; j += 1) {
      body.varuint32();
      body.byte();
    }

    const functionIndex = importedFunctions + fi;
    const funcRecords: FloatOpRecord[] = [];
    const categoryCounts = zeroCategoryCounts();
    let instructionIndex = 0;
    let blockIndex = 0;
    let f32Count = 0;
    let f64Count = 0;
    let hasIntToFloat = false;
    let hasFloatToInt = false;
    let prevOpcode: number | null = null;
    let totalInstructions = 0;

    while (!body.done) {
      const opcode = body.byte();
      totalInstructions += 1;

      // Track block depth changes
      if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) {
        blockIndex += 1;
      } else if (opcode === 0x0b || opcode === 0x05) {
        // end / else — keep block index stable (we don't track exact nesting)
      }

      const floatInfo = FLOAT_OPCODES[opcode];
      if (floatInfo) {
        const record: FloatOpRecord = {
          functionIndex,
          blockIndex,
          instructionIndex,
          opcode: floatInfo.opcode,
          valueType: floatInfo.valueType,
          category: floatInfo.category,
        };
        funcRecords.push(record);
        addFloatCategoryCount(categoryCounts, floatInfo.category);
        if (floatInfo.valueType === 'f32') f32Count += 1;
        else f64Count += 1;

        if (INT_TO_FLOAT_OPCODES.has(opcode)) hasIntToFloat = true;
        if (FLOAT_TO_INT_OPCODES.has(opcode)) hasFloatToInt = true;

        // Detect common two-instruction sequences
        if (prevOpcode !== null && FLOAT_OPCODES[prevOpcode]) {
          sequences.push({
            functionIndex,
            instructionIndex: instructionIndex - 1,
            opcodes: [FLOAT_OPCODES[prevOpcode].opcode, floatInfo.opcode],
          });
        }
      }

      prevOpcode = opcode;
      instructionIndex += 1;

      // Skip immediates (reuse existing logic)
      skipInstructionImmediate(opcode, body);
    }

    records.push(...funcRecords);

    const totalFloatOps = funcRecords.length;
    const floatDensity = totalInstructions === 0 ? 0 : totalFloatOps / totalInstructions;

    functionSummaries.push({
      functionIndex,
      totalFloatOps,
      f32Count,
      f64Count,
      categoryCounts,
      hasArithmetic: categoryCounts.arithmetic > 0,
      hasComparison: categoryCounts.comparison > 0,
      hasConversion: categoryCounts.conversion > 0,
      hasReinterpretation: categoryCounts.reinterpretation > 0,
      hasMixedPrecision: f32Count > 0 && f64Count > 0,
      hasIntFloatIntRoundtrip: hasIntToFloat && hasFloatToInt,
      floatDensity,
    });
  }

  return { records, functionSummaries, sequences };
}

export function analyzeFloatOps(file: string): WasmFloatOpsReport {
  const sections = loadSections(file);
  const importSection = sections.find((s) => s.id === 2);
  const codeSection = sections.find((s) => s.id === 10);
  const importedCount = importedFunctionCount(importSection);

  const { records, functionSummaries, sequences } = parseFloatOpsFromCode(
    codeSection,
    importedCount,
  );

  // Module-level aggregates
  let totalF32 = 0;
  let totalF64 = 0;
  const categorySums = zeroCategoryCounts();
  records.forEach((r) => {
    if (r.valueType === 'f32') totalF32 += 1;
    else totalF64 += 1;
    addFloatCategoryCount(categorySums, r.category);
  });

  const floatFunctions = functionSummaries.filter((f) => f.totalFloatOps > 0);
  const highestDensity =
    floatFunctions.length === 0
      ? null
      : floatFunctions.reduce((a, b) => (b.floatDensity > a.floatDensity ? b : a));

  // Concentration: float usage is "concentrated" when >= 80% of all float
  // ops come from <= 20% of functions (or a single function when only 1 has
  // float ops and the module has > 1 function).
  let floatConcentrated = false;
  if (floatFunctions.length > 0 && functionSummaries.length > 0) {
    const totalOps = records.length;
    const threshold = Math.max(1, Math.ceil(floatFunctions.length * 0.2));
    const topFns = [...floatFunctions]
      .sort((a, b) => b.totalFloatOps - a.totalFloatOps)
      .slice(0, threshold);
    const topOps = topFns.reduce((sum, f) => sum + f.totalFloatOps, 0);
    floatConcentrated = totalOps > 0 && topOps / totalOps >= 0.8;
  }

  return {
    file,
    valid: true,
    records,
    functions: functionSummaries,
    sequences,
    statistics: {
      totalFloatInstructions: records.length,
      totalF32Instructions: totalF32,
      totalF64Instructions: totalF64,
      arithmeticCount: categorySums.arithmetic,
      comparisonCount: categorySums.comparison,
      conversionCount: categorySums.conversion,
      roundingCount: categorySums.rounding,
      reinterpretationCount: categorySums.reinterpretation,
      minmaxCount: categorySums.minmax,
      absoluteSignCount: categorySums.absolute_sign,
      constantCount: categorySums.constant,
      functionsUsingFloat: floatFunctions.length,
      highestDensityFunction: highestDensity
        ? {
            functionIndex: highestDensity.functionIndex,
            floatDensity: highestDensity.floatDensity,
          }
        : null,
      floatConcentrated,
    },
  };
}

export function compareFloatOpsReports(
  beforeFile: string,
  afterFile: string,
): {
  before: WasmFloatOpsReport;
  after: WasmFloatOpsReport;
  comparison: {
    addedOpcodes: string[];
    removedOpcodes: string[];
    changedCategories: Array<{ opcode: string; before: FloatOpCategory; after: FloatOpCategory }>;
    newF32Usage: boolean;
    newF64Usage: boolean;
    newlyFloatFunctions: number[];
    removedFloatFunctions: number[];
    totalFloatDelta: number;
    f32Delta: number;
    f64Delta: number;
  };
} {
  const before = analyzeFloatOps(beforeFile);
  const after = analyzeFloatOps(afterFile);

  const beforeOpcodeSet = new Set(before.records.map((r) => r.opcode));
  const afterOpcodeSet = new Set(after.records.map((r) => r.opcode));

  const addedOpcodes = [...afterOpcodeSet].filter((o) => !beforeOpcodeSet.has(o)).sort();
  const removedOpcodes = [...beforeOpcodeSet].filter((o) => !afterOpcodeSet.has(o)).sort();

  // Detect category changes for opcodes that appear in both
  const changedCategories: Array<{
    opcode: string;
    before: FloatOpCategory;
    after: FloatOpCategory;
  }> = [];
  const beforeCatMap = new Map(before.records.map((r) => [r.opcode, r.category]));
  const afterCatMap = new Map(after.records.map((r) => [r.opcode, r.category]));
  afterCatMap.forEach((cat, opcode) => {
    const bCat = beforeCatMap.get(opcode);
    if (bCat && bCat !== cat) {
      changedCategories.push({ opcode, before: bCat, after: cat });
    }
  });

  const beforeFloatFnSet = new Set(
    before.functions.filter((f) => f.totalFloatOps > 0).map((f) => f.functionIndex),
  );
  const afterFloatFnSet = new Set(
    after.functions.filter((f) => f.totalFloatOps > 0).map((f) => f.functionIndex),
  );

  const newlyFloatFunctions = [...afterFloatFnSet]
    .filter((idx) => !beforeFloatFnSet.has(idx))
    .sort((a, b) => a - b);
  const removedFloatFunctions = [...beforeFloatFnSet]
    .filter((idx) => !afterFloatFnSet.has(idx))
    .sort((a, b) => a - b);

  return {
    before,
    after,
    comparison: {
      addedOpcodes,
      removedOpcodes,
      changedCategories,
      newF32Usage: before.statistics.totalF32Instructions === 0 && after.statistics.totalF32Instructions > 0,
      newF64Usage: before.statistics.totalF64Instructions === 0 && after.statistics.totalF64Instructions > 0,
      newlyFloatFunctions,
      removedFloatFunctions,
      totalFloatDelta:
        after.statistics.totalFloatInstructions - before.statistics.totalFloatInstructions,
      f32Delta: after.statistics.totalF32Instructions - before.statistics.totalF32Instructions,
      f64Delta: after.statistics.totalF64Instructions - before.statistics.totalF64Instructions,
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

// =============================================================================
// WASM Recursion & Call-Cycle Analysis
// =============================================================================

/** A single statically-resolved call relationship. */
export interface WasmCallEdge {
  /** Index of the calling function. */
  callerIndex: number;
  /** Index of the called function. */
  calleeIndex: number;
  /** Byte offset of the call instruction inside the function body. */
  instructionOffset: number;
  /** 'direct' for `call`, 'indirect' for `call_indirect`. */
  callType: 'direct' | 'indirect';
}

/** A conservatively resolved indirect call: one candidate edge per table slot. */
export interface WasmIndirectCallCandidate {
  callerIndex: number;
  /** Table index used by the call_indirect instruction. */
  tableIndex: number;
  /** Type index specified by call_indirect. */
  typeIndex: number;
  instructionOffset: number;
  /** Resolved callee candidates from the element section (may be empty). */
  candidateCallees: number[];
}

/** Classification of a strongly connected component. */
export type WasmSccKind =
  | 'direct_self_recursion'       // single node with self-edge
  | 'mutual_recursion_two'        // exactly 2 nodes forming a cycle
  | 'multi_function_cycle'        // 3+ nodes
  | 'non_recursive';              // SCC of size 1 with no self-edge

export interface WasmScc {
  /** Stable numeric ID, assigned in reverse topological order (SCC 0 = sink-most). */
  id: number;
  kind: WasmSccKind;
  members: number[];
  /** Intra-SCC direct call edges only. */
  internalEdges: WasmCallEdge[];
  /** Shortest cycle length (in number of edges) within this SCC; 1 = self-loop. */
  shortestCycleLength: number | null;
  /** Whether this SCC participates in any indirect-call candidate cycle. */
  hasIndirectCycle: boolean;
  /**
   * Simple cycles enumerated by Johnson's algorithm up to the configured maximum.
   * Only populated when maxCycles > 0.
   */
  enumeratedCycles: number[][];
}

export interface WasmRecursionStatistics {
  totalFunctions: number;
  totalCallEdges: number;
  totalDirectCallEdges: number;
  totalIndirectCallSites: number;
  totalUnresolvedIndirectCalls: number;
  recursiveFunctionCount: number;
  recursiveComponentCount: number;
  largestRecursiveComponentSize: number;
  directSelfRecursiveFunctionCount: number;
  mutualRecursionComponentCount: number;
  maxCycleSize: number;
  averageRecursiveComponentSize: number;
  /** Minimum shortestCycleLength across all recursive SCCs. */
  minimumCycleLength: number | null;
}

export interface WasmRecursionReport {
  file: string;
  valid: true;
  /** All direct call edges (excluding indirect). */
  callEdges: WasmCallEdge[];
  /** All indirect call sites with conservative candidate resolution. */
  indirectCallCandidates: WasmIndirectCallCandidate[];
  /** All SCCs, including non-recursive ones. */
  sccs: WasmScc[];
  /** Only the recursive SCCs. */
  recursiveSccs: WasmScc[];
  /** Functions that appear in at least one recursive SCC. */
  recursiveFunctions: number[];
  /** Functions sorted by the count of recursive edges they participate in (descending). */
  mostConnectedRecursiveFunctions: Array<{ functionIndex: number; edgeCount: number }>;
  statistics: WasmRecursionStatistics;
}

// ---------------------------------------------------------------------------
// Internal binary helpers (self-contained re-implementations to avoid
// coupling to the internal Reader class above).
// ---------------------------------------------------------------------------

class RecReader {
  pos = 0;
  constructor(private readonly buf: Buffer) {}
  get done(): boolean { return this.pos >= this.buf.length; }
  byte(): number {
    if (this.pos >= this.buf.length) throw new WasmValidationError('Unexpected end of data');
    return this.buf[this.pos++];
  }
  bytes(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new WasmValidationError('Section length exceeds data');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  u32(): number {
    let result = 0; let shift = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.byte();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
    throw new WasmValidationError('Malformed LEB128');
  }
  i32(): number {
    let result = 0; let shift = 0; let b = 0;
    do { b = this.byte(); result |= (b & 0x7f) << shift; shift += 7; }
    while ((b & 0x80) !== 0 && shift < 35);
    if (shift < 32 && (b & 0x40) !== 0) result |= ~0 << shift;
    return result;
  }
  i64Bytes(): void { let b: number; do { b = this.byte(); } while ((b & 0x80) !== 0); }
  str(): string { return this.bytes(this.u32()).toString('utf8'); }
}

interface RecSection { id: number; payload: Buffer }

function recParseSections(wasm: Buffer): RecSection[] {
  if (wasm.length < 8) throw new WasmValidationError('WASM binary too short');
  if (wasm[0] !== 0x00 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d)
    throw new WasmValidationError('Missing WASM magic header');
  if (wasm.readUInt32LE(4) !== 1) throw new WasmValidationError('Unsupported WASM version');
  const sections: RecSection[] = [];
  const r = new RecReader(wasm.subarray(8));
  while (!r.done) {
    const id = r.byte();
    const size = r.u32();
    sections.push({ id, payload: r.bytes(size) });
  }
  return sections;
}

function recCountImportedFunctions(sec: RecSection | undefined): number {
  if (!sec) return 0;
  const r = new RecReader(sec.payload);
  const count = r.u32();
  let fns = 0;
  for (let i = 0; i < count; i++) {
    r.str(); r.str();
    const kind = r.byte();
    if (kind === 0x00) { fns++; r.u32(); }
    else if (kind === 0x01) { r.byte(); r.u32(); if (sec.payload[r.pos - 4] & 1) r.u32(); }
    else if (kind === 0x02) { r.u32(); if (sec.payload[r.pos - 1] & 1) r.u32(); }
    else if (kind === 0x03) { r.byte(); r.byte(); }
  }
  return fns;
}

/**
 * Parse element sections to build a table of function-index candidates per
 * table slot.  Returns a flat array indexed by slot number → function index
 * (only the first/active segment that writes each slot is used).
 */
function recParseElementTable(sec: RecSection | undefined): Map<number, number> {
  const tableMap = new Map<number, number>();
  if (!sec) return tableMap;
  try {
    const r = new RecReader(sec.payload);
    const count = r.u32();
    for (let i = 0; i < count; i++) {
      const flags = r.u32();
      const hasElemType = (flags & 0x01) !== 0;
      const hasTable = (flags & 0x02) !== 0;
      const isDeclarative = (flags & 0x04) !== 0;
      if (hasElemType) r.byte(); // element type
      let offset = 0;
      if (hasTable && !isDeclarative) {
        r.u32(); // table index
        // read offset init expr
        let op = r.byte();
        if (op === 0x41) { offset = r.i32(); r.byte(); /* end */ }
        else if (op === 0x42) { r.i64Bytes(); r.byte(); }
        else if (op === 0x23) { r.u32(); r.byte(); }
        else { r.byte(); /* end */ }
      } else if (!hasTable && !isDeclarative) {
        // passive — skip
      }
      const elemCount = r.u32();
      for (let j = 0; j < elemCount; j++) {
        const funcIdx = r.u32();
        const slot = offset + j;
        if (!tableMap.has(slot)) tableMap.set(slot, funcIdx);
      }
    }
  } catch {
    // element section parse failures are non-fatal; return what we have
  }
  return tableMap;
}

/** Skip an instruction's immediates without executing. */
function recSkipImmediate(op: number, r: RecReader): void {
  if ([0x02, 0x03, 0x04].includes(op)) r.byte();
  else if ([0x0c, 0x0d, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26].includes(op)) r.u32();
  else if (op === 0x0e) { const n = r.u32(); for (let i = 0; i <= n; i++) r.u32(); }
  else if (op === 0x11) { r.u32(); r.byte(); }
  else if (op >= 0x28 && op <= 0x3e) { r.u32(); r.u32(); }
  else if (op === 0x3f || op === 0x40) r.byte();
  else if (op === 0x41) r.i32();
  else if (op === 0x42) r.i64Bytes();
  else if (op === 0x43) r.bytes(4);
  else if (op === 0x44) r.bytes(8);
  else if (op === 0xfc) { r.u32(); /* bulk memory subop */ }
}

interface ParsedFunctionCalls {
  directEdges: Array<{ calleeIndex: number; offset: number }>;
  indirectSites: Array<{ typeIndex: number; tableIndex: number; offset: number }>;
}

function recParseFunctionBody(body: Buffer): ParsedFunctionCalls {
  const directEdges: Array<{ calleeIndex: number; offset: number }> = [];
  const indirectSites: Array<{ typeIndex: number; tableIndex: number; offset: number }> = [];
  try {
    const r = new RecReader(body);
    const localCount = r.u32();
    for (let i = 0; i < localCount; i++) { r.u32(); r.byte(); }
    while (!r.done) {
      const instrOffset = r.pos;
      const op = r.byte();
      if (op === 0x10) {
        const calleeIndex = r.u32();
        directEdges.push({ calleeIndex, offset: instrOffset });
      } else if (op === 0x11) {
        const typeIndex = r.u32();
        const tableIndex = r.byte();
        indirectSites.push({ typeIndex, tableIndex, offset: instrOffset });
      } else {
        recSkipImmediate(op, r);
      }
    }
  } catch {
    // truncated body — return what was parsed
  }
  return { directEdges, indirectSites };
}

// ---------------------------------------------------------------------------
// Tarjan's SCC algorithm
// ---------------------------------------------------------------------------

function tarjanScc(adjacency: Map<number, Set<number>>, nodes: number[]): number[][] {
  const index = new Map<number, number>();
  const lowlink = new Map<number, number>();
  const onStack = new Map<number, boolean>();
  const stack: number[] = [];
  const sccs: number[][] = [];
  let counter = 0;

  function strongConnect(v: number): void {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.set(v, true);

    for (const w of (adjacency.get(v) ?? new Set())) {
      if (!index.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.get(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.set(w, false);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (const node of nodes) {
    if (!index.has(node)) strongConnect(node);
  }
  return sccs;
}

/**
 * Enumerate simple cycles within a single SCC using DFS (Johnson's algorithm,
 * limited to maxCycles to avoid unbounded work on dense graphs).
 */
function enumerateCyclesInScc(
  members: number[],
  intraEdges: Map<number, Set<number>>,
  maxCycles: number,
): number[][] {
  const cycles: number[][] = [];
  if (members.length === 0) return cycles;

  const memberSet = new Set(members);
  const blocked = new Map<number, boolean>();
  const blockMap = new Map<number, Set<number>>();
  members.forEach((m) => { blocked.set(m, false); blockMap.set(m, new Set()); });

  const stack: number[] = [];
  let startNode = members[0];

  function unblock(u: number): void {
    blocked.set(u, false);
    for (const w of (blockMap.get(u) ?? new Set())) {
      blockMap.get(u)!.delete(w);
      if (blocked.get(w)) unblock(w);
    }
  }

  function circuit(v: number, start: number): boolean {
    if (cycles.length >= maxCycles) return false;
    let found = false;
    stack.push(v);
    blocked.set(v, true);

    for (const w of (intraEdges.get(v) ?? new Set())) {
      if (!memberSet.has(w)) continue;
      if (w === start) {
        cycles.push([...stack]);
        found = true;
        if (cycles.length >= maxCycles) { stack.pop(); return found; }
      } else if (!blocked.get(w)) {
        if (circuit(w, start)) found = true;
      }
    }

    if (found) {
      unblock(v);
    } else {
      for (const w of (intraEdges.get(v) ?? new Set())) {
        if (!memberSet.has(w)) continue;
        blockMap.get(w)!.add(v);
      }
    }
    stack.pop();
    return found;
  }

  for (let i = 0; i < members.length && cycles.length < maxCycles; i++) {
    startNode = members[i];
    // Reset blocked for members from startNode onward
    for (let j = i; j < members.length; j++) {
      blocked.set(members[j], false);
      blockMap.get(members[j])!.clear();
    }
    circuit(startNode, startNode);
  }

  return cycles;
}

/** Find the shortest cycle length within an SCC using BFS from each member. */
function shortestCycleInScc(
  members: number[],
  intraEdges: Map<number, Set<number>>,
): number | null {
  if (members.length === 0) return null;
  let shortest: number | null = null;

  for (const start of members) {
    // BFS
    const dist = new Map<number, number>();
    dist.set(start, 0);
    const queue = [start];
    while (queue.length > 0) {
      const u = queue.shift()!;
      for (const v of (intraEdges.get(u) ?? new Set())) {
        if (!new Set(members).has(v)) continue;
        if (v === start) {
          const len = dist.get(u)! + 1;
          if (shortest === null || len < shortest) shortest = len;
          // don't return — keep searching for even shorter
        } else if (!dist.has(v)) {
          dist.set(v, dist.get(u)! + 1);
          if (shortest === null || dist.get(v)! < shortest) queue.push(v);
        }
      }
    }
  }
  return shortest;
}

function classifyScc(
  members: number[],
  intraEdges: Map<number, Set<number>>,
): WasmSccKind {
  if (members.length === 1) {
    return (intraEdges.get(members[0])?.has(members[0]) ?? false)
      ? 'direct_self_recursion'
      : 'non_recursive';
  }
  if (members.length === 2) return 'mutual_recursion_two';
  return 'multi_function_cycle';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse call-graph recursion in a WASM binary without executing any code.
 *
 * The analysis:
 *  1. Parses the code section to extract direct `call` and `call_indirect`
 *     instruction sites for every locally-defined function.
 *  2. Resolves `call_indirect` candidates conservatively using the first
 *     active element segment; unresolved sites are recorded separately.
 *  3. Runs Tarjan's SCC algorithm on the direct-call adjacency graph.
 *  4. Classifies each SCC and calculates the shortest cycle length.
 *  5. Optionally enumerates simple cycles up to `maxCycles`.
 *
 * No WASM code is executed at any point.
 */
export function analyzeRecursion(
  file: string,
  options: { maxCycles?: number } = {},
): WasmRecursionReport {
  const maxCycles = options.maxCycles ?? 0; // 0 = no enumeration
  const wasm = (() => {
    try { return fs.readFileSync(file); }
    catch (e) { throw new WasmValidationError(`Unable to read WASM file "${file}": ${(e as Error).message}`); }
  })();

  const sections = recParseSections(wasm);
  const importedFnCount = recCountImportedFunctions(sections.find((s) => s.id === 2));
  const elementTable = recParseElementTable(sections.find((s) => s.id === 9));

  // Extract code bodies
  const codeSection = sections.find((s) => s.id === 10);
  const bodies: Buffer[] = [];
  if (codeSection) {
    const r = new RecReader(codeSection.payload);
    const count = r.u32();
    for (let i = 0; i < count; i++) {
      const size = r.u32();
      bodies.push(r.bytes(size));
    }
  }

  const totalFunctions = importedFnCount + bodies.length;
  const callEdges: WasmCallEdge[] = [];
  const indirectCallCandidates: WasmIndirectCallCandidate[] = [];

  // Build call graph
  for (let bodyIdx = 0; bodyIdx < bodies.length; bodyIdx++) {
    const callerIndex = importedFnCount + bodyIdx;
    const parsed = recParseFunctionBody(bodies[bodyIdx]);

    for (const edge of parsed.directEdges) {
      callEdges.push({
        callerIndex,
        calleeIndex: edge.calleeIndex,
        instructionOffset: edge.offset,
        callType: 'direct',
      });
    }

    for (const site of parsed.indirectSites) {
      const candidates: number[] = [];
      // Conservative resolution: collect all function indices from element table
      for (const [, fnIdx] of elementTable) {
        if (!candidates.includes(fnIdx)) candidates.push(fnIdx);
      }
      candidates.sort((a, b) => a - b);
      indirectCallCandidates.push({
        callerIndex,
        tableIndex: site.tableIndex,
        typeIndex: site.typeIndex,
        instructionOffset: site.offset,
        candidateCallees: candidates,
      });
    }
  }

  // Build adjacency map for direct calls only
  const directAdj = new Map<number, Set<number>>();
  for (let i = 0; i < totalFunctions; i++) directAdj.set(i, new Set());
  for (const edge of callEdges) {
    if (edge.callType === 'direct' && edge.calleeIndex < totalFunctions) {
      directAdj.get(edge.callerIndex)?.add(edge.calleeIndex);
    }
  }

  // All function indices (include imported for completeness; they have no body)
  const allNodes = Array.from({ length: totalFunctions }, (_, i) => i);
  const rawSccs = tarjanScc(directAdj, allNodes);

  // Build edge lookup for intra-SCC edges
  const edgesByFunction = new Map<number, WasmCallEdge[]>();
  for (const e of callEdges) {
    const list = edgesByFunction.get(e.callerIndex) ?? [];
    list.push(e);
    edgesByFunction.set(e.callerIndex, list);
  }

  // Build indirect adjacency for cycle checking
  const indirectAdj = new Map<number, Set<number>>();
  for (let i = 0; i < totalFunctions; i++) indirectAdj.set(i, new Set());
  for (const site of indirectCallCandidates) {
    for (const callee of site.candidateCallees) {
      if (callee < totalFunctions) indirectAdj.get(site.callerIndex)?.add(callee);
    }
  }

  const sccs: WasmScc[] = [];
  let sccId = 0;

  for (const rawScc of rawSccs) {
    const members = [...rawScc].sort((a, b) => a - b);
    const memberSet = new Set(members);

    // Collect intra-SCC direct edges
    const intraEdges: WasmCallEdge[] = [];
    for (const m of members) {
      for (const e of (edgesByFunction.get(m) ?? [])) {
        if (e.callType === 'direct' && memberSet.has(e.calleeIndex)) intraEdges.push(e);
      }
    }

    // Intra-SCC adjacency map
    const intraAdj = new Map<number, Set<number>>();
    for (const m of members) intraAdj.set(m, new Set());
    for (const e of intraEdges) intraAdj.get(e.callerIndex)?.add(e.calleeIndex);

    const kind = classifyScc(members, intraAdj);
    const isRecursive = kind !== 'non_recursive';
    const shortestCycleLength = isRecursive ? shortestCycleInScc(members, intraAdj) : null;

    // Enumerate simple cycles if requested and this SCC is recursive
    const enumeratedCycles: number[][] =
      isRecursive && maxCycles > 0
        ? enumerateCyclesInScc(members, intraAdj, maxCycles)
        : [];

    // Check if any indirect candidate creates a cycle within members
    let hasIndirectCycle = false;
    if (!isRecursive) {
      for (const site of indirectCallCandidates) {
        if (!memberSet.has(site.callerIndex)) continue;
        for (const callee of site.candidateCallees) {
          if (memberSet.has(callee)) { hasIndirectCycle = true; break; }
        }
        if (hasIndirectCycle) break;
      }
    }

    sccs.push({
      id: sccId++,
      kind,
      members,
      internalEdges: intraEdges,
      shortestCycleLength,
      hasIndirectCycle,
      enumeratedCycles,
    });
  }

  // Recursive SCCs
  const recursiveSccs = sccs.filter((s) => s.kind !== 'non_recursive');
  const recursiveFunctionSet = new Set<number>();
  for (const s of recursiveSccs) s.members.forEach((m) => recursiveFunctionSet.add(m));
  const recursiveFunctions = [...recursiveFunctionSet].sort((a, b) => a - b);

  // Most connected recursive functions
  const edgeCountMap = new Map<number, number>();
  for (const s of recursiveSccs) {
    for (const e of s.internalEdges) {
      edgeCountMap.set(e.callerIndex, (edgeCountMap.get(e.callerIndex) ?? 0) + 1);
      edgeCountMap.set(e.calleeIndex, (edgeCountMap.get(e.calleeIndex) ?? 0) + 1);
    }
  }
  const mostConnectedRecursiveFunctions = [...edgeCountMap.entries()]
    .map(([functionIndex, edgeCount]) => ({ functionIndex, edgeCount }))
    .sort((a, b) => b.edgeCount - a.edgeCount || a.functionIndex - b.functionIndex);

  // Statistics
  const recursiveSizes = recursiveSccs.map((s) => s.members.length);
  const totalUnresolvedIndirect = indirectCallCandidates.filter(
    (c) => c.candidateCallees.length === 0,
  ).length;
  const cycleLengths = recursiveSccs
    .map((s) => s.shortestCycleLength)
    .filter((l): l is number => l !== null);

  const statistics: WasmRecursionStatistics = {
    totalFunctions,
    totalCallEdges: callEdges.length,
    totalDirectCallEdges: callEdges.filter((e) => e.callType === 'direct').length,
    totalIndirectCallSites: indirectCallCandidates.length,
    totalUnresolvedIndirectCalls: totalUnresolvedIndirect,
    recursiveFunctionCount: recursiveFunctions.length,
    recursiveComponentCount: recursiveSccs.length,
    largestRecursiveComponentSize: recursiveSizes.length > 0 ? Math.max(...recursiveSizes) : 0,
    directSelfRecursiveFunctionCount: sccs.filter(
      (s) => s.kind === 'direct_self_recursion',
    ).length,
    mutualRecursionComponentCount: sccs.filter(
      (s) => s.kind === 'mutual_recursion_two' || s.kind === 'multi_function_cycle',
    ).length,
    maxCycleSize: recursiveSizes.length > 0 ? Math.max(...recursiveSizes) : 0,
    averageRecursiveComponentSize:
      recursiveSizes.length > 0
        ? recursiveSizes.reduce((a, b) => a + b, 0) / recursiveSizes.length
        : 0,
    minimumCycleLength: cycleLengths.length > 0 ? Math.min(...cycleLengths) : null,
  };

  return {
    file,
    valid: true,
    callEdges,
    indirectCallCandidates,
    sccs,
    recursiveSccs,
    recursiveFunctions,
    mostConnectedRecursiveFunctions,
    statistics,
  };
}

export function compareRecursionReports(
  beforeFile: string,
  afterFile: string,
  options: { maxCycles?: number } = {},
) {
  const before = analyzeRecursion(beforeFile, options);
  const after = analyzeRecursion(afterFile, options);

  const beforeRecursiveFns = new Set(before.recursiveFunctions);
  const afterRecursiveFns = new Set(after.recursiveFunctions);

  const newlyRecursiveFunctions = after.recursiveFunctions.filter(
    (f) => !beforeRecursiveFns.has(f),
  );
  const removedRecursiveFunctions = before.recursiveFunctions.filter(
    (f) => !afterRecursiveFns.has(f),
  );

  // Compare SCCs by canonical member signature
  const beforeSccMap = new Map(
    before.recursiveSccs.map((s) => [s.members.join(','), s]),
  );
  const afterSccMap = new Map(
    after.recursiveSccs.map((s) => [s.members.join(','), s]),
  );

  const introducedSccs = after.recursiveSccs.filter((s) => !beforeSccMap.has(s.members.join(',')));
  const removedSccs = before.recursiveSccs.filter((s) => !afterSccMap.has(s.members.join(',')));
  const changedSccs: Array<{
    before: WasmScc;
    after: WasmScc;
    changes: string[];
  }> = [];

  for (const [key, beforeScc] of beforeSccMap) {
    const afterScc = afterSccMap.get(key);
    if (!afterScc) continue;
    const changes: string[] = [];
    if (beforeScc.kind !== afterScc.kind) changes.push('kind');
    if (beforeScc.shortestCycleLength !== afterScc.shortestCycleLength) {
      const delta = (afterScc.shortestCycleLength ?? 0) - (beforeScc.shortestCycleLength ?? 0);
      changes.push(delta > 0 ? 'cycle_size_increased' : 'cycle_size_decreased');
    }
    if (beforeScc.internalEdges.length !== afterScc.internalEdges.length) changes.push('edge_count');
    if (changes.length > 0) changedSccs.push({ before: beforeScc, after: afterScc, changes });
  }

  return {
    before,
    after,
    comparison: {
      newlyRecursiveFunctions,
      removedRecursiveFunctions,
      introducedSccs,
      removedSccs,
      changedSccs,
      recursiveComponentCountDelta:
        after.statistics.recursiveComponentCount - before.statistics.recursiveComponentCount,
      recursiveFunctionCountDelta:
        after.statistics.recursiveFunctionCount - before.statistics.recursiveFunctionCount,
    },
  };
}

// =============================================================================
// WASM Embedded String Analysis (ISSUE-274 / 250-wasm-strings)
// =============================================================================

export type StringEncoding = 'ascii' | 'utf8';

export type StringSourceSection = 'data_segment' | 'custom_section';

export type StringCategory =
  | 'error_message'
  | 'url_like'
  | 'identifier_like'
  | 'numeric_string'
  | 'path_like'
  | 'uncategorized';

export interface WasmStringRecord {
  value: string;
  byteLength: number;
  encoding: StringEncoding;
  sourceSection: StringSourceSection;
  segmentIndex: number | null;
  sectionName: string | null;
  byteOffset: number;
  occurrenceCount: number;
  contentHash: string;
  category: StringCategory;
  isNullTerminated: boolean;
}

export interface WasmStringReport {
  file: string;
  valid: true;
  strings: WasmStringRecord[];
  statistics: {
    totalDetectedStrings: number;
    uniqueStrings: number;
    totalStringBytes: number;
    averageStringLength: number;
    maximumStringLength: number;
    printableDataPercentage: number;
    mostFrequentStrings: Array<{ value: string; count: number }>;
  };
}

function classifyString(value: string): StringCategory {
  if (/^[\w./-]{2,}$/.test(value) && /\//.test(value)) return 'path_like';
  if (/^https?:\/\//i.test(value) || /^[a-z][a-z0-9+\-.]*:\/\//i.test(value)) return 'url_like';
  if (/error|fail|panic|overflow|underflow|invalid|abort|assert/i.test(value)) return 'error_message';
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(value)) return 'numeric_string';
  if (/^[a-zA-Z_][a-zA-Z0-9_:.]*$/.test(value)) return 'identifier_like';
  return 'uncategorized';
}

function isPrintable(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
}

function isValidUtf8(buf: Buffer): boolean {
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    let charLen: number;
    if (b <= 0x7f) { charLen = 1; }
    else if ((b & 0xe0) === 0xc0) { charLen = 2; }
    else if ((b & 0xf0) === 0xe0) { charLen = 3; }
    else if ((b & 0xf8) === 0xf0) { charLen = 4; }
    else return false;
    if (i + charLen > buf.length) return false;
    for (let j = 1; j < charLen; j++) {
      if ((buf[i + j] & 0xc0) !== 0x80) return false;
    }
    i += charLen;
  }
  return true;
}

function isAllAscii(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7e || buf[i] < 0x20) return false;
  }
  return true;
}

function extractStringsFromBuffer(
  buf: Buffer,
  minLength: number,
  sourceSection: StringSourceSection,
  segmentIndex: number | null,
  sectionName: string | null,
  occurrenceMap: Map<string, WasmStringRecord>,
): void {
  let i = 0;
  while (i < buf.length) {
    // Try to find a run of printable bytes
    let start = i;
    while (start < buf.length && !isPrintable(buf[start])) start++;
    let end = start;
    while (end < buf.length && isPrintable(buf[end])) end++;
    const len = end - start;
    if (len >= minLength) {
      const slice = buf.subarray(start, end);
      const isNullTerminated = end < buf.length && buf[end] === 0x00;
      let encoding: StringEncoding;
      let value: string;
      if (isAllAscii(slice)) {
        encoding = 'ascii';
        value = slice.toString('ascii');
      } else if (isValidUtf8(slice)) {
        encoding = 'utf8';
        value = slice.toString('utf8');
      } else {
        i = end + 1;
        continue;
      }
      const contentHash = createHash('sha256').update(slice).digest('hex').slice(0, 16);
      const existing = occurrenceMap.get(value);
      if (existing) {
        existing.occurrenceCount += 1;
      } else {
        occurrenceMap.set(value, {
          value,
          byteLength: slice.length,
          encoding,
          sourceSection,
          segmentIndex,
          sectionName,
          byteOffset: start,
          occurrenceCount: 1,
          contentHash,
          category: classifyString(value),
          isNullTerminated,
        });
      }
    }
    i = end + 1;
  }
}

export interface WasmStringAnalysisOptions {
  minLength?: number;
  maxLength?: number;
  searchPattern?: string;
  caseInsensitive?: boolean;
  encodingFilter?: StringEncoding;
  sourceSectionFilter?: StringSourceSection;
  categoryFilter?: StringCategory;
}

function parseDataSegments(section: Section | undefined): Array<{ index: number; data: Buffer }> {
  if (!section) return [];
  const reader = new Reader(section.payload);
  const count = reader.varuint32();
  const segments: Array<{ index: number; data: Buffer }> = [];
  for (let i = 0; i < count; i++) {
    const flags = reader.varuint32();
    if ((flags & 0x01) === 0) {
      // Active segment: memory index + offset expr
      if ((flags & 0x02) !== 0) reader.varuint32(); // explicit memory index
      // Skip offset expression until 0x0b (end)
      let b: number;
      do { b = reader.byte(); } while (b !== 0x0b);
    }
    // else passive segment: no offset expr
    const dataLen = reader.varuint32();
    const data = reader.bytes(dataLen);
    segments.push({ index: i, data });
  }
  return segments;
}

export function analyzeStrings(file: string, options: WasmStringAnalysisOptions = {}): WasmStringReport {
  const minLength = options.minLength ?? 4;
  const maxLength = options.maxLength ?? Infinity;
  const sections = loadSections(file);

  const occurrenceMap = new Map<string, WasmStringRecord>();

  // Scan data segments (section id 11)
  const dataSection = sections.find((s) => s.id === 11);
  try {
    const segments = parseDataSegments(dataSection);
    for (const seg of segments) {
      extractStringsFromBuffer(seg.data, minLength, 'data_segment', seg.index, null, occurrenceMap);
    }
  } catch {
    // Malformed data section: continue with custom sections
  }

  // Scan custom sections (section id 0)
  const customSections = sections.filter((s) => s.id === 0);
  for (const cs of customSections) {
    try {
      const reader = new Reader(cs.payload);
      const sectionName = reader.string();
      const payload = cs.payload.subarray(reader.offset);
      extractStringsFromBuffer(payload, minLength, 'custom_section', null, sectionName, occurrenceMap);
    } catch {
      // Skip malformed custom section
    }
  }

  // Calculate total printable bytes for printable-data percentage
  let totalBytes = 0;
  let printableBytes = 0;
  const dataSegArr = dataSection ? (() => { try { return parseDataSegments(dataSection); } catch { return []; } })() : [];
  for (const seg of dataSegArr) {
    totalBytes += seg.data.length;
    for (let i = 0; i < seg.data.length; i++) {
      if (isPrintable(seg.data[i])) printableBytes++;
    }
  }

  // Apply filters
  let allStrings = [...occurrenceMap.values()];
  if (maxLength !== Infinity) allStrings = allStrings.filter((s) => s.byteLength <= maxLength);
  if (options.encodingFilter) allStrings = allStrings.filter((s) => s.encoding === options.encodingFilter);
  if (options.sourceSectionFilter) allStrings = allStrings.filter((s) => s.sourceSection === options.sourceSectionFilter);
  if (options.categoryFilter) allStrings = allStrings.filter((s) => s.category === options.categoryFilter);
  if (options.searchPattern) {
    const flags = options.caseInsensitive ? 'i' : '';
    let pattern: RegExp;
    try { pattern = new RegExp(options.searchPattern, flags); } catch { pattern = new RegExp(''); }
    allStrings = allStrings.filter((s) => pattern.test(s.value));
  }

  // Sort deterministically
  allStrings.sort((a, b) => a.sourceSection.localeCompare(b.sourceSection) || a.byteOffset - b.byteOffset);

  const totalStringBytes = allStrings.reduce((sum, s) => sum + s.byteLength, 0);
  const lengths = allStrings.map((s) => s.byteLength);
  const mostFrequent = [...allStrings]
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
    .slice(0, 10)
    .map((s) => ({ value: s.value, count: s.occurrenceCount }));

  return {
    file,
    valid: true,
    strings: allStrings,
    statistics: {
      totalDetectedStrings: allStrings.reduce((sum, s) => sum + s.occurrenceCount, 0),
      uniqueStrings: allStrings.length,
      totalStringBytes,
      averageStringLength: allStrings.length === 0 ? 0 : totalStringBytes / allStrings.length,
      maximumStringLength: lengths.length === 0 ? 0 : Math.max(...lengths),
      printableDataPercentage: totalBytes === 0 ? 0 : (printableBytes / totalBytes) * 100,
      mostFrequentStrings: mostFrequent,
    },
  };
}

export function compareStringReports(beforeFile: string, afterFile: string, options: WasmStringAnalysisOptions = {}) {
  const before = analyzeStrings(beforeFile, options);
  const after = analyzeStrings(afterFile, options);

  const beforeMap = new Map(before.strings.map((s) => [s.value, s]));
  const afterMap = new Map(after.strings.map((s) => [s.value, s]));

  const addedStrings = [...afterMap.values()].filter((s) => !beforeMap.has(s.value));
  const removedStrings = [...beforeMap.values()].filter((s) => !afterMap.has(s.value));
  const countChanges = [...afterMap.entries()]
    .filter(([v, s]) => {
      const b = beforeMap.get(v);
      return b && b.occurrenceCount !== s.occurrenceCount;
    })
    .map(([v, s]) => ({ value: v, before: beforeMap.get(v)!.occurrenceCount, after: s.occurrenceCount }));

  return {
    before,
    after,
    comparison: {
      addedStrings,
      removedStrings,
      changedOccurrenceCounts: countChanges,
      addedCount: addedStrings.length,
      removedCount: removedStrings.length,
    },
  };
}

// =============================================================================
// WASM Operand-Stack Type Analysis (ISSUE-275 / 251-wasm-stack-types)
// =============================================================================

export type WasmValType = 'i32' | 'i64' | 'f32' | 'f64' | 'funcref' | 'externref' | 'unknown';

export interface WasmStackStateRecord {
  functionIndex: number;
  blockIndex: number;
  instructionIndex: number;
  opcode: string;
  inputTypes: WasmValType[];
  outputTypes: WasmValType[];
  stackDepthBefore: number;
  stackDepthAfter: number;
  isUnreachable: boolean;
}

export interface WasmStackTypeIssue {
  functionIndex: number;
  blockIndex: number;
  instructionIndex: number;
  opcode: string;
  kind: 'stack_underflow' | 'type_mismatch' | 'impossible_merge';
  description: string;
}

export interface WasmStackTypeFunctionSummary {
  functionIndex: number;
  maxStackDepth: number;
  totalInstructions: number;
  typeTransitions: number;
  polymorphicStateCount: number;
  issueCount: number;
}

export interface WasmStackTypesReport {
  file: string;
  valid: true;
  records: WasmStackStateRecord[];
  issues: WasmStackTypeIssue[];
  functions: WasmStackTypeFunctionSummary[];
  statistics: {
    totalFunctions: number;
    totalInstructions: number;
    totalTypeTransitions: number;
    totalPolymorphicStates: number;
    totalIssues: number;
    maxStackDepth: number;
    typeTransitionFrequencies: Record<string, number>;
    functionsWithHighestTransitions: Array<{ functionIndex: number; transitions: number }>;
  };
}

// Instruction type signatures: [inputTypes, outputTypes]
interface TypeSig { in: WasmValType[]; out: WasmValType[] }

// Module-level shorthand constants for common value types used in stack analysis
const _i32: WasmValType = 'i32';
const _i64: WasmValType = 'i64';
const _f32: WasmValType = 'f32';
const _f64: WasmValType = 'f64';

function valType(byte: number): WasmValType {
  const map: Record<number, WasmValType> = {
    0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64',
    0x70: 'funcref', 0x6f: 'externref',
  };
  return map[byte] ?? 'unknown';
}

function parseTypeSection(sec: Section | undefined): Array<{ params: WasmValType[]; results: WasmValType[] }> {
  if (!sec) return [];
  const r = new Reader(sec.payload);
  const count = r.varuint32();
  const types: Array<{ params: WasmValType[]; results: WasmValType[] }> = [];
  for (let i = 0; i < count; i++) {
    const tag = r.byte(); // 0x60 for function type
    if (tag !== 0x60) { types.push({ params: [], results: [] }); continue; }
    const pCount = r.varuint32();
    const params: WasmValType[] = [];
    for (let j = 0; j < pCount; j++) params.push(valType(r.byte()));
    const rCount = r.varuint32();
    const results: WasmValType[] = [];
    for (let j = 0; j < rCount; j++) results.push(valType(r.byte()));
    types.push({ params, results });
  }
  return types;
}

function parseFunctionSection(sec: Section | undefined): number[] {
  if (!sec) return [];
  const r = new Reader(sec.payload);
  const count = r.varuint32();
  const indices: number[] = [];
  for (let i = 0; i < count; i++) indices.push(r.varuint32());
  return indices;
}

type StackState = WasmValType[] | 'polymorphic'; // polymorphic = unreachable

function typeSigFor(opcode: number, typeIdx: number, types: Array<{ params: WasmValType[]; results: WasmValType[] }>, funcTypeIndices: number[], importedFunctions: number): TypeSig {
  const i32: WasmValType = 'i32'; const i64: WasmValType = 'i64';
  const f32: WasmValType = 'f32'; const f64: WasmValType = 'f64';
  const sig = (i: WasmValType[], o: WasmValType[]): TypeSig => ({ in: i, out: o });
  switch (opcode) {
    case 0x00: return sig([], []); // unreachable — handled separately
    case 0x01: return sig([], []); // nop
    case 0x1a: return sig(['unknown'], []); // drop
    case 0x45: return sig([i32], [i32]); // i32.eqz
    case 0x46: case 0x47: case 0x48: case 0x49: case 0x4a: case 0x4b: return sig([i32, i32], [i32]);
    case 0x50: return sig([i64], [i32]); // i64.eqz
    case 0x51: case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: return sig([i64, i64], [i32]);
    case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f: case 0x60: return sig([f32, f32], [i32]);
    case 0x61: case 0x62: case 0x63: case 0x64: case 0x65: case 0x66: return sig([f64, f64], [i32]);
    case 0x41: return sig([], [i32]); // i32.const
    case 0x42: return sig([], [i64]); // i64.const
    case 0x43: return sig([], [f32]); // f32.const
    case 0x44: return sig([], [f64]); // f64.const
    // i32 arithmetic
    case 0x6a: case 0x6b: case 0x6c: case 0x6d: case 0x6e: case 0x6f:
    case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77: case 0x78: case 0x79: case 0x7a: case 0x7b:
      return sig([i32, i32], [i32]);
    case 0x67: case 0x68: case 0x69: return sig([i32], [i32]); // clz/ctz/popcnt
    // i64 arithmetic
    case 0x7c: case 0x7d: case 0x7e: case 0x7f: case 0x80: case 0x81:
    case 0x82: case 0x83: case 0x84: case 0x85: case 0x86: case 0x87: case 0x88: case 0x89: case 0x8a:
      return sig([i64, i64], [i64]);
    case 0x79: case 0x7a: case 0x7b: return sig([i64], [i64]);
    // f32 arithmetic
    case 0x8b: case 0x8c: case 0x91: case 0x8d: case 0x8e: case 0x8f: case 0x90: return sig([f32], [f32]);
    case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97: case 0x98: return sig([f32, f32], [f32]);
    // f64 arithmetic
    case 0x99: case 0x9a: case 0x9f: case 0x9b: case 0x9c: case 0x9d: case 0x9e: return sig([f64], [f64]);
    case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4: case 0xa5: case 0xa6: return sig([f64, f64], [f64]);
    // conversions
    case 0xa7: return sig([i64], [i32]);
    case 0xa8: return sig([f32], [i32]); case 0xa9: return sig([f32], [i32]);
    case 0xaa: return sig([f64], [i32]); case 0xab: return sig([f64], [i32]);
    case 0xac: return sig([i32], [i64]); case 0xad: return sig([i32], [i64]);
    case 0xae: return sig([f32], [i64]); case 0xaf: return sig([f32], [i64]);
    case 0xb0: return sig([f64], [i64]); case 0xb1: return sig([f64], [i64]);
    case 0xb2: return sig([i32], [f32]); case 0xb3: return sig([i32], [f32]);
    case 0xb4: return sig([i64], [f32]); case 0xb5: return sig([i64], [f32]);
    case 0xb6: return sig([f64], [f32]);
    case 0xb7: return sig([i32], [f64]); case 0xb8: return sig([i32], [f64]);
    case 0xb9: return sig([i64], [f64]); case 0xba: return sig([i64], [f64]);
    case 0xbb: return sig([f32], [f64]);
    case 0xbc: return sig([f32], [i32]); case 0xbd: return sig([f64], [i64]);
    case 0xbe: return sig([i32], [f32]); case 0xbf: return sig([i64], [f64]);
    // memory
    case 0x28: case 0x2c: case 0x2d: case 0x2e: case 0x2f: case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35: return sig([i32], [i32]);
    case 0x29: return sig([i32], [i64]);
    case 0x2a: return sig([i32], [f32]);
    case 0x2b: return sig([i32], [f64]);
    case 0x36: case 0x3a: case 0x3b: case 0x3c: case 0x3d: case 0x3e: return sig([i32, i32], []);
    case 0x37: return sig([i32, i64], []);
    case 0x38: return sig([i32, f32], []);
    case 0x39: return sig([i32, f64], []);
    case 0x3f: return sig([], [i32]); // memory.size
    case 0x40: return sig([i32], [i32]); // memory.grow
    // call
    case 0x10: {
      const ti = typeIdx < funcTypeIndices.length + importedFunctions
        ? (typeIdx < importedFunctions ? undefined : funcTypeIndices[typeIdx - importedFunctions])
        : undefined;
      const t = ti !== undefined && ti < types.length ? types[ti] : null;
      return t ? sig([...t.params], [...t.results]) : sig([], []);
    }
    default: return sig([], []);
  }
}

function opcodeNameFor(opcode: number): string {
  return opcodeNames[opcode] ?? `opcode_0x${opcode.toString(16)}`;
}

export function analyzeStackTypes(file: string): WasmStackTypesReport {
  const sections = loadSections(file);
  const importSec = sections.find((s) => s.id === 2);
  const typeSec = sections.find((s) => s.id === 1);
  const funcSec = sections.find((s) => s.id === 3);
  const codeSec = sections.find((s) => s.id === 10);
  const importLocalSec = sections.find((s) => s.id === 2);

  const types = parseTypeSection(typeSec);
  const funcTypeIndices = parseFunctionSection(funcSec);
  const importedFunctions = importedFunctionCount(importLocalSec);

  const allRecords: WasmStackStateRecord[] = [];
  const allIssues: WasmStackTypeIssue[] = [];
  const funcSummaries: WasmStackTypeFunctionSummary[] = [];
  const globalTransitionFrequencies: Record<string, number> = {};

  if (!codeSec) {
    return {
      file, valid: true, records: [], issues: [], functions: [],
      statistics: { totalFunctions: 0, totalInstructions: 0, totalTypeTransitions: 0, totalPolymorphicStates: 0, totalIssues: 0, maxStackDepth: 0, typeTransitionFrequencies: {}, functionsWithHighestTransitions: [] },
    };
  }

  const reader = new Reader(codeSec.payload);
  const funcCount = reader.varuint32();

  for (let fi = 0; fi < funcCount; fi++) {
    const bodySize = reader.varuint32();
    const body = new Reader(reader.bytes(bodySize));
    const localGroupCount = body.varuint32();
    for (let j = 0; j < localGroupCount; j++) { body.varuint32(); body.byte(); }

    const functionIndex = importedFunctions + fi;
    const stack: WasmValType[] = [];
    let blockIndex = 0;
    let instrIndex = 0;
    let isUnreachable = false;
    let maxDepth = 0;
    let transitions = 0;
    let polymorphicCount = 0;
    const funcRecords: WasmStackStateRecord[] = [];
    const funcIssues: WasmStackTypeIssue[] = [];

    while (!body.done) {
      const opcode = body.byte();
      const opName = opcodeNameFor(opcode);
      const depthBefore = stack.length;

      let inputTypes: WasmValType[] = [];
      let outputTypes: WasmValType[] = [];
      let isUnreachableInstr = isUnreachable;

      if (opcode === 0x00) {
        // unreachable
        isUnreachable = true;
        isUnreachableInstr = true;
        inputTypes = []; outputTypes = [];
      } else if (opcode === 0x0b) {
        // end — pop block
        if (blockIndex > 0) blockIndex--;
        if (isUnreachable) isUnreachable = false;
      } else if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) {
        // block/loop/if
        blockIndex++;
        body.byte(); // block type
        isUnreachable = false;
      } else if (opcode === 0x05) {
        // else
        isUnreachable = false;
      } else if (opcode === 0x0c || opcode === 0x0d) {
        // br / br_if
        body.varuint32();
        if (opcode === 0x0c) isUnreachable = true;
        inputTypes = opcode === 0x0d ? [_i32] : [];
      } else if (opcode === 0x0e) {
        // br_table
        const n = body.varuint32();
        for (let k = 0; k <= n; k++) body.varuint32();
        isUnreachable = true;
        inputTypes = [_i32];
      } else if (opcode === 0x0f) {
        // return
        isUnreachable = true;
      } else if (opcode === 0x20 || opcode === 0x21 || opcode === 0x22) {
        // local.get / local.set / local.tee
        body.varuint32();
        inputTypes = opcode === 0x20 ? [] : ['i32' as WasmValType];
        outputTypes = opcode === 0x21 ? [] : ['i32' as WasmValType];
      } else if (opcode === 0x23 || opcode === 0x24) {
        // global.get / global.set
        body.varuint32();
        inputTypes = opcode === 0x24 ? ['i32' as WasmValType] : [];
        outputTypes = opcode === 0x23 ? ['i32' as WasmValType] : [];
      } else if (opcode === 0x10) {
        // call
        const callIdx = body.varuint32();
        const ts = typeSigFor(opcode, callIdx, types, funcTypeIndices, importedFunctions);
        inputTypes = ts.in; outputTypes = ts.out;
      } else if (opcode === 0x11) {
        // call_indirect
        const typeIdx2 = body.varuint32();
        body.byte(); // table index
        const t = typeIdx2 < types.length ? types[typeIdx2] : null;
        inputTypes = [...(t ? t.params : []), 'i32' as WasmValType];
        outputTypes = t ? t.results : [];
      } else {
        const ts = typeSigFor(opcode, 0, types, funcTypeIndices, importedFunctions);
        inputTypes = ts.in; outputTypes = ts.out;
        skipInstructionImmediate(opcode, body);
      }

      if (!isUnreachable) {
        for (let k = 0; k < inputTypes.length; k++) {
          if (stack.length === 0) {
            funcIssues.push({ functionIndex, blockIndex, instructionIndex: instrIndex, opcode: opName, kind: 'stack_underflow', description: `Stack underflow consuming operand ${k} for ${opName}` });
          } else {
            stack.pop();
          }
        }
        for (const t of outputTypes) stack.push(t);
        maxDepth = Math.max(maxDepth, stack.length);
        transitions++;
        const transKey = `[${inputTypes.join(',')}]->[${outputTypes.join(',')}]`;
        globalTransitionFrequencies[transKey] = (globalTransitionFrequencies[transKey] ?? 0) + 1;
      } else {
        polymorphicCount++;
      }

      funcRecords.push({
        functionIndex,
        blockIndex,
        instructionIndex: instrIndex,
        opcode: opName,
        inputTypes,
        outputTypes,
        stackDepthBefore: depthBefore,
        stackDepthAfter: stack.length,
        isUnreachable: isUnreachableInstr,
      });

      instrIndex++;
    }

    allRecords.push(...funcRecords);
    allIssues.push(...funcIssues);
    funcSummaries.push({
      functionIndex,
      maxStackDepth: maxDepth,
      totalInstructions: instrIndex,
      typeTransitions: transitions,
      polymorphicStateCount: polymorphicCount,
      issueCount: funcIssues.length,
    });
  }

  const allDepths = funcSummaries.map((f) => f.maxStackDepth);
  const allTransitions = funcSummaries.map((f) => f.typeTransitions);

  return {
    file,
    valid: true,
    records: allRecords,
    issues: allIssues,
    functions: funcSummaries,
    statistics: {
      totalFunctions: funcSummaries.length,
      totalInstructions: allRecords.length,
      totalTypeTransitions: allTransitions.reduce((a, b) => a + b, 0),
      totalPolymorphicStates: funcSummaries.reduce((a, b) => a + b.polymorphicStateCount, 0),
      totalIssues: allIssues.length,
      maxStackDepth: allDepths.length === 0 ? 0 : Math.max(...allDepths),
      typeTransitionFrequencies: sortedRecord(globalTransitionFrequencies),
      functionsWithHighestTransitions: [...funcSummaries]
        .sort((a, b) => b.typeTransitions - a.typeTransitions)
        .slice(0, 10)
        .map((f) => ({ functionIndex: f.functionIndex, transitions: f.typeTransitions })),
    },
  };
}

export function compareStackTypesReports(beforeFile: string, afterFile: string) {
  const before = analyzeStackTypes(beforeFile);
  const after = analyzeStackTypes(afterFile);
  const beforeTransSet = new Set(Object.keys(before.statistics.typeTransitionFrequencies));
  const afterTransSet = new Set(Object.keys(after.statistics.typeTransitionFrequencies));
  return {
    before,
    after,
    comparison: {
      addedTransitions: [...afterTransSet].filter((k) => !beforeTransSet.has(k)),
      removedTransitions: [...beforeTransSet].filter((k) => !afterTransSet.has(k)),
      newIssues: after.statistics.totalIssues - before.statistics.totalIssues,
      maxStackDepthDelta: after.statistics.maxStackDepth - before.statistics.maxStackDepth,
    },
  };
}

// =============================================================================
// WASM Global Mutation Analysis (ISSUE-276 / 252-wasm-globals-usage)
// =============================================================================

export type GlobalAccessKind = 'read' | 'write';

export type GlobalUsageClassification = 'read_only' | 'write_only' | 'read_write' | 'never_accessed';

export interface WasmGlobalAccessRecord {
  globalIndex: number;
  functionIndex: number;
  blockIndex: number;
  instructionIndex: number;
  opcode: 'global.get' | 'global.set';
}

export interface WasmGlobalUsageSummary {
  globalIndex: number;
  valueType: string;
  mutable: boolean;
  source: 'imported' | 'defined';
  importModule: string | null;
  importName: string | null;
  classification: GlobalUsageClassification;
  totalReads: number;
  totalWrites: number;
  readingFunctions: number[];
  writingFunctions: number[];
  accessedByMultipleFunctions: boolean;
  writtenByMultipleFunctions: boolean;
}

export interface WasmGlobalFunctionSummary {
  functionIndex: number;
  totalGlobalReads: number;
  totalGlobalWrites: number;
  uniqueGlobalsAccessed: number;
  mutableGlobalsModified: number;
}

export interface WasmGlobalMutationReport {
  file: string;
  valid: true;
  accesses: WasmGlobalAccessRecord[];
  globals: WasmGlobalUsageSummary[];
  functionSummaries: WasmGlobalFunctionSummary[];
  statistics: {
    totalGlobals: number;
    importedGlobals: number;
    localGlobals: number;
    mutableGlobals: number;
    immutableGlobals: number;
    totalReads: number;
    totalWrites: number;
    globalsNeverAccessed: number;
    globalsAccessedByMultipleFunctions: number;
    globalsWrittenByMultipleFunctions: number;
  };
}

function parseGlobalAccesses(
  codeSec: Section | undefined,
  importedFunctions: number,
): WasmGlobalAccessRecord[] {
  const accesses: WasmGlobalAccessRecord[] = [];
  if (!codeSec) return accesses;
  const reader = new Reader(codeSec.payload);
  const count = reader.varuint32();
  for (let fi = 0; fi < count; fi++) {
    const bodySize = reader.varuint32();
    const body = new Reader(reader.bytes(bodySize));
    const localGroupCount = body.varuint32();
    for (let j = 0; j < localGroupCount; j++) { body.varuint32(); body.byte(); }
    const functionIndex = importedFunctions + fi;
    let blockIndex = 0;
    let instrIndex = 0;
    let unreachable = false;
    while (!body.done) {
      const opcode = body.byte();
      if (opcode === 0x00) { unreachable = true; }
      else if (opcode === 0x0b) { if (blockIndex > 0) blockIndex--; unreachable = false; }
      else if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) { blockIndex++; body.byte(); unreachable = false; }
      else if (opcode === 0x05) { unreachable = false; }
      if (!unreachable && (opcode === 0x23 || opcode === 0x24)) {
        const globalIndex = body.varuint32();
        accesses.push({
          globalIndex,
          functionIndex,
          blockIndex,
          instructionIndex: instrIndex,
          opcode: opcode === 0x23 ? 'global.get' : 'global.set',
        });
      } else {
        skipInstructionImmediate(opcode, body);
      }
      instrIndex++;
    }
  }
  return accesses;
}

export function analyzeGlobalMutation(file: string): WasmGlobalMutationReport {
  const sections = loadSections(file);
  const imports = parseImportSection(sections.find((s) => s.id === 2));
  const allGlobals = [
    ...imports.globals,
    ...parseGlobalSection(sections.find((s) => s.id === 6), imports.globals.length),
  ];
  const importedFunctions = importedFunctionCount(sections.find((s) => s.id === 2));
  const accesses = parseGlobalAccesses(sections.find((s) => s.id === 10), importedFunctions);

  // Build per-global maps
  const readsByGlobal = new Map<number, Set<number>>();
  const writesByGlobal = new Map<number, Set<number>>();
  for (const g of allGlobals) {
    readsByGlobal.set(g.index, new Set());
    writesByGlobal.set(g.index, new Set());
  }
  for (const acc of accesses) {
    if (acc.opcode === 'global.get') readsByGlobal.get(acc.globalIndex)?.add(acc.functionIndex);
    else writesByGlobal.get(acc.globalIndex)?.add(acc.functionIndex);
  }

  const globalSummaries: WasmGlobalUsageSummary[] = allGlobals.map((g) => {
    const reads = readsByGlobal.get(g.index) ?? new Set();
    const writes = writesByGlobal.get(g.index) ?? new Set();
    const totalReads = accesses.filter((a) => a.globalIndex === g.index && a.opcode === 'global.get').length;
    const totalWrites = accesses.filter((a) => a.globalIndex === g.index && a.opcode === 'global.set').length;
    let classification: GlobalUsageClassification;
    if (totalReads === 0 && totalWrites === 0) classification = 'never_accessed';
    else if (totalReads > 0 && totalWrites === 0) classification = 'read_only';
    else if (totalReads === 0 && totalWrites > 0) classification = 'write_only';
    else classification = 'read_write';
    return {
      globalIndex: g.index,
      valueType: g.valueType,
      mutable: g.mutable,
      source: g.source,
      importModule: g.module,
      importName: g.name,
      classification,
      totalReads,
      totalWrites,
      readingFunctions: [...reads].sort((a, b) => a - b),
      writingFunctions: [...writes].sort((a, b) => a - b),
      accessedByMultipleFunctions: reads.size + writes.size > 1,
      writtenByMultipleFunctions: writes.size > 1,
    };
  });

  // Per-function summaries
  const funcMap = new Map<number, WasmGlobalFunctionSummary>();
  for (const acc of accesses) {
    const existing = funcMap.get(acc.functionIndex);
    if (!existing) {
      funcMap.set(acc.functionIndex, {
        functionIndex: acc.functionIndex,
        totalGlobalReads: acc.opcode === 'global.get' ? 1 : 0,
        totalGlobalWrites: acc.opcode === 'global.set' ? 1 : 0,
        uniqueGlobalsAccessed: 1,
        mutableGlobalsModified: acc.opcode === 'global.set' && allGlobals.find((g) => g.index === acc.globalIndex)?.mutable ? 1 : 0,
      });
    } else {
      if (acc.opcode === 'global.get') existing.totalGlobalReads++;
      else existing.totalGlobalWrites++;
    }
  }
  // Recalculate uniqueGlobalsAccessed accurately
  for (const [fnIdx, summary] of funcMap) {
    const accessed = new Set(accesses.filter((a) => a.functionIndex === fnIdx).map((a) => a.globalIndex));
    const mutMod = new Set(accesses.filter((a) => a.functionIndex === fnIdx && a.opcode === 'global.set' && allGlobals.find((g) => g.index === a.globalIndex)?.mutable).map((a) => a.globalIndex));
    summary.uniqueGlobalsAccessed = accessed.size;
    summary.mutableGlobalsModified = mutMod.size;
  }
  const functionSummaries = [...funcMap.values()].sort((a, b) => a.functionIndex - b.functionIndex);

  return {
    file,
    valid: true,
    accesses,
    globals: globalSummaries,
    functionSummaries,
    statistics: {
      totalGlobals: allGlobals.length,
      importedGlobals: imports.globals.length,
      localGlobals: allGlobals.length - imports.globals.length,
      mutableGlobals: allGlobals.filter((g) => g.mutable).length,
      immutableGlobals: allGlobals.filter((g) => !g.mutable).length,
      totalReads: accesses.filter((a) => a.opcode === 'global.get').length,
      totalWrites: accesses.filter((a) => a.opcode === 'global.set').length,
      globalsNeverAccessed: globalSummaries.filter((g) => g.classification === 'never_accessed').length,
      globalsAccessedByMultipleFunctions: globalSummaries.filter((g) => g.accessedByMultipleFunctions).length,
      globalsWrittenByMultipleFunctions: globalSummaries.filter((g) => g.writtenByMultipleFunctions).length,
    },
  };
}

export function compareGlobalMutationReports(beforeFile: string, afterFile: string) {
  const before = analyzeGlobalMutation(beforeFile);
  const after = analyzeGlobalMutation(afterFile);
  const beforeMap = new Map(before.globals.map((g) => [g.globalIndex, g]));
  const afterMap = new Map(after.globals.map((g) => [g.globalIndex, g]));
  const changedUsage: Array<{ globalIndex: number; before: GlobalUsageClassification; after: GlobalUsageClassification }> = [];
  for (const [idx, ag] of afterMap) {
    const bg = beforeMap.get(idx);
    if (bg && bg.classification !== ag.classification) changedUsage.push({ globalIndex: idx, before: bg.classification, after: ag.classification });
  }
  return {
    before,
    after,
    comparison: {
      addedGlobals: [...afterMap.keys()].filter((k) => !beforeMap.has(k)).map((k) => afterMap.get(k)!),
      removedGlobals: [...beforeMap.keys()].filter((k) => !afterMap.has(k)).map((k) => beforeMap.get(k)!),
      changedUsageClassification: changedUsage,
      newMutatedGlobals: after.globals.filter((g) => g.totalWrites > 0 && (beforeMap.get(g.globalIndex)?.totalWrites ?? 0) === 0),
      globalsBecomingUnused: before.globals.filter((g) => g.classification !== 'never_accessed' && afterMap.get(g.globalIndex)?.classification === 'never_accessed'),
    },
  };
}

// =============================================================================
// WASM Literal & Magic-Number Analysis (ISSUE-277 / 253-wasm-literals)
// =============================================================================

export type LiteralType = 'i32' | 'i64' | 'f32' | 'f64';

export type LiteralStructuralClass =
  | 'zero'
  | 'one'
  | 'negative_one'
  | 'power_of_two'
  | 'bit_mask'
  | 'byte_mask'
  | 'alignment_like'
  | 'small_integer'
  | 'large_integer'
  | 'unusual_constant'
  | 'positive_float'
  | 'negative_float'
  | 'zero_float'
  | 'float_edge'
  | 'none';

export interface WasmLiteralRecord {
  functionIndex: number;
  blockIndex: number;
  instructionIndex: number;
  opcode: string;
  literalType: LiteralType;
  rawI32: number | null;
  rawI64: bigint | null;
  rawF32: number | null;
  rawF64: number | null;
  signedValue: string;
  unsignedValue: string;
  hexValue: string;
  structuralClass: LiteralStructuralClass;
  contentHash: string;
}

export interface WasmLiteralOccurrenceSummary {
  signedValue: string;
  unsignedValue: string;
  hexValue: string;
  literalType: LiteralType;
  structuralClass: LiteralStructuralClass;
  occurrenceCount: number;
  functionIndices: number[];
  usedInMultipleFunctions: boolean;
  opcodeCategories: string[];
  contentHash: string;
}

export interface WasmLiteralsReport {
  file: string;
  valid: true;
  records: WasmLiteralRecord[];
  occurrenceSummaries: WasmLiteralOccurrenceSummary[];
  statistics: {
    totalLiteralOccurrences: number;
    uniqueLiterals: number;
    integerLiterals: number;
    floatingPointLiterals: number;
    mostFrequentLiteral: WasmLiteralOccurrenceSummary | null;
    maxObservedInteger: string | null;
    minObservedInteger: string | null;
    literalsSharedAcrossFunctions: number;
    largeConstantThreshold: number;
    unusualConstantCount: number;
  };
}

function classifyLiteral(
  literalType: LiteralType,
  i32Val: number | null,
  i64Val: bigint | null,
  f32Val: number | null,
  f64Val: number | null,
  largeThreshold: number,
): LiteralStructuralClass {
  if (literalType === 'f32' && f32Val !== null) {
    if (f32Val === 0 || Object.is(f32Val, -0)) return 'zero_float';
    if (!isFinite(f32Val) || isNaN(f32Val)) return 'float_edge';
    return f32Val > 0 ? 'positive_float' : 'negative_float';
  }
  if (literalType === 'f64' && f64Val !== null) {
    if (f64Val === 0 || Object.is(f64Val, -0)) return 'zero_float';
    if (!isFinite(f64Val) || isNaN(f64Val)) return 'float_edge';
    return f64Val > 0 ? 'positive_float' : 'negative_float';
  }
  const val = i32Val !== null ? BigInt(i32Val) : i64Val;
  if (val === null) return 'none';
  if (val === 0n) return 'zero';
  if (val === 1n) return 'one';
  if (val === -1n || (i32Val !== null && i32Val === -1) || (i64Val !== null && i64Val === -1n)) return 'negative_one';
  const absVal = val < 0n ? -val : val;
  if (absVal > 0n && (absVal & (absVal - 1n)) === 0n) return 'power_of_two';
  // byte mask: all 1s in lower N bytes (e.g. 0xff, 0xffff, etc.)
  if (absVal === 0xffn || absVal === 0xffffn || absVal === 0xffffffn || absVal === 0xffffffffn) return 'byte_mask';
  // bit mask: all lower bits set (power_of_two - 1)
  if (absVal > 0n && ((absVal + 1n) & absVal) === 0n) return 'bit_mask';
  // alignment like: multiple of page size (4096) or common alignment
  if (i32Val !== null && i32Val > 0 && (i32Val % 4096 === 0 || i32Val % 64 === 0 || i32Val % 16 === 0)) return 'alignment_like';
  if (absVal > BigInt(largeThreshold)) return 'unusual_constant';
  if (absVal <= 127n) return 'small_integer';
  return 'large_integer';
}

function literalHash(signedValue: string, literalType: string): string {
  return createHash('sha256').update(`${literalType}:${signedValue}`).digest('hex').slice(0, 16);
}

function opcodeCategory(opcode: string): string {
  if (opcode === 'i32.const' || opcode === 'i64.const') return 'integer_constant';
  if (opcode === 'f32.const' || opcode === 'f64.const') return 'float_constant';
  return 'other';
}

export interface WasmLiteralsAnalysisOptions {
  largeConstantThreshold?: number;
  searchValue?: string;
  searchHex?: string;
  literalTypeFilter?: LiteralType;
  minOccurrences?: number;
}

export function analyzeLiterals(file: string, options: WasmLiteralsAnalysisOptions = {}): WasmLiteralsReport {
  const largeThreshold = options.largeConstantThreshold ?? 100000;
  const sections = loadSections(file);
  const importSec = sections.find((s) => s.id === 2);
  const codeSec = sections.find((s) => s.id === 10);
  const importedCount = importedFunctionCount(importSec);

  const records: WasmLiteralRecord[] = [];

  if (codeSec) {
    const reader = new Reader(codeSec.payload);
    const funcCount = reader.varuint32();
    for (let fi = 0; fi < funcCount; fi++) {
      const bodySize = reader.varuint32();
      const body = new Reader(reader.bytes(bodySize));
      const localCount = body.varuint32();
      for (let j = 0; j < localCount; j++) { body.varuint32(); body.byte(); }
      const functionIndex = importedCount + fi;
      let blockIndex = 0;
      let instrIndex = 0;
      let unreachable = false;
      while (!body.done) {
        const opcode = body.byte();
        if (opcode === 0x00) { unreachable = true; skipInstructionImmediate(opcode, body); instrIndex++; continue; }
        if (opcode === 0x0b) { if (blockIndex > 0) blockIndex--; unreachable = false; instrIndex++; continue; }
        if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) { blockIndex++; body.byte(); unreachable = false; instrIndex++; continue; }
        if (opcode === 0x05) { unreachable = false; instrIndex++; continue; }

        if (!unreachable) {
          if (opcode === 0x41) {
            // i32.const
            const v = body.varint32();
            const unsigned = (v >>> 0);
            const signed = v | 0;
            const hex = `0x${(unsigned).toString(16).padStart(8, '0')}`;
            const cls = classifyLiteral('i32', v, null, null, null, largeThreshold);
            records.push({
              functionIndex, blockIndex, instructionIndex: instrIndex,
              opcode: 'i32.const', literalType: 'i32',
              rawI32: v, rawI64: null, rawF32: null, rawF64: null,
              signedValue: String(signed), unsignedValue: String(unsigned), hexValue: hex,
              structuralClass: cls, contentHash: literalHash(String(signed), 'i32'),
            });
          } else if (opcode === 0x42) {
            // i64.const
            let result = 0n; let shift = 0n; let b: number;
            do { b = body.byte(); result |= BigInt(b & 0x7f) << shift; shift += 7n; } while ((b & 0x80) !== 0);
            // sign extend
            if ((b & 0x40) !== 0 && shift < 64n) result |= (~0n << shift);
            const unsigned64 = result & 0xffffffffffffffffn;
            const hex64 = `0x${unsigned64.toString(16).padStart(16, '0')}`;
            const cls = classifyLiteral('i64', null, result, null, null, largeThreshold);
            records.push({
              functionIndex, blockIndex, instructionIndex: instrIndex,
              opcode: 'i64.const', literalType: 'i64',
              rawI32: null, rawI64: result, rawF32: null, rawF64: null,
              signedValue: String(result), unsignedValue: String(unsigned64), hexValue: hex64,
              structuralClass: cls, contentHash: literalHash(String(result), 'i64'),
            });
          } else if (opcode === 0x43) {
            // f32.const
            const bytes = body.bytes(4);
            const buf = Buffer.alloc(4);
            bytes.copy(buf);
            const floatVal = buf.readFloatLE(0);
            const bits = buf.readUInt32LE(0);
            const hex = `0x${bits.toString(16).padStart(8, '0')}`;
            const cls = classifyLiteral('f32', null, null, floatVal, null, largeThreshold);
            records.push({
              functionIndex, blockIndex, instructionIndex: instrIndex,
              opcode: 'f32.const', literalType: 'f32',
              rawI32: null, rawI64: null, rawF32: floatVal, rawF64: null,
              signedValue: isNaN(floatVal) ? 'NaN' : String(floatVal), unsignedValue: hex, hexValue: hex,
              structuralClass: cls, contentHash: literalHash(hex, 'f32'),
            });
          } else if (opcode === 0x44) {
            // f64.const
            const bytes = body.bytes(8);
            const buf = Buffer.alloc(8);
            bytes.copy(buf);
            const floatVal = buf.readDoubleLE(0);
            const lo = buf.readUInt32LE(0); const hi = buf.readUInt32LE(4);
            const hex = `0x${hi.toString(16).padStart(8, '0')}${lo.toString(16).padStart(8, '0')}`;
            const cls = classifyLiteral('f64', null, null, null, floatVal, largeThreshold);
            records.push({
              functionIndex, blockIndex, instructionIndex: instrIndex,
              opcode: 'f64.const', literalType: 'f64',
              rawI32: null, rawI64: null, rawF32: null, rawF64: floatVal,
              signedValue: isNaN(floatVal) ? 'NaN' : String(floatVal), unsignedValue: hex, hexValue: hex,
              structuralClass: cls, contentHash: literalHash(hex, 'f64'),
            });
          } else {
            skipInstructionImmediate(opcode, body);
          }
        } else {
          skipInstructionImmediate(opcode, body);
        }
        instrIndex++;
      }
    }
  }

  // Build occurrence summaries
  const summaryMap = new Map<string, WasmLiteralOccurrenceSummary>();
  for (const rec of records) {
    const key = `${rec.literalType}:${rec.signedValue}`;
    const existing = summaryMap.get(key);
    if (existing) {
      existing.occurrenceCount++;
      if (!existing.functionIndices.includes(rec.functionIndex)) existing.functionIndices.push(rec.functionIndex);
      if (!existing.opcodeCategories.includes(opcodeCategory(rec.opcode))) existing.opcodeCategories.push(opcodeCategory(rec.opcode));
    } else {
      summaryMap.set(key, {
        signedValue: rec.signedValue,
        unsignedValue: rec.unsignedValue,
        hexValue: rec.hexValue,
        literalType: rec.literalType,
        structuralClass: rec.structuralClass,
        occurrenceCount: 1,
        functionIndices: [rec.functionIndex],
        usedInMultipleFunctions: false,
        opcodeCategories: [opcodeCategory(rec.opcode)],
        contentHash: rec.contentHash,
      });
    }
  }
  // Finalize multi-function flags
  for (const summary of summaryMap.values()) {
    summary.functionIndices.sort((a, b) => a - b);
    summary.usedInMultipleFunctions = summary.functionIndices.length > 1;
    summary.opcodeCategories.sort();
  }

  let summaries = [...summaryMap.values()].sort((a, b) => b.occurrenceCount - a.occurrenceCount || a.signedValue.localeCompare(b.signedValue));

  // Apply filters
  if (options.literalTypeFilter) summaries = summaries.filter((s) => s.literalType === options.literalTypeFilter);
  if (options.minOccurrences) summaries = summaries.filter((s) => s.occurrenceCount >= options.minOccurrences!);
  if (options.searchValue !== undefined) summaries = summaries.filter((s) => s.signedValue === options.searchValue || s.unsignedValue === options.searchValue);
  if (options.searchHex !== undefined) {
    const normalizedHex = options.searchHex.toLowerCase().replace(/^0x/, '');
    summaries = summaries.filter((s) => s.hexValue.toLowerCase().replace(/^0x/, '') === normalizedHex);
  }

  // Integer ranges
  const intRecords = records.filter((r) => r.literalType === 'i32' || r.literalType === 'i64');
  let maxInt: string | null = null;
  let minInt: string | null = null;
  if (intRecords.length > 0) {
    const vals = intRecords.map((r) => r.rawI64 !== null ? r.rawI64 : BigInt(r.rawI32 ?? 0));
    const mx = vals.reduce((a, b) => (b > a ? b : a));
    const mn = vals.reduce((a, b) => (b < a ? b : a));
    maxInt = String(mx);
    minInt = String(mn);
  }

  return {
    file,
    valid: true,
    records,
    occurrenceSummaries: summaries,
    statistics: {
      totalLiteralOccurrences: records.length,
      uniqueLiterals: summaryMap.size,
      integerLiterals: records.filter((r) => r.literalType === 'i32' || r.literalType === 'i64').length,
      floatingPointLiterals: records.filter((r) => r.literalType === 'f32' || r.literalType === 'f64').length,
      mostFrequentLiteral: summaries[0] ?? null,
      maxObservedInteger: maxInt,
      minObservedInteger: minInt,
      literalsSharedAcrossFunctions: summaries.filter((s) => s.usedInMultipleFunctions).length,
      largeConstantThreshold: largeThreshold,
      unusualConstantCount: summaries.filter((s) => s.structuralClass === 'unusual_constant').length,
    },
  };
}

export function compareLiteralsReports(beforeFile: string, afterFile: string, options: WasmLiteralsAnalysisOptions = {}) {
  const before = analyzeLiterals(beforeFile, options);
  const after = analyzeLiterals(afterFile, options);
  const beforeMap = new Map(before.occurrenceSummaries.map((s) => [`${s.literalType}:${s.signedValue}`, s]));
  const afterMap = new Map(after.occurrenceSummaries.map((s) => [`${s.literalType}:${s.signedValue}`, s]));
  const addedLiterals = [...afterMap.values()].filter((s) => !beforeMap.has(`${s.literalType}:${s.signedValue}`));
  const removedLiterals = [...beforeMap.values()].filter((s) => !afterMap.has(`${s.literalType}:${s.signedValue}`));
  const changedCounts: Array<{ key: string; before: number; after: number }> = [];
  for (const [k, as] of afterMap) {
    const bs = beforeMap.get(k);
    if (bs && bs.occurrenceCount !== as.occurrenceCount) changedCounts.push({ key: k, before: bs.occurrenceCount, after: as.occurrenceCount });
  }
  const newFunctionLiterals = [...afterMap.values()].filter((as) => {
    const bs = beforeMap.get(`${as.literalType}:${as.signedValue}`);
    if (!bs) return false;
    return as.functionIndices.some((f) => !bs.functionIndices.includes(f));
  });
  return {
    before,
    after,
    comparison: {
      addedLiterals,
      removedLiterals,
      changedOccurrenceCounts: changedCounts,
      literalsInNewFunctions: newFunctionLiterals,
      totalOccurrenceDelta: after.statistics.totalLiteralOccurrences - before.statistics.totalLiteralOccurrences,
      uniqueLiteralsDelta: after.statistics.uniqueLiterals - before.statistics.uniqueLiterals,
    },
  };
}
