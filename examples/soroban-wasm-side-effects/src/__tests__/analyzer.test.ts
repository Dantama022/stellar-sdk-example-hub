import { WasmAnalyzer } from '../analyzer';
import { parseWasm } from '@wasm-tool/wasm-parser';
import * as fs from 'fs';
import * as path from 'path';

describe('WasmAnalyzer', () => {
  let simpleWasmBuffer: Buffer;
  let memoryWasmBuffer: Buffer;
  let globalWasmBuffer: Buffer;

  beforeAll(async () => {
    // These would be paths to test WASM files in a real implementation
    // For this example, we'll create minimal test cases
    
    // Simple pure function WASM (1+1)
    simpleWasmBuffer = Buffer.from([
      0x00, 0x61, 0x73, 0x6d, // Magic number
      0x01, 0x00, 0x00, 0x00, // Version
      // Type section
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
      // Function section
      0x03, 0x02, 0x00, 0x00,
      // Code section
      0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x01, 0x41, 0x01, 0x6a, 0x0b
    ]);

    // WASM with memory access
    memoryWasmBuffer = Buffer.from([
      0x00, 0x61, 0x73, 0x6d,
      0x01, 0x00, 0x00, 0x00,
      // Memory section (1 page)
      0x05, 0x03, 0x01, 0x00, 0x00,
      // Type section
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
      // Function section
      0x03, 0x02, 0x00, 0x00,
      // Code section - function that writes to memory
      0x0a, 0x0d, 0x01, 0x0b, 0x00, 
      0x41, 0x00, 0x41, 0x01, 0x36, 0x00, 0x00, // i32.const 0, i32.const 1, i32.store
      0x0b
    ]);

    // WASM with global variable
    globalWasmBuffer = Buffer.from([
      0x00, 0x61, 0x73, 0x6d,
      0x01, 0x00, 0x00, 0x00,
      // Global section (mutable i32)
      0x06, 0x07, 0x01, 0x7f, 0x00, 0x41, 0x00, 0x0b, 0x01,
      // Type section
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
      // Function section
      0x03, 0x02, 0x00, 0x00,
      // Code section - function that writes to global
      0x0a, 0x08, 0x01, 0x06, 0x00, 
      0x23, 0x00, 0x41, 0x01, 0x3e, 0x00, 0x0b // global.get 0, i32.const 1, global.set 0
    ]);
  });

  test('should classify pure function correctly', () => {
    const module = parseWasm(simpleWasmBuffer);
    const analyzer = new WasmAnalyzer(module);
    const result = analyzer.analyzeAll();

    expect(result.summary.pure).toBe(1);
    expect(result.summary.total).toBe(1);
    expect(result.functions[0].classification).toBe('pure');
  });

  test('should detect memory writes', () => {
    const module = parseWasm(memoryWasmBuffer);
    const analyzer = new WasmAnalyzer(module);
    const result = analyzer.analyzeAll();

    expect(result.summary.stateMutating).toBe(1);
    expect(result.functions[0].evidence.memoryWrites).toBe(true);
  });

  test('should detect global mutations', () => {
    const module = parseWasm(globalWasmBuffer);
    const analyzer = new WasmAnalyzer(module);
    const result = analyzer.analyzeAll();

    expect(result.summary.stateMutating).toBe(1);
    expect(result.functions[0].evidence.mutableGlobalWrites.length).toBeGreaterThan(0);
  });

  test('should handle empty module', () => {
    const emptyBuffer = Buffer.from([
      0x00, 0x61, 0x73, 0x6d,
      0x01, 0x00, 0x00, 0x00
    ]);
    
    const module = parseWasm(emptyBuffer);
    const analyzer = new WasmAnalyzer(module);
    const result = analyzer.analyzeAll();

    expect(result.summary.total).toBe(0);
  });
});
