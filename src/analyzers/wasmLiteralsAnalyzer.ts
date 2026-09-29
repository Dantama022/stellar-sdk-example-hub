import { LiteralOccurrence, LiteralInfo, WasmLiteralAnalysis, LiteralType, ClassificationPattern } from '../types/wasmLiterals';

interface WasmModule {
  types: any[];
  funcs: any[];
  code: any[];
  data: any[];
}

export interface WasmLiteralAnalysisOptions {
  includeFloats: boolean;
  includeHex: boolean;
  classifyPatterns: boolean;
  minOccurrences: number;
}

const DEFAULT_OPTIONS: WasmLiteralAnalysisOptions = {
  includeFloats: true,
  includeHex: true,
  classifyPatterns: true,
  minOccurrences: 1
};

// WASM opcodes that can contain immediate numeric literals
const NUMERIC_OPCODES = new Set([
  0x41, // i32.const
  0x42, // i64.const
  0x43, // f32.const
  0x44, // f64.const
  0x45, // i32.eqz
  0x46, // i32.eq
  0x47, // i32.ne
  0x48, // i32.lt_s
  0x49, // i32.lt_u
  0x4A, // i32.gt_s
  0x4B, // i32.gt_u
  0x4C, // i32.le_s
  0x4D, // i32.le_u
  0x4E, // i32.ge_s
  0x4F, // i32.ge_u
  0x50, // i64.eqz
  0x51, // i64.eq
  0x52, // i64.ne
  0x53, // i64.lt_s
  0x54, // i64.lt_u
  0x55, // i64.gt_s
  0x56, // i64.gt_u
  0x57, // i64.le_s
  0x58, // i64.le_u
  0x59, // i64.ge_s
  0x5A, // i64.ge_u
  0x6A, // i32.rem_s
  0x6B, // i32.rem_u
  0x6C, // i32.and
  0x6D, // i32.or
  0x6E, // i32.xor
  0x6F, // i32.shl
  0x70, // i32.shr_s
  0x71, // i32.shr_u
  0x72, // i32.rotl
  0x73, // i32.rotr
  0x79, // i64.rem_s
  0x7A, // i64.rem_u
  0x7B, // i64.and
  0x7C, // i64.or
  0x7D, // i64.xor
  0x7E, // i64.shl
  0x7F, // i64.shr_s
  0x80, // i64.shr_u
  0x81, // i64.rotl
  0x82, // i64.rotr
  0x28, // i32.trunc_f32_s
  0x29, // i32.trunc_f32_u
  0x2A, // i32.trunc_f64_s
  0x2B, // i32.trunc_f64_u
  0x2C, // i64.extend_i32_s
  0x2D, // i64.extend_i32_u
  0x2E, // i64.trunc_f32_s
  0x2F, // i64.trunc_f32_u
  0x30, // i64.trunc_f64_s
  0x31, // i64.trunc_f64_u
  0x3C, // i32.extend8_s
  0x3D, // i32.extend16_s
  0x3E, // i64.extend8_s
  0x3F, // i64.extend16_s
  0x40, // i64.extend32_s
  0x1A, // drop
  0x1B, // select
  0x00, // unreachable
  0x01, // nop
  0x02, // block
  0x03, // loop
  0x04, // if
  0x05, // else
  0x0B, // end
  0x0C, // br
  0x0D, // br_if
  0x0E, // br_table
  0x0F, // return
  0x10, // call
  0x11, // call_indirect
  0x12, // return_call
  0x13, // return_call_indirect
  0x14, // delegate
  0x15, // catch
  0x16, // throw
  0x17, // rethrow
  0x18, // try
  0x19, // try_table
]);

// Patterns for deterministic classification
const PATTERN_CHECKS: Array<{ pattern: ClassificationPattern; check: (value: bigint | number) => boolean }> = [
  { pattern: 'zero', check: (v) => v === 0n || v === 0 },
  { pattern: 'one', check: (v) => v === 1n || v === 1 },
  { pattern: 'negative-one', check: (v) => v === -1n || v === -1 },
  { pattern: 'power-of-two', check: (v) => typeof v === 'bigint' ? (v > 0n && (v & (v - 1n)) === 0n) : (v > 0 && (v & (v - 1)) === 0) },
  { pattern: 'bit-mask', check: (v) => typeof v === 'bigint' ? isBitMask(v) : isBitMask(BigInt(v)) },
  { pattern: 'byte-mask', check: (v) => typeof v === 'bigint' ? v <= 0xFFn : v <= 0xFF },
  { pattern: 'alignment-like', check: (v) => typeof v === 'bigint' ? [1n, 2n, 4n, 8n, 16n].includes(v) : [1, 2, 4, 8, 16].includes(v) }
];

function isBitMask(value: bigint): boolean {
  if (value <= 0n) return false;
  // Check if it's a sequence of 1s followed by 0s (e.g., 0b111000)
  const binary = value.toString(2);
  const ones = binary.split('0');
  return ones.length === 1 || (ones.length === 2 && ones[1] === '');
}

function decodeWasmModule(buffer: Buffer): WasmModule {
  // Simple WASM binary format parser (minimal implementation for literals)
  // Note: In production, use a proper WASM parser like 'wasm-parser' or 'leb128'
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 0;

  // Skip magic number and version
  if (buffer.subarray(0, 4).toString() !== '\0asm') {
    throw new Error('Invalid WASM magic number');
  }
  offset = 8; // Skip magic (4 bytes) + version (4 bytes)

  const module: Partial<WasmModule> = {
    types: [],
    funcs: [],
    code: [],
    data: []
  };

  while (offset < buffer.length) {
    const sectionId = view.getUint8(offset++);
    if (sectionId === 0) break; // End of module

    const sectionSize = decodeULEB128(view, offset);
    offset += sectionSize.length;
    const sectionEnd = offset + sectionSize.value;

    switch (sectionId) {
      case 1: // Type section
        module.types = parseTypeSection(view, offset, sectionEnd);
        break;
      case 3: // Function section
        module.funcs = parseFunctionSection(view, offset, sectionEnd);
        break;
      case 10: // Code section
        module.code = parseCodeSection(view, offset, sectionEnd);
        break;
      case 11: // Data section
        module.data = parseDataSection(view, offset, sectionEnd);
        break;
    }
    offset = sectionEnd;
  }

  return module as WasmModule;
}

function decodeULEB128(view: DataView, offset: number): { value: number; length: number } {
  let value = 0;
  let shift = 0;
  let length = 0;

  while (true) {
    const byte = view.getUint8(offset++);
    length++;
    value |= (byte & 0x7F) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }

  return { value, length };
}

function decodeSLEB128(view: DataView, offset: number): { value: bigint; length: number } {
  let value = 0n;
  let shift = 0n;
  let length = 0;
  let byte: number;

  do {
    byte = view.getUint8(offset++);
    length++;
    value |= BigInt(byte & 0x7F) << shift;
    shift += 7n;
  } while ((byte & 0x80) !== 0);

  if ((byte & 0x40) !== 0) {
    value = -((~value + 1n) & ((1n << shift) - 1n));
  }

  return { value, length };
}

function parseTypeSection(view: DataView, offset: number, end: number): any[] {
  const count = decodeULEB128(view, offset).value;
  offset += decodeULEB128(view, offset).length;
  const types = [];
  for (let i = 0; i < count; i++) {
    const form = view.getUint8(offset++);
    types.push({ form, params: [], results: [] });
    // Simplified - actual parsing would be more complex
  }
  return types;
}

function parseFunctionSection(view: DataView, offset: number, end: number): any[] {
  const count = decodeULEB128(view, offset).value;
  offset += decodeULEB128(view, offset).length;
  const funcs = [];
  for (let i = 0; i < count; i++) {
    funcs.push(decodeULEB128(view, offset).value);
    offset += decodeULEB128(view, offset).length;
  }
  return funcs;
}

function parseCodeSection(view: DataView, offset: number, end: number): any[] {
  const count = decodeULEB128(view, offset).value;
  offset += decodeULEB128(view, offset).length;
  const code = [];

  for (let i = 0; i < count; i++) {
    const bodySize = decodeULEB128(view, offset).value;
    offset += decodeULEB128(view, offset).length;
    const bodyStart = offset;

    // Parse function body
    const localsCount = decodeULEB128(view, offset).value;
    offset += decodeULEB128(view, offset).length;

    for (let j = 0; j < localsCount; j++) {
      const n = decodeULEB128(view, offset).value;
      offset += decodeULEB128(view, offset).length;
      const type = view.getUint8(offset++);
    }

    // Parse instructions
    const instructions: any[] = [];
    while (offset < bodyStart + bodySize) {
      const opcode = view.getUint8(offset++);

      if (NUMERIC_OPCODES.has(opcode)) {
        let value: bigint | number;
        let bitWidth: number;
        let type: LiteralType;

        switch (opcode) {
          case 0x41: // i32.const
            value = decodeSLEB128(view, offset).value;
            offset += decodeSLEB128(view, offset).length;
            bitWidth = 32;
            type = 'i32';
            break;
          case 0x42: // i64.const
            value = decodeSLEB128(view, offset).value;
            offset += decodeSLEB128(view, offset).length;
            bitWidth = 64;
            type = 'i64';
            break;
          case 0x43: // f32.const
            if (!DEFAULT_OPTIONS.includeFloats) continue;
            value = view.getFloat32(offset, true);
            offset += 4;
            bitWidth = 32;
            type = 'f32';
            break;
          case 0x44: // f64.const
            if (!DEFAULT_OPTIONS.includeFloats) continue;
            value = view.getFloat64(offset, true);
            offset += 8;
            bitWidth = 64;
            type = 'f64';
            break;
          default:
            // For other opcodes, we might have immediate values
            // This is a simplified approach
            value = decodeULEB128(view, offset).value;
            offset += decodeULEB128(view, offset).length;
            bitWidth = 32; // Default
            type = 'i32';
        }

        instructions.push({
          opcode,
          type: 'numeric',
          value,
          bitWidth,
          literalType: type
        });
      } else {
        // Handle other opcodes (simplified)
        switch (opcode) {
          case 0x0B: // end
          case 0x02: // block
          case 0x03: // loop
          case 0x04: // if
            // These might have type signatures
            const typeIndex = decodeULEB128(view, offset).value;
            offset += decodeULEB128(view, offset).length;
            break;
          case 0x0C: // br
          case 0x0D: // br_if
            offset += decodeULEB128(view, offset).length;
            break;
          case 0x0E: // br_table
            {
              const numTargets = decodeULEB128(view, offset).value;
              offset += decodeULEB128(view, offset).length;
              for (let k = 0; k < numTargets; k++) {
                offset += decodeULEB128(view, offset).length;
              }
              offset += decodeULEB128(view, offset).length; // default target
            }
            break;
          case 0x10: // call
            offset += decodeULEB128(view, offset).length;
            break;
          case 0x11: // call_indirect
            offset += decodeULEB128(view, offset).length; // type index
            offset += decodeULEB128(view, offset).length; // table index
            break;
          // Add more cases as needed
        }
        instructions.push({ opcode, type: 'other' });
      }
    }

    code.push({
      locals: [],
      body: instructions,
      bodySize
    });
    offset = bodyStart + bodySize;
  }

  return code;
}

function parseDataSection(view: DataView, offset: number, end: number): any[] {
  const count = decodeULEB128(view, offset).value;
  offset += decodeULEB128(view, offset).length;
  const data = [];

  for (let i = 0; i < count; i++) {
    const index = decodeULEB128(view, offset).value;
    offset += decodeULEB128(view, offset).length;
    const size = decodeULEB128(view, offset).value;
    offset += decodeULEB128(view, offset).length;
    const bytes = buffer.subarray(offset, offset + size);
    offset += size;

    // Analyze data section for literals
    // This is a simplified approach - would need more sophisticated analysis
    data.push({ index, bytes });
  }

  return data;
}

export function analyzeWasmLiterals(
  wasmBuffer: Buffer,
  options: Partial<WasmLiteralAnalysisOptions> = {}
): WasmLiteralAnalysis {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const module = decodeWasmModule(wasmBuffer);
  const literalsMap = new Map<string, LiteralInfo>();
  const allOccurrences: LiteralOccurrence[] = [];

  // Analyze code section for literals
  for (let funcIndex = 0; funcIndex < module.code.length; funcIndex++) {
    const funcBody = module.code[funcIndex];

    for (let blockIndex = 0; blockIndex < funcBody.body.length; blockIndex++) {
      const instruction = funcBody.body[blockIndex];

      if (instruction.type === 'numeric') {
        const rawValue = instruction.value;
        const bitWidth = instruction.bitWidth;
        const literalType = instruction.literalType;

        // Create normalized representation
        let normalizedValue: string;
        let signedValue: bigint | number | null = null;
        let unsignedValue: bigint | number | null = null;
        let hexValue: string | null = null;

        if (typeof rawValue === 'bigint') {
          normalizedValue = rawValue.toString();
          signedValue = rawValue;
          unsignedValue = rawValue >= 0n ? rawValue : null;
          if (opts.includeHex) {
            hexValue = '0x' + rawValue.toString(16);
          }
        } else if (typeof rawValue === 'number') {
          normalizedValue = rawValue.toString();
          signedValue = rawValue;
          unsignedValue = rawValue >= 0 ? rawValue : null;
          if (opts.includeHex) {
            hexValue = '0x' + Math.floor(rawValue).toString(16);
          }
        } else {
          // For floats
          normalizedValue = rawValue.toString();
          if (opts.includeHex) {
            const floatView = new DataView(new ArrayBuffer(8));
            if (literalType === 'f32') {
              floatView.setFloat32(0, rawValue, true);
              hexValue = '0x' + Buffer.from(floatView.buffer).toString('hex');
            } else {
              floatView.setFloat64(0, rawValue, true);
              hexValue = '0x' + Buffer.from(floatView.buffer).toString('hex');
            }
          }
        }

        // Create occurrence record
        const occurrence: LiteralOccurrence = {
          functionIndex: funcIndex,
          blockIndex,
          instructionIndex: blockIndex,
          opcode: instruction.opcode,
          rawValue,
          bitWidth,
          literalType
        };

        allOccurrences.push(occurrence);

        // Create or update literal info
        const key = `${normalizedValue}-${bitWidth}-${literalType}`;
        if (!literalsMap.has(key)) {
          const classifications: ClassificationPattern[] = [];

          if (opts.classifyPatterns) {
            for (const { pattern, check } of PATTERN_CHECKS) {
              if (check(rawValue)) {
                classifications.push(pattern);
              }
            }
          }

          literalsMap.set(key, {
            normalizedValue,
            signedValue,
            unsignedValue,
            hexValue,
            bitWidth,
            literalType,
            occurrences: [],
            occurrenceCount: 0,
            classifications
          });
        }

        const literalInfo = literalsMap.get(key)!;
        literalInfo.occurrences.push(occurrence);
        literalInfo.occurrenceCount++;
      }
    }
  }

  // Analyze data section for literals (simplified)
  for (const dataSegment of module.data) {
    const view = new DataView(dataSegment.bytes.buffer, dataSegment.bytes.byteOffset, dataSegment.bytes.byteLength);

    // Look for 4-byte and 8-byte aligned values
    for (let i = 0; i < dataSegment.bytes.length - 3; i += 4) {
      const value32 = view.getUint32(i, true);
      const key = `${value32}-32-i32`;

      if (!literalsMap.has(key)) {
        const classifications: ClassificationPattern[] = [];
        if (opts.classifyPatterns) {
          for (const { pattern, check } of PATTERN_CHECKS) {
            if (check(value32)) {
              classifications.push(pattern);
            }
          }
        }

        literalsMap.set(key, {
          normalizedValue: value32.toString(),
          signedValue: view.getInt32(i, true),
          unsignedValue: value32,
          hexValue: opts.includeHex ? '0x' + value32.toString(16) : null,
          bitWidth: 32,
          literalType: 'i32',
          occurrences: [],
          occurrenceCount: 0,
          classifications
        });
      }

      const literalInfo = literalsMap.get(key)!;
      literalInfo.occurrences.push({
        functionIndex: null,
        blockIndex: null,
        instructionIndex: null,
        opcode: null,
        rawValue: value32,
        bitWidth: 32,
        literalType: 'i32'
      });
      literalInfo.occurrenceCount++;
    }

    for (let i = 0; i < dataSegment.bytes.length - 7; i += 8) {
      const value64 = view.getBigUint64(i, true);
      const key = `${value64}-64-i64`;

      if (!literalsMap.has(key)) {
        const classifications: ClassificationPattern[] = [];
        if (opts.classifyPatterns) {
          for (const { pattern, check } of PATTERN_CHECKS) {
            if (check(value64)) {
              classifications.push(pattern);
            }
          }
        }

        literalsMap.set(key, {
          normalizedValue: value64.toString(),
          signedValue: view.getBigInt64(i, true),
          unsignedValue: value64,
          hexValue: opts.includeHex ? '0x' + value64.toString(16) : null,
          bitWidth: 64,
          literalType: 'i64',
          occurrences: [],
          occurrenceCount: 0,
          classifications
        });
      }

      const literalInfo = literalsMap.get(key)!;
      literalInfo.occurrences.push({
        functionIndex: null,
        blockIndex: null,
        instructionIndex: null,
        opcode: null,
        rawValue: value64,
        bitWidth: 64,
        literalType: 'i64'
      });
      literalInfo.occurrenceCount++;
    }
  }

  // Convert map to array and filter by min occurrences
  const literals = Array.from(literalsMap.values())
    .filter(l => l.occurrenceCount >= opts.minOccurrences)
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount);

  // Calculate statistics
  const totalOccurrences = allOccurrences.length;
  const uniqueLiterals = literals.length;
  const integerLiterals = literals.filter(l => l.literalType.startsWith('i')).length;
  const floatLiterals = literals.filter(l => l.literalType.startsWith('f')).length;

  const mostFrequentLiteral = literals[0]?.normalizedValue ?? null;

  const integerValues = literals
    .filter(l => l.literalType.startsWith('i') && typeof l.signedValue === 'bigint')
    .map(l => l.signedValue as bigint);

  const minInteger = integerValues.length > 0 ? Math.min(...integerValues.map(v => Number(v))) : null;
  const maxInteger = integerValues.length > 0 ? Math.max(...integerValues.map(v => Number(v))) : null;

  // Find literals shared across functions
  const functionLiteralMap = new Map<number, Set<string>>();
  for (const literal of literals) {
    for (const occurrence of literal.occurrences) {
      if (occurrence.functionIndex !== null) {
        const funcIndex = occurrence.functionIndex;
        if (!functionLiteralMap.has(funcIndex)) {
          functionLiteralMap.set(funcIndex, new Set());
        }
        functionLiteralMap.get(funcIndex)!.add(literal.normalizedValue);
      }
    }
  }

  const sharedAcrossFunctions = literals.filter(l => {
    const funcIndices = new Set<number>();
    for (const occurrence of l.occurrences) {
      if (occurrence.functionIndex !== null) {
        funcIndices.add(occurrence.functionIndex);
      }
    }
    return funcIndices.size > 1;
  }).length;

  // Find literals used by multiple opcode categories
  const opcodeCategories = new Map<string, Set<string>>();
  for (const literal of literals) {
    for (const occurrence of literal.occurrences) {
      if (occurrence.opcode !== null) {
        const category = getOpcodeCategory(occurrence.opcode);
        if (!opcodeCategories.has(literal.normalizedValue)) {
          opcodeCategories.set(literal.normalizedValue, new Set());
        }
        opcodeCategories.get(literal.normalizedValue)!.add(category);
      }
    }
  }

  const sharedAcrossOpcodeCategories = Array.from(opcodeCategories.entries())
    .filter(([_, categories]) => categories.size > 1)
    .length;

  return {
    file: '', // Would be set by CLI
    literals,
    statistics: {
      totalOccurrences,
      uniqueLiterals,
      integerLiterals,
      floatLiterals,
      mostFrequentLiteral,
      minInteger,
      maxInteger,
      sharedAcrossFunctions,
      sharedAcrossOpcodeCategories
    }
  };
}

function getOpcodeCategory(opcode: number): string {
  if (opcode >= 0x41 && opcode <= 0x44) return 'const';
  if (opcode >= 0x45 && opcode <= 0x5A) return 'i32_comparison';
  if (opcode >= 0x50 && opcode <= 0x5A) return 'i64_comparison';
  if (opcode >= 0x6A && opcode <= 0x73) return 'i32_arithmetic';
  if (opcode >= 0x79 && opcode <= 0x82) return 'i64_arithmetic';
  if (opcode >= 0x28 && opcode <= 0x3F) return 'conversion';
  if (opcode >= 0x10 && opcode <= 0x19) return 'control';
  if (opcode >= 0x0C && opcode <= 0x0E) return 'branch';
  if (opcode >= 0x02 && opcode <= 0x05) return 'block';
  return 'other';
}
