/**
 * Compatibility adapter for the legacy WASM analyzers.
 *
 * The analyzers in `src/analyzer` were originally written against the
 * `wasm-parser` package, which is no longer published on npm. This module
 * offers the same `parse()` shape on top of the repository's own binary
 * reader (`src/wasm/wasmBinary.ts`), so the repository installs and builds
 * without an external dependency that cannot be resolved.
 *
 * The adapter never instantiates or executes a module: it only decodes the
 * binary format.
 */

import { parseWasmModule, type WasmInstruction, type WasmModule } from './wasmBinary';

/** An instruction in the shape the legacy analyzers expect. */
export interface LegacyInstruction {
  /** Mnemonic of the instruction. */
  opcode: string;
  /** Alias of {@link LegacyInstruction.opcode}. */
  name: string;
  /** Decoded immediates. */
  args: (number | string | bigint)[];
  /** Target of a `call` instruction, when there is one. */
  index?: number;
  /** Byte offset of the instruction inside the function body. */
  offset: number;
}

/** A function in the shape the legacy analyzers expect. */
export interface LegacyFunction {
  /** Exported name of the function, when it has one. */
  name?: string;
  /** Body of the function. */
  body: {
    /** Instructions of the body. */
    instructions: LegacyInstruction[];
  };
}

/** A module in the shape the legacy analyzers expect. */
export interface LegacyModule {
  /** Locally defined functions. */
  functions: LegacyFunction[];
  /** Imported entries. */
  imports: { module: string; name: string; kind: string }[];
  /** Exported entries. */
  exports: { name: string; kind: string; index: number }[];
  /** The fully decoded module. */
  module: WasmModule;
}

/** Converts a decoded instruction into the legacy shape. */
export function toLegacyInstruction(instruction: WasmInstruction): LegacyInstruction {
  const legacy: LegacyInstruction = {
    opcode: instruction.name,
    name: instruction.name,
    args: instruction.args,
    offset: instruction.offset,
  };
  if (instruction.name === 'call') {
    legacy.index = Number(instruction.args[0] ?? 0);
  }
  return legacy;
}

/**
 * Parses a WebAssembly binary into the legacy module shape.
 *
 * @throws {WasmParseError} when the buffer is not a valid WebAssembly module.
 */
export function parse(buffer: Buffer): LegacyModule {
  const module = parseWasmModule(buffer);

  return {
    functions: module.functions.map((func) => ({
      name: func.name,
      body: {
        instructions: func.instructions.map(toLegacyInstruction),
      },
    })),
    imports: module.imports,
    exports: module.exports,
    module,
  };
}
