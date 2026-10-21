/**
 * Helpers that build small WebAssembly binaries for the offline analyses.
 *
 * The fixtures are assembled byte by byte so that the tests can describe
 * exactly which instruction they want to inspect. Nothing here executes a
 * module: the helpers only produce bytes.
 */

/** Encodes an unsigned LEB128 integer. */
export function u32(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

/** Encodes a signed LEB128 integer. */
export function i32(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value | 0;
  for (;;) {
    const byte = remaining & 0x7f;
    remaining >>= 7;
    const signBit = (byte & 0x40) !== 0;
    if ((remaining === 0 && !signBit) || (remaining === -1 && signBit)) {
      bytes.push(byte);
      break;
    }
    bytes.push(byte | 0x80);
  }
  return bytes;
}

/** Encodes a length-prefixed name. */
export function name(value: string): number[] {
  const bytes = [...Buffer.from(value, 'utf8')];
  return [...u32(bytes.length), ...bytes];
}

/** Builds a section from its id and payload. */
export function section(id: number, payload: number[]): number[] {
  return [id, ...u32(payload.length), ...payload];
}

/** The eight header bytes of every WebAssembly module. */
export const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/** A custom section with the given name and payload. */
export function customSection(customName: string, payload: number[] = []): number[] {
  return section(0, [...name(customName), ...payload]);
}

/** Instruction builders. */
export const op = {
  unreachable: (): number[] => [0x00],
  nop: (): number[] => [0x01],
  block: (): number[] => [0x02, 0x40],
  loop: (): number[] => [0x03, 0x40],
  if: (): number[] => [0x04, 0x40],
  else: (): number[] => [0x05],
  end: (): number[] => [0x0b],
  br: (depth: number): number[] => [0x0c, ...u32(depth)],
  brIf: (depth: number): number[] => [0x0d, ...u32(depth)],
  brTable: (depths: number[], fallback: number): number[] => [
    0x0e,
    ...u32(depths.length),
    ...depths.flatMap((depth) => u32(depth)),
    ...u32(fallback),
  ],
  return: (): number[] => [0x0f],
  call: (index: number): number[] => [0x10, ...u32(index)],
  drop: (): number[] => [0x1a],
  select: (): number[] => [0x1b],
  localGet: (index: number): number[] => [0x20, ...u32(index)],
  localSet: (index: number): number[] => [0x21, ...u32(index)],
  localTee: (index: number): number[] => [0x22, ...u32(index)],
  globalGet: (index: number): number[] => [0x23, ...u32(index)],
  globalSet: (index: number): number[] => [0x24, ...u32(index)],
  i32Load: (align: number, offset: number): number[] => [0x28, ...u32(align), ...u32(offset)],
  i64Load: (align: number, offset: number): number[] => [0x29, ...u32(align), ...u32(offset)],
  f32Load: (align: number, offset: number): number[] => [0x2a, ...u32(align), ...u32(offset)],
  f64Load: (align: number, offset: number): number[] => [0x2b, ...u32(align), ...u32(offset)],
  i32Load8S: (align: number, offset: number): number[] => [0x2c, ...u32(align), ...u32(offset)],
  i32Load8U: (align: number, offset: number): number[] => [0x2d, ...u32(align), ...u32(offset)],
  i32Load16S: (align: number, offset: number): number[] => [0x2e, ...u32(align), ...u32(offset)],
  i32Load16U: (align: number, offset: number): number[] => [0x2f, ...u32(align), ...u32(offset)],
  i64Load32S: (align: number, offset: number): number[] => [0x34, ...u32(align), ...u32(offset)],
  i32Store: (align: number, offset: number): number[] => [0x36, ...u32(align), ...u32(offset)],
  i64Store: (align: number, offset: number): number[] => [0x37, ...u32(align), ...u32(offset)],
  f32Store: (align: number, offset: number): number[] => [0x38, ...u32(align), ...u32(offset)],
  f64Store: (align: number, offset: number): number[] => [0x39, ...u32(align), ...u32(offset)],
  i32Store8: (align: number, offset: number): number[] => [0x3a, ...u32(align), ...u32(offset)],
  i32Store16: (align: number, offset: number): number[] => [0x3b, ...u32(align), ...u32(offset)],
  i64Store32: (align: number, offset: number): number[] => [0x3e, ...u32(align), ...u32(offset)],
  memorySize: (): number[] => [0x3f, 0x00],
  memoryGrow: (): number[] => [0x40, 0x00],
  i32Const: (value: number): number[] => [0x41, ...i32(value)],
  i64Const: (value: number): number[] => [0x42, ...i32(value)],
  i32Eqz: (): number[] => [0x45],
  i32Eq: (): number[] => [0x46],
  i32Ne: (): number[] => [0x47],
  i32LtS: (): number[] => [0x48],
  i32GeS: (): number[] => [0x4e],
  i32Add: (): number[] => [0x6a],
  i32Sub: (): number[] => [0x6b],
  i32Mul: (): number[] => [0x6c],
  i32And: (): number[] => [0x71],
  i32Or: (): number[] => [0x72],
  i32Xor: (): number[] => [0x73],
  i32Shl: (): number[] => [0x74],
  i32ShrU: (): number[] => [0x76],
  i64Add: (): number[] => [0x7c],
  i64Sub: (): number[] => [0x7d],
  i64Mul: (): number[] => [0x7e],
  i64Eq: (): number[] => [0x51],
  i32WrapI64: (): number[] => [0xa7],
  i64ExtendI32S: (): number[] => [0xac],
  i32Extend8S: (): number[] => [0xc0],
};

/** Options for {@link buildModule}. */
export interface ModuleOptions {
  /** Bodies of the local functions, one byte array per function. */
  bodies?: number[][];
  /** Extra sections appended after the code section. */
  extraSections?: number[][];
  /** Include a memory section declaring one memory with the given minimum size. */
  memoryPages?: number;
  /** Names of the exported functions, in order. */
  exportNames?: string[];
  /** Include a custom section named `producers`. */
  producersSection?: boolean;
}

/**
 * Builds a WebAssembly module with the given function bodies.
 *
 * The module declares one function type `() -> ()` and one local function per
 * body. Every body is expected to be a sequence of instructions that ends
 * with the `end` opcode.
 */
export function buildModule(options: ModuleOptions = {}): Buffer {
  const bodies = options.bodies ?? [];
  const parts: number[] = [...WASM_HEADER];

  // Type section: one `() -> ()` signature.
  parts.push(...section(1, [0x01, 0x60, 0x00, 0x00]));

  // Function section: every function uses type 0.
  parts.push(...section(3, [bodies.length, ...bodies.map(() => 0x00)]));

  if (options.memoryPages !== undefined) {
    parts.push(...section(5, [0x01, 0x00, ...u32(options.memoryPages)]));
  }

  if (options.exportNames && options.exportNames.length > 0) {
    const payload: number[] = [options.exportNames.length];
    options.exportNames.forEach((exportName, index) => {
      payload.push(...name(exportName), 0x00, ...u32(index));
    });
    parts.push(...section(7, payload));
  }

  if (options.producersSection) {
    parts.push(...customSection('producers', [0x01, 0x02, 0x03]));
  }

  if (bodies.length > 0) {
    const payload: number[] = [bodies.length];
    for (const body of bodies) {
      const full = [0x00, ...body, ...op.end()];
      payload.push(...u32(full.length), ...full);
    }
    parts.push(...section(10, payload));
  }

  for (const extra of options.extraSections ?? []) {
    parts.push(...extra);
  }

  return Buffer.from(parts);
}
