import { analyzeConstants } from '../src/analysis/wasm-constants.js';
import { readWasmModule } from '../src/parsers/wasm-parser.js';
import fs from 'fs';
import path from 'path';

describe('WASM Constant Propagation Analysis', () => {
  let simpleWasmBuffer: Buffer;

  beforeAll(() => {
    // In a real test, we would have actual WASM files
    // For this example, we'll create a mock buffer
    simpleWasmBuffer = Buffer.from([0x00, 0x61, 0x73, 0x6d]); // WASM magic header
  });

  test('should analyze simple WASM with constants', () => {
    // This test would use a real WASM file in a proper implementation
    // For now, we'll just test that the function runs without error
    
    // Mock the readWasmModule to return a simple structure
    jest.mock('../src/parsers/wasm-parser.js', () => ({
      readWasmModule: jest.fn(() => ({
        name: 'test_module',
        functions: [
          {
            index: 0,
            name: 'test_func',
            params: [],
            results: [],
            locals: [],
            body: {
              blocks: [
                {
                  index: 0,
                  instructions: [
                    { opcode: 'i32.const', args: [42] },
                    { opcode: 'i32.const', args: [100] },
                    { opcode: 'i32.add', args: [0, 1] }
                  ],
                  predecessors: [],
                  successors: []
                }
              ]
            }
          }
        ]
      }))
    }));

    const result = analyzeConstants(simpleWasmBuffer);
    
    expect(result.moduleName).toBe('test_module');
    expect(result.functions.length).toBe(1);
    expect(result.functions[0].name).toBe('test_func');
    
    // Should find the constants
    expect(result.functions[0].constants.length).toBeGreaterThan(0);
    
    // Should have stats
    expect(result.stats).toBeDefined();
    expect(result.stats.totalConstantProducingInstructions).toBeGreaterThanOrEqual(0);
  });

  test('should handle empty WASM module', () => {
    const emptyBuffer = Buffer.from([]);
    
    // Mock empty module
    jest.mock('../src/parsers/wasm-parser.js', () => ({
      readWasmModule: jest.fn(() => ({
        name: undefined,
        functions: []
      }))
    }));

    const result = analyzeConstants(emptyBuffer);
    
    expect(result.functions.length).toBe(0);
    expect(result.stats.totalConstantProducingInstructions).toBe(0);
  });

  test('should propagate constants through arithmetic', () => {
    // Mock a function with arithmetic operations
    jest.mock('../src/parsers/wasm-parser.js', () => ({
      readWasmModule: jest.fn(() => ({
        name: 'arithmetic_test',
        functions: [
          {
            index: 0,
            name: 'add_constants',
            params: [],
            results: [],
            locals: [],
            body: {
              blocks: [
                {
                  index: 0,
                  instructions: [
                    { opcode: 'i32.const', args: [2] },
                    { opcode: 'i32.const', args: [3] },
                    { opcode: 'i32.add', args: [0, 1] }
                  ],
                  predecessors: [],
                  successors: []
                }
              ]
            }
          }
        ]
      }))
    }));

    const result = analyzeConstants(simpleWasmBuffer);
    
    // Should find the constants and the result of the addition
    expect(result.functions[0].constants.length).toBeGreaterThanOrEqual(2);
    
    // Check if we have a constant for the addition result
    const addConstant = result.functions[0].constants.find(
      c => c.instructionIndex === 2 // The add instruction
    );
    
    expect(addConstant).toBeDefined();
    if (addConstant) {
      expect(addConstant.value.type).toBe('i32');
      expect(addConstant.value.value).toBe(5); // 2 + 3
    }
  });

  test('should handle comparisons', () => {
    // Mock a function with comparison operations
    jest.mock('../src/parsers/wasm-parser.js', () => ({
      readWasmModule: jest.fn(() => ({
        name: 'comparison_test',
        functions: [
          {
            index: 0,
            name: 'compare_constants',
            params: [],
            results: [],
            locals: [],
            body: {
              blocks: [
                {
                  index: 0,
                  instructions: [
                    { opcode: 'i32.const', args: [10] },
                    { opcode: 'i32.const', args: [20] },
                    { opcode: 'i32.lt_s', args: [0, 1] }
                  ],
                  predecessors: [],
                  successors: []
                }
              ]
            }
          }
        ]
      }))
    }));

    const result = analyzeConstants(simpleWasmBuffer);
    
    // Should find the comparison result
    const cmpConstant = result.functions[0].constants.find(
      c => c.instructionIndex === 2 // The lt_s instruction
    );
    
    expect(cmpConstant).toBeDefined();
    if (cmpConstant) {
      expect(cmpConstant.value.type).toBe('i32');
      expect(cmpConstant.value.value).toBe(1); // 10 < 20 is true (1)
    }
  });
});

describe('WASM Constant Propagation Comparison', () => {
  test('should compare two WASM modules', () => {
    const wasm1 = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
    const wasm2 = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

    // Mock different modules
    jest.mock('../src/parsers/wasm-parser.js', () => ({
      readWasmModule: jest.fn((buffer: Buffer) => {
        if (buffer === wasm1) {
          return {
            name: 'module1',
            functions: [
              {
                index: 0,
                name: 'func1',
                params: [],
                results: [],
                locals: [],
                body: {
                  blocks: [
                    {
                      index: 0,
                      instructions: [
                        { opcode: 'i32.const', args: [10] }
                      ],
                      predecessors: [],
                      successors: []
                    }
                  ]
                }
              }
            ]
          };
        } else {
          return {
            name: 'module2',
            functions: [
              {
                index: 0,
                name: 'func1',
                params: [],
                results: [],
                locals: [],
                body: {
                  blocks: [
                    {
                      index: 0,
                      instructions: [
                        { opcode: 'i32.const', args: [20] }
                      ],
                      predecessors: [],
                      successors: []
                    }
                  ]
                }
              }
            ]
          };
        }
      })
    }));

    const result1 = analyzeConstants(wasm1);
    const result2 = analyzeConstants(wasm2);

    // In a real implementation, we would have a compare function
    // For now, just verify we can analyze both
    expect(result1.functions.length).toBe(1);
    expect(result2.functions.length).toBe(1);
    
    // The constants should be different
    expect(result1.functions[0].constants[0].value.value).toBe(10);
    expect(result2.functions[0].constants[0].value.value).toBe(20);
  });
});