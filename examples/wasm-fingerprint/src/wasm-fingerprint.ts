import { sha256 } from 'js-sha256';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// WASM section types
const enum SectionType {
  Custom = 0,
  Type = 1,
  Import = 2,
  Function = 3,
  Table = 4,
  Memory = 5,
  Global = 6,
  Export = 7,
  Start = 8,
  Element = 9,
  Code = 10,
  Data = 11,
  DataCount = 12,
}

// Type definitions
interface TypeDef {
  form: number;
  params: number[];
  results: number[];
}

interface ImportDesc {
  type: 'func' | 'table' | 'mem' | 'global';
  index: number;
}

interface ExportDesc {
  type: 'func' | 'table' | 'mem' | 'global';
  index: number;
}

interface ElementSegment {
  type: number;
  elements: number[];
  mode: 'passive' | 'active' | 'declarative';
}

interface DataSegment {
  type: 'active' | 'passive';
  memoryIndex?: number;
  offset?: number;
  data: Uint8Array;
}

interface WasmModule {
  types: TypeDef[];
  imports: Array<{ module: string; name: string; desc: ImportDesc }>;
  functions: number[];
  tables: Array<{ type: number; min: number; max?: number }>;
  memories: Array<{ min: number; max?: number }>;
  globals: Array<{ type: number; mutable: boolean; init: Uint8Array }>;
  exports: Array<{ name: string; desc: ExportDesc }>;
  start?: number;
  elements: ElementSegment[];
  code: Uint8Array[];
  data: DataSegment[];
}

interface Fingerprints {
  rawBinaryFingerprint: string;
  semanticModuleFingerprint: string;
  typeFingerprint: string;
  importExportFingerprint: string;
  codeFingerprint: string;
  memoryTableFingerprint: string;
  globalFingerprint: string;
  dataElementFingerprint: string;
}

interface ComparisonResult {
  binaryMatch: boolean;
  semanticMatch: boolean;
  differenceType: 'binary-only' | 'metadata-only' | 'semantic';
  changedComponents: string[];
}

// Main fingerprinting function
function computeFingerprints(wasmBuffer: Uint8Array): Fingerprints {
  const rawBinaryFingerprint = sha256(wasmBuffer);
  
  const module = parseWasmModule(wasmBuffer);
  const normalized = normalizeModule(module);
  
  const semanticModuleFingerprint = computeSemanticFingerprint(normalized);
  const typeFingerprint = computeTypeFingerprint(normalized.types);
  const importExportFingerprint = computeImportExportFingerprint(normalized);
  const codeFingerprint = computeCodeFingerprint(normalized.code);
  const memoryTableFingerprint = computeMemoryTableFingerprint(normalized);
  const globalFingerprint = computeGlobalFingerprint(normalized.globals);
  const dataElementFingerprint = computeDataElementFingerprint(normalized);

  return {
    rawBinaryFingerprint,
    semanticModuleFingerprint,
    typeFingerprint,
    importExportFingerprint,
    codeFingerprint,
    memoryTableFingerprint,
    globalFingerprint,
    dataElementFingerprint,
  };
}

function compareFingerprints(wasmBuffer1: Uint8Array, wasmBuffer2: Uint8Array): ComparisonResult {
  const fp1 = computeFingerprints(wasmBuffer1);
  const fp2 = computeFingerprints(wasmBuffer2);

  const binaryMatch = fp1.rawBinaryFingerprint === fp2.rawBinaryFingerprint;
  const semanticMatch = fp1.semanticModuleFingerprint === fp2.semanticModuleFingerprint;

  let differenceType: ComparisonResult['differenceType'] = 'semantic';
  const changedComponents: string[] = [];

  if (binaryMatch) {
    differenceType = 'binary-only';
  } else if (semanticMatch) {
    differenceType = 'metadata-only';
  } else {
    if (fp1.typeFingerprint !== fp2.typeFingerprint) changedComponents.push('types');
    if (fp1.importExportFingerprint !== fp2.importExportFingerprint) changedComponents.push('imports/exports');
    if (fp1.codeFingerprint !== fp2.codeFingerprint) changedComponents.push('code');
    if (fp1.memoryTableFingerprint !== fp2.memoryTableFingerprint) changedComponents.push('memory/table');
    if (fp1.globalFingerprint !== fp2.globalFingerprint) changedComponents.push('globals');
    if (fp1.dataElementFingerprint !== fp2.dataElementFingerprint) changedComponents.push('data/elements');
  }

  return {
    binaryMatch,
    semanticMatch,
    differenceType,
    changedComponents,
  };
}

// WASM parsing
function parseWasmModule(wasmBuffer: Uint8Array): WasmModule {
  const view = new DataView(wasmBuffer.buffer, wasmBuffer.byteOffset, wasmBuffer.byteLength);
  let offset = 0;

  // Magic number and version
  const magic = view.getUint32(offset, true);
  offset += 4;
  if (magic !== 0x6d736100) throw new Error('Invalid WASM magic number');

  const version = view.getUint32(offset, true);
  offset += 4;
  if (version !== 1) throw new Error('Unsupported WASM version');

  const module: WasmModule = {
    types: [],
    imports: [],
    functions: [],
    tables: [],
    memories: [],
    globals: [],
    exports: [],
    elements: [],
    code: [],
    data: [],
  };

  while (offset < view.byteLength) {
    const sectionStart = offset;
    const sectionSize = view.getUint32(offset, true);
    offset += 4;

    const sectionType = view.getUint8(offset) as SectionType;
    offset += 1;

    switch (sectionType) {
      case SectionType.Type:
        module.types = parseTypeSection(view, offset, sectionSize - 1);
        break;
      case SectionType.Import:
        module.imports = parseImportSection(view, offset, sectionSize - 1);
        break;
      case SectionType.Function:
        module.functions = parseFunctionSection(view, offset, sectionSize - 1);
        break;
      case SectionType.Table:
        module.tables = parseTableSection(view, offset, sectionSize - 1);
        break;
      case SectionType.Memory:
        module.memories = parseMemorySection(view, offset, sectionSize - 1);
        break;
      case SectionType.Global:
        module.globals = parseGlobalSection(view, offset, sectionSize - 1);
        break;
      case SectionType.Export:
        module.exports = parseExportSection(view, offset, sectionSize - 1);
        break;
      case SectionType.Start:
        module.start = view.getUint32(offset, true);
        break;
      case SectionType.Element:
        module.elements = parseElementSection(view, offset, sectionSize - 1);
        break;
      case SectionType.Code:
        module.code = parseCodeSection(view, offset, sectionSize - 1);
        break;
      case SectionType.Data:
        module.data = parseDataSection(view, offset, sectionSize - 1);
        break;
      // Skip custom sections
      case SectionType.Custom:
        break;
      default:
        console.warn(`Skipping unknown section type: ${sectionType}`);
    }

    offset = sectionStart + 4 + sectionSize;
  }

  return module;
}

function parseTypeSection(view: DataView, offset: number, size: number): TypeDef[] {
  const end = offset + size;
  const count = view.getVarUint32(offset);
  offset += count.bytesRead;

  const types: TypeDef[] = [];
  for (let i = 0; i < count.value; i++) {
    const form = view.getUint8(offset++);
    const params: number[] = [];
    const paramCount = view.getVarUint32(offset);
    offset += paramCount.bytesRead;
    for (let j = 0; j < paramCount.value; j++) {
      params.push(view.getUint8(offset++));
    }

    const results: number[] = [];
    const resultCount = view.getVarUint32(offset);
    offset += resultCount.bytesRead;
    for (let j = 0; j < resultCount.value; j++) {
      results.push(view.getUint8(offset++));
    }

    types.push({ form, params, results });
  }

  return types;
}

function parseImportSection(view: DataView, offset: number, size: number): Array<{ module: string; name: string; desc: ImportDesc }> {
  const end = offset + size;
  const count = view.getVarUint32(offset);
  offset += count.bytesRead;

  const imports: Array<{ module: string; name: string; desc: ImportDesc }> = [];
  for (let i = 0; i < count.value; i++) {
    const module = view.getString(offset);
    offset += module.bytesRead;
    const name = view.getString(offset);
    offset += name.bytesRead;

    const type = view.getUint8(offset++) as 0 | 1 | 2 | 3;
    let desc: ImportDesc;
    switch (type) {
      case 0:
        desc = { type: 'func', index: view.getVarUint32(offset).value };
        offset += view.getVarUint32(offset).bytesRead;
        break;
      case 1:
        desc = { type: 'table', index: view.getVarUint32(offset).value };
        offset += view.getVarUint32(offset).bytesRead;
        break;
      case 2:
        desc = { type: 'mem', index: view.getVarUint32(offset).value };
        offset += view.getVarUint32(offset).bytesRead;
        break;
      case 3:
        desc = { type: 'global', index: view.getVarUint32(offset).value };
        offset += view.getVarUint32(offset).bytesRead;
        break;
      default:
        throw new Error(`Unknown import type: ${type}`);
    }

    imports.push({ module, name, desc });
  }

  return imports;
}

function parseFunctionSection(view: DataView, offset: number, size: number): number[] {
  const end = offset + size;
  const count = view.getVarUint32(offset);
  offset += count.bytesRead;

  const functions: number[] = [];
  for (let i = 0; i < count.value; i++) {
    functions.push(view.getVarUint32(offset).value);
    offset += view.getVarUint32(offset).bytesRead;
  }

  return functions;
}

function parseTableSection(view: DataView, offset: number, size: number): Array<{ type: number; min: number; max?: number }> {
  const end = offset + size;
  const count = view.getVarUint32(offset);
  offset += count.bytesRead;

  const tables: Array<{ type: number; min: number; max?: number }> = [];
  for (let i = 0; i < count.value; i++) {
    const type = view.getUint8(offset++);
    const min = view.getVarUint32(offset).value;
    offset += view.getVarUint32(offset).bytesRead;
    const max = view.getVarUint32(offset).value;
    offset += view.getVarUint32(offset).bytesRead;

    tables.push({ type, min, max });
  }

  return tables;
}

function parseMemorySection(view: DataView, offset: number, size: number): Array<{ min: number; max?: number }> {
  const end = offset + size;
  const count = view.getVarUint32(offset);
  offset += count.bytesRead;

  const memories: Array<{ min: number; max?: number }> = [];
  for (let i = 0; i < count.value; i++) {
    const min = view.getVarUint32(offset).value;
    offset += view.getVarUint32(offset).bytesRead;
    const max = view.getVarUint32(offset).value;
    offset += view.getVarUint32(offset).bytesRead;

    memories.push({ min, max });
  }

  return memories;
}

function parseGlobalSection(view: DataView, offset: number, size: number): Array<{ type: number; mutable: boolean; init: Uint8Array }> {
  const end = offset + size;
  const count = view.getVarUint32(offset);
  offset += count.bytesRead;

  const globals: Array<{ type: number; mutable: boolean; init: Uint8Array }> = [];
  for (let i = 0; i < count.value; i++) {
    const type = view.getUint8(offset++);
    const mutable = view.getUint8(offset++) === 1;
    const init = view.getBytes(offset);
    offset += init.bytesRead;

    globals.push({ type, mutable, init: new Uint8Array(init.value) });
  }

  return globals;
}

function parseExportSection(view: DataView, offset: number, size: number): Array<{ name: string; desc: ExportDesc }> {
  const end = offset + size;
  const count = view.getVarUint32(offset);
  offset += count.bytesRead;

  const exports: Array<{ name: string; desc: ExportDesc }> = [];
  for (let i = 0; i < count.value; i++) {
    const name = view.getString(offset);
    offset += name.bytesRead;

    const type = view.getUint8(offset++) as 0 | 1 | 2 | 3;
    const index = view.getVarUint32(offset).value;
    offset += view.getVarUint32(offset).bytesRead;

    let desc: ExportDesc;
    switch (type) {
      case 0: desc = { type: 'func', index }; break;
      case 1: desc = { type: 'table', index }; break;
      case 2: desc = { type: 'mem', index }; break;
      case 3: desc = { type: 'global', index }; break;
      default: throw new Error(`Unknown export type: ${type}`);
    }

    exports.push({ name, desc });
  }

  return exports;
}

function parseElementSection(view: DataView, offset: number, size: number): ElementSegment[] {
  const end = offset + size;
  const count = view.getVarUint32(offset);
  offset += count.bytesRead;

  const elements: ElementSegment[] = [];
  for (let i = 0; i < count.value; i++) {
    const type = view.getUint8(offset++);
    const mode = view.getVarUint32(offset).value;

    let segment: ElementSegment;
    switch (mode) {
      case 0: // Passive
        segment = { type, elements: [], mode: 'passive' };
        break;
      case 1: // Active
        segment = {
          type,
          elements: [],
          mode: 'active',
          memoryIndex: view.getVarUint32(offset).value,
          offset: view.getVarUint32(offset).value,
        };
        offset += view.getVarUint32(offset).bytesRead * 2;
        break;
      case 2: // Declarative
        segment = { type, elements: [], mode: 'declarative' };
        break;
      default:
        throw new Error(`Unknown element mode: ${mode}`);
    }

    const elemCount = view.getVarUint32(offset);
    offset += elemCount.bytesRead;
    for (let j = 0; j < elemCount.value; j++) {
      segment.elements.push(view.getVarUint32(offset).value);
      offset += view.getVarUint32(offset).bytesRead;
    }

    elements.push(segment);
  }

  return elements;
}

function parseCodeSection(view: DataView, offset: number, size: number): Uint8Array[] {
  const end = offset + size;
  const count = view.getVarUint32(offset);
  offset += count.bytesRead;

  const code: Uint8Array[] = [];
  for (let i = 0; i < count.value; i++) {
    const bodySize = view.getVarUint32(offset).value;
    offset += view.getVarUint32(offset).bytesRead;
    const body = new Uint8Array(view.buffer, offset, bodySize);
    offset += bodySize;
    code.push(body);
  }

  return code;
}

function parseDataSection(view: DataView, offset: number, size: number): DataSegment[] {
  const end = offset + size;
  const count = view.getVarUint32(offset);
  offset += count.bytesRead;

  const data: DataSegment[] = [];
  for (let i = 0; i < count.value; i++) {
    const type = view.getVarUint32(offset).value;
    let segment: DataSegment;

    if (type === 0) { // Active
      segment = {
        type: 'active',
        memoryIndex: view.getVarUint32(offset).value,
        offset: view.getVarUint32(offset).value,
        data: new Uint8Array(view.buffer, offset, 0),
      };
      offset += view.getVarUint32(offset).bytesRead * 2;
    } else { // Passive
      segment = { type: 'passive', data: new Uint8Array(view.buffer, offset, 0) };
    }

    const dataSize = view.getVarUint32(offset).value;
    offset += view.getVarUint32(offset).bytesRead;
    segment.data = new Uint8Array(view.buffer, offset, dataSize);
    offset += dataSize;

    data.push(segment);
  }

  return data;
}

// Normalization
function normalizeModule(module: WasmModule): WasmModule {
  return {
    types: normalizeTypes(module.types),
    imports: [...module.imports].sort((a, b) => 
      a.module.localeCompare(b.module) || a.name.localeCompare(b.name) || 
      a.desc.type.localeCompare(b.desc.type) || a.desc.index - b.desc.index
    ),
    functions: [...module.functions].sort((a, b) => a - b),
    tables: [...module.tables].sort((a, b) => 
      a.type - b.type || a.min - b.min || (a.max ?? 0) - (b.max ?? 0)
    ),
    memories: [...module.memories].sort((a, b) => 
      a.min - b.min || (a.max ?? 0) - (b.max ?? 0)
    ),
    globals: normalizeGlobals(module.globals),
    exports: [...module.exports].sort((a, b) => 
      a.name.localeCompare(b.name) || a.desc.type.localeCompare(b.desc.type) || a.desc.index - b.desc.index
    ),
    start: module.start,
    elements: normalizeElements(module.elements),
    code: module.code,
    data: normalizeDataSegments(module.data),
  };
}

function normalizeTypes(types: TypeDef[]): TypeDef[] {
  return [...types].sort((a, b) => {
    if (a.form !== b.form) return a.form - b.form;
    if (a.params.length !== b.params.length) return a.params.length - b.params.length;
    for (let i = 0; i < a.params.length; i++) {
      if (a.params[i] !== b.params[i]) return a.params[i] - b.params[i];
    }
    if (a.results.length !== b.results.length) return a.results.length - b.results.length;
    for (let i = 0; i < a.results.length; i++) {
      if (a.results[i] !== b.results[i]) return a.results[i] - b.results[i];
    }
    return 0;
  });
}

function normalizeGlobals(globals: Array<{ type: number; mutable: boolean; init: Uint8Array }>): Array<{ type: number; mutable: boolean; init: Uint8Array }> {
  return [...globals].sort((a, b) => {
    if (a.type !== b.type) return a.type - b.type;
    if (a.mutable !== b.mutable) return a.mutable ? 1 : -1;
    return compareByteArrays(a.init, b.init);
  });
}

function normalizeElements(elements: ElementSegment[]): ElementSegment[] {
  return [...elements].sort((a, b) => {
    if (a.type !== b.type) return a.type - b.type;
    if (a.mode !== b.mode) return a.mode.localeCompare(b.mode);
    if (a.mode === 'active') {
      if (a.memoryIndex !== b.memoryIndex) return (a.memoryIndex ?? 0) - (b.memoryIndex ?? 0);
      if (a.offset !== b.offset) return a.offset! - b.offset!;
    }
    if (a.elements.length !== b.elements.length) return a.elements.length - b.elements.length;
    for (let i = 0; i < a.elements.length; i++) {
      if (a.elements[i] !== b.elements[i]) return a.elements[i] - b.elements[i];
    }
    return 0;
  });
}

function normalizeDataSegments(data: DataSegment[]): DataSegment[] {
  return [...data].sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    if (a.type === 'active') {
      if (a.memoryIndex !== b.memoryIndex) return (a.memoryIndex ?? 0) - (b.memoryIndex ?? 0);
      if (a.offset !== b.offset) return a.offset! - b.offset!;
    }
    return compareByteArrays(a.data, b.data);
  });
}

function compareByteArrays(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Fingerprint computation
function computeSemanticFingerprint(module: WasmModule): string {
  const data = JSON.stringify({
    types: module.types,
    imports: module.imports,
    functions: module.functions,
    tables: module.tables,
    memories: module.memories,
    globals: module.globals,
    exports: module.exports,
    start: module.start,
    elements: module.elements,
    data: module.data,
  });
  return sha256(data);
}

function computeTypeFingerprint(types: TypeDef[]): string {
  const data = JSON.stringify(types);
  return sha256(data);
}

function computeImportExportFingerprint(module: WasmModule): string {
  const data = JSON.stringify({
    imports: module.imports,
    exports: module.exports,
  });
  return sha256(data);
}

function computeCodeFingerprint(code: Uint8Array[]): string {
  const data = JSON.stringify(code.map(c => Array.from(c)));
  return sha256(data);
}

function computeMemoryTableFingerprint(module: WasmModule): string {
  const data = JSON.stringify({
    tables: module.tables,
    memories: module.memories,
  });
  return sha256(data);
}

function computeGlobalFingerprint(globals: Array<{ type: number; mutable: boolean; init: Uint8Array }>): string {
  const data = JSON.stringify(globals);
  return sha256(data);
}

function computeDataElementFingerprint(module: WasmModule): string {
  const data = JSON.stringify({
    elements: module.elements,
    data: module.data,
  });
  return sha256(data);
}

// DataView extensions
declare global {
  interface DataView {
    getVarUint32(offset: number): { value: number; bytesRead: number };
    getString(offset: number): { value: string; bytesRead: number };
    getBytes(offset: number): { value: Uint8Array; bytesRead: number };
  }
}

DataView.prototype.getVarUint32 = function(offset: number): { value: number; bytesRead: number } {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  let byte: number;

  do {
    byte = this.getUint8(offset + bytesRead++);
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);

  return { value: result, bytesRead };
};

DataView.prototype.getString = function(offset: number): { value: string; bytesRead: number } {
  const length = this.getVarUint32(offset).value;
  const bytesRead = this.getVarUint32(offset).bytesRead;
  const bytes = new Uint8Array(this.buffer, this.byteOffset + offset + bytesRead, length);
  return { value: new TextDecoder().decode(bytes), bytesRead: bytesRead + length };
};

DataView.prototype.getBytes = function(offset: number): { value: Uint8Array; bytesRead: number } {
  const length = this.getVarUint32(offset).value;
  const bytesRead = this.getVarUint32(offset).bytesRead;
  const bytes = new Uint8Array(this.buffer, this.byteOffset + offset + bytesRead, length);
  return { value: bytes, bytesRead: bytesRead + length };
};

// Export functions
const wasmFingerprint = {
  computeFingerprints,
  compareFingerprints,
};

export { wasmFingerprint, Fingerprints, ComparisonResult };
