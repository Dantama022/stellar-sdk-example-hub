import fs from 'fs';

import { compareBySignature, ComparisonResult, WasmValidationError } from './wasm-static-analysis';

/**
 * Offline WASM local-variable analysis.
 *
 * The module bytes are decoded statically: the WebAssembly runtime is never
 * used to compile, instantiate, or execute the artifact.
 */

export type WasmLocalKind = 'param' | 'local';

export interface WasmLocalDeclarationGroup {
  groupIndex: number;
  count: number;
  valueType: string;
  startIndex: number;
  endIndex: number;
}

export interface WasmLocalInfo {
  index: number;
  kind: WasmLocalKind;
  valueType: string;
  declarationGroup: number | null;
  reads: number;
  writes: number;
  tees: number;
  accessCount: number;
  referenced: boolean;
  writeOnly: boolean;
}

export interface WasmLocalAccessRef {
  functionIndex: number;
  exportName: string | null;
  localIndex: number;
  kind: WasmLocalKind;
  valueType: string;
  accessCount: number;
}

export interface WasmFunctionLocalsInfo {
  functionIndex: number;
  exportName: string | null;
  typeIndex: number;
  paramCount: number;
  declaredLocalCount: number;
  totalLocalCount: number;
  declarationGroups: WasmLocalDeclarationGroup[];
  paramsByValueType: Record<string, number>;
  localsByValueType: Record<string, number>;
  readCount: number;
  writeCount: number;
  teeCount: number;
  locals: WasmLocalInfo[];
  mostAccessedLocals: WasmLocalInfo[];
  unusedLocals: number[];
  unusedParams: number[];
  writeOnlyLocals: number[];
}

export interface WasmLocalsReport {
  file: string;
  valid: true;
  functions: WasmFunctionLocalsInfo[];
  statistics: {
    importedFunctionCount: number;
    definedFunctionCount: number;
    totalParams: number;
    totalDeclaredLocals: number;
    totalLocals: number;
    totalDeclarationGroups: number;
    averageDeclaredLocalsPerFunction: number;
    maxDeclaredLocalsPerFunction: number;
    paramsByValueType: Record<string, number>;
    localsByValueType: Record<string, number>;
    totalReads: number;
    totalWrites: number;
    totalTees: number;
    unusedLocalCount: number;
    unusedParamCount: number;
    writeOnlyLocalCount: number;
    mostAccessedLocals: WasmLocalAccessRef[];
    functionsWithMostLocals: Array<{
      functionIndex: number;
      exportName: string | null;
      declaredLocalCount: number;
      totalLocalCount: number;
    }>;
  };
}

export interface WasmLocalsComparison {
  before: WasmLocalsReport;
  after: WasmLocalsReport;
  comparison: {
    identical: boolean;
    functions: ComparisonResult<WasmFunctionLocalsInfo>;
    deltas: {
      definedFunctionCount: number;
      totalParams: number;
      totalDeclaredLocals: number;
      totalReads: number;
      totalWrites: number;
      totalTees: number;
      unusedLocalCount: number;
      localsByValueType: Record<string, number>;
    };
  };
}

/** Maximum locals per function accepted by mainstream engines (wasmparser, V8). */
export const MAX_LOCALS_PER_FUNCTION = 50000;

const MOST_ACCESSED_PER_FUNCTION = 5;
const MOST_ACCESSED_PER_MODULE = 10;
const TOP_FUNCTIONS = 10;

const VALUE_TYPES: Record<number, string> = {
  0x7f: 'i32',
  0x7e: 'i64',
  0x7d: 'f32',
  0x7c: 'f64',
  0x7b: 'v128',
  0x70: 'funcref',
  0x6f: 'externref',
};

class Reader {
  offset = 0;

  constructor(
    private readonly data: Buffer,
    private readonly context: string,
  ) {}

  get done(): boolean {
    return this.offset >= this.data.length;
  }

  private fail(message: string): never {
    throw new WasmValidationError(`${message} (${this.context}, offset ${this.offset})`);
  }

  byte(): number {
    if (this.offset >= this.data.length) this.fail('Unexpected end of WASM data');
    return this.data[this.offset++];
  }

  peek(): number {
    if (this.offset >= this.data.length) this.fail('Unexpected end of WASM data');
    return this.data[this.offset];
  }

  bytes(length: number): Buffer {
    if (length < 0 || this.offset + length > this.data.length) {
      this.fail('Length exceeds remaining WASM data');
    }
    const out = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  u32(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i += 1) {
      const byte = this.byte();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        if (result > 0xffffffff) this.fail('Unsigned LEB128 value exceeds 32 bits');
        return result;
      }
      shift += 7;
    }
    return this.fail('Invalid unsigned LEB128 value');
  }

  /** Consumes a signed LEB128 value of at most `maxBits` bits without decoding it. */
  skipSigned(maxBits: number): void {
    const maxBytes = Math.ceil(maxBits / 7);
    for (let i = 0; i < maxBytes; i += 1) {
      if ((this.byte() & 0x80) === 0) return;
    }
    this.fail('Invalid signed LEB128 value');
  }

  name(): string {
    return this.bytes(this.u32()).toString('utf8');
  }

  valueType(): string {
    const byte = this.byte();
    const name = VALUE_TYPES[byte];
    if (!name) this.fail(`Unsupported value type 0x${byte.toString(16)}`);
    return name;
  }
}

interface RawSection {
  id: number;
  payload: Buffer;
}

interface FuncType {
  params: string[];
  results: string[];
}

function readSections(wasm: Buffer): RawSection[] {
  if (wasm.length < 8) throw new WasmValidationError('Invalid WASM binary: file is too short');
  if (wasm.subarray(0, 4).compare(Buffer.from([0x00, 0x61, 0x73, 0x6d])) !== 0) {
    throw new WasmValidationError('Invalid WASM binary: missing WebAssembly magic header');
  }
  if (wasm.subarray(4, 8).compare(Buffer.from([0x01, 0x00, 0x00, 0x00])) !== 0) {
    throw new WasmValidationError('Unsupported WASM binary: expected version 1');
  }
  const reader = new Reader(wasm.subarray(8), 'module');
  const sections: RawSection[] = [];
  const seen = new Set<number>();
  while (!reader.done) {
    const id = reader.byte();
    if (id > 12) throw new WasmValidationError(`Invalid WASM binary: unknown section id ${id}`);
    const payload = reader.bytes(reader.u32());
    if (id !== 0) {
      if (seen.has(id)) {
        throw new WasmValidationError(`Invalid WASM binary: duplicate section id ${id}`);
      }
      seen.add(id);
    }
    sections.push({ id, payload });
  }
  return sections;
}

function parseTypes(section: RawSection | undefined): FuncType[] {
  if (!section) return [];
  const reader = new Reader(section.payload, 'type section');
  const count = reader.u32();
  const types: FuncType[] = [];
  for (let i = 0; i < count; i += 1) {
    const form = reader.byte();
    if (form !== 0x60) {
      throw new WasmValidationError(`Unsupported type form 0x${form.toString(16)} at type ${i}`);
    }
    const params = Array.from({ length: reader.u32() }, () => reader.valueType());
    const results = Array.from({ length: reader.u32() }, () => reader.valueType());
    types.push({ params, results });
  }
  return types;
}

function skipLimits(reader: Reader): void {
  const flags = reader.u32();
  reader.u32();
  if ((flags & 0x01) === 0x01) reader.u32();
}

function parseImportedFunctionTypes(section: RawSection | undefined): number[] {
  if (!section) return [];
  const reader = new Reader(section.payload, 'import section');
  const count = reader.u32();
  const typeIndices: number[] = [];
  for (let i = 0; i < count; i += 1) {
    reader.name();
    reader.name();
    const kind = reader.byte();
    if (kind === 0x00) typeIndices.push(reader.u32());
    else if (kind === 0x01) {
      reader.byte();
      skipLimits(reader);
    } else if (kind === 0x02) skipLimits(reader);
    else if (kind === 0x03) {
      reader.byte();
      reader.byte();
    } else if (kind === 0x04) {
      reader.byte();
      reader.u32();
    } else throw new WasmValidationError(`Unsupported import kind: ${kind}`);
  }
  return typeIndices;
}

function parseFunctionSection(section: RawSection | undefined): number[] {
  if (!section) return [];
  const reader = new Reader(section.payload, 'function section');
  return Array.from({ length: reader.u32() }, () => reader.u32());
}

function parseFunctionExports(section: RawSection | undefined): Map<number, string> {
  const names = new Map<number, string>();
  if (!section) return names;
  const reader = new Reader(section.payload, 'export section');
  const count = reader.u32();
  const entries: Array<[number, string]> = [];
  for (let i = 0; i < count; i += 1) {
    const name = reader.name();
    const kind = reader.byte();
    const index = reader.u32();
    if (kind === 0x00) entries.push([index, name]);
  }
  // Deterministic choice when a function is exported under several names.
  entries
    .sort(([a, nameA], [b, nameB]) => a - b || nameA.localeCompare(nameB))
    .forEach(([index, name]) => {
      if (!names.has(index)) names.set(index, name);
    });
  return names;
}

function skipBlockType(reader: Reader): void {
  const next = reader.peek();
  if (next === 0x40 || VALUE_TYPES[next] !== undefined) reader.byte();
  else reader.skipSigned(33);
}

function skipMemArg(reader: Reader): void {
  const align = reader.u32();
  // Multi-memory proposal: bit 6 of the alignment flags signals an explicit memory index.
  if ((align & 0x40) !== 0) reader.u32();
  reader.u32();
}

function skipPrefixedFc(reader: Reader): void {
  const sub = reader.u32();
  if (sub <= 7) return; // saturating truncation
  switch (sub) {
    case 8: // memory.init
    case 10: // memory.copy
    case 12: // table.init
    case 14: // table.copy
      reader.u32();
      reader.u32();
      return;
    case 9: // data.drop
    case 11: // memory.fill
    case 13: // elem.drop
    case 15: // table.grow
    case 16: // table.size
    case 17: // table.fill
      reader.u32();
      return;
    default:
      throw new WasmValidationError(`Unsupported 0xfc sub-opcode ${sub}`);
  }
}

interface LocalAccessCounters {
  reads: number[];
  writes: number[];
  tees: number[];
}

/**
 * Walks a function body's instruction stream, counting local.get / local.set /
 * local.tee accesses per local index and skipping every other immediate.
 */
function scanInstructions(
  body: Reader,
  totalLocals: number,
  functionIndex: number,
): LocalAccessCounters {
  const counters: LocalAccessCounters = {
    reads: new Array<number>(totalLocals).fill(0),
    writes: new Array<number>(totalLocals).fill(0),
    tees: new Array<number>(totalLocals).fill(0),
  };
  let depth = 1;
  while (!body.done) {
    if (depth === 0) {
      throw new WasmValidationError(
        `Function ${functionIndex} has instructions after its final end opcode`,
      );
    }
    const opcode = body.byte();
    if (opcode >= 0x20 && opcode <= 0x22) {
      const index = body.u32();
      if (index >= totalLocals) {
        throw new WasmValidationError(
          `Function ${functionIndex} references local ${index} but only ${totalLocals} locals exist`,
        );
      }
      if (opcode === 0x20) counters.reads[index] += 1;
      else if (opcode === 0x21) counters.writes[index] += 1;
      else counters.tees[index] += 1;
      continue;
    }
    if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04 || opcode === 0x06) {
      skipBlockType(body);
      depth += 1;
    } else if (opcode === 0x0b) {
      depth -= 1;
    } else if (opcode === 0x18) {
      // delegate (legacy exception handling) closes its try block.
      body.u32();
      depth -= 1;
    } else if (opcode === 0x0e) {
      const targets = body.u32();
      for (let i = 0; i <= targets; i += 1) body.u32();
    } else if (opcode === 0x1c) {
      const count = body.u32();
      for (let i = 0; i < count; i += 1) body.valueType();
    } else if (opcode === 0x11 || opcode === 0x13) {
      body.u32();
      body.u32();
    } else if (
      [0x07, 0x08, 0x09, 0x0c, 0x0d, 0x10, 0x12, 0x23, 0x24, 0x25, 0x26, 0xd2].includes(opcode)
    ) {
      body.u32();
    } else if (opcode >= 0x28 && opcode <= 0x3e) {
      skipMemArg(body);
    } else if (opcode === 0x3f || opcode === 0x40) {
      body.u32();
    } else if (opcode === 0x41) {
      body.skipSigned(32);
    } else if (opcode === 0x42) {
      body.skipSigned(64);
    } else if (opcode === 0x43) {
      body.bytes(4);
    } else if (opcode === 0x44) {
      body.bytes(8);
    } else if (opcode === 0xd0) {
      body.valueType();
    } else if (opcode === 0xfc) {
      skipPrefixedFc(body);
    } else if (opcode === 0xfd) {
      throw new WasmValidationError(
        `Function ${functionIndex} uses SIMD (0xfd) instructions, which are not supported by this analysis`,
      );
    } else if (
      opcode === 0x00 ||
      opcode === 0x01 ||
      opcode === 0x05 ||
      opcode === 0x0f ||
      opcode === 0x19 ||
      opcode === 0x1a ||
      opcode === 0x1b ||
      opcode === 0xd1 ||
      (opcode >= 0x45 && opcode <= 0xc4)
    ) {
      // No immediates.
    } else {
      throw new WasmValidationError(
        `Function ${functionIndex} contains unsupported or unknown opcode 0x${opcode.toString(16)}`,
      );
    }
  }
  if (depth !== 0) {
    throw new WasmValidationError(`Function ${functionIndex} body is missing its final end opcode`);
  }
  return counters;
}

function addCount(target: Record<string, number>, key: string, amount = 1): void {
  target[key] = (target[key] ?? 0) + amount;
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function byAccessDesc(a: WasmLocalInfo, b: WasmLocalInfo): number {
  return b.accessCount - a.accessCount || a.index - b.index;
}

function analyzeFunctionBody(
  bodyBytes: Buffer,
  functionIndex: number,
  typeIndex: number,
  type: FuncType,
  exportName: string | null,
): WasmFunctionLocalsInfo {
  const body = new Reader(bodyBytes, `function ${functionIndex}`);
  const params = type.params;
  const groupCount = body.u32();
  const declarationGroups: WasmLocalDeclarationGroup[] = [];
  const declaredTypes: Array<{ valueType: string; group: number }> = [];
  let nextIndex = params.length;
  for (let g = 0; g < groupCount; g += 1) {
    const count = body.u32();
    const valueType = body.valueType();
    if (declaredTypes.length + count > MAX_LOCALS_PER_FUNCTION) {
      throw new WasmValidationError(
        `Function ${functionIndex} declares more than ${MAX_LOCALS_PER_FUNCTION} locals`,
      );
    }
    declarationGroups.push({
      groupIndex: g,
      count,
      valueType,
      startIndex: nextIndex,
      endIndex: nextIndex + count - 1,
    });
    for (let i = 0; i < count; i += 1) declaredTypes.push({ valueType, group: g });
    nextIndex += count;
  }

  const totalLocals = params.length + declaredTypes.length;
  const counters = scanInstructions(body, totalLocals, functionIndex);

  const locals: WasmLocalInfo[] = [];
  for (let index = 0; index < totalLocals; index += 1) {
    const isParam = index < params.length;
    const declared = isParam ? null : declaredTypes[index - params.length];
    const reads = counters.reads[index];
    const writes = counters.writes[index];
    const tees = counters.tees[index];
    const accessCount = reads + writes + tees;
    locals.push({
      index,
      kind: isParam ? 'param' : 'local',
      valueType: isParam ? params[index] : (declared as { valueType: string }).valueType,
      declarationGroup: declared ? declared.group : null,
      reads,
      writes,
      tees,
      accessCount,
      referenced: accessCount > 0,
      // local.tee both writes and yields the value, so it does not count as a read of the local.
      writeOnly: writes + tees > 0 && reads === 0,
    });
  }

  const paramsByValueType: Record<string, number> = {};
  const localsByValueType: Record<string, number> = {};
  locals.forEach((local) =>
    addCount(local.kind === 'param' ? paramsByValueType : localsByValueType, local.valueType),
  );
  const declared = locals.filter((local) => local.kind === 'local');

  return {
    functionIndex,
    exportName,
    typeIndex,
    paramCount: params.length,
    declaredLocalCount: declared.length,
    totalLocalCount: totalLocals,
    declarationGroups,
    paramsByValueType: sortedRecord(paramsByValueType),
    localsByValueType: sortedRecord(localsByValueType),
    readCount: counters.reads.reduce((sum, value) => sum + value, 0),
    writeCount: counters.writes.reduce((sum, value) => sum + value, 0),
    teeCount: counters.tees.reduce((sum, value) => sum + value, 0),
    locals,
    mostAccessedLocals: locals
      .filter((local) => local.accessCount > 0)
      .sort(byAccessDesc)
      .slice(0, MOST_ACCESSED_PER_FUNCTION),
    unusedLocals: declared.filter((local) => !local.referenced).map((local) => local.index),
    unusedParams: locals
      .filter((local) => local.kind === 'param' && !local.referenced)
      .map((local) => local.index),
    writeOnlyLocals: declared.filter((local) => local.writeOnly).map((local) => local.index),
  };
}

/** Analyses local-variable declarations and accesses from WASM bytes. */
export function analyzeLocalsBuffer(wasm: Buffer, file = '<buffer>'): WasmLocalsReport {
  const sections = readSections(wasm);
  const find = (id: number) => sections.find((section) => section.id === id);
  const types = parseTypes(find(1));
  const importedTypes = parseImportedFunctionTypes(find(2));
  const functionTypes = parseFunctionSection(find(3));
  const exports = parseFunctionExports(find(7));

  const codeSection = find(10);
  const code = codeSection ? new Reader(codeSection.payload, 'code section') : null;
  const bodyCount = code ? code.u32() : 0;
  if (bodyCount !== functionTypes.length) {
    throw new WasmValidationError(
      `Invalid WASM binary: function section declares ${functionTypes.length} functions but code section has ${bodyCount} bodies`,
    );
  }
  importedTypes.forEach((typeIndex) => {
    if (typeIndex >= types.length) {
      throw new WasmValidationError(`Imported function references unknown type ${typeIndex}`);
    }
  });

  const functions: WasmFunctionLocalsInfo[] = functionTypes.map((typeIndex, i) => {
    const functionIndex = importedTypes.length + i;
    const type = types[typeIndex];
    if (!type) {
      throw new WasmValidationError(
        `Function ${functionIndex} references unknown type ${typeIndex}`,
      );
    }
    const bodyBytes = (code as Reader).bytes((code as Reader).u32());
    return analyzeFunctionBody(
      bodyBytes,
      functionIndex,
      typeIndex,
      type,
      exports.get(functionIndex) ?? null,
    );
  });
  if (code && !code.done) {
    throw new WasmValidationError('Invalid WASM binary: trailing bytes in code section');
  }

  const paramsByValueType: Record<string, number> = {};
  const localsByValueType: Record<string, number> = {};
  functions.forEach((fn) => {
    Object.entries(fn.paramsByValueType).forEach(([t, n]) => addCount(paramsByValueType, t, n));
    Object.entries(fn.localsByValueType).forEach(([t, n]) => addCount(localsByValueType, t, n));
  });
  const sum = (pick: (fn: WasmFunctionLocalsInfo) => number) =>
    functions.reduce((total, fn) => total + pick(fn), 0);
  const totalDeclaredLocals = sum((fn) => fn.declaredLocalCount);

  const mostAccessedLocals: WasmLocalAccessRef[] = functions
    .flatMap((fn) =>
      fn.locals
        .filter((local) => local.accessCount > 0)
        .map((local) => ({
          functionIndex: fn.functionIndex,
          exportName: fn.exportName,
          localIndex: local.index,
          kind: local.kind,
          valueType: local.valueType,
          accessCount: local.accessCount,
        })),
    )
    .sort(
      (a, b) =>
        b.accessCount - a.accessCount ||
        a.functionIndex - b.functionIndex ||
        a.localIndex - b.localIndex,
    )
    .slice(0, MOST_ACCESSED_PER_MODULE);

  return {
    file,
    valid: true,
    functions,
    statistics: {
      importedFunctionCount: importedTypes.length,
      definedFunctionCount: functions.length,
      totalParams: sum((fn) => fn.paramCount),
      totalDeclaredLocals,
      totalLocals: sum((fn) => fn.totalLocalCount),
      totalDeclarationGroups: sum((fn) => fn.declarationGroups.length),
      averageDeclaredLocalsPerFunction:
        functions.length === 0 ? 0 : totalDeclaredLocals / functions.length,
      maxDeclaredLocalsPerFunction:
        functions.length === 0 ? 0 : Math.max(...functions.map((fn) => fn.declaredLocalCount)),
      paramsByValueType: sortedRecord(paramsByValueType),
      localsByValueType: sortedRecord(localsByValueType),
      totalReads: sum((fn) => fn.readCount),
      totalWrites: sum((fn) => fn.writeCount),
      totalTees: sum((fn) => fn.teeCount),
      unusedLocalCount: sum((fn) => fn.unusedLocals.length),
      unusedParamCount: sum((fn) => fn.unusedParams.length),
      writeOnlyLocalCount: sum((fn) => fn.writeOnlyLocals.length),
      mostAccessedLocals,
      functionsWithMostLocals: [...functions]
        .sort(
          (a, b) =>
            b.declaredLocalCount - a.declaredLocalCount ||
            b.totalLocalCount - a.totalLocalCount ||
            a.functionIndex - b.functionIndex,
        )
        .slice(0, TOP_FUNCTIONS)
        .map((fn) => ({
          functionIndex: fn.functionIndex,
          exportName: fn.exportName,
          declaredLocalCount: fn.declaredLocalCount,
          totalLocalCount: fn.totalLocalCount,
        })),
    },
  };
}

export function analyzeLocals(file: string): WasmLocalsReport {
  let wasm: Buffer;
  try {
    wasm = fs.readFileSync(file);
  } catch (error) {
    throw new WasmValidationError(
      `Unable to read WASM file "${file}": ${(error as Error).message}`,
    );
  }
  return analyzeLocalsBuffer(wasm, file);
}

function functionIdentity(fn: WasmFunctionLocalsInfo): string {
  return fn.exportName !== null ? `export:${fn.exportName}` : `index:${fn.functionIndex}`;
}

function localTypeSignature(fn: WasmFunctionLocalsInfo): string {
  return fn.locals.map((local) => `${local.kind}:${local.valueType}`).join(',');
}

function accessSignature(fn: WasmFunctionLocalsInfo): string {
  return fn.locals.map((local) => `${local.reads}/${local.writes}/${local.tees}`).join(',');
}

export function functionLocalChanges(
  before: WasmFunctionLocalsInfo,
  after: WasmFunctionLocalsInfo,
): string[] {
  const changes: string[] = [];
  if (before.paramCount !== after.paramCount) changes.push('param_count');
  if (before.declaredLocalCount !== after.declaredLocalCount) changes.push('local_count');
  if (localTypeSignature(before) !== localTypeSignature(after)) changes.push('local_types');
  if (JSON.stringify(before.declarationGroups) !== JSON.stringify(after.declarationGroups)) {
    changes.push('declaration_groups');
  }
  if (before.readCount !== after.readCount) changes.push('read_count');
  if (before.writeCount !== after.writeCount) changes.push('write_count');
  if (before.teeCount !== after.teeCount) changes.push('tee_count');
  if (accessSignature(before) !== accessSignature(after)) changes.push('access_pattern');
  if (JSON.stringify(before.unusedLocals) !== JSON.stringify(after.unusedLocals)) {
    changes.push('unused_locals');
  }
  return changes;
}

export function compareLocalsReports(
  before: WasmLocalsReport,
  after: WasmLocalsReport,
): WasmLocalsComparison {
  const functions = compareBySignature(
    before.functions,
    after.functions,
    functionIdentity,
    (fn) =>
      JSON.stringify([
        localTypeSignature(fn),
        fn.declarationGroups.map((g) => [g.count, g.valueType]),
        accessSignature(fn),
      ]),
    functionLocalChanges,
  );
  const typeKeys = [
    ...new Set([
      ...Object.keys(before.statistics.localsByValueType),
      ...Object.keys(after.statistics.localsByValueType),
    ]),
  ].sort();
  const delta = (pick: (report: WasmLocalsReport) => number) => pick(after) - pick(before);
  return {
    before,
    after,
    comparison: {
      identical:
        functions.added.length === 0 &&
        functions.removed.length === 0 &&
        functions.changed.length === 0,
      functions,
      deltas: {
        definedFunctionCount: delta((r) => r.statistics.definedFunctionCount),
        totalParams: delta((r) => r.statistics.totalParams),
        totalDeclaredLocals: delta((r) => r.statistics.totalDeclaredLocals),
        totalReads: delta((r) => r.statistics.totalReads),
        totalWrites: delta((r) => r.statistics.totalWrites),
        totalTees: delta((r) => r.statistics.totalTees),
        unusedLocalCount: delta((r) => r.statistics.unusedLocalCount),
        localsByValueType: Object.fromEntries(
          typeKeys.map((t) => [
            t,
            (after.statistics.localsByValueType[t] ?? 0) -
              (before.statistics.localsByValueType[t] ?? 0),
          ]),
        ),
      },
    },
  };
}

export function compareLocalsFiles(beforeFile: string, afterFile: string): WasmLocalsComparison {
  return compareLocalsReports(analyzeLocals(beforeFile), analyzeLocals(afterFile));
}
