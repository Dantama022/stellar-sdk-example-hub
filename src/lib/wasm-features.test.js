const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseWasmModule, detectFeatures, compareFeatures, WASM_FEATURES } = require('./wasm-features');

const fixturesDir = path.join(__dirname, '../../test/fixtures/wasm');

describe('WASM Feature Detection', () => {
  before(() => {
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }
  });

  describe('parseWasmModule', () => {
    it('should parse a valid WASM module', () => {
      const simpleWasm = Buffer.from([
        0x00, 0x61, 0x73, 0x6D, // Magic
        0x01, 0x00, 0x00, 0x00, // Version
        0x00, 0x06, 0x00, 0x01, 0x7F, 0x00, // Type section
        0x03, 0x07, 0x00, 0x01, 0x02, 0x00, 0x01, // Function section
        0x0A, 0x09, 0x00, 0x01, 0x00, 0x41, 0x00, 0x0B, 0x0B // Code section
      ]);

      const module = parseWasmModule(simpleWasm);
      assert.strictEqual(module.magic, '\0asm');
      assert.strictEqual(module.version, 1);
      assert.strictEqual(module.sections.length, 3);
    });

    it('should throw on invalid magic number', () => {
      const invalidWasm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      assert.throws(() => parseWasmModule(invalidWasm), /Invalid WASM magic number/);
    });
  });

  describe('detectFeatures', () => {
    it('should detect bulk memory operations', () => {
      const wasmWithBulkMemory = Buffer.from([
        0x00, 0x61, 0x73, 0x6D,
        0x01, 0x00, 0x00, 0x00,
        0x00, 0x06, 0x00, 0x01, 0x7F, 0x00,
        0x03, 0x02, 0x00, 0x00,
        0x0A, 0x0A, 0x00, 0x01, 0x00, 0x41, 0x00, 0xFE, 0x00, 0x00, 0x0B, 0x0B
      ]);

      const module = parseWasmModule(wasmWithBulkMemory);
      const features = detectFeatures(module);

      assert(features.detected[WASM_FEATURES.BULK_MEMORY]);
      assert(features.detected[WASM_FEATURES.BULK_MEMORY].count > 0);
    });

    it('should detect reference types', () => {
      const wasmWithRefTypes = Buffer.from([
        0x00, 0x61, 0x73, 0x6D,
        0x01, 0x00, 0x00, 0x00,
        0x00, 0x08, 0x00, 0x01, 0x60, 0x00, 0x01, 0x7F, 0x00,
        0x03, 0x02, 0x00, 0x00,
        0x0A, 0x0B, 0x00, 0x01, 0x00, 0x41, 0x00, 0xFE, 0x10, 0x00, 0x0B, 0x0B
      ]);

      const module = parseWasmModule(wasmWithRefTypes);
      const features = detectFeatures(module);

      assert(features.detected[WASM_FEATURES.REFERENCE_TYPES]);
    });

    it('should detect SIMD instructions', () => {
      const wasmWithSIMD = Buffer.from([
        0x00, 0x61, 0x73, 0x6D,
        0x01, 0x00, 0x00, 0x00,
        0x00, 0x06, 0x00, 0x01, 0x7F, 0x00,
        0x03, 0x02, 0x00, 0x00,
        0x0A, 0x0A, 0x00, 0x01, 0x00, 0x41, 0x00, 0xFD, 0x00, 0x00, 0x0B, 0x0B
      ]);

      const module = parseWasmModule(wasmWithSIMD);
      const features = detectFeatures(module);

      assert(features.detected[WASM_FEATURES.SIMD]);
    });

    it('should detect multiple memories', () => {
      const wasmWithMultipleMemories = Buffer.from([
        0x00, 0x61, 0x73, 0x6D,
        0x01, 0x00, 0x00, 0x00,
        0x02, 0x07, 0x00, 0x02, 0x01, 0x00, 0x01, 0x00, 0x01
      ]);

      const module = parseWasmModule(wasmWithMultipleMemories);
      const features = detectFeatures(module);

      assert(features.detected[WASM_FEATURES.MULTIPLE_MEMORIES]);
    });

    it('should detect indirect calls', () => {
      const wasmWithIndirectCalls = Buffer.from([
        0x00, 0x61, 0x73, 0x6D,
        0x01, 0x00, 0x00, 0x00,
        0x00, 0x06, 0x00, 0x01, 0x7F, 0x00,
        0x01, 0x04, 0x00, 0x01, 0x00, 0x00,
        0x03, 0x02, 0x00, 0x00,
        0x0A, 0x0C, 0x00, 0x01, 0x00, 0x41, 0x00, 0x11, 0x00, 0x00, 0x00, 0x00, 0x0B, 0x0B
      ]);

      const module = parseWasmModule(wasmWithIndirectCalls);
      const features = detectFeatures(module);

      assert(features.detected[WASM_FEATURES.INDIRECT_CALLS]);
      assert(features.detected[WASM_FEATURES.INDIRECT_CALLS].count > 0);
    });

    it('should handle empty module', () => {
      const emptyWasm = Buffer.from([
        0x00, 0x61, 0x73, 0x6D,
        0x01, 0x00, 0x00, 0x00
      ]);

      const module = parseWasmModule(emptyWasm);
      const features = detectFeatures(module);

      assert.deepStrictEqual(features.detected, {});
      assert(features.undetected.length > 0);
    });
  });

  describe('compareFeatures', () => {
    it('should detect new features', () => {
      const features1 = {
        detected: {},
        undetected: [WASM_FEATURES.BULK_MEMORY, WASM_FEATURES.SIMD],
        unknown: []
      };

      const features2 = {
        detected: {
          [WASM_FEATURES.BULK_MEMORY]: { count: 1, functions: ['function 0'], locations: ['function 0 (offset 5)'] }
        },
        undetected: [WASM_FEATURES.SIMD],
        unknown: []
      };

      const comparison = compareFeatures(features1, features2);
      assert(comparison.newFeatures.includes(WASM_FEATURES.BULK_MEMORY));
      assert.strictEqual(comparison.removedFeatures.length, 0);
    });

    it('should detect removed features', () => {
      const features1 = {
        detected: {
          [WASM_FEATURES.BULK_MEMORY]: { count: 1, functions: ['function 0'], locations: ['function 0 (offset 5)'] }
        },
        undetected: [WASM_FEATURES.SIMD],
        unknown: []
      };

      const features2 = {
        detected: {},
        undetected: [WASM_FEATURES.BULK_MEMORY, WASM_FEATURES.SIMD],
        unknown: []
      };

      const comparison = compareFeatures(features1, features2);
      assert(comparison.removedFeatures.includes(WASM_FEATURES.BULK_MEMORY));
      assert.strictEqual(comparison.newFeatures.length, 0);
    });

    it('should detect changed counts', () => {
      const features1 = {
        detected: {
          [WASM_FEATURES.BULK_MEMORY]: { count: 1, functions: ['function 0'], locations: ['function 0 (offset 5)'] }
        },
        undetected: [],
        unknown: []
      };

      const features2 = {
        detected: {
          [WASM_FEATURES.BULK_MEMORY]: { count: 3, functions: ['function 0', 'function 1'], locations: ['function 0 (offset 5)', 'function 1 (offset 10)'] }
        },
        undetected: [],
        unknown: []
      };

      const comparison = compareFeatures(features1, features2);
      assert(comparison.changedCounts[WASM_FEATURES.BULK_MEMORY]);
      assert.strictEqual(comparison.changedCounts[WASM_FEATURES.BULK_MEMORY].old, 1);
      assert.strictEqual(comparison.changedCounts[WASM_FEATURES.BULK_MEMORY].new, 3);
    });

    it('should detect new function usage', () => {
      const features1 = {
        detected: {
          [WASM_FEATURES.BULK_MEMORY]: { count: 1, functions: ['function 0'], locations: ['function 0 (offset 5)'] }
        },
        undetected: [],
        unknown: []
      };

      const features2 = {
        detected: {
          [WASM_FEATURES.BULK_MEMORY]: { count: 2, functions: ['function 0', 'function 1'], locations: ['function 0 (offset 5)', 'function 1 (offset 10)'] }
        },
        undetected: [],
        unknown: []
      };

      const comparison = compareFeatures(features1, features2);
      assert(comparison.newFunctionUsage[WASM_FEATURES.BULK_MEMORY]);
      assert(comparison.newFunctionUsage[WASM_FEATURES.BULK_MEMORY].includes('function 1'));
    });
  });
});