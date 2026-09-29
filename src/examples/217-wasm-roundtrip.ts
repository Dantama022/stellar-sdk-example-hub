import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import chalk from 'chalk';

import { WasmValidationError } from '../utils/wasm-static-analysis';

/**
 * Example 217: Soroban Contract WASM Binary Round-Trip Integrity
 *
 * Reads a Soroban contract WASM artifact, parses it into a normalized module
 * representation, re-encodes that representation into a new binary, then
 * parses the generated binary again and compares the two normalized structures.
 *
 * The check distinguishes:
 *   - Byte-identical round trip
 *   - Binary-different but structurally equivalent round trip
 *   - Structurally changed round trip
 *   - Failed round trip
 *
 * No contract code is ever executed; the operation is completely offline.
 *
 * Round-trip limitations:
 *   - LEB128 re-encoding may produce minimal-length encodings where the
 *     original compiler emitted non-minimal LEB128 sequences. This causes a
 *     binary difference with no semantic impact.
 *   - Custom sections are preserved verbatim; content is not re-interpreted.
 *   - Data segment layout is preserved; active offsets are not recomputed.
 *   - Function body bytes are carried through without instruction-level
 *     re-encoding, so instruction sequences remain identical.
 *   - Section ordering is preserved exactly as read; no normalization reorder
 *     is applied.
 */

// ---------------------------------------------------------------------------
// Internal binary helpers
// ---------------------------------------------------------------------------

function readByte(buf: Buffer, offset: number): [number, number] {
  if (offset >= buf.length) throw new WasmValidationError('Unexpected end of WASM data');
  return [buf[offset], offset + 1];
}

function readVarUint32(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    if (offset >= buf.length) throw new WasmValidationError('Unexpected end of WASM data');
    const byte = buf[offset++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result >>> 0, offset];
    shift += 7;
  }
  throw new WasmValidationError('Invalid unsigned LEB128 value');
}

function readVarInt32(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let byte = 0;
  do {
    if (offset >= buf.length) throw new WasmValidationError('Unexpected end of WASM data');
    byte = buf[offset++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while ((byte & 0x80) !== 0 && shift < 35);
  if (shift < 32 && (byte & 0x40) !== 0) result |= ~0 << shift;
  return [result, offset];
}

function readString(buf: Buffer, offset: number): [string, number] {
  const [length, next] = readVarUint32(buf, offset);
  if (next + length > buf.length) throw new WasmValidationError('String length exceeds data');
  return [buf.subarray(next, next + length).toString('utf8'), next + length];
}

function encodeVarUint32(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return Buffer.from(bytes);
}


function encodeString(value: string): Buffer {
  const strBuf = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeVarUint32(strBuf.length), strBuf]);
}

// ---------------------------------------------------------------------------
// Normalized module representation
// ---------------------------------------------------------------------------

const TYPE_NAME_MAP: Record<number, string> = {
  0x7f: 'i32',
  0x7e: 'i64',
  0x7d: 'f32',
  0x7c: 'f64',
  0x7b: 'v128',
  0x70: 'funcref',
  0x6f: 'externref',
};
const TYPE_BYTE_MAP: Record<string, number> = Object.fromEntries(
  Object.entries(TYPE_NAME_MAP).map(([k, v]) => [v, Number(k)]),
);

function typeByte(name: string): number {
  const v = TYPE_BYTE_MAP[name];
  if (v === undefined) throw new WasmValidationError(`Unknown value type name: ${name}`);
  return v;
}

export interface NormalizedFuncType {
  params: string[];
  results: string[];
}

export interface NormalizedImport {
  module: string;
  name: string;
  kind: 'function' | 'table' | 'memory' | 'global';
  typeIndex?: number;
  elementType?: string;
  limitsFlags?: number;
  limitsInitial?: number;
  limitsMaximum?: number | null;
  valueType?: string;
  mutable?: boolean;
}

export interface NormalizedFunction {
  typeIndex: number;
}

export interface NormalizedTable {
  elementType: string;
  limitsFlags: number;
  limitsInitial: number;
  limitsMaximum: number | null;
}

export interface NormalizedMemory {
  limitsFlags: number;
  limitsInitial: number;
  limitsMaximum: number | null;
}

export interface NormalizedGlobal {
  valueType: string;
  mutable: boolean;
  initExprBytes: Buffer;
}

export interface NormalizedExport {
  name: string;
  kind: number;
  index: number;
}

export interface NormalizedElement {
  flags: number;
  rawBytes: Buffer;
}

export interface NormalizedDataSegment {
  flags: number;
  rawBytes: Buffer;
}

export interface NormalizedCustomSection {
  name: string;
  payload: Buffer;
}

export interface NormalizedFunctionBody {
  bodyBytes: Buffer;
}

export interface NormalizedModule {
  wasmVersion: number;
  types: NormalizedFuncType[];
  imports: NormalizedImport[];
  functions: NormalizedFunction[];
  tables: NormalizedTable[];
  memories: NormalizedMemory[];
  globals: NormalizedGlobal[];
  exports: NormalizedExport[];
  startFunction: number | null;
  elements: NormalizedElement[];
  functionBodies: NormalizedFunctionBody[];
  dataCounts: number | null;
  dataSegments: NormalizedDataSegment[];
  customSections: NormalizedCustomSection[];
  /** Section ordering: [{id, label}] preserving original order */
  sectionOrder: Array<{ id: number; label: string }>;
}

function sectionLabel(id: number, customName?: string): string {
  const LABELS: Record<number, string> = {
    0: `custom(${customName ?? ''})`,
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
    12: 'datacount',
  };
  return LABELS[id] ?? `unknown(${id})`;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseLimits(
  buf: Buffer,
  offset: number,
): [{ flags: number; initial: number; maximum: number | null }, number] {
  const [flags, o1] = readVarUint32(buf, offset);
  const [initial, o2] = readVarUint32(buf, o1);
  if (flags & 0x01) {
    const [maximum, o3] = readVarUint32(buf, o2);
    return [{ flags, initial, maximum }, o3];
  }
  return [{ flags, initial, maximum: null }, o2];
}

function parseInitExpr(buf: Buffer, offset: number): [Buffer, number] {
  const start = offset;
  while (offset < buf.length) {
    const op = buf[offset++];
    if (op === 0x0b) return [buf.subarray(start, offset), offset]; // end opcode
    if (op === 0x41 || op === 0x42) {
      // i32.const / i64.const: skip varint32
      [, offset] = readVarInt32(buf, offset);
    } else if (op === 0x23 || op === 0x44) {
      // global.get / f64.const
      if (op === 0x23) {
        [, offset] = readVarUint32(buf, offset);
      } else {
        offset += 8;
      }
    } else if (op === 0x43) {
      offset += 4; // f32.const
    }
  }
  throw new WasmValidationError('Initializer expression missing end opcode');
}

export function parseWasmModule(wasm: Buffer): NormalizedModule {
  if (wasm.length < 8) throw new WasmValidationError('Invalid WASM binary: too short');
  if (wasm.subarray(0, 4).compare(Buffer.from([0x00, 0x61, 0x73, 0x6d])) !== 0)
    throw new WasmValidationError('Invalid WASM binary: missing magic header');
  const version = wasm.readUInt32LE(4);
  if (version !== 1) throw new WasmValidationError(`Unsupported WASM version: ${version}`);

  const mod: NormalizedModule = {
    wasmVersion: version,
    types: [],
    imports: [],
    functions: [],
    tables: [],
    memories: [],
    globals: [],
    exports: [],
    startFunction: null,
    elements: [],
    functionBodies: [],
    dataCounts: null,
    dataSegments: [],
    customSections: [],
    sectionOrder: [],
  };

  let pos = 8;
  while (pos < wasm.length) {
    let id: number;
    [id, pos] = readByte(wasm, pos);
    let size: number;
    [size, pos] = readVarUint32(wasm, pos);
    const end = pos + size;
    if (end > wasm.length) throw new WasmValidationError('Section extends beyond WASM data');
    const payload = wasm.subarray(pos, end);

    // Parse each known section
    if (id === 0) {
      // Custom section
      let nameOffset = 0;
      const [name, after] = readString(payload, nameOffset);
      nameOffset = after;
      mod.customSections.push({ name, payload: payload.subarray(nameOffset) });
      mod.sectionOrder.push({ id, label: sectionLabel(id, name) });
    } else if (id === 1) {
      // Type section
      let o = 0;
      let count: number;
      [count, o] = readVarUint32(payload, o);
      for (let i = 0; i < count; i++) {
        const [funcByte, o2] = readByte(payload, o);
        o = o2;
        if (funcByte !== 0x60) throw new WasmValidationError(`Unknown type form: 0x${funcByte.toString(16)}`);
        let paramCount: number;
        [paramCount, o] = readVarUint32(payload, o);
        const params: string[] = [];
        for (let p = 0; p < paramCount; p++) {
          const [b, o3] = readByte(payload, o);
          o = o3;
          params.push(TYPE_NAME_MAP[b] ?? `unknown(0x${b.toString(16)})`);
        }
        let resultCount: number;
        [resultCount, o] = readVarUint32(payload, o);
        const results: string[] = [];
        for (let r = 0; r < resultCount; r++) {
          const [b, o3] = readByte(payload, o);
          o = o3;
          results.push(TYPE_NAME_MAP[b] ?? `unknown(0x${b.toString(16)})`);
        }
        mod.types.push({ params, results });
      }
      mod.sectionOrder.push({ id, label: sectionLabel(id) });
    } else if (id === 2) {
      // Import section
      let o = 0;
      let count: number;
      [count, o] = readVarUint32(payload, o);
      for (let i = 0; i < count; i++) {
        let module: string, name: string, kindByte: number;
        [module, o] = readString(payload, o);
        [name, o] = readString(payload, o);
        [kindByte, o] = readByte(payload, o);
        const imp: NormalizedImport = { module, name, kind: 'function' };
        if (kindByte === 0x00) {
          imp.kind = 'function';
          [imp.typeIndex, o] = readVarUint32(payload, o);
        } else if (kindByte === 0x01) {
          imp.kind = 'table';
          const [elemByte, o2] = readByte(payload, o);
          o = o2;
          imp.elementType = TYPE_NAME_MAP[elemByte] ?? `unknown(0x${elemByte.toString(16)})`;
          const [lim, o3] = parseLimits(payload, o);
          o = o3;
          imp.limitsFlags = lim.flags;
          imp.limitsInitial = lim.initial;
          imp.limitsMaximum = lim.maximum;
        } else if (kindByte === 0x02) {
          imp.kind = 'memory';
          const [lim, o2] = parseLimits(payload, o);
          o = o2;
          imp.limitsFlags = lim.flags;
          imp.limitsInitial = lim.initial;
          imp.limitsMaximum = lim.maximum;
        } else if (kindByte === 0x03) {
          imp.kind = 'global';
          const [vtByte, o2] = readByte(payload, o);
          o = o2;
          imp.valueType = TYPE_NAME_MAP[vtByte] ?? `unknown(0x${vtByte.toString(16)})`;
          const [mutByte, o3] = readByte(payload, o);
          o = o3;
          imp.mutable = mutByte === 1;
        } else {
          throw new WasmValidationError(`Unknown import kind: 0x${kindByte.toString(16)}`);
        }
        mod.imports.push(imp);
      }
      mod.sectionOrder.push({ id, label: sectionLabel(id) });
    } else if (id === 3) {
      // Function section
      let o = 0;
      let count: number;
      [count, o] = readVarUint32(payload, o);
      for (let i = 0; i < count; i++) {
        let typeIndex: number;
        [typeIndex, o] = readVarUint32(payload, o);
        mod.functions.push({ typeIndex });
      }
      mod.sectionOrder.push({ id, label: sectionLabel(id) });
    } else if (id === 4) {
      // Table section
      let o = 0;
      let count: number;
      [count, o] = readVarUint32(payload, o);
      for (let i = 0; i < count; i++) {
        const [elemByte, o2] = readByte(payload, o);
        o = o2;
        const [lim, o3] = parseLimits(payload, o);
        o = o3;
        mod.tables.push({
          elementType: TYPE_NAME_MAP[elemByte] ?? `unknown(0x${elemByte.toString(16)})`,
          limitsFlags: lim.flags,
          limitsInitial: lim.initial,
          limitsMaximum: lim.maximum,
        });
      }
      mod.sectionOrder.push({ id, label: sectionLabel(id) });
    } else if (id === 5) {
      // Memory section
      let o = 0;
      let count: number;
      [count, o] = readVarUint32(payload, o);
      for (let i = 0; i < count; i++) {
        const [lim, o2] = parseLimits(payload, o);
        o = o2;
        mod.memories.push({ limitsFlags: lim.flags, limitsInitial: lim.initial, limitsMaximum: lim.maximum });
      }
      mod.sectionOrder.push({ id, label: sectionLabel(id) });
    } else if (id === 6) {
      // Global section
      let o = 0;
      let count: number;
      [count, o] = readVarUint32(payload, o);
      for (let i = 0; i < count; i++) {
        const [vtByte, o2] = readByte(payload, o);
        o = o2;
        const [mutByte, o3] = readByte(payload, o);
        o = o3;
        const [initExprBytes, o4] = parseInitExpr(payload, o);
        o = o4;
        mod.globals.push({
          valueType: TYPE_NAME_MAP[vtByte] ?? `unknown(0x${vtByte.toString(16)})`,
          mutable: mutByte === 1,
          initExprBytes,
        });
      }
      mod.sectionOrder.push({ id, label: sectionLabel(id) });
    } else if (id === 7) {
      // Export section
      let o = 0;
      let count: number;
      [count, o] = readVarUint32(payload, o);
      for (let i = 0; i < count; i++) {
        let name: string, kind: number, index: number;
        [name, o] = readString(payload, o);
        [kind, o] = readByte(payload, o);
        [index, o] = readVarUint32(payload, o);
        mod.exports.push({ name, kind, index });
      }
      mod.sectionOrder.push({ id, label: sectionLabel(id) });
    } else if (id === 8) {
      // Start section
      let o = 0;
      [mod.startFunction, o] = readVarUint32(payload, o);
      void o;
      mod.sectionOrder.push({ id, label: sectionLabel(id) });
    } else if (id === 9) {
      // Element section — preserve raw bytes per segment for fidelity
      let o = 0;
      let count: number;
      [count, o] = readVarUint32(payload, o);
      for (let i = 0; i < count; i++) {
        const start = o;
        const [flags, o2] = readVarUint32(payload, o);
        o = o2;
        // Skip segment body — we preserve raw bytes
        const isPassiveOrDeclarative = (flags & 0x01) !== 0;
        const hasTable = (flags & 0x02) !== 0 && !isPassiveOrDeclarative;
        const hasElemType = isPassiveOrDeclarative || (flags & 0x04) !== 0;
        if (hasTable) {
          [, o] = readVarUint32(payload, o); // table index
          [, o] = parseInitExpr(payload, o); // offset
        }
        if (hasElemType) [, o] = readByte(payload, o);
        let elemCount: number;
        [elemCount, o] = readVarUint32(payload, o);
        for (let j = 0; j < elemCount; j++) {
          [, o] = readVarUint32(payload, o);
        }
        mod.elements.push({ flags, rawBytes: payload.subarray(start, o) });
      }
      mod.sectionOrder.push({ id, label: sectionLabel(id) });
    } else if (id === 10) {
      // Code section — preserve raw function bodies for fidelity
      let o = 0;
      let count: number;
      [count, o] = readVarUint32(payload, o);
      for (let i = 0; i < count; i++) {
        let bodySize: number;
        [bodySize, o] = readVarUint32(payload, o);
        mod.functionBodies.push({ bodyBytes: payload.subarray(o, o + bodySize) });
        o += bodySize;
      }
      mod.sectionOrder.push({ id, label: sectionLabel(id) });
    } else if (id === 11) {
      // Data section — preserve raw bytes per segment
      let o = 0;
      let count: number;
      [count, o] = readVarUint32(payload, o);
      for (let i = 0; i < count; i++) {
        const start = o;
        const [flags, o2] = readVarUint32(payload, o);
        o = o2;
        if ((flags & 0x01) === 0) {
          // Active segment: optional memory index + offset expr
          if (flags === 2) [, o] = readVarUint32(payload, o); // explicit memory index
          [, o] = parseInitExpr(payload, o);
        }
        let dataSize: number;
        [dataSize, o] = readVarUint32(payload, o);
        o += dataSize;
        mod.dataSegments.push({ flags, rawBytes: payload.subarray(start, o) });
      }
      mod.sectionOrder.push({ id, label: sectionLabel(id) });
    } else if (id === 12) {
      // DataCount section
      const [count] = readVarUint32(payload, 0);
      mod.dataCounts = count;
      mod.sectionOrder.push({ id, label: sectionLabel(id) });
    } else {
      // Unknown section — skip
      mod.sectionOrder.push({ id, label: `unknown(${id})` });
    }

    pos = end;
  }

  return mod;
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

function encodeSection(id: number, payloadBufs: Buffer[]): Buffer {
  const payload = Buffer.concat(payloadBufs);
  return Buffer.concat([Buffer.from([id]), encodeVarUint32(payload.length), payload]);
}

function encodeLimits(flags: number, initial: number, maximum: number | null): Buffer {
  const parts = [encodeVarUint32(flags), encodeVarUint32(initial)];
  if (flags & 0x01) parts.push(encodeVarUint32(maximum!));
  return Buffer.concat(parts);
}

export function encodeWasmModule(mod: NormalizedModule): Buffer {
  const magic = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
  const version = Buffer.alloc(4);
  version.writeUInt32LE(mod.wasmVersion, 0);

  const sections: Buffer[] = [];

  // Encode sections in original order; use sectionOrder as a guide for IDs
  // We track which custom sections have been emitted
  let customIdx = 0;
  const emittedIds = new Set<number>();

  for (const { id } of mod.sectionOrder) {
    if (id === 0) {
      const cs = mod.customSections[customIdx++];
      if (cs) {
        sections.push(encodeSection(0, [encodeString(cs.name), cs.payload]));
      }
      continue;
    }
    if (emittedIds.has(id)) continue;
    emittedIds.add(id);

    if (id === 1 && mod.types.length > 0) {
      const entries = mod.types.map((t) =>
        Buffer.concat([
          Buffer.from([0x60]),
          encodeVarUint32(t.params.length),
          Buffer.from(t.params.map(typeByte)),
          encodeVarUint32(t.results.length),
          Buffer.from(t.results.map(typeByte)),
        ]),
      );
      sections.push(encodeSection(1, [encodeVarUint32(mod.types.length), ...entries]));
    } else if (id === 2 && mod.imports.length > 0) {
      const entries = mod.imports.map((imp) => {
        const head = Buffer.concat([encodeString(imp.module), encodeString(imp.name)]);
        if (imp.kind === 'function') {
          return Buffer.concat([head, Buffer.from([0x00]), encodeVarUint32(imp.typeIndex!)]);
        } else if (imp.kind === 'table') {
          return Buffer.concat([
            head,
            Buffer.from([0x01, typeByte(imp.elementType!)]),
            encodeLimits(imp.limitsFlags!, imp.limitsInitial!, imp.limitsMaximum!),
          ]);
        } else if (imp.kind === 'memory') {
          return Buffer.concat([
            head,
            Buffer.from([0x02]),
            encodeLimits(imp.limitsFlags!, imp.limitsInitial!, imp.limitsMaximum!),
          ]);
        } else {
          // global
          return Buffer.concat([
            head,
            Buffer.from([0x03, typeByte(imp.valueType!), imp.mutable ? 1 : 0]),
          ]);
        }
      });
      sections.push(encodeSection(2, [encodeVarUint32(mod.imports.length), ...entries]));
    } else if (id === 3 && mod.functions.length > 0) {
      const entries = mod.functions.map((f) => encodeVarUint32(f.typeIndex));
      sections.push(encodeSection(3, [encodeVarUint32(mod.functions.length), ...entries]));
    } else if (id === 4 && mod.tables.length > 0) {
      const entries = mod.tables.map((t) =>
        Buffer.concat([Buffer.from([typeByte(t.elementType)]), encodeLimits(t.limitsFlags, t.limitsInitial, t.limitsMaximum)]),
      );
      sections.push(encodeSection(4, [encodeVarUint32(mod.tables.length), ...entries]));
    } else if (id === 5 && mod.memories.length > 0) {
      const entries = mod.memories.map((m) => encodeLimits(m.limitsFlags, m.limitsInitial, m.limitsMaximum));
      sections.push(encodeSection(5, [encodeVarUint32(mod.memories.length), ...entries]));
    } else if (id === 6 && mod.globals.length > 0) {
      const entries = mod.globals.map((g) =>
        Buffer.concat([Buffer.from([typeByte(g.valueType), g.mutable ? 1 : 0]), g.initExprBytes]),
      );
      sections.push(encodeSection(6, [encodeVarUint32(mod.globals.length), ...entries]));
    } else if (id === 7 && mod.exports.length > 0) {
      const entries = mod.exports.map((e) =>
        Buffer.concat([encodeString(e.name), Buffer.from([e.kind]), encodeVarUint32(e.index)]),
      );
      sections.push(encodeSection(7, [encodeVarUint32(mod.exports.length), ...entries]));
    } else if (id === 8 && mod.startFunction !== null) {
      sections.push(encodeSection(8, [encodeVarUint32(mod.startFunction)]));
    } else if (id === 9 && mod.elements.length > 0) {
      const entries = mod.elements.map((e) => e.rawBytes);
      sections.push(encodeSection(9, [encodeVarUint32(mod.elements.length), ...entries]));
    } else if (id === 10 && mod.functionBodies.length > 0) {
      const entries = mod.functionBodies.map((b) =>
        Buffer.concat([encodeVarUint32(b.bodyBytes.length), b.bodyBytes]),
      );
      sections.push(encodeSection(10, [encodeVarUint32(mod.functionBodies.length), ...entries]));
    } else if (id === 11 && mod.dataSegments.length > 0) {
      const entries = mod.dataSegments.map((d) => d.rawBytes);
      sections.push(encodeSection(11, [encodeVarUint32(mod.dataSegments.length), ...entries]));
    } else if (id === 12 && mod.dataCounts !== null) {
      sections.push(encodeSection(12, [encodeVarUint32(mod.dataCounts)]));
    }
  }

  return Buffer.concat([magic, version, ...sections]);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export type RoundTripStatus =
  | 'byte-identical'
  | 'structurally-equivalent'
  | 'structurally-changed'
  | 'failed';

export interface SectionDiff {
  field: string;
  original: unknown;
  roundTripped: unknown;
}

export interface RoundTripReport {
  status: RoundTripStatus;
  originalFile: string;
  originalHash: string;
  roundTrippedHash: string;
  byteIdentical: boolean;
  structurallyEquivalent: boolean;
  differences: SectionDiff[];
  diagnostics: string[];
  originalModule?: NormalizedModule;
  roundTrippedModule?: NormalizedModule;
}

function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function funcTypeKey(t: NormalizedFuncType): string {
  return `(${t.params.join(',')}) -> (${t.results.join(',')})`;
}

function compareModules(orig: NormalizedModule, rt: NormalizedModule): SectionDiff[] {
  const diffs: SectionDiff[] = [];

  // WASM version
  if (orig.wasmVersion !== rt.wasmVersion) {
    diffs.push({ field: 'wasmVersion', original: orig.wasmVersion, roundTripped: rt.wasmVersion });
  }

  // Section order
  const origOrder = orig.sectionOrder.map((s) => s.label).join(',');
  const rtOrder = rt.sectionOrder.map((s) => s.label).join(',');
  if (origOrder !== rtOrder) {
    diffs.push({ field: 'sectionOrder', original: origOrder, roundTripped: rtOrder });
  }

  // Type section
  if (orig.types.length !== rt.types.length) {
    diffs.push({ field: 'types.count', original: orig.types.length, roundTripped: rt.types.length });
  } else {
    orig.types.forEach((t, i) => {
      const key = funcTypeKey(t);
      const rtKey = funcTypeKey(rt.types[i]);
      if (key !== rtKey) {
        diffs.push({ field: `types[${i}]`, original: key, roundTripped: rtKey });
      }
    });
  }

  // Imports
  if (orig.imports.length !== rt.imports.length) {
    diffs.push({ field: 'imports.count', original: orig.imports.length, roundTripped: rt.imports.length });
  } else {
    orig.imports.forEach((imp, i) => {
      const rtImp = rt.imports[i];
      if (imp.module !== rtImp.module || imp.name !== rtImp.name || imp.kind !== rtImp.kind || imp.typeIndex !== rtImp.typeIndex) {
        diffs.push({ field: `imports[${i}]`, original: `${imp.module}.${imp.name}(${imp.kind})`, roundTripped: `${rtImp.module}.${rtImp.name}(${rtImp.kind})` });
      }
    });
  }

  // Functions (type index references)
  if (orig.functions.length !== rt.functions.length) {
    diffs.push({ field: 'functions.count', original: orig.functions.length, roundTripped: rt.functions.length });
  } else {
    orig.functions.forEach((f, i) => {
      if (f.typeIndex !== rt.functions[i].typeIndex) {
        diffs.push({ field: `functions[${i}].typeIndex`, original: f.typeIndex, roundTripped: rt.functions[i].typeIndex });
      }
    });
  }

  // Function bodies
  if (orig.functionBodies.length !== rt.functionBodies.length) {
    diffs.push({ field: 'functionBodies.count', original: orig.functionBodies.length, roundTripped: rt.functionBodies.length });
  } else {
    orig.functionBodies.forEach((b, i) => {
      const origHash = hashBuffer(b.bodyBytes);
      const rtHash = hashBuffer(rt.functionBodies[i].bodyBytes);
      if (origHash !== rtHash) {
        diffs.push({ field: `functionBodies[${i}].hash`, original: origHash, roundTripped: rtHash });
      }
    });
  }

  // Tables
  if (orig.tables.length !== rt.tables.length) {
    diffs.push({ field: 'tables.count', original: orig.tables.length, roundTripped: rt.tables.length });
  } else {
    orig.tables.forEach((t, i) => {
      const rtT = rt.tables[i];
      if (t.elementType !== rtT.elementType || t.limitsInitial !== rtT.limitsInitial || t.limitsMaximum !== rtT.limitsMaximum) {
        diffs.push({ field: `tables[${i}]`, original: JSON.stringify(t), roundTripped: JSON.stringify(rtT) });
      }
    });
  }

  // Memories
  if (orig.memories.length !== rt.memories.length) {
    diffs.push({ field: 'memories.count', original: orig.memories.length, roundTripped: rt.memories.length });
  } else {
    orig.memories.forEach((m, i) => {
      const rtM = rt.memories[i];
      if (m.limitsInitial !== rtM.limitsInitial || m.limitsMaximum !== rtM.limitsMaximum) {
        diffs.push({ field: `memories[${i}]`, original: JSON.stringify(m), roundTripped: JSON.stringify(rtM) });
      }
    });
  }

  // Globals
  if (orig.globals.length !== rt.globals.length) {
    diffs.push({ field: 'globals.count', original: orig.globals.length, roundTripped: rt.globals.length });
  } else {
    orig.globals.forEach((g, i) => {
      const rtG = rt.globals[i];
      if (g.valueType !== rtG.valueType || g.mutable !== rtG.mutable || !g.initExprBytes.equals(rtG.initExprBytes)) {
        diffs.push({ field: `globals[${i}]`, original: `${g.valueType}(mutable=${g.mutable})`, roundTripped: `${rtG.valueType}(mutable=${rtG.mutable})` });
      }
    });
  }

  // Exports
  if (orig.exports.length !== rt.exports.length) {
    diffs.push({ field: 'exports.count', original: orig.exports.length, roundTripped: rt.exports.length });
  } else {
    orig.exports.forEach((e, i) => {
      const rtE = rt.exports[i];
      if (e.name !== rtE.name || e.kind !== rtE.kind || e.index !== rtE.index) {
        diffs.push({ field: `exports[${i}]`, original: `${e.name}(kind=${e.kind},idx=${e.index})`, roundTripped: `${rtE.name}(kind=${rtE.kind},idx=${rtE.index})` });
      }
    });
  }

  // Elements (raw bytes hash)
  if (orig.elements.length !== rt.elements.length) {
    diffs.push({ field: 'elements.count', original: orig.elements.length, roundTripped: rt.elements.length });
  } else {
    orig.elements.forEach((el, i) => {
      const origHash = hashBuffer(el.rawBytes);
      const rtHash = hashBuffer(rt.elements[i].rawBytes);
      if (origHash !== rtHash) {
        diffs.push({ field: `elements[${i}].hash`, original: origHash, roundTripped: rtHash });
      }
    });
  }

  // Data segments (raw bytes hash)
  if (orig.dataSegments.length !== rt.dataSegments.length) {
    diffs.push({ field: 'dataSegments.count', original: orig.dataSegments.length, roundTripped: rt.dataSegments.length });
  } else {
    orig.dataSegments.forEach((ds, i) => {
      const origHash = hashBuffer(ds.rawBytes);
      const rtHash = hashBuffer(rt.dataSegments[i].rawBytes);
      if (origHash !== rtHash) {
        diffs.push({ field: `dataSegments[${i}].hash`, original: origHash, roundTripped: rtHash });
      }
    });
  }

  // Custom sections
  if (orig.customSections.length !== rt.customSections.length) {
    diffs.push({ field: 'customSections.count', original: orig.customSections.length, roundTripped: rt.customSections.length });
  } else {
    orig.customSections.forEach((cs, i) => {
      const rtCs = rt.customSections[i];
      if (cs.name !== rtCs.name) {
        diffs.push({ field: `customSections[${i}].name`, original: cs.name, roundTripped: rtCs.name });
      }
      const origHash = hashBuffer(cs.payload);
      const rtHash = hashBuffer(rtCs.payload);
      if (origHash !== rtHash) {
        diffs.push({ field: `customSections[${i}].payloadHash`, original: origHash, roundTripped: rtHash });
      }
    });
  }

  // Start function
  if (orig.startFunction !== rt.startFunction) {
    diffs.push({ field: 'startFunction', original: orig.startFunction, roundTripped: rt.startFunction });
  }

  // DataCount
  if (orig.dataCounts !== rt.dataCounts) {
    diffs.push({ field: 'dataCounts', original: orig.dataCounts, roundTripped: rt.dataCounts });
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// Main round-trip function
// ---------------------------------------------------------------------------

export interface RoundTripParams {
  wasmFile: string;
  output?: string;
  json?: boolean;
  forceOverwrite?: boolean;
}

export async function performRoundTrip(params: RoundTripParams): Promise<RoundTripReport> {
  const { wasmFile, output, forceOverwrite = false } = params;

  const report: RoundTripReport = {
    status: 'failed',
    originalFile: wasmFile,
    originalHash: '',
    roundTrippedHash: '',
    byteIdentical: false,
    structurallyEquivalent: false,
    differences: [],
    diagnostics: [],
  };

  // Read original
  let originalBytes: Buffer;
  try {
    originalBytes = fs.readFileSync(wasmFile);
  } catch (err: unknown) {
    report.diagnostics.push(`Cannot read source file: ${(err as Error).message}`);
    return report;
  }

  report.originalHash = hashBuffer(originalBytes);

  // Parse original
  let originalModule: NormalizedModule;
  try {
    originalModule = parseWasmModule(originalBytes);
  } catch (err: unknown) {
    const msg = err instanceof WasmValidationError ? err.message : String(err);
    report.diagnostics.push(`Parse failed: ${msg}`);
    return report;
  }
  report.originalModule = originalModule;

  // Re-encode
  let roundTrippedBytes: Buffer;
  try {
    roundTrippedBytes = encodeWasmModule(originalModule);
  } catch (err: unknown) {
    report.diagnostics.push(`Encode failed: ${(err as Error).message}`);
    return report;
  }

  report.roundTrippedHash = hashBuffer(roundTrippedBytes);
  report.byteIdentical = originalBytes.equals(roundTrippedBytes);

  // Parse round-tripped
  let roundTrippedModule: NormalizedModule;
  try {
    roundTrippedModule = parseWasmModule(roundTrippedBytes);
  } catch (err: unknown) {
    report.diagnostics.push(`Re-parse failed: ${(err as Error).message}`);
    return report;
  }
  report.roundTrippedModule = roundTrippedModule;

  // Compare
  report.differences = compareModules(originalModule, roundTrippedModule);
  report.structurallyEquivalent = report.differences.length === 0;

  if (report.byteIdentical) {
    report.status = 'byte-identical';
  } else if (report.structurallyEquivalent) {
    report.status = 'structurally-equivalent';
    report.diagnostics.push(
      'Binary differs but structure is identical. This is typically caused by ' +
      'non-minimal LEB128 encoding in the original binary (a valid compiler choice). ' +
      'The re-encoded artifact is semantically identical.',
    );
  } else {
    report.status = 'structurally-changed';
  }

  // Write output if requested
  if (output) {
    const resolvedOutput = path.resolve(output);
    const resolvedSource = path.resolve(wasmFile);
    if (resolvedOutput === resolvedSource && !forceOverwrite) {
      report.diagnostics.push(
        `Refused to overwrite source artifact "${wasmFile}". Pass forceOverwrite=true or choose a different --output path.`,
      );
    } else {
      try {
        fs.writeFileSync(resolvedOutput, roundTrippedBytes);
      } catch (err: unknown) {
        report.diagnostics.push(`Failed to write output file: ${(err as Error).message}`);
      }
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// CLI display
// ---------------------------------------------------------------------------

function printReport(report: RoundTripReport, jsonMode: boolean): void {
  if (jsonMode) {
    const out = {
      status: report.status,
      originalFile: report.originalFile,
      originalHash: report.originalHash,
      roundTrippedHash: report.roundTrippedHash,
      byteIdentical: report.byteIdentical,
      structurallyEquivalent: report.structurallyEquivalent,
      differences: report.differences,
      diagnostics: report.diagnostics,
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const statusColor: Record<RoundTripStatus, (s: string) => string> = {
    'byte-identical': chalk.green,
    'structurally-equivalent': chalk.yellow,
    'structurally-changed': chalk.red,
    failed: chalk.red,
  };

  const colorFn = statusColor[report.status] ?? chalk.gray;

  console.log(chalk.bold('\nWASM Round-Trip Integrity Report'));
  console.log(`File:            ${report.originalFile}`);
  console.log(`Original hash:   ${report.originalHash}`);
  console.log(`Round-trip hash: ${report.roundTrippedHash}`);
  console.log(`Status:          ${colorFn(report.status)}`);

  if (report.originalModule) {
    const m = report.originalModule;
    console.log(chalk.bold('\nModule summary:'));
    console.log(`  WASM version:      ${m.wasmVersion}`);
    console.log(`  Types:             ${m.types.length}`);
    console.log(`  Imports:           ${m.imports.length}`);
    console.log(`  Functions:         ${m.functions.length}`);
    console.log(`  Function bodies:   ${m.functionBodies.length}`);
    console.log(`  Tables:            ${m.tables.length}`);
    console.log(`  Memories:          ${m.memories.length}`);
    console.log(`  Globals:           ${m.globals.length}`);
    console.log(`  Exports:           ${m.exports.length}`);
    console.log(`  Elements:          ${m.elements.length}`);
    console.log(`  Data segments:     ${m.dataSegments.length}`);
    console.log(`  Custom sections:   ${m.customSections.length}`);
    console.log(`  Section order:     ${m.sectionOrder.map((s) => s.label).join(', ')}`);
  }

  if (report.differences.length > 0) {
    console.log(chalk.bold.red(`\nStructural differences (${report.differences.length}):`));
    report.differences.forEach((d) => {
      console.log(`  ${chalk.yellow(d.field)}`);
      console.log(`    original:     ${JSON.stringify(d.original)}`);
      console.log(`    round-tripped: ${JSON.stringify(d.roundTripped)}`);
    });
  }

  if (report.diagnostics.length > 0) {
    console.log(chalk.bold('\nDiagnostics:'));
    report.diagnostics.forEach((d) => console.log(`  ${chalk.cyan(d)}`));
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Example entry point
// ---------------------------------------------------------------------------

export interface WasmRoundTripParams {
  wasmFile?: string;
  output?: string;
  json?: boolean;
  forceOverwrite?: boolean;
}

const DEFAULT_WASM = path.join(__dirname, '../contracts/sample/hello.wasm');

export async function run(params: WasmRoundTripParams = {}): Promise<void> {
  const wasmFile =
    params.wasmFile?.trim() ||
    process.env.WASM_FILE?.trim() ||
    process.argv[3]?.trim() ||
    DEFAULT_WASM;

  const outputFile = params.output?.trim() || process.env.WASM_OUTPUT?.trim() || process.argv[4]?.trim();
  const jsonMode = params.json ?? process.argv.includes('--json');
  const forceOverwrite = params.forceOverwrite ?? process.argv.includes('--force');

  if (!jsonMode) {
    console.log(chalk.bold('Soroban Contract WASM Binary Round-Trip Integrity'));
    console.log(`Source: ${wasmFile}`);
  }

  if (!fs.existsSync(wasmFile)) {
    const msg = `WASM file not found: ${wasmFile}`;
    if (jsonMode) {
      console.log(JSON.stringify({ status: 'failed', diagnostics: [msg] }, null, 2));
    } else {
      console.error(chalk.red(msg));
    }
    return;
  }

  const report = await performRoundTrip({ wasmFile, output: outputFile, json: jsonMode, forceOverwrite });
  printReport(report, jsonMode);

  if (outputFile && !report.diagnostics.some((d) => d.startsWith('Refused') || d.startsWith('Failed to write'))) {
    if (!jsonMode) {
      console.log(chalk.green(`Round-tripped artifact written to: ${outputFile}`));
    }
  }
}
