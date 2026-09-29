import { analyzeWasmLiterals } from '../src/analyzers/wasmLiteralsAnalyzer';
import fs from 'fs';
import path from 'path';

describe('WASM Literals Analyzer', () => {
  let simpleWasmBuffer: Buffer;

  beforeAll(() => {
    // Create a simple WASM module with known literals for testing
    // This is a minimal WASM module with i32.const 42 and i64.const 100
    const wasmBinary = Buffer.from([
      0x00, 0x61, 0x73, 0x6D, // Magic: \0asm
      0x01, 0x00, 0x00, 0x00, // Version: 1
      // Type section
      0x01, 0x07, 0x01,       // Section ID 1 (type), length 7, 1 type
      0x60, 0x00, 0x00,       // Func type: [] -> []
      // Function section
      0x03, 0x02, 0x01, 0x00, // Section ID 3 (function), length 2, 1 function (type 0)
      // Code section
      0x0A, 0x0B, 0x01,       // Section ID 10 (code), length 11, 1 function
      0x07, 0x00, 0x00,       // Body size 7, 0 locals
      0x41, 0x2A, 0x00,       // i32.const 42 (0x2A)
      0x42, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // i64.const 100
      0x0B                    // end
    ]);

    simpleWasmBuffer = wasmBinary;
  });

  it('should extract integer literals from WASM', () => {
    const result = analyzeWasmLiterals(simpleWasmBuffer);

    expect(result.statistics.totalOccurrences).toBe(2);
    expect(result.statistics.uniqueLiterals).toBe(2);
    expect(result.statistics.integerLiterals).toBe(2);
    expect(result.statistics.floatLiterals).toBe(0);

    const literals = result.literals.map(l => l.normalizedValue);
    expect(literals).toContain('42');
    expect(literals).toContain('100');
  });

  it('should classify common patterns', () => {
    // Create a WASM with power of two (16) and zero
    const wasmWithPatterns = Buffer.from([
      0x00, 0x61, 0x73, 0x6D,
      0x01, 0x00, 0x00, 0x00,
      0x01, 0x07, 0x01,
      0x60, 0x00, 0x00,
      0x03, 0x02, 0x01, 0x00,
      0x0A, 0x0D, 0x01,
      0x09, 0x00, 0x00,
      0x41, 0x10, 0x00,     // i32.const 16 (power of two)
      0x41, 0x00, 0x00,     // i32.const 0
      0x0B
    ]);

    const result = analyzeWasmLiterals(wasmWithPatterns);

    const literal16 = result.literals.find(l => l.normalizedValue === '16');
    const literal0 = result.literals.find(l => l.normalizedValue === '0');

    expect(literal16?.classifications).toContain('power-of-two');
    expect(literal0?.classifications).toContain('zero');
  });

  it('should filter by minimum occurrences', () => {
    const result = analyzeWasmLiterals(simpleWasmBuffer, { minOccurrences: 2 });
    expect(result.literals.length).toBe(0);

    const result2 = analyzeWasmLiterals(simpleWasmBuffer, { minOccurrences: 1 });
    expect(result2.literals.length).toBe(2);
  });

  it('should include hexadecimal representations when enabled', () => {
    const result = analyzeWasmLiterals(simpleWasmBuffer, { includeHex: true });
    const literal42 = result.literals.find(l => l.normalizedValue === '42');
    expect(literal42?.hexValue).toBe('0x2a');

    const resultNoHex = analyzeWasmLiterals(simpleWasmBuffer, { includeHex: false });
    const literal42NoHex = resultNoHex.literals.find(l => l.normalizedValue === '42');
    expect(literal42NoHex?.hexValue).toBeNull();
  });

  it('should handle floating point literals when enabled', () => {
    // WASM with f32.const 1.0 and f64.const 2.0
    const wasmWithFloats = Buffer.from([
      0x00, 0x61, 0x73, 0x6D,
      0x01, 0x00, 0x00, 0x00,
      0x01, 0x07, 0x01,
      0x60, 0x00, 0x00,
      0x03, 0x02, 0x01, 0x00,
      0x0A, 0x15, 0x01,
      0x11, 0x00, 0x00,
      0x43, 0x00, 0x00, 0x80, 0x3F, // f32.const 1.0
      0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, // f64.const 2.0
      0x0B
    ]);

    const result = analyzeWasmLiterals(wasmWithFloats, { includeFloats: true });
    expect(result.statistics.floatLiterals).toBe(2);

    const resultNoFloats = analyzeWasmLiterals(wasmWithFloats, { includeFloats: false });
    expect(resultNoFloats.statistics.floatLiterals).toBe(0);
  });

  it('should calculate correct statistics', () => {
    const result = analyzeWasmLiterals(simpleWasmBuffer);

    expect(result.statistics.mostFrequentLiteral).toBe('42'); // First in order
    expect(result.statistics.minInteger).toBe(42);
    expect(result.statistics.maxInteger).toBe(100);
  });
});
