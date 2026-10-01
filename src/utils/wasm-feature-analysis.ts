import { readFileSync } from 'fs';

export type WasmFeatureName =
  | 'atomic-instructions'
  | 'bulk-memory'
  | 'element-initialization'
  | 'exceptions'
  | 'indirect-calls'
  | 'memory-initialization'
  | 'memory64'
  | 'multiple-memories'
  | 'multiple-tables'
  | 'reference-types'
  | 'shared-memory'
  | 'simd'
  | 'tail-calls'
  | 'table-instructions'
  | 'typed-function-references';

export type WasmFeatureStatus = 'detected' | 'not-detected' | 'could-not-be-determined';

export interface WasmFeatureOccurrence {
  section: string;
  functionIndex: number | null;
  instructionOffset: number | null;
  detail: string;
}

export interface WasmFeatureEntry {
  status: WasmFeatureStatus;
  occurrenceCount: number;
  functionsUsing: number[];
  occurrences: WasmFeatureOccurrence[];
}

export interface WasmFeatureProfile {
  file?: string;
  header: { magic: string; version: number };
  sections: Array<{ id: number; name: string; size: number; order: number }>;
  functionsScanned: number;
  instructionScanComplete: boolean;
  features: Record<WasmFeatureName, WasmFeatureEntry>;
  warnings: string[];
}

export interface WasmFeatureChange {
  feature: WasmFeatureName;
  beforeCount: number;
  afterCount: number;
  newlyUsingFunctions: number[];
  noLongerUsingFunctions: number[];
}

export interface WasmFeatureComparison {
  before: WasmFeatureProfile;
  after: WasmFeatureProfile;
  newlyIntroducedFeatures: WasmFeatureName[];
  removedFeatures: WasmFeatureName[];
  changedUsageCounts: WasmFeatureChange[];
  functionsNewlyUsingFeatures: WasmFeatureChange[];
  functionsNoLongerUsingFeatures: WasmFeatureChange[];
}

const FEATURE_NAMES: WasmFeatureName[] = [
  'atomic-instructions',
  'bulk-memory',
  'element-initialization',
  'exceptions',
  'indirect-calls',
  'memory-initialization',
  'memory64',
  'multiple-memories',
  'multiple-tables',
  'reference-types',
  'shared-memory',
  'simd',
  'tail-calls',
  'table-instructions',
  'typed-function-references',
];

const SECTION_NAMES: Record<number, string> = {
  0: 'custom',
  1: 'type',
  2: 'import',
  3: 'function',
  4: 'table',
  5: 'memory',
  6: 'global',
  7: 'export',
  8: 'start',
  9: 'element',
  10: 'code',
  11: 'data',
  12: 'data-count',
  13: 'tag',
};

const SECTION_ORDER = Object.fromEntries(
  Object.entries(SECTION_NAMES).map(([id, name]) => [name, Number(id)]),
);

const INSTRUCTION_FEATURES = new Set<WasmFeatureName>([
  'atomic-instructions',
  'bulk-memory',
  'element-initialization',
  'exceptions',
  'indirect-calls',
  'memory-initialization',
  'reference-types',
  'simd',
  'tail-calls',
  'table-instructions',
  'typed-function-references',
]);

const FEATURE_SECTIONS: Record<WasmFeatureName, number[]> = {
  'atomic-instructions': [10],
  'bulk-memory': [10, 11],
  'element-initialization': [9, 10],
  exceptions: [2, 10, 13],
  'indirect-calls': [10],
  'memory-initialization': [10, 11],
  memory64: [2, 5],
  'multiple-memories': [2, 5, 10, 11],
  'multiple-tables': [2, 4, 9, 10],
  'reference-types': [1, 2, 4, 6, 9, 10, 11],
  'shared-memory': [2, 5, 10],
  simd: [1, 6, 10],
  'tail-calls': [10],
  'table-instructions': [10],
  'typed-function-references': [1, 2, 6, 9, 10],
};

class BinaryReader {
  offset = 0;

  constructor(readonly bytes: Buffer) {}

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  byte(): number {
    if (this.done) throw new Error('Unexpected end of WASM data');
    return this.bytes[this.offset++];
  }

  take(length: number): Buffer {
    if (length < 0 || this.offset + length > this.bytes.length)
      throw new Error('WASM field exceeds its containing section or function');
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  u32(): number {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const next = this.byte();
      result |= (next & 0x7f) << shift;
      if ((next & 0x80) === 0) return result >>> 0;
    }
    throw new Error('Invalid WASM unsigned LEB128 value');
  }

  s32(): number {
    let result = 0;
    let shift = 0;
    for (let count = 0; count < 5; count += 1) {
      const next = this.byte();
      result |= (next & 0x7f) << shift;
      shift += 7;
      if ((next & 0x80) === 0) {
        if (shift < 32 && (next & 0x40) !== 0) result |= ~0 << shift;
        return result | 0;
      }
    }
    throw new Error('Invalid WASM signed LEB128 value');
  }

  s64(): void {
    for (let count = 0; count < 10; count += 1) if ((this.byte() & 0x80) === 0) return;
    throw new Error('Invalid WASM signed LEB128 value');
  }

  u64(): void {
    for (let count = 0; count < 10; count += 1) if ((this.byte() & 0x80) === 0) return;
    throw new Error('Invalid WASM unsigned LEB128 value');
  }

  name(): string {
    return this.take(this.u32()).toString('utf8');
  }
}

interface ModuleSection {
  id: number;
  order: number;
  payload: Buffer;
}

function emptyFeature(): WasmFeatureEntry {
  return { status: 'not-detected', occurrenceCount: 0, functionsUsing: [], occurrences: [] };
}

function featureMap(): Record<WasmFeatureName, WasmFeatureEntry> {
  return Object.fromEntries(FEATURE_NAMES.map((name) => [name, emptyFeature()])) as Record<
    WasmFeatureName,
    WasmFeatureEntry
  >;
}

function readSections(bytes: Buffer): ModuleSection[] {
  if (bytes.length < 8 || !bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])))
    throw new Error('Invalid WASM binary: missing or truncated magic header');
  if (bytes.readUInt32LE(4) !== 1) throw new Error('Unsupported WASM binary version');
  const reader = new BinaryReader(bytes.subarray(8));
  const sections: ModuleSection[] = [];
  while (!reader.done) {
    const id = reader.byte();
    const size = reader.u32();
    sections.push({ id, order: sections.length, payload: reader.take(size) });
  }
  return sections;
}

function mark(
  features: Record<WasmFeatureName, WasmFeatureEntry>,
  name: WasmFeatureName,
  section: string,
  detail: string,
  functionIndex: number | null = null,
  instructionOffset: number | null = null,
): void {
  const feature = features[name];
  feature.status = 'detected';
  feature.occurrenceCount += 1;
  if (functionIndex !== null && !feature.functionsUsing.includes(functionIndex))
    feature.functionsUsing.push(functionIndex);
  feature.occurrences.push({ section, functionIndex, instructionOffset, detail });
}

const memory64Indices = new Set<number>();
let memoryCount = 0;

function parseLimits(reader: BinaryReader, memory = true): number {
  const flags = reader.u32();
  if (memory && (flags & 4) !== 0) markCurrent(reader, 'memory64');
  if (memory && (flags & 2) !== 0) markCurrent(reader, 'shared-memory');
  if ((flags & 4) !== 0) reader.u64();
  else reader.u32();
  if ((flags & 1) !== 0) {
    if ((flags & 4) !== 0) reader.u64();
    else reader.u32();
  }
  return flags;
}

let currentFeatures: Record<WasmFeatureName, WasmFeatureEntry>;
let currentSection = '';

function markCurrent(reader: BinaryReader, feature: WasmFeatureName): void {
  mark(currentFeatures, feature, currentSection, `encoded in ${currentSection} limits`);
  void reader;
}

function valueType(reader: BinaryReader, functionIndex: number | null = null): void {
  const type = reader.byte();
  if (type === 0x63 || type === 0x64) {
    mark(currentFeatures, 'reference-types', currentSection, 'reference value type');
    const heapType = reader.s32();
    if (heapType >= 0)
      mark(
        currentFeatures,
        'typed-function-references',
        currentSection,
        'indexed typed reference',
        functionIndex,
      );
  } else if (type === 0x70 || type === 0x6f) {
    mark(currentFeatures, 'reference-types', currentSection, 'reference value type');
  } else if (type === 0x7b) {
    mark(currentFeatures, 'simd', currentSection, 'v128 value type');
  }
}

function parseTypeSection(reader: BinaryReader): void {
  const count = reader.u32();
  for (let index = 0; index < count; index += 1) {
    const form = reader.byte();
    if (form === 0x60) {
      const params = reader.u32();
      for (let param = 0; param < params; param += 1) valueType(reader);
      const results = reader.u32();
      for (let result = 0; result < results; result += 1) valueType(reader);
    } else if (form === 0x4e) {
      const groupSize = reader.u32();
      for (let member = 0; member < groupSize; member += 1) parseSubtype(reader);
    } else if (form === 0x4f || form === 0x50) {
      parseSubtypeBody(reader);
    } else {
      throw new Error(`Unknown type form 0x${form.toString(16)}`);
    }
  }
}

function parseSubtype(reader: BinaryReader): void {
  const form = reader.byte();
  if (form === 0x4f || form === 0x50) parseSubtypeBody(reader);
  else if (form === 0x60) parseFuncType(reader);
  else throw new Error(`Unknown recursive type form 0x${form.toString(16)}`);
}

function parseSubtypeBody(reader: BinaryReader): void {
  const superCount = reader.u32();
  for (let index = 0; index < superCount; index += 1) reader.u32();
  const composite = reader.byte();
  if (composite === 0x60) {
    mark(currentFeatures, 'typed-function-references', currentSection, 'function subtype');
    parseFuncType(reader);
  } else if (composite === 0x5f) {
    const fields = reader.u32();
    for (let index = 0; index < fields; index += 1) {
      valueType(reader);
      reader.byte();
    }
  } else if (composite === 0x5e) {
    valueType(reader);
    reader.byte();
  } else throw new Error(`Unknown composite type 0x${composite.toString(16)}`);
}

function parseFuncType(reader: BinaryReader): void {
  const params = reader.u32();
  for (let index = 0; index < params; index += 1) valueType(reader);
  const results = reader.u32();
  for (let index = 0; index < results; index += 1) valueType(reader);
}

function parseTableType(reader: BinaryReader): void {
  valueType(reader);
  parseLimits(reader, false);
}

function parseMemoryType(reader: BinaryReader): void {
  const flags = parseLimits(reader);
  if ((flags & 4) !== 0) memory64Indices.add(memoryCount);
  memoryCount += 1;
}

function parseGlobalType(reader: BinaryReader): void {
  valueType(reader);
  reader.byte();
}

function parseGlobalSection(reader: BinaryReader): void {
  const count = reader.u32();
  for (let index = 0; index < count; index += 1) {
    parseGlobalType(reader);
    skipConstExpression(reader);
  }
}

function parseImportSection(reader: BinaryReader): {
  functions: number;
  tables: number;
  memories: number;
} {
  const count = reader.u32();
  let functions = 0;
  let tables = 0;
  let memories = 0;
  for (let index = 0; index < count; index += 1) {
    reader.name();
    reader.name();
    switch (reader.byte()) {
      case 0:
        reader.u32();
        functions += 1;
        break;
      case 1:
        parseTableType(reader);
        tables += 1;
        break;
      case 2:
        parseMemoryType(reader);
        memories += 1;
        break;
      case 3:
        parseGlobalType(reader);
        break;
      case 4:
        reader.byte();
        reader.u32();
        mark(currentFeatures, 'exceptions', currentSection, 'tag import');
        break;
      default:
        throw new Error('Unknown import descriptor kind');
    }
  }
  return { functions, tables, memories };
}

function parseResourceSection(reader: BinaryReader, kind: 'table' | 'memory'): number {
  const count = reader.u32();
  for (let index = 0; index < count; index += 1) {
    if (kind === 'table') parseTableType(reader);
    else parseMemoryType(reader);
  }
  return count;
}

function skipConstExpression(reader: BinaryReader): void {
  while (!reader.done) {
    const opcode = reader.byte();
    if (opcode === 0x0b) return;
    if (opcode === 0x41) reader.s32();
    else if (opcode === 0x42) reader.s64();
    else if (opcode === 0x43) reader.take(4);
    else if (opcode === 0x44) reader.take(8);
    else if (opcode === 0x23) reader.u32();
    else if (opcode === 0xd2) {
      reader.u32();
      mark(currentFeatures, 'reference-types', currentSection, 'constant-expression ref.func');
    } else if (opcode === 0xd0) {
      const heapType = reader.s32();
      mark(currentFeatures, 'reference-types', currentSection, 'constant-expression ref.null');
      if (heapType >= 0)
        mark(
          currentFeatures,
          'typed-function-references',
          currentSection,
          'typed constant reference',
        );
    } else throw new Error(`Unknown constant-expression opcode 0x${opcode.toString(16)}`);
  }
  throw new Error('Unterminated constant expression');
}

function parseElementSection(reader: BinaryReader): void {
  const count = reader.u32();
  for (let index = 0; index < count; index += 1) {
    const flags = reader.u32();
    const mode = flags & 3;
    if (mode !== 0) {
      mark(
        currentFeatures,
        'element-initialization',
        currentSection,
        `element segment mode ${mode}`,
      );
      mark(currentFeatures, 'reference-types', currentSection, 'non-active element segment');
    }
    if (mode === 0 || mode === 2) {
      if (mode === 2 && reader.u32() > 0)
        mark(currentFeatures, 'multiple-tables', currentSection, 'element segment table index');
      skipConstExpression(reader);
    }
    const expressionElements = (flags & 4) !== 0;
    if (expressionElements) {
      valueType(reader);
      const elements = reader.u32();
      for (let item = 0; item < elements; item += 1) skipConstExpression(reader);
    } else {
      if (mode !== 0) reader.byte();
      const elements = reader.u32();
      for (let item = 0; item < elements; item += 1) reader.u32();
    }
  }
}

function parseDataSection(reader: BinaryReader): void {
  const count = reader.u32();
  for (let index = 0; index < count; index += 1) {
    const flags = reader.u32();
    if (flags === 1) {
      mark(currentFeatures, 'bulk-memory', currentSection, 'passive data segment');
      mark(currentFeatures, 'memory-initialization', currentSection, 'passive data segment');
    } else if (flags === 2) {
      if (reader.u32() > 0)
        mark(currentFeatures, 'multiple-memories', currentSection, 'data segment memory index');
      skipConstExpression(reader);
    } else if (flags === 0) skipConstExpression(reader);
    else throw new Error(`Unknown data segment flags ${flags}`);
    reader.take(reader.u32());
  }
}

interface DecodeState {
  features: Record<WasmFeatureName, WasmFeatureEntry>;
  functionIndex: number;
  section: string;
  instructionScanComplete: boolean;
  warnings: string[];
}

function featureAt(
  state: DecodeState,
  name: WasmFeatureName,
  detail: string,
  offset: number,
): void {
  mark(state.features, name, state.section, detail, state.functionIndex, offset);
}

function memarg(reader: BinaryReader, state: DecodeState, offset: number): void {
  const alignment = reader.u32();
  let memoryIndex = 0;
  if ((alignment & 0x40) !== 0) {
    memoryIndex = reader.u32();
    if (memoryIndex > 0) featureAt(state, 'multiple-memories', 'indexed memory argument', offset);
  }
  if (memory64Indices.has(memoryIndex)) reader.u64();
  else reader.u32();
}

function decodePrefixed(
  reader: BinaryReader,
  state: DecodeState,
  prefix: number,
  offset: number,
): void {
  const subopcode = reader.u32();
  if (prefix === 0xfc) {
    if (subopcode <= 7) return;
    featureAt(state, 'bulk-memory', `0xfc.${subopcode}`, offset);
    if (subopcode === 8) {
      reader.u32();
      const memory = reader.u32();
      featureAt(state, 'memory-initialization', 'memory.init', offset);
      if (memory > 0) featureAt(state, 'multiple-memories', 'memory.init memory index', offset);
    } else if (subopcode === 9) {
      reader.u32();
      featureAt(state, 'memory-initialization', 'data.drop', offset);
    } else if (subopcode === 10) {
      const destination = reader.u32();
      const source = reader.u32();
      featureAt(state, 'memory-initialization', 'memory.copy', offset);
      if (destination > 0 || source > 0)
        featureAt(state, 'multiple-memories', 'memory.copy memory indices', offset);
    } else if (subopcode === 11) {
      reader.u32();
      featureAt(state, 'memory-initialization', 'memory.fill', offset);
    } else if (subopcode === 12) {
      reader.u32();
      const table = reader.u32();
      featureAt(state, 'element-initialization', 'table.init', offset);
      featureAt(state, 'reference-types', 'table.init', offset);
      if (table > 0) featureAt(state, 'multiple-tables', 'table.init table index', offset);
    } else if (subopcode === 13) {
      reader.u32();
      featureAt(state, 'element-initialization', 'elem.drop', offset);
      featureAt(state, 'reference-types', 'elem.drop', offset);
    } else if (subopcode === 14) {
      const destination = reader.u32();
      const source = reader.u32();
      featureAt(state, 'table-instructions', 'table.copy', offset);
      featureAt(state, 'reference-types', 'table.copy', offset);
      if (destination > 0 || source > 0)
        featureAt(state, 'multiple-tables', 'table.copy table indices', offset);
    } else if (subopcode >= 15 && subopcode <= 17) {
      const table = reader.u32();
      featureAt(state, 'table-instructions', `table operation 0xfc.${subopcode}`, offset);
      featureAt(state, 'reference-types', `table operation 0xfc.${subopcode}`, offset);
      if (table > 0) featureAt(state, 'multiple-tables', 'table instruction table index', offset);
    } else {
      throw new Error(`Unknown 0xfc opcode ${subopcode}`);
    }
    return;
  }
  if (prefix === 0xfd) {
    featureAt(state, 'simd', `0xfd.${subopcode}`, offset);
    if (subopcode <= 11) memarg(reader, state, offset);
    else if (subopcode === 12) reader.take(16);
    else if (subopcode === 13) reader.take(16);
    else if (subopcode >= 21 && subopcode <= 34) reader.byte();
    else if (subopcode >= 84 && subopcode <= 91) {
      memarg(reader, state, offset);
      reader.byte();
    } else if (subopcode > 0x113) throw new Error(`Unknown SIMD opcode ${subopcode}`);
    return;
  }
  if (prefix === 0xfe) {
    featureAt(state, 'atomic-instructions', `0xfe.${subopcode}`, offset);
    featureAt(state, 'shared-memory', 'atomic instruction', offset);
    if (subopcode === 3) reader.byte();
    else if (subopcode <= 2 || subopcode >= 0x10) memarg(reader, state, offset);
    else throw new Error(`Unknown atomic opcode ${subopcode}`);
    return;
  }
  throw new Error(`Unknown opcode prefix 0x${prefix.toString(16)}`);
}

function decodeInstruction(reader: BinaryReader, state: DecodeState): void {
  const offset = reader.offset;
  const opcode = reader.byte();
  if (opcode === 0xfc || opcode === 0xfd || opcode === 0xfe) {
    decodePrefixed(reader, state, opcode, offset);
    return;
  }
  if (
    opcode === 0x00 ||
    opcode === 0x01 ||
    opcode === 0x05 ||
    opcode === 0x0b ||
    opcode === 0x0f ||
    opcode === 0x1a ||
    opcode === 0x1b
  )
    return;
  if (opcode >= 0x02 && opcode <= 0x04) {
    reader.s32();
    return;
  }
  if (opcode === 0x1f) {
    featureAt(state, 'exceptions', 'try_table', offset);
    reader.s32();
    const catches = reader.u32();
    for (let index = 0; index < catches; index += 1) {
      const kind = reader.byte();
      if (kind === 0 || kind === 1) reader.u32();
      else if (kind > 3) throw new Error(`Unknown try_table catch kind ${kind}`);
      reader.u32();
    }
    return;
  }
  if (opcode >= 0x06 && opcode <= 0x0a) {
    featureAt(state, 'exceptions', `exception instruction 0x${opcode.toString(16)}`, offset);
    if (opcode === 0x06) reader.s32();
    else if (opcode >= 0x07 && opcode <= 0x09) reader.u32();
    return;
  }
  if (opcode === 0x18 || opcode === 0x19) {
    featureAt(state, 'exceptions', opcode === 0x18 ? 'delegate' : 'catch_all', offset);
    if (opcode === 0x18) reader.u32();
    return;
  }
  if (opcode === 0x0c || opcode === 0x0d || opcode === 0x10 || opcode === 0x12) {
    reader.u32();
    if (opcode === 0x12) featureAt(state, 'tail-calls', 'return_call', offset);
    return;
  }
  if (opcode === 0x0e) {
    const labels = reader.u32();
    for (let index = 0; index <= labels; index += 1) reader.u32();
    return;
  }
  if (opcode === 0x11 || opcode === 0x13) {
    reader.u32();
    const tableIndex = reader.u32();
    featureAt(
      state,
      'indirect-calls',
      opcode === 0x11 ? 'call_indirect' : 'return_call_indirect',
      offset,
    );
    if (opcode === 0x13) featureAt(state, 'tail-calls', 'return_call_indirect', offset);
    if (tableIndex > 0) featureAt(state, 'multiple-tables', 'indirect call table index', offset);
    return;
  }
  if (opcode === 0x14 || opcode === 0x15) {
    reader.u32();
    featureAt(
      state,
      'typed-function-references',
      opcode === 0x14 ? 'call_ref' : 'return_call_ref',
      offset,
    );
    featureAt(state, 'reference-types', 'typed function reference call', offset);
    if (opcode === 0x15) featureAt(state, 'tail-calls', 'return_call_ref', offset);
    return;
  }
  if (opcode === 0x1c) {
    const types = reader.u32();
    for (let index = 0; index < types; index += 1) valueType(reader, state.functionIndex);
    return;
  }
  if (opcode >= 0x20 && opcode <= 0x26) {
    const index = reader.u32();
    if (opcode === 0x25 || opcode === 0x26) {
      featureAt(state, 'table-instructions', 'table.get/set', offset);
      featureAt(state, 'reference-types', 'table.get/set', offset);
      if (index > 0) featureAt(state, 'multiple-tables', 'table.get/set table index', offset);
    }
    return;
  }
  if (opcode >= 0x28 && opcode <= 0x3e) {
    memarg(reader, state, offset);
    return;
  }
  if (opcode === 0x3f || opcode === 0x40) {
    const memoryIndex = reader.u32();
    if (memoryIndex > 0)
      featureAt(state, 'multiple-memories', 'memory.size/grow memory index', offset);
    return;
  }
  if (opcode === 0x41) {
    reader.s32();
    return;
  }
  if (opcode === 0x42) return reader.s64();
  if (opcode === 0x43) return void reader.take(4);
  if (opcode === 0x44) return void reader.take(8);
  if (opcode >= 0x45 && opcode <= 0xc4) return;
  if (opcode >= 0xd0 && opcode <= 0xd6) {
    featureAt(state, 'reference-types', `reference instruction 0x${opcode.toString(16)}`, offset);
    if (opcode === 0xd0) reader.s32();
    else if (opcode === 0xd2) reader.u32();
    else if (opcode === 0xd5 || opcode === 0xd6) reader.u32();
    return;
  }
  throw new Error(`Unknown opcode 0x${opcode.toString(16)}`);
}

function parseCodeSection(
  reader: BinaryReader,
  state: Omit<DecodeState, 'functionIndex'> & { functionIndexBase: number },
): number {
  const count = reader.u32();
  for (let bodyIndex = 0; bodyIndex < count; bodyIndex += 1) {
    const bodySize = reader.u32();
    const body = new BinaryReader(reader.take(bodySize));
    const functionIndex = state.functionIndexBase + bodyIndex;
    const localGroups = body.u32();
    for (let group = 0; group < localGroups; group += 1) {
      body.u32();
      valueType(body, functionIndex);
    }
    while (!body.done) {
      try {
        decodeInstruction(body, { ...state, functionIndex });
      } catch (error) {
        state.instructionScanComplete = false;
        state.warnings.push(
          `Function ${functionIndex}: ${error instanceof Error ? error.message : String(error)}; remaining instructions in this function were not decoded.`,
        );
        break;
      }
    }
  }
  return count;
}

export function analyzeWasmFeatures(bytes: Buffer, file?: string): WasmFeatureProfile {
  const sections = readSections(bytes);
  const features = featureMap();
  memory64Indices.clear();
  memoryCount = 0;
  currentFeatures = features;
  const profile: WasmFeatureProfile = {
    ...(file ? { file } : {}),
    header: { magic: '0061736d', version: bytes.readUInt32LE(4) },
    sections: sections.map((section) => ({
      id: section.id,
      name: SECTION_NAMES[section.id] ?? `unknown-${section.id}`,
      size: section.payload.length,
      order: section.order,
    })),
    functionsScanned: 0,
    instructionScanComplete: true,
    features,
    warnings: [],
  };
  const unknownSection = sections.some((section) => SECTION_NAMES[section.id] === undefined);
  if (unknownSection)
    profile.warnings.push(
      'Unknown standard section encountered; feature coverage may be incomplete.',
    );
  let tables = 0;
  let memories = 0;
  const unreadableSections = new Set<number>();
  let importedFunctions = 0;
  for (const section of sections) {
    currentSection = SECTION_NAMES[section.id] ?? `unknown-${section.id}`;
    const reader = new BinaryReader(section.payload);
    try {
      switch (section.id) {
        case 1:
          parseTypeSection(reader);
          break;
        case 2: {
          const imports = parseImportSection(reader);
          importedFunctions = imports.functions;
          tables += imports.tables;
          memories += imports.memories;
          break;
        }
        case 4:
          tables += parseResourceSection(reader, 'table');
          break;
        case 5:
          memories += parseResourceSection(reader, 'memory');
          break;
        case 6:
          parseGlobalSection(reader);
          break;
        case 9:
          parseElementSection(reader);
          break;
        case 10:
          profile.functionsScanned = parseCodeSection(reader, {
            features,
            section: 'code',
            instructionScanComplete: profile.instructionScanComplete,
            warnings: profile.warnings,
            functionIndexBase: importedFunctions,
          });
          profile.instructionScanComplete =
            profile.instructionScanComplete &&
            !profile.warnings.some((warning) => warning.startsWith('Function '));
          break;
        case 11:
          parseDataSection(reader);
          break;
        case 13:
          {
            const tags = reader.u32();
            for (let index = 0; index < tags; index += 1) {
              reader.byte();
              reader.u32();
              mark(features, 'exceptions', 'tag', 'tag section entry');
            }
          }
          break;
      }
    } catch (error) {
      unreadableSections.add(section.id);
      profile.warnings.push(
        `Section ${currentSection}: ${error instanceof Error ? error.message : String(error)}; remaining metadata was not decoded.`,
      );
      if (section.id === 10) profile.instructionScanComplete = false;
    }
  }
  if (tables > 1) mark(features, 'multiple-tables', 'table', `${tables} tables declared`);
  if (memories > 1) mark(features, 'multiple-memories', 'memory', `${memories} memories declared`);
  for (const name of FEATURE_NAMES) {
    const feature = features[name];
    feature.occurrences.sort((left, right) => {
      return (
        (SECTION_ORDER[left.section] ?? Number.MAX_SAFE_INTEGER) -
          (SECTION_ORDER[right.section] ?? Number.MAX_SAFE_INTEGER) ||
        (left.functionIndex ?? -1) - (right.functionIndex ?? -1) ||
        (left.instructionOffset ?? -1) - (right.instructionOffset ?? -1) ||
        left.section.localeCompare(right.section) ||
        left.detail.localeCompare(right.detail)
      );
    });
    feature.functionsUsing.sort((left, right) => left - right);
    if (
      feature.status !== 'detected' &&
      (unknownSection ||
        FEATURE_SECTIONS[name].some((sectionId) => unreadableSections.has(sectionId)))
    )
      feature.status = 'could-not-be-determined';
    else if (
      feature.status !== 'detected' &&
      INSTRUCTION_FEATURES.has(name) &&
      !profile.instructionScanComplete
    )
      feature.status = 'could-not-be-determined';
  }
  return profile;
}

export function compareWasmFeatureProfiles(
  before: WasmFeatureProfile,
  after: WasmFeatureProfile,
): WasmFeatureComparison {
  const newlyIntroducedFeatures: WasmFeatureName[] = [];
  const removedFeatures: WasmFeatureName[] = [];
  const changedUsageCounts: WasmFeatureChange[] = [];
  const functionsNewlyUsingFeatures: WasmFeatureChange[] = [];
  const functionsNoLongerUsingFeatures: WasmFeatureChange[] = [];
  for (const feature of FEATURE_NAMES) {
    const left = before.features[feature];
    const right = after.features[feature];
    if (left.status === 'not-detected' && right.status === 'detected')
      newlyIntroducedFeatures.push(feature);
    if (left.status === 'detected' && right.status === 'not-detected')
      removedFeatures.push(feature);
    const leftFunctions = new Set(left.functionsUsing);
    const rightFunctions = new Set(right.functionsUsing);
    const newlyUsingFunctions = [...rightFunctions]
      .filter((index) => !leftFunctions.has(index))
      .sort((a, b) => a - b);
    const noLongerUsingFunctions = [...leftFunctions]
      .filter((index) => !rightFunctions.has(index))
      .sort((a, b) => a - b);
    const change = {
      feature,
      beforeCount: left.occurrenceCount,
      afterCount: right.occurrenceCount,
      newlyUsingFunctions,
      noLongerUsingFunctions,
    };
    if (left.occurrenceCount !== right.occurrenceCount) changedUsageCounts.push(change);
    if (newlyUsingFunctions.length > 0) functionsNewlyUsingFeatures.push(change);
    if (noLongerUsingFunctions.length > 0) functionsNoLongerUsingFeatures.push(change);
  }
  return {
    before,
    after,
    newlyIntroducedFeatures,
    removedFeatures,
    changedUsageCounts,
    functionsNewlyUsingFeatures,
    functionsNoLongerUsingFeatures,
  };
}

export function analyzeWasmFeatureFile(file: string): WasmFeatureProfile {
  return analyzeWasmFeatures(readFileSync(file), file);
}
