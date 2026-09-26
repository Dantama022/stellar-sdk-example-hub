import * as fs from 'fs';
import { EntryObservation, Snapshot, loadSnapshot, validateSnapshotOrder } from './197-state-lifecycle';

type WasmKind = 'function' | 'table' | 'memory' | 'global' | 'tag';

interface WasmSection {
  id: number;
  name: string;
  customName?: string;
  size: number;
  payloadSize: number;
  category: string;
}

interface WasmType {
  parameters: string[];
  results: string[];
}

interface WasmImport {
  module: string;
  name: string;
  kind: WasmKind;
  type: string;
  typeIndex?: number;
}

interface WasmExport {
  name: string;
  kind: WasmKind;
  type: string;
  index: number;
}

interface WasmModuleInfo {
  byteLength: number;
  sections: WasmSection[];
  types: WasmType[];
  imports: WasmImport[];
  exports: WasmExport[];
  functionTypes: number[];
  definedTables: string[];
  definedMemories: string[];
  definedGlobals: string[];
}

const sectionNames: Record<number, string> = {
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

const sectionOrder: Record<number, number> = {
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

const valueTypes: Record<number, string> = {
  0x7f: 'i32',
  0x7e: 'i64',
  0x7d: 'f32',
  0x7c: 'f64',
  0x7b: 'v128',
  0x70: 'funcref',
  0x6f: 'externref',
};

class WasmReader {
  offset: number;

  constructor(
    private readonly bytes: Uint8Array,
    offset = 0,
    private readonly end = bytes.length,
  ) {
    this.offset = offset;
  }

  get remaining(): number {
    return this.end - this.offset;
  }

  byte(): number {
    this.require(1);
    return this.bytes[this.offset++];
  }

  u32(): number {
    let value = 0;
    let shift = 0;
    for (let index = 0; index < 5; index += 1) {
      const next = this.byte();
      value |= (next & 0x7f) << shift;
      if ((next & 0x80) === 0) {
        if (index === 4 && next > 0x0f) throw new Error('Invalid WASM unsigned integer.');
        return value >>> 0;
      }
      shift += 7;
    }
    throw new Error('Invalid WASM unsigned integer.');
  }

  name(): string {
    const length = this.u32();
    const data = this.take(length);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      throw new Error('WASM name contains invalid UTF-8.');
    }
  }

  vector<T>(readItem: () => T): T[] {
    const count = this.u32();
    if (count > this.remaining) throw new Error('WASM vector exceeds its section boundary.');
    const values: T[] = [];
    for (let index = 0; index < count; index += 1) values.push(readItem());
    return values;
  }

  take(length: number): Uint8Array {
    this.require(length);
    const data = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return data;
  }

  finish(): void {
    if (this.offset !== this.end) throw new Error('WASM section contains malformed or unsupported data.');
  }

  private require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      throw new Error('WASM binary is truncated or contains an invalid section length.');
    }
  }
}

function readValueType(reader: WasmReader): string {
  const value = reader.byte();
  return valueTypes[value] ?? `0x${value.toString(16).padStart(2, '0')}`;
}

function readLimits(reader: WasmReader): string {
  const flags = reader.u32();
  if ((flags & ~0x03) !== 0) throw new Error('Unsupported WASM memory/table limits flags.');
  const minimum = reader.u32();
  const maximum = (flags & 0x01) !== 0 ? reader.u32() : undefined;
  const shared = (flags & 0x02) !== 0 ? ', shared' : '';
  return maximum === undefined ? `min ${minimum}${shared}` : `min ${minimum}, max ${maximum}${shared}`;
}

function readTableType(reader: WasmReader): string {
  const element = readValueType(reader);
  return `${element} ${readLimits(reader)}`;
}

function readMemoryType(reader: WasmReader): string {
  return readLimits(reader);
}

function readGlobalType(reader: WasmReader): string {
  const type = readValueType(reader);
  const mutable = reader.byte();
  if (mutable > 1) throw new Error('Invalid WASM global mutability.');
  return `${type}${mutable ? ' mutable' : ' immutable'}`;
}

function kindName(kind: number): WasmKind {
  switch (kind) {
    case 0:
      return 'function';
    case 1:
      return 'table';
    case 2:
      return 'memory';
    case 3:
      return 'global';
    case 4:
      return 'tag';
    default:
      throw new Error(`Unsupported WASM import/export kind ${kind}.`);
  }
}

function parseWasm(input: Uint8Array): WasmModuleInfo {
  if (input.length < 8 || input[0] !== 0 || input[1] !== 0x61 || input[2] !== 0x73 || input[3] !== 0x6d) {
    throw new Error('Invalid WASM file: missing WebAssembly magic header.');
  }
  if (input[4] !== 1 || input[5] !== 0 || input[6] !== 0 || input[7] !== 0) {
    throw new Error('Unsupported WASM binary version.');
  }
  if (!WebAssembly.validate(input)) throw new Error('WASM binary failed WebAssembly validation.');

  const reader = new WasmReader(input, 8);
  const sections: WasmSection[] = [];
  const types: WasmType[] = [];
  const imports: WasmImport[] = [];
  const exports: WasmExport[] = [];
  const functionTypes: number[] = [];
  const definedTables: string[] = [];
  const definedMemories: string[] = [];
  const definedGlobals: string[] = [];
  let lastSectionOrder = 0;

  while (reader.remaining > 0) {
    const start = reader.offset;
    const id = reader.byte();
    const payloadLength = reader.u32();
    const payloadStart = reader.offset;
    if (payloadLength > reader.remaining) throw new Error('WASM binary is truncated or contains an invalid section length.');
    const sectionReader = new WasmReader(input, payloadStart, payloadStart + payloadLength);
    const standardName = sectionNames[id];
    if (id !== 0 && standardName === undefined) throw new Error(`Unsupported WASM section id ${id}.`);
    const order = sectionOrder[id];
    if (id !== 0 && (order === undefined || order <= lastSectionOrder)) {
      throw new Error('WASM sections are out of order or duplicated.');
    }
    if (id !== 0) lastSectionOrder = order;

    let customName: string | undefined;
    if (id === 0) {
      customName = sectionReader.name();
    } else if (id === 1) {
      types.push(
        ...sectionReader.vector(() => {
          if (sectionReader.byte() !== 0x60) throw new Error('Unsupported WASM type form.');
          return {
            parameters: sectionReader.vector(() => readValueType(sectionReader)),
            results: sectionReader.vector(() => readValueType(sectionReader)),
          };
        }),
      );
      sectionReader.finish();
    } else if (id === 2) {
      imports.push(
        ...sectionReader.vector(() => {
          const module = sectionReader.name();
          const name = sectionReader.name();
          const kind = kindName(sectionReader.byte());
          let type = '';
          let typeIndex: number | undefined;
          if (kind === 'function') {
            typeIndex = sectionReader.u32();
            type = `type ${typeIndex}`;
          } else if (kind === 'table') type = readTableType(sectionReader);
          else if (kind === 'memory') type = readMemoryType(sectionReader);
          else if (kind === 'global') type = readGlobalType(sectionReader);
          else type = `attribute ${sectionReader.byte()}, type ${sectionReader.u32()}`;
          return { module, name, kind, type, typeIndex };
        }),
      );
      sectionReader.finish();
    } else if (id === 3) {
      functionTypes.push(...sectionReader.vector(() => sectionReader.u32()));
      sectionReader.finish();
    } else if (id === 4) {
      definedTables.push(...sectionReader.vector(() => readTableType(sectionReader)));
      sectionReader.finish();
    } else if (id === 5) {
      definedMemories.push(...sectionReader.vector(() => readMemoryType(sectionReader)));
      sectionReader.finish();
    } else if (id === 6) {
      definedGlobals.push(
        ...sectionReader.vector(() => {
          const type = readGlobalType(sectionReader);
          skipExpression(sectionReader);
          return type;
        }),
      );
      sectionReader.finish();
    } else if (id === 7) {
      exports.push(
        ...sectionReader.vector(() => {
          const name = sectionReader.name();
          const kind = kindName(sectionReader.byte());
          return { name, kind, index: sectionReader.u32(), type: '' };
        }),
      );
      sectionReader.finish();
    }

    const sectionEnd = payloadStart + payloadLength;
    reader.offset = sectionEnd;
    sections.push({
      id,
      name: standardName ?? 'custom',
      customName,
      size: sectionEnd - start,
      payloadSize: payloadLength,
      category: categoryForSection(id),
    });
  }

  const importedByKind = (kind: WasmKind) => imports.filter((entry) => entry.kind === kind);
  for (const entry of imports) {
    if (entry.kind === 'function') entry.type = formatFunctionType(types[entry.typeIndex ?? -1]);
  }
  const indexTypes: Record<WasmKind, string[]> = {
    function: [
      ...importedByKind('function').map((entry) => entry.type),
      ...functionTypes.map((index) => formatFunctionType(types[index])),
    ],
    table: [...importedByKind('table').map((entry) => entry.type), ...definedTables],
    memory: [...importedByKind('memory').map((entry) => entry.type), ...definedMemories],
    global: [...importedByKind('global').map((entry) => entry.type), ...definedGlobals],
    tag: importedByKind('tag').map((entry) => entry.type),
  };
  for (const entry of exports) entry.type = indexTypes[entry.kind][entry.index] ?? 'unknown';

  return { byteLength: input.length, sections, types, imports, exports, functionTypes, definedTables, definedMemories, definedGlobals };
}

function skipExpression(reader: WasmReader): void {
  let depth = 1;
  while (depth > 0) {
    const opcode = reader.byte();
    if (opcode === 0x0b) depth -= 1;
    else if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) {
      depth += 1;
      reader.byte();
    } else if (opcode === 0x41 || opcode === 0x42) {
      skipLeb(reader);
    } else if (opcode === 0x43) reader.take(4);
    else if (opcode === 0x44) reader.take(8);
    else if (opcode === 0x23 || opcode === 0xd2) reader.u32();
    else if (opcode === 0xd0) reader.byte();
    else if (opcode === 0xfc) {
      const subopcode = reader.u32();
      if (subopcode === 8) {
        reader.u32();
        reader.u32();
      } else if (subopcode === 9 || subopcode === 11 || subopcode === 13 || subopcode === 15 || subopcode === 16 || subopcode === 17) {
        reader.u32();
      } else if (subopcode === 10 || subopcode === 12 || subopcode === 14) {
        reader.u32();
        reader.u32();
      }
    } else if (opcode === 0x1c) {
      const count = reader.u32();
      reader.take(count);
    } else if (opcode === 0x00 || opcode === 0x01 || opcode === 0x0f || opcode === 0x1a || opcode === 0x1b) {
      continue;
    } else if (opcode >= 0x28 && opcode <= 0x3e) {
      reader.u32();
      reader.u32();
    } else if (opcode === 0x0c || opcode === 0x0d || opcode === 0x10 || opcode === 0x20 || opcode === 0x21 || opcode === 0x22 || opcode === 0x24 || opcode === 0x25 || opcode === 0x26) {
      reader.u32();
    } else if (opcode === 0x11) {
      reader.u32();
      reader.u32();
    } else if (opcode === 0x40) {
      reader.byte();
    } else if (opcode === 0x07 || opcode === 0x08 || opcode === 0x09 || opcode === 0x0a || opcode === 0x18 || opcode === 0xd4 || opcode === 0xd5) {
      reader.u32();
    } else if (opcode === 0x1f) {
      reader.u32();
      reader.u32();
    }
  }
}

function skipLeb(reader: WasmReader): void {
  for (let index = 0; index < 10; index += 1) if ((reader.byte() & 0x80) === 0) return;
  throw new Error('Invalid WASM constant expression.');
}

function formatFunctionType(type: WasmType | undefined): string {
  return type ? `(${type.parameters.join(', ')}) -> (${type.results.join(', ')})` : 'unknown';
}

function categoryForSection(id: number): string {
  if (id === 1) return 'type';
  if (id === 2) return 'import';
  if (id === 7) return 'export';
  if (id === 10) return 'code';
  if (id === 11) return 'data';
  return 'other';
}

function loadWasm(filePath: string): WasmModuleInfo {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error: unknown) {
    throw new Error(`Cannot read WASM file "${filePath}": ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseWasm(bytes);
  } catch (error: unknown) {
    throw new Error(`Invalid or unsupported WASM file "${filePath}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface WasmFootprintReport {
  file: string;
  totalBytes: number;
  sectionCount: number;
  sections: Array<WasmSection & { percent: number }>;
  aggregates: Record<string, { bytes: number; percent: number }>;
  comparison?: {
    file: string;
    totalBytes: number;
    totalDeltaBytes: number;
    sections: Array<{ section: string; beforeBytes: number; afterBytes: number; deltaBytes: number }>;
  };
}

export function analyzeWasmFootprint(filePath: string, compareFile?: string): WasmFootprintReport {
  const info = loadWasm(filePath);
  const aggregates: Record<string, { bytes: number; percent: number }> = {};
  for (const name of ['code', 'data', 'type', 'import', 'export', 'other']) aggregates[name] = { bytes: 0, percent: 0 };
  for (const section of info.sections) aggregates[section.category].bytes += section.size;
  aggregates.other.bytes += 8;
  for (const aggregate of Object.values(aggregates)) aggregate.percent = percentage(aggregate.bytes, info.byteLength);
  const sections = info.sections.map((section) => ({ ...section, percent: percentage(section.size, info.byteLength) }));
  const report: WasmFootprintReport = {
    file: filePath,
    totalBytes: info.byteLength,
    sectionCount: sections.length,
    sections,
    aggregates,
  };
  if (compareFile) {
    const compareInfo = loadWasm(compareFile);
    const before = sectionSizeMap(info.sections);
    const after = sectionSizeMap(compareInfo.sections);
    const sectionKeys = [...new Set([...before.keys(), ...after.keys()])].sort();
    report.comparison = {
      file: compareFile,
      totalBytes: compareInfo.byteLength,
      totalDeltaBytes: compareInfo.byteLength - info.byteLength,
      sections: sectionKeys
        .map((section) => ({
          section,
          beforeBytes: before.get(section) ?? 0,
          afterBytes: after.get(section) ?? 0,
          deltaBytes: (after.get(section) ?? 0) - (before.get(section) ?? 0),
        }))
        .filter((entry) => entry.deltaBytes !== 0),
    };
  }
  return report;
}

function percentage(size: number, total: number): number {
  return total === 0 ? 0 : Number(((size / total) * 100).toFixed(4));
}

function sectionSizeMap(sections: WasmSection[]): Map<string, number> {
  const counts = new Map<string, number>();
  const result = new Map<string, number>();
  for (const section of sections) {
    const base = section.customName === undefined ? section.name : `custom:${section.customName}`;
    const occurrence = (counts.get(base) ?? 0) + 1;
    counts.set(base, occurrence);
    result.set(`${base}#${occurrence}`, section.size);
  }
  return result;
}

export interface WasmCompatibilityReport {
  oldFile: string;
  newFile: string;
  unchanged: boolean;
  imports: { added: WasmImport[]; removed: WasmImport[]; modified: Array<{ before: WasmImport; after: WasmImport }> };
  exports: { added: WasmExport[]; removed: WasmExport[]; modified: Array<{ before: WasmExport; after: WasmExport }> };
}

function compareEntries<T>(
  before: T[],
  after: T[],
  identity: (entry: T) => string,
  signature: (entry: T) => string,
): { added: T[]; removed: T[]; modified: Array<{ before: T; after: T }> } {
  const oldMap = new Map(before.map((entry) => [identity(entry), entry]));
  const newMap = new Map(after.map((entry) => [identity(entry), entry]));
  const added: T[] = [];
  const removed: T[] = [];
  const modified: Array<{ before: T; after: T }> = [];
  for (const key of [...new Set([...oldMap.keys(), ...newMap.keys()])].sort()) {
    const oldEntry = oldMap.get(key);
    const newEntry = newMap.get(key);
    if (!oldEntry && newEntry) added.push(newEntry);
    else if (oldEntry && !newEntry) removed.push(oldEntry);
    else if (oldEntry && newEntry && signature(oldEntry) !== signature(newEntry)) {
      modified.push({ before: oldEntry, after: newEntry });
    }
  }
  return { added, removed, modified };
}

export function compareWasmCompatibility(oldFile: string, newFile: string): WasmCompatibilityReport {
  const oldModule = loadWasm(oldFile);
  const newModule = loadWasm(newFile);
  const imports = compareEntries(
    oldModule.imports,
    newModule.imports,
    (entry) => `${entry.module}\0${entry.name}\0${entry.kind}`,
    (entry) => entry.type,
  );
  const exports = compareEntries(
    oldModule.exports,
    newModule.exports,
    (entry) => `${entry.name}\0${entry.kind}`,
    (entry) => entry.type,
  );
  const unchanged = imports.added.length + imports.removed.length + imports.modified.length + exports.added.length + exports.removed.length + exports.modified.length === 0;
  return { oldFile, newFile, unchanged, imports, exports };
}

export interface WasmDependencyReport {
  file: string;
  importCount: number;
  uniqueDependencyCount: number;
  countsByType: Record<WasmKind, number>;
  modules: Array<{ module: string; countsByType: Record<WasmKind, number>; imports: WasmImport[] }>;
  dependencies: WasmImport[];
  comparison?: { file: string; shared: WasmImport[]; added: WasmImport[]; removed: WasmImport[] };
}

function dependencyKey(entry: WasmImport): string {
  return `${entry.module}\0${entry.name}\0${entry.kind}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueImports(entries: WasmImport[]): WasmImport[] {
  const values = new Map<string, WasmImport>();
  for (const entry of entries) if (!values.has(dependencyKey(entry))) values.set(dependencyKey(entry), entry);
  return [...values.values()].sort((left, right) => compareText(dependencyKey(left), dependencyKey(right)));
}

export function analyzeWasmDependencies(filePath: string, compareFile?: string): WasmDependencyReport {
  const info = loadWasm(filePath);
  const dependencies = uniqueImports(info.imports);
  const kinds: WasmKind[] = ['function', 'memory', 'table', 'global', 'tag'];
  const countsByType = Object.fromEntries(kinds.map((kind) => [kind, dependencies.filter((entry) => entry.kind === kind).length])) as Record<WasmKind, number>;
  const moduleNames = [...new Set(dependencies.map((entry) => entry.module))].sort();
  const report: WasmDependencyReport = {
    file: filePath,
    importCount: info.imports.length,
    uniqueDependencyCount: dependencies.length,
    countsByType,
    modules: moduleNames.map((module) => {
      const moduleImports = dependencies.filter((entry) => entry.module === module);
      return {
        module,
        countsByType: Object.fromEntries(kinds.map((kind) => [kind, moduleImports.filter((entry) => entry.kind === kind).length])) as Record<WasmKind, number>,
        imports: moduleImports,
      };
    }),
    dependencies,
  };
  if (compareFile) {
    const other = uniqueImports(loadWasm(compareFile).imports);
    const otherKeys = new Set(other.map(dependencyKey));
    const currentKeys = new Set(dependencies.map(dependencyKey));
    report.comparison = {
      file: compareFile,
      shared: dependencies.filter((entry) => otherKeys.has(dependencyKey(entry))),
      added: other.filter((entry) => !currentKeys.has(dependencyKey(entry))),
      removed: dependencies.filter((entry) => !otherKeys.has(dependencyKey(entry))),
    };
  }
  return report;
}

function printReport(title: string, report: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(title);
  console.log(JSON.stringify(report, null, 2));
}

function wasmArgs(args: string[]): { files: string[]; json: boolean } {
  const unknownFlags = args.filter((arg) => arg.startsWith('--') && arg !== '--json');
  if (unknownFlags.length > 0) throw new Error(`Unknown WASM analysis option: ${unknownFlags[0]}`);
  return { files: args.filter((arg) => !arg.startsWith('--')), json: args.includes('--json') };
}

export async function runWasmFootprint(args: string[]): Promise<void> {
  const { files, json } = wasmArgs(args);
  if (files.length < 1 || files.length > 2) throw new Error('Usage: wasm-footprint <wasmFile> [compareWasmFile] [--json]');
  const report = analyzeWasmFootprint(files[0], files[1]);
  if (!json) {
    console.log(`WASM footprint: ${report.file}\nTotal: ${report.totalBytes} bytes\nSections: ${report.sectionCount}`);
    for (const section of report.sections) {
      const type = section.customName ? `custom (${section.customName})` : section.name;
      console.log(`section ${section.id} ${type}: ${section.size} bytes (${section.percent}%, ${section.payloadSize} payload bytes, ${section.category})`);
    }
    console.log('Aggregates:');
    for (const [name, aggregate] of Object.entries(report.aggregates)) {
      console.log(`  ${name}: ${aggregate.bytes} bytes (${aggregate.percent}%)`);
    }
    if (report.comparison) {
      console.log(`Comparison with ${report.comparison.file}: ${report.comparison.totalDeltaBytes > 0 ? '+' : ''}${report.comparison.totalDeltaBytes} bytes`);
      if (report.comparison.sections.length === 0) console.log('  No section size changes.');
      for (const section of report.comparison.sections) {
        console.log(`  ${section.section}: ${section.beforeBytes} -> ${section.afterBytes} bytes (${section.deltaBytes > 0 ? '+' : ''}${section.deltaBytes})`);
      }
    }
    return;
  }
  printReport('', report, true);
}

export async function runWasmCompatibility(args: string[]): Promise<void> {
  const { files, json } = wasmArgs(args);
  if (files.length !== 2) throw new Error('Usage: wasm-compat <old.wasm> <new.wasm> [--json]');
  const report = compareWasmCompatibility(files[0], files[1]);
  printReport(report.unchanged ? 'WASM compatibility: unchanged' : 'WASM compatibility changes', report, json);
}

export async function runWasmDependencies(args: string[]): Promise<void> {
  const { files, json } = wasmArgs(args);
  if (files.length < 1 || files.length > 2) throw new Error('Usage: wasm-deps <wasmFile> [compareWasmFile] [--json]');
  const report = analyzeWasmDependencies(files[0], files[1]);
  printReport(`WASM dependencies: ${report.uniqueDependencyCount} unique`, report, json);
}

export type StateTransitionType = 'created' | 'reappeared' | 'removed' | 'persisting' | 'value-changed' | 'durability-changed' | 'ttl-increased' | 'ttl-decreased' | 'ttl-unchanged' | 'ttl-unknown';

const stateTransitionTypes: StateTransitionType[] = [
  'created',
  'reappeared',
  'removed',
  'persisting',
  'value-changed',
  'durability-changed',
  'ttl-increased',
  'ttl-decreased',
  'ttl-unchanged',
  'ttl-unknown',
];

export interface StateTransitionRow {
  contractId: string;
  previousState: string;
  currentState: string;
  transitionType: StateTransitionType;
  count: number;
  ledgerKeys: string[];
}

export interface StateTransitionReport {
  snapshotCount: number;
  snapshotLedgers: Array<number | undefined>;
  rows: StateTransitionRow[];
}

export interface StateTransitionOptions {
  contractId?: string;
  transitionType?: StateTransitionType;
  minimumFrequency?: number;
}

function stateName(entry: EntryObservation | undefined): string {
  return entry ? `present:${entry.durability}` : 'absent';
}

export function analyzeStateTransitions(snapshots: Snapshot[], options: StateTransitionOptions = {}): StateTransitionReport {
  if (snapshots.length < 2) throw new Error('At least two snapshots are required for state transition analysis.');
  const violations = validateSnapshotOrder(snapshots);
  if (violations.length > 0) throw new Error(`Snapshot ordering validation failed: ${violations.join(' ')}`);
  const byKey = new Map<string, Array<EntryObservation | undefined>>();
  snapshots.forEach((snapshot, index) => {
    const current = new Map<string, EntryObservation>();
    for (const entry of snapshot.entries) current.set(entry.ledgerKey, entry);
    for (const [key, observations] of byKey) observations[index] = current.get(key);
    for (const [key, entry] of current) {
      if (!byKey.has(key)) {
        const observations: Array<EntryObservation | undefined> = Array(snapshots.length).fill(undefined);
        observations[index] = entry;
        byKey.set(key, observations);
      }
    }
  });

  const grouped = new Map<string, StateTransitionRow>();
  const add = (key: string, contractId: string | undefined, previous: string, current: string, type: StateTransitionType) => {
    const resolvedContract = contractId ?? 'unknown';
    if (options.contractId && options.contractId !== resolvedContract) return;
    if (options.transitionType && options.transitionType !== type) return;
    const groupingKey = `${resolvedContract}\0${previous}\0${current}\0${type}`;
    const row = grouped.get(groupingKey) ?? { contractId: resolvedContract, previousState: previous, currentState: current, transitionType: type, count: 0, ledgerKeys: [] };
    row.count += 1;
    row.ledgerKeys.push(key);
    grouped.set(groupingKey, row);
  };

  for (const [key, observations] of [...byKey.entries()].sort(([left], [right]) => compareText(left, right))) {
    for (let index = 1; index < snapshots.length; index += 1) {
      const before = observations[index - 1];
      const after = observations[index];
      const previousState = stateName(before);
      const currentState = stateName(after);
      const contractId = after?.contractId ?? before?.contractId;
      if (!before && after) {
        const existedEarlier = observations.slice(0, index - 1).some((entry) => entry !== undefined);
        add(key, contractId, previousState, currentState, existedEarlier ? 'reappeared' : 'created');
      } else if (before && !after) {
        add(key, contractId, previousState, currentState, 'removed');
      } else if (before && after) {
        let changed = false;
        if (before.valueXdr !== after.valueXdr || before.valueDecoded !== after.valueDecoded) {
          add(key, contractId, previousState, currentState, 'value-changed');
          changed = true;
        }
        if (before.durability !== after.durability) {
          add(key, contractId, previousState, currentState, 'durability-changed');
          changed = true;
        }
        if (before.liveUntilLedgerSeq === undefined || after.liveUntilLedgerSeq === undefined) {
          add(key, contractId, previousState, currentState, 'ttl-unknown');
        } else if (before.liveUntilLedgerSeq < after.liveUntilLedgerSeq) {
          add(key, contractId, previousState, currentState, 'ttl-increased');
          changed = true;
        } else if (before.liveUntilLedgerSeq > after.liveUntilLedgerSeq) {
          add(key, contractId, previousState, currentState, 'ttl-decreased');
          changed = true;
        } else add(key, contractId, previousState, currentState, 'ttl-unchanged');
        if (!changed) add(key, contractId, previousState, currentState, 'persisting');
      }
    }
  }

  const minimumFrequency = Math.max(1, options.minimumFrequency ?? 1);
  const rows = [...grouped.values()]
    .filter((row) => row.count >= minimumFrequency)
    .map((row) => ({ ...row, ledgerKeys: row.ledgerKeys.sort() }))
    .sort((left, right) => compareText(
      `${left.contractId}\0${left.transitionType}\0${left.previousState}\0${left.currentState}`,
      `${right.contractId}\0${right.transitionType}\0${right.previousState}\0${right.currentState}`,
    ));
  return { snapshotCount: snapshots.length, snapshotLedgers: snapshots.map((snapshot) => snapshot.ledger), rows };
}

function parseStateOptions(args: string[]): { files: string[]; json: boolean; options: StateTransitionOptions } {
  const files: string[] = [];
  const options: StateTransitionOptions = {};
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') json = true;
    else if (arg === '--contract' || arg === '--type' || arg === '--min-frequency') {
      const value = args[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      if (arg === '--contract') options.contractId = value;
      else if (arg === '--type') {
        if (!stateTransitionTypes.includes(value as StateTransitionType)) {
          throw new Error(`Unsupported transition type "${value}".`);
        }
        options.transitionType = value as StateTransitionType;
      }
      else {
        const frequency = Number(value);
        if (!Number.isInteger(frequency) || frequency < 1) throw new Error('--min-frequency must be a positive integer.');
        options.minimumFrequency = frequency;
      }
    } else if (arg.startsWith('--')) throw new Error(`Unknown state-transitions option: ${arg}`);
    else files.push(arg);
  }
  return { files, json, options };
}

export async function runStateTransitions(args: string[]): Promise<void> {
  const { files, json, options } = parseStateOptions(args);
  if (files.length < 2) throw new Error('Usage: state-transitions <snapshot-001.json> <snapshot-002.json> [...] [--contract <id>] [--type <transition>] [--min-frequency <count>] [--json]');
  const snapshots = files.map(loadSnapshot);
  const report = analyzeStateTransitions(snapshots, options);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Soroban state transition matrix (${report.snapshotCount} snapshots)`);
  console.log(`Ledgers: ${report.snapshotLedgers.map((ledger) => ledger ?? 'unknown').join(' -> ')}`);
  if (report.rows.length === 0) console.log('No transitions matched.');
  for (const row of report.rows) console.log(`${row.contractId} | ${row.previousState} -> ${row.currentState} | ${row.transitionType} | ${row.count} | ${row.ledgerKeys.join(', ')}`);
}