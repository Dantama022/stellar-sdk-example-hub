/**
 * Minimal, dependency-free WebAssembly binary reader.
 *
 * The Soroban analysis examples in this repository all need the same three
 * things from a `.wasm` artifact:
 *
 * 1. The *section* layout of the module, including raw byte ranges, so two
 *    artifacts can be compared byte-for-byte at the section level.
 * 2. The *instruction stream* of every function body, with immediates decoded
 *    (memory arguments in particular) and structured control flow intact.
 * 3. Module metadata: imports, exports, memories and the function index
 *    space.
 *
 * This module provides all three by reading the binary format directly. It
 * never instantiates, compiles or executes the module: only bytes are read.
 *
 * The reader implements the WebAssembly 1.0 (MVP) instruction set plus the
 * commonly used post-MVP additions (sign-extension operators, saturating
 * truncation, bulk memory operations, reference types and the SIMD
 * memory-access opcodes). Unknown opcodes are reported as `unsupported`
 * rather than throwing, so a newer toolchain output can still be inspected.
 */

/** Thrown when a buffer is not a structurally valid WebAssembly module. */
export class WasmParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WasmParseError';
  }
}

/** Canonical names of the WebAssembly section ids. */
export const SECTION_NAMES: Record<number, string> = {
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
  12: 'data_count',
  13: 'tag',
};

/** A single section of a WebAssembly module, with its raw byte range. */
export interface WasmSection {
  /** Numeric section id (0 = custom). */
  id: number;
  /** Canonical section name, e.g. `type`, `code`, `custom`. */
  name: string;
  /** Zero-based occurrence index of this section among sections with the same id. */
  index: number;
  /** Offset of the section id byte inside the file. */
  offset: number;
  /** Offset of the first payload byte inside the file. */
  payloadOffset: number;
  /** Payload length in bytes (excluding the id and the length prefix). */
  size: number;
  /** Total number of bytes the section occupies, including its length prefix. */
  totalSize: number;
  /** Raw payload bytes. */
  payload: Buffer;
  /** Custom-section name, when the section id is 0 and the name is readable. */
  customName?: string;
}

/** Memory-access metadata attached to load/store instructions. */
export interface MemoryAccessInfo {
  /** Whether the instruction reads or writes linear memory. */
  kind: 'load' | 'store';
  /** Value type moved by the access. */
  valueType: 'i32' | 'i64' | 'f32' | 'f64' | 'v128';
  /** Width of the access in bits (8, 16, 32, 64 or 128). */
  widthBits: number;
  /** True for signed integer loads (`load8_s`, `load16_s`, `load32_s`). */
  signed: boolean;
  /** True for unsigned integer loads (`load8_u`, `load16_u`, `load32_u`). */
  unsigned: boolean;
}

/** A decoded instruction. */
export interface WasmInstruction {
  /** Index of the instruction inside its function body. */
  index: number;
  /** Byte offset of the instruction inside the function body. */
  offset: number;
  /** Primary opcode byte (for `0xFC`/`0xFD` prefixed opcodes this is the prefix). */
  opcode: number;
  /** Secondary opcode for prefixed instructions, otherwise `undefined`. */
  subOpcode?: number;
  /** Mnemonic of the instruction, e.g. `i32.load`, `block`, `br_if`. */
  name: string;
  /** Decoded immediates, in encoding order. */
  args: (number | string | bigint)[];
  /** Memory argument of a load/store instruction. */
  memarg?: {
    /** Alignment exponent as encoded (the alignment is `2^align` bytes). */
    align: number;
    /** Static offset immediate. */
    offset: number;
    /** Memory index the access targets. */
    memoryIndex: number;
  };
  /** Present when the instruction reads or writes linear memory. */
  memoryAccess?: MemoryAccessInfo;
  /** Block type of `block`/`loop`/`if` instructions. */
  blockType?: string;
  /** True when the opcode is not part of the supported instruction set. */
  unsupported: boolean;
}

/** A function type of the type section. */
export interface WasmFunctionType {
  /** Parameter value types. */
  params: string[];
  /** Result value types. */
  results: string[];
}

/** A function body decoded from the code section. */
export interface WasmFunction {
  /** Index in the module function index space (imported functions come first). */
  index: number;
  /** Index into the type section. */
  typeIndex: number;
  /** Number of parameters of the function. */
  paramCount: number;
  /** Number of results of the function. */
  resultCount: number;
  /** Exported name, when the function is exported. */
  name?: string;
  /** Local declarations, excluding parameters. */
  locals: { count: number; type: string }[];
  /** Decoded instructions of the body. */
  instructions: WasmInstruction[];
  /** Offset of the body inside the file. */
  bodyOffset: number;
  /** Length of the body in bytes. */
  bodySize: number;
}

/** Memory section entry. */
export interface MemoryInfo {
  index: number;
  imported: boolean;
  /** Minimum number of pages. */
  min: number;
  /** Maximum number of pages, when the memory declares a maximum. */
  max?: number;
}

/** A decoded module. */
export interface WasmModule {
  /** Binary format version (always 1 for the current spec). */
  version: number;
  /** All sections, in file order. */
  sections: WasmSection[];
  /** Locally defined functions (imported functions are not included). */
  functions: WasmFunction[];
  /** Number of imported functions, i.e. the offset of the local function space. */
  importedFunctionCount: number;
  /** Imported function descriptors. */
  imports: { module: string; name: string; kind: string }[];
  /** Exported entries. */
  exports: { name: string; kind: string; index: number }[];
  /** Memories declared by the module. */
  memories: MemoryInfo[];
  /** Function types of the type section. */
  types: WasmFunctionType[];
  /** Type index of every function in the function index space. */
  functionTypeIndices: number[];
}

// ─── Primitive readers ───────────────────────────────────────────────────────

/** Reads an unsigned LEB128 integer. */
export function readVarUint(buf: Buffer, pos: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let cursor = pos;

  for (;;) {
    if (cursor >= buf.length) {
      throw new WasmParseError(`Unexpected end of input while reading a LEB128 value at ${pos}`);
    }
    const byte = buf[cursor++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) {
      throw new WasmParseError(`Malformed LEB128 value at offset ${pos}`);
    }
  }

  return { value: result, next: cursor };
}

/** Reads a signed LEB128 integer as a `bigint`. */
export function readVarInt(buf: Buffer, pos: number): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let cursor = pos;
  let byte: number;

  do {
    if (cursor >= buf.length) {
      throw new WasmParseError(
        `Unexpected end of input while reading a signed LEB128 value at ${pos}`,
      );
    }
    byte = buf[cursor++];
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if (shift > 128n) {
      throw new WasmParseError(`Malformed signed LEB128 value at offset ${pos}`);
    }
  } while (byte & 0x80);

  if ((byte & 0x40) !== 0) {
    // Sign extend.
    result -= 1n << shift;
  }

  return { value: result, next: cursor };
}

/** Reads a fixed-size little-endian IEEE-754 value. */
function readFloat(buf: Buffer, pos: number, bytes: 4 | 8): { value: number; next: number } {
  if (pos + bytes > buf.length) {
    throw new WasmParseError(`Unexpected end of input while reading a float at ${pos}`);
  }
  const value = bytes === 4 ? buf.readFloatLE(pos) : buf.readDoubleLE(pos);
  return { value, next: pos + bytes };
}

/** Reads a length-prefixed UTF-8 name. */
function readName(buf: Buffer, pos: number): { value: string; next: number } {
  const { value: length, next } = readVarUint(buf, pos);
  if (next + length > buf.length) {
    throw new WasmParseError(`Unexpected end of input while reading a name at ${pos}`);
  }
  return { value: buf.toString('utf8', next, next + length), next: next + length };
}

// ─── Section parsing ─────────────────────────────────────────────────────────

const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

/**
 * Returns true when the buffer starts with the WebAssembly magic bytes.
 *
 * This is a cheap pre-check; use {@link parseWasmSections} for full
 * validation.
 */
export function isWasmBinary(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 4).equals(WASM_MAGIC);
}

/**
 * Parses the section table of a WebAssembly module.
 *
 * @throws {WasmParseError} when the buffer is not a valid WebAssembly module.
 */
export function parseWasmSections(buf: Buffer): WasmSection[] {
  if (!isWasmBinary(buf)) {
    throw new WasmParseError('Not a WebAssembly binary: the "\\0asm" magic bytes are missing');
  }

  const version = buf.readUInt32LE(4);
  if (version !== 1) {
    throw new WasmParseError(`Unsupported WebAssembly binary version: ${version}`);
  }

  const sections: WasmSection[] = [];
  const counters = new Map<number, number>();
  let pos = 8;

  while (pos < buf.length) {
    const id = buf[pos];
    const idOffset = pos;
    pos += 1;

    const { value: size, next } = readVarUint(buf, pos);
    const payloadOffset = next;

    if (payloadOffset + size > buf.length) {
      throw new WasmParseError(
        `Section ${SECTION_NAMES[id] ?? id} at offset ${idOffset} declares ${size} bytes but the file ends early`,
      );
    }

    const payload = buf.subarray(payloadOffset, payloadOffset + size);
    const index = counters.get(id) ?? 0;
    counters.set(id, index + 1);

    const section: WasmSection = {
      id,
      name: SECTION_NAMES[id] ?? `unknown_${id}`,
      index,
      offset: idOffset,
      payloadOffset,
      size,
      totalSize: 1 + (payloadOffset - idOffset - 1) + size,
      payload: Buffer.from(payload),
    };

    if (id === 0) {
      try {
        section.customName = readName(payload, 0).value;
      } catch {
        section.customName = undefined;
      }
    }

    sections.push(section);
    pos = payloadOffset + size;
  }

  return sections;
}

// ─── Instruction decoding ────────────────────────────────────────────────────

interface MemoryOpSpec {
  name: string;
  kind: 'load' | 'store';
  valueType: 'i32' | 'i64' | 'f32' | 'f64' | 'v128';
  widthBits: number;
  signed?: boolean;
  unsigned?: boolean;
}

const MEMORY_OPS: Record<number, MemoryOpSpec> = {
  0x28: { name: 'i32.load', kind: 'load', valueType: 'i32', widthBits: 32 },
  0x29: { name: 'i64.load', kind: 'load', valueType: 'i64', widthBits: 64 },
  0x2a: { name: 'f32.load', kind: 'load', valueType: 'f32', widthBits: 32 },
  0x2b: { name: 'f64.load', kind: 'load', valueType: 'f64', widthBits: 64 },
  0x2c: { name: 'i32.load8_s', kind: 'load', valueType: 'i32', widthBits: 8, signed: true },
  0x2d: { name: 'i32.load8_u', kind: 'load', valueType: 'i32', widthBits: 8, unsigned: true },
  0x2e: { name: 'i32.load16_s', kind: 'load', valueType: 'i32', widthBits: 16, signed: true },
  0x2f: { name: 'i32.load16_u', kind: 'load', valueType: 'i32', widthBits: 16, unsigned: true },
  0x30: { name: 'i64.load8_s', kind: 'load', valueType: 'i64', widthBits: 8, signed: true },
  0x31: { name: 'i64.load8_u', kind: 'load', valueType: 'i64', widthBits: 8, unsigned: true },
  0x32: { name: 'i64.load16_s', kind: 'load', valueType: 'i64', widthBits: 16, signed: true },
  0x33: { name: 'i64.load16_u', kind: 'load', valueType: 'i64', widthBits: 16, unsigned: true },
  0x34: { name: 'i64.load32_s', kind: 'load', valueType: 'i64', widthBits: 32, signed: true },
  0x35: { name: 'i64.load32_u', kind: 'load', valueType: 'i64', widthBits: 32, unsigned: true },
  0x36: { name: 'i32.store', kind: 'store', valueType: 'i32', widthBits: 32 },
  0x37: { name: 'i64.store', kind: 'store', valueType: 'i64', widthBits: 64 },
  0x38: { name: 'f32.store', kind: 'store', valueType: 'f32', widthBits: 32 },
  0x39: { name: 'f64.store', kind: 'store', valueType: 'f64', widthBits: 64 },
  0x3a: { name: 'i32.store8', kind: 'store', valueType: 'i32', widthBits: 8 },
  0x3b: { name: 'i32.store16', kind: 'store', valueType: 'i32', widthBits: 16 },
  0x3c: { name: 'i64.store8', kind: 'store', valueType: 'i64', widthBits: 8 },
  0x3d: { name: 'i64.store16', kind: 'store', valueType: 'i64', widthBits: 16 },
  0x3e: { name: 'i64.store32', kind: 'store', valueType: 'i64', widthBits: 32 },
};

/** SIMD (v128) memory access opcodes, encoded as `0xFD` + sub-opcode. */
const SIMD_MEMORY_OPS: Record<number, MemoryOpSpec> = {
  0x00: { name: 'v128.load', kind: 'load', valueType: 'v128', widthBits: 128 },
  0x01: { name: 'v128.load8x8_s', kind: 'load', valueType: 'v128', widthBits: 64 },
  0x02: { name: 'v128.load8x8_u', kind: 'load', valueType: 'v128', widthBits: 64 },
  0x03: { name: 'v128.load16x4_s', kind: 'load', valueType: 'v128', widthBits: 64 },
  0x04: { name: 'v128.load16x4_u', kind: 'load', valueType: 'v128', widthBits: 64 },
  0x05: { name: 'v128.load32x2_s', kind: 'load', valueType: 'v128', widthBits: 64 },
  0x06: { name: 'v128.load32x2_u', kind: 'load', valueType: 'v128', widthBits: 64 },
  0x07: { name: 'v128.load8_splat', kind: 'load', valueType: 'v128', widthBits: 8 },
  0x08: { name: 'v128.load16_splat', kind: 'load', valueType: 'v128', widthBits: 16 },
  0x09: { name: 'v128.load32_splat', kind: 'load', valueType: 'v128', widthBits: 32 },
  0x0a: { name: 'v128.load64_splat', kind: 'load', valueType: 'v128', widthBits: 64 },
  0x0b: { name: 'v128.load32_zero', kind: 'load', valueType: 'v128', widthBits: 32 },
  0x0c: { name: 'v128.load64_zero', kind: 'load', valueType: 'v128', widthBits: 64 },
  0x0d: { name: 'v128.store', kind: 'store', valueType: 'v128', widthBits: 128 },
  0x0e: { name: 'v128.load8_lane', kind: 'load', valueType: 'v128', widthBits: 8 },
  0x0f: { name: 'v128.load16_lane', kind: 'load', valueType: 'v128', widthBits: 16 },
  0x10: { name: 'v128.load32_lane', kind: 'load', valueType: 'v128', widthBits: 32 },
  0x11: { name: 'v128.load64_lane', kind: 'load', valueType: 'v128', widthBits: 64 },
  0x12: { name: 'v128.store8_lane', kind: 'store', valueType: 'v128', widthBits: 8 },
  0x13: { name: 'v128.store16_lane', kind: 'store', valueType: 'v128', widthBits: 16 },
  0x14: { name: 'v128.store32_lane', kind: 'store', valueType: 'v128', widthBits: 32 },
  0x15: { name: 'v128.store64_lane', kind: 'store', valueType: 'v128', widthBits: 64 },
};

const SIMD_LANE_OPS = new Set([0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15]);

const NO_IMMEDIATE_NAMES: Record<number, string> = {
  0x00: 'unreachable',
  0x01: 'nop',
  0x05: 'else',
  0x0b: 'end',
  0x0f: 'return',
  0x1a: 'drop',
  0x1b: 'select',
};

const NUMERIC_OP_NAMES: Record<number, string> = {
  0x45: 'i32.eqz',
  0x46: 'i32.eq',
  0x47: 'i32.ne',
  0x48: 'i32.lt_s',
  0x49: 'i32.lt_u',
  0x4a: 'i32.gt_s',
  0x4b: 'i32.gt_u',
  0x4c: 'i32.le_s',
  0x4d: 'i32.le_u',
  0x4e: 'i32.ge_s',
  0x4f: 'i32.ge_u',
  0x50: 'i64.eqz',
  0x51: 'i64.eq',
  0x52: 'i64.ne',
  0x53: 'i64.lt_s',
  0x54: 'i64.lt_u',
  0x55: 'i64.gt_s',
  0x56: 'i64.gt_u',
  0x57: 'i64.le_s',
  0x58: 'i64.le_u',
  0x59: 'i64.ge_s',
  0x5a: 'i64.ge_u',
  0x5b: 'f32.eq',
  0x5c: 'f32.ne',
  0x5d: 'f32.lt',
  0x5e: 'f32.gt',
  0x5f: 'f32.le',
  0x60: 'f32.ge',
  0x61: 'f64.eq',
  0x62: 'f64.ne',
  0x63: 'f64.lt',
  0x64: 'f64.gt',
  0x65: 'f64.le',
  0x66: 'f64.ge',
  0x67: 'i32.clz',
  0x68: 'i32.ctz',
  0x69: 'i32.popcnt',
  0x6a: 'i32.add',
  0x6b: 'i32.sub',
  0x6c: 'i32.mul',
  0x6d: 'i32.div_s',
  0x6e: 'i32.div_u',
  0x6f: 'i32.rem_s',
  0x70: 'i32.rem_u',
  0x71: 'i32.and',
  0x72: 'i32.or',
  0x73: 'i32.xor',
  0x74: 'i32.shl',
  0x75: 'i32.shr_s',
  0x76: 'i32.shr_u',
  0x77: 'i32.rotl',
  0x78: 'i32.rotr',
  0x79: 'i64.clz',
  0x7a: 'i64.ctz',
  0x7b: 'i64.popcnt',
  0x7c: 'i64.add',
  0x7d: 'i64.sub',
  0x7e: 'i64.mul',
  0x7f: 'i64.div_s',
  0x80: 'i64.div_u',
  0x81: 'i64.rem_s',
  0x82: 'i64.rem_u',
  0x83: 'i64.and',
  0x84: 'i64.or',
  0x85: 'i64.xor',
  0x86: 'i64.shl',
  0x87: 'i64.shr_s',
  0x88: 'i64.shr_u',
  0x89: 'i64.rotl',
  0x8a: 'i64.rotr',
  0x8b: 'f32.abs',
  0x8c: 'f32.neg',
  0x8d: 'f32.ceil',
  0x8e: 'f32.floor',
  0x8f: 'f32.trunc',
  0x90: 'f32.nearest',
  0x91: 'f32.sqrt',
  0x92: 'f32.add',
  0x93: 'f32.sub',
  0x94: 'f32.mul',
  0x95: 'f32.div',
  0x96: 'f32.min',
  0x97: 'f32.max',
  0x98: 'f32.copysign',
  0x99: 'f64.abs',
  0x9a: 'f64.neg',
  0x9b: 'f64.ceil',
  0x9c: 'f64.floor',
  0x9d: 'f64.trunc',
  0x9e: 'f64.nearest',
  0x9f: 'f64.sqrt',
  0xa0: 'f64.add',
  0xa1: 'f64.sub',
  0xa2: 'f64.mul',
  0xa3: 'f64.div',
  0xa4: 'f64.min',
  0xa5: 'f64.max',
  0xa6: 'f64.copysign',
  0xa7: 'i32.wrap_i64',
  0xa8: 'i32.trunc_f32_s',
  0xa9: 'i32.trunc_f32_u',
  0xaa: 'i32.trunc_f64_s',
  0xab: 'i32.trunc_f64_u',
  0xac: 'i64.extend_i32_s',
  0xad: 'i64.extend_i32_u',
  0xae: 'i64.trunc_f32_s',
  0xaf: 'i64.trunc_f32_u',
  0xb0: 'i64.trunc_f64_s',
  0xb1: 'i64.trunc_f64_u',
  0xb2: 'f32.convert_i32_s',
  0xb3: 'f32.convert_i32_u',
  0xb4: 'f32.convert_i64_s',
  0xb5: 'f32.convert_i64_u',
  0xb6: 'f32.demote_f64',
  0xb7: 'f64.convert_i32_s',
  0xb8: 'f64.convert_i32_u',
  0xb9: 'f64.convert_i64_s',
  0xba: 'f64.convert_i64_u',
  0xbb: 'f64.promote_f32',
  0xbc: 'i32.reinterpret_f32',
  0xbd: 'i64.reinterpret_f64',
  0xbe: 'f32.reinterpret_i32',
  0xbf: 'f64.reinterpret_i64',
  0xc0: 'i32.extend8_s',
  0xc1: 'i32.extend16_s',
  0xc2: 'i64.extend8_s',
  0xc3: 'i64.extend16_s',
  0xc4: 'i64.extend32_s',
};

const VALTYPE_NAMES: Record<number, string> = {
  0x7f: 'i32',
  0x7e: 'i64',
  0x7d: 'f32',
  0x7c: 'f64',
  0x7b: 'v128',
  0x70: 'funcref',
  0x6f: 'externref',
};

/** Reads a block type immediate. */
function readBlockType(buf: Buffer, pos: number): { value: string; next: number } {
  const byte = buf[pos];
  if (byte === 0x40) return { value: 'empty', next: pos + 1 };
  if (byte in VALTYPE_NAMES) return { value: VALTYPE_NAMES[byte], next: pos + 1 };
  const { value, next } = readVarInt(buf, pos);
  return { value: `type:${value.toString()}`, next };
}

/** Decodes the instructions of a function body. */
export function decodeInstructions(body: Buffer): WasmInstruction[] {
  const instructions: WasmInstruction[] = [];
  let pos = 0;

  while (pos < body.length) {
    const offset = pos;
    const opcode = body[pos++];
    const args: (number | string | bigint)[] = [];
    let name =
      NO_IMMEDIATE_NAMES[opcode] ?? NUMERIC_OP_NAMES[opcode] ?? `opcode_0x${opcode.toString(16)}`;
    let subOpcode: number | undefined;
    let memarg: WasmInstruction['memarg'];
    let memoryAccess: MemoryAccessInfo | undefined;
    let blockType: string | undefined;
    let unsupported = false;

    switch (opcode) {
      case 0x02:
      case 0x03:
      case 0x04: {
        name = opcode === 0x02 ? 'block' : opcode === 0x03 ? 'loop' : 'if';
        const bt = readBlockType(body, pos);
        blockType = bt.value;
        args.push(bt.value);
        pos = bt.next;
        break;
      }
      case 0x0c:
      case 0x0d: {
        name = opcode === 0x0c ? 'br' : 'br_if';
        const { value, next } = readVarUint(body, pos);
        args.push(value);
        pos = next;
        break;
      }
      case 0x0e: {
        name = 'br_table';
        const { value: count, next } = readVarUint(body, pos);
        pos = next;
        for (let i = 0; i < count; i++) {
          const label = readVarUint(body, pos);
          args.push(label.value);
          pos = label.next;
        }
        const def = readVarUint(body, pos);
        args.push(def.value);
        pos = def.next;
        break;
      }
      case 0x10: {
        name = 'call';
        const { value, next } = readVarUint(body, pos);
        args.push(value);
        pos = next;
        break;
      }
      case 0x11: {
        name = 'call_indirect';
        const typeIndex = readVarUint(body, pos);
        const tableIndex = readVarUint(body, typeIndex.next);
        args.push(typeIndex.value, tableIndex.value);
        pos = tableIndex.next;
        break;
      }
      case 0x1c: {
        name = 'select';
        const { value: count, next } = readVarUint(body, pos);
        pos = next;
        for (let i = 0; i < count; i++) {
          const type = body[pos++];
          args.push(VALTYPE_NAMES[type] ?? `type_0x${type.toString(16)}`);
        }
        break;
      }
      case 0x20:
      case 0x21:
      case 0x22:
      case 0x23:
      case 0x24:
      case 0x25:
      case 0x26: {
        name =
          opcode === 0x20
            ? 'local.get'
            : opcode === 0x21
              ? 'local.set'
              : opcode === 0x22
                ? 'local.tee'
                : opcode === 0x23
                  ? 'global.get'
                  : opcode === 0x24
                    ? 'global.set'
                    : opcode === 0x25
                      ? 'table.get'
                      : 'table.set';
        const { value, next } = readVarUint(body, pos);
        args.push(value);
        pos = next;
        break;
      }
      case 0x3f:
      case 0x40: {
        name = opcode === 0x3f ? 'memory.size' : 'memory.grow';
        const { value, next } = readVarUint(body, pos);
        args.push(value);
        pos = next;
        break;
      }
      case 0x41: {
        name = 'i32.const';
        const { value, next } = readVarInt(body, pos);
        args.push(value);
        pos = next;
        break;
      }
      case 0x42: {
        name = 'i64.const';
        const { value, next } = readVarInt(body, pos);
        args.push(value);
        pos = next;
        break;
      }
      case 0x43: {
        name = 'f32.const';
        const { value, next } = readFloat(body, pos, 4);
        args.push(value);
        pos = next;
        break;
      }
      case 0x44: {
        name = 'f64.const';
        const { value, next } = readFloat(body, pos, 8);
        args.push(value);
        pos = next;
        break;
      }
      case 0xd0: {
        name = 'ref.null';
        const { value, next } = readVarInt(body, pos);
        args.push(value);
        pos = next;
        break;
      }
      case 0xd1: {
        name = 'ref.is_null';
        break;
      }
      case 0xd2: {
        name = 'ref.func';
        const { value, next } = readVarUint(body, pos);
        args.push(value);
        pos = next;
        break;
      }
      case 0xfc: {
        subOpcode = body[pos++];
        name = `0xfc.${subOpcode}`;
        if (subOpcode <= 0x07) {
          name = [
            'i32.trunc_sat_f32_s',
            'i32.trunc_sat_f32_u',
            'i32.trunc_sat_f64_s',
            'i32.trunc_sat_f64_u',
            'i64.trunc_sat_f32_s',
            'i64.trunc_sat_f32_u',
            'i64.trunc_sat_f64_s',
            'i64.trunc_sat_f64_u',
          ][subOpcode];
          break;
        }
        if (subOpcode === 0x08) {
          name = 'memory.init';
          const dataIndex = readVarUint(body, pos);
          const memIndex = readVarUint(body, dataIndex.next);
          args.push(dataIndex.value, memIndex.value);
          pos = memIndex.next;
          break;
        }
        if (subOpcode === 0x09) {
          name = 'data.drop';
          const { value, next } = readVarUint(body, pos);
          args.push(value);
          pos = next;
          break;
        }
        if (subOpcode === 0x0a || subOpcode === 0x0b) {
          name = subOpcode === 0x0a ? 'memory.copy' : 'memory.fill';
          const dest = readVarUint(body, pos);
          const source = readVarUint(body, dest.next);
          args.push(dest.value, source.value);
          pos = source.next;
          break;
        }
        unsupported = true;
        break;
      }
      case 0xfd: {
        subOpcode = body[pos++];
        const spec = SIMD_MEMORY_OPS[subOpcode];
        if (spec) {
          name = spec.name;
          const align = readVarUint(body, pos);
          const offset = readVarUint(body, align.next);
          let memoryIndex = 0;
          let cursor = offset.next;
          if ((align.value & 0x40) !== 0) {
            const mem = readVarUint(body, cursor);
            memoryIndex = mem.value;
            cursor = mem.next;
          }
          memarg = { align: align.value & 0x3f, offset: offset.value, memoryIndex };
          args.push(align.value & 0x3f, offset.value);
          if (SIMD_LANE_OPS.has(subOpcode)) {
            const lane = body[cursor++];
            args.push(lane);
          }
          memoryAccess = {
            kind: spec.kind,
            valueType: spec.valueType,
            widthBits: spec.widthBits,
            signed: spec.signed ?? false,
            unsigned: spec.unsigned ?? false,
          };
          pos = cursor;
          break;
        }
        name = `0xfd.${subOpcode}`;
        unsupported = true;
        break;
      }
      default: {
        const spec = MEMORY_OPS[opcode];
        if (spec) {
          name = spec.name;
          const align = readVarUint(body, pos);
          const offset = readVarUint(body, align.next);
          let memoryIndex = 0;
          let cursor = offset.next;
          if ((align.value & 0x40) !== 0) {
            const mem = readVarUint(body, cursor);
            memoryIndex = mem.value;
            cursor = mem.next;
          }
          memarg = { align: align.value & 0x3f, offset: offset.value, memoryIndex };
          args.push(align.value & 0x3f, offset.value);
          memoryAccess = {
            kind: spec.kind,
            valueType: spec.valueType,
            widthBits: spec.widthBits,
            signed: spec.signed ?? false,
            unsigned: spec.unsigned ?? false,
          };
          pos = cursor;
          break;
        }
        if (opcode in NUMERIC_OP_NAMES || opcode in NO_IMMEDIATE_NAMES) break;
        unsupported = true;
        break;
      }
    }

    instructions.push({
      index: instructions.length,
      offset,
      opcode,
      subOpcode,
      name,
      args,
      memarg,
      memoryAccess,
      blockType,
      unsupported,
    });
  }

  return instructions;
}

// ─── Module parsing ──────────────────────────────────────────────────────────

/** Parses the type section into function signatures. */
function parseTypeSection(payload: Buffer): { params: string[]; results: string[] }[] {
  const types: { params: string[]; results: string[] }[] = [];
  let pos = 0;
  const { value: count, next } = readVarUint(payload, pos);
  pos = next;

  for (let i = 0; i < count; i++) {
    if (payload[pos] !== 0x60) {
      // Unknown type form: skip the section rather than failing the whole module.
      return types;
    }
    pos += 1;
    const { value: paramCount, next: afterParams } = readVarUint(payload, pos);
    pos = afterParams;
    const params: string[] = [];
    for (let p = 0; p < paramCount; p++) {
      params.push(VALTYPE_NAMES[payload[pos]] ?? `type_0x${payload[pos].toString(16)}`);
      pos += 1;
    }
    const { value: resultCount, next: afterResults } = readVarUint(payload, pos);
    pos = afterResults;
    const results: string[] = [];
    for (let r = 0; r < resultCount; r++) {
      results.push(VALTYPE_NAMES[payload[pos]] ?? `type_0x${payload[pos].toString(16)}`);
      pos += 1;
    }
    types.push({ params, results });
  }

  return types;
}

/** Parses the import section. */
function parseImportSection(payload: Buffer): {
  imports: WasmModule['imports'];
  memories: MemoryInfo[];
  functionTypes: number[];
} {
  const imports: WasmModule['imports'] = [];
  const memories: MemoryInfo[] = [];
  const functionTypes: number[] = [];
  let pos = 0;
  const { value: count, next } = readVarUint(payload, pos);
  pos = next;

  for (let i = 0; i < count; i++) {
    const module = readName(payload, pos);
    const name = readName(payload, module.next);
    const kindByte = payload[name.next];
    let cursor = name.next + 1;

    switch (kindByte) {
      case 0x00: {
        const typeIndex = readVarUint(payload, cursor);
        cursor = typeIndex.next;
        functionTypes.push(typeIndex.value);
        imports.push({ module: module.value, name: name.value, kind: 'function' });
        break;
      }
      case 0x01: {
        // Table: element type + limits.
        cursor += 1;
        const limits = readLimits(payload, cursor);
        cursor = limits.next;
        imports.push({ module: module.value, name: name.value, kind: 'table' });
        break;
      }
      case 0x02: {
        const limits = readLimits(payload, cursor);
        cursor = limits.next;
        memories.push({ index: memories.length, imported: true, min: limits.min, max: limits.max });
        imports.push({ module: module.value, name: name.value, kind: 'memory' });
        break;
      }
      case 0x03: {
        cursor += 2; // value type + mutability
        imports.push({ module: module.value, name: name.value, kind: 'global' });
        break;
      }
      default:
        imports.push({ module: module.value, name: name.value, kind: `unknown_${kindByte}` });
        break;
    }
    pos = cursor;
  }

  return { imports, memories, functionTypes };
}

/** Reads a limits structure (`min` and optional `max`). */
function readLimits(payload: Buffer, pos: number): { min: number; max?: number; next: number } {
  const flags = payload[pos];
  const { value: min, next } = readVarUint(payload, pos + 1);
  if ((flags & 0x01) !== 0) {
    const max = readVarUint(payload, next);
    return { min, max: max.value, next: max.next };
  }
  return { min, next };
}

/** Parses the export section. */
function parseExportSection(payload: Buffer): WasmModule['exports'] {
  const exports: WasmModule['exports'] = [];
  let pos = 0;
  const { value: count, next } = readVarUint(payload, pos);
  pos = next;
  const kinds = ['function', 'table', 'memory', 'global', 'tag'];

  for (let i = 0; i < count; i++) {
    const name = readName(payload, pos);
    const kindByte = payload[name.next];
    const index = readVarUint(payload, name.next + 1);
    exports.push({
      name: name.value,
      kind: kinds[kindByte] ?? `unknown_${kindByte}`,
      index: index.value,
    });
    pos = index.next;
  }

  return exports;
}

/** Parses the memory section. */
function parseMemorySection(payload: Buffer, imported: MemoryInfo[]): MemoryInfo[] {
  const memories = [...imported];
  let pos = 0;
  const { value: count, next } = readVarUint(payload, pos);
  pos = next;

  for (let i = 0; i < count; i++) {
    const limits = readLimits(payload, pos);
    memories.push({
      index: memories.length,
      imported: false,
      min: limits.min,
      max: limits.max,
    });
    pos = limits.next;
  }

  return memories;
}

/**
 * Parses a complete WebAssembly module.
 *
 * @throws {WasmParseError} when the module structure cannot be read.
 */
export function parseWasmModule(buf: Buffer): WasmModule {
  const sections = parseWasmSections(buf);

  const sectionByName = (name: string) => sections.find((s) => s.name === name);

  const typeSection = sectionByName('type');
  const types = typeSection ? parseTypeSection(typeSection.payload) : [];

  const importSection = sectionByName('import');
  const imported = importSection
    ? parseImportSection(importSection.payload)
    : { imports: [], memories: [], functionTypes: [] };
  const imports = imported.imports;
  const importedMemories = imported.memories;
  const importedFunctionTypes = imported.functionTypes;

  const functionSection = sectionByName('function');
  const typeIndices: number[] = [];
  if (functionSection) {
    let pos = 0;
    const { value: count, next } = readVarUint(functionSection.payload, pos);
    pos = next;
    for (let i = 0; i < count; i++) {
      const typeIndex = readVarUint(functionSection.payload, pos);
      typeIndices.push(typeIndex.value);
      pos = typeIndex.next;
    }
  }

  const exportSection = sectionByName('export');
  const exports = exportSection ? parseExportSection(exportSection.payload) : [];

  const memorySection = sectionByName('memory');
  const memories = memorySection
    ? parseMemorySection(memorySection.payload, importedMemories)
    : importedMemories;

  const codeSection = sectionByName('code');
  const functions: WasmFunction[] = [];
  const importedFunctionCount = imports.filter((i) => i.kind === 'function').length;

  if (codeSection) {
    let pos = 0;
    const { value: count, next } = readVarUint(codeSection.payload, pos);
    pos = next;

    for (let i = 0; i < count; i++) {
      const bodySize = readVarUint(codeSection.payload, pos);
      const bodyStart = bodySize.next;
      const bodyEnd = bodyStart + bodySize.value;
      if (bodyEnd > codeSection.payload.length) {
        throw new WasmParseError(`Code section entry ${i} extends past the section boundary`);
      }

      const body = codeSection.payload.subarray(bodyStart, bodyEnd);
      let cursor = 0;
      const { value: localGroups, next: afterGroups } = readVarUint(body, cursor);
      cursor = afterGroups;
      const locals: { count: number; type: string }[] = [];
      for (let g = 0; g < localGroups; g++) {
        const count = readVarUint(body, cursor);
        const typeByte = body[count.next];
        locals.push({
          count: count.value,
          type: VALTYPE_NAMES[typeByte] ?? `type_0x${typeByte.toString(16)}`,
        });
        cursor = count.next + 1;
      }

      functions.push({
        index: importedFunctionCount + i,
        typeIndex: typeIndices[i] ?? 0,
        paramCount: 0,
        resultCount: 0,
        locals,
        instructions: decodeInstructions(body.subarray(cursor)),
        bodyOffset: codeSection.payloadOffset + bodyStart + cursor,
        bodySize: bodyEnd - bodyStart - cursor,
      });
      pos = bodyEnd;
    }
  }

  const module: WasmModule = {
    version: buf.readUInt32LE(4),
    sections,
    functions,
    importedFunctionCount,
    imports,
    exports,
    memories,
    types,
    functionTypeIndices: [...importedFunctionTypes, ...typeIndices],
  };

  // Attach exported names to functions.
  for (const entry of exports) {
    if (entry.kind !== 'function') continue;
    const fn = module.functions.find((f) => f.index === entry.index);
    if (fn) fn.name = entry.name;
  }

  // Attach the parameter/result counts so local indexes can be resolved.
  for (const fn of module.functions) {
    const signature = types[fn.typeIndex];
    fn.paramCount = signature ? signature.params.length : 0;
    fn.resultCount = signature ? signature.results.length : 0;
  }

  return module;
}
