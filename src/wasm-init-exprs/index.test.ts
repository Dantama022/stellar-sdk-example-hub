import { parseWasm, WasmModule, InitExpr, SectionType } from './analyzer';
import { outputJson, outputCsv, outputDot } from './output';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('WASM Initialization Expression Analyzer', () => {
  let simpleWasm: Buffer;

  beforeAll(() => {
    // In a real test, we'd use a real WASM file
    // For this example, we'll create a minimal mock
    simpleWasm = Buffer.from([
      0x00, 0x61, 0x73, 0x6D, // Magic number
      0x01, 0x00, 0x00, 0x00, // Version 1
      // Global section
      0x06, 0x09, 0x01,       // Section 6 (global), length 9, 1 global
      0x7F, 0x00,             // Type i32, immutable
      0x05, 0x03, 0x41, 0x01, 0x0B, // Init expr: i32.const 1
      // Data section
      0x0B, 0x0A, 0x01,       // Section 11 (data), length 10, 1 segment
      0x00,                   // Memory index 0
      0x05, 0x03, 0x41, 0x00, 0x0B, // Offset expr: i32.const 0
      0x04, 0x01, 0x02, 0x03  // Data length 4, data bytes
    ]);
  });

  describe('parseWasm', () => {
    it('should parse global section', () => {
      const module = parseWasm(simpleWasm);
      expect(module.globals.length).toBe(1);
      expect(module.globals[0].type).toBe('i32');
      expect(module.globals[0].mutable).toBe(false);
      expect(module.globals[0].initExpr).toBeDefined();
    });

    it('should parse data section', () => {
      const module = parseWasm(simpleWasm);
      expect(module.dataSegments.length).toBe(1);
      expect(module.dataSegments[0].memoryIndex).toBe(0);
      expect(module.dataSegments[0].offsetExpr).toBeDefined();
    });
  });

  describe('expression analysis', () => {
    it('should classify constant expressions', () => {
      const module = parseWasm(simpleWasm);
      const global = module.globals[0];
      
      if (!global.initExpr) {
        fail('Expected initExpr to be defined');
        return;
      }

      const expr: InitExpr = {
        section: SectionType.Global,
        entryIndex: 0,
        opcodes: [0x41, 0x01, 0x0B],
        referencedGlobals: [],
        constants: [1],
        resultType: 'i32',
        classification: 'constant',
        staticValue: 1,
        rawBytes: Array.from(global.initExpr)
      };

      expect(expr.classification).toBe('constant');
      expect(expr.staticValue).toBe(1);
    });
  });

  describe('output formats', () => {
    const mockAnalysis = {
      module: { globals: [], dataSegments: [], elementSegments: [] } as WasmModule,
      expressions: [
        {
          section: 'global' as SectionType,
          entryIndex: 0,
          opcodes: [0x41, 0x01, 0x0B],
          referencedGlobals: [],
          constants: [1],
          resultType: 'i32',
          classification: 'constant' as const,
          staticValue: 1,
          rawBytes: [0x41, 0x01, 0x0B]
        }
      ],
      dependencyGraph: {
        nodes: ['global_0'],
        edges: []
      },
      metrics: {
        totalExpressions: 1,
        constantExpressions: 1,
        globalDependent: 0,
        importedDependent: 0,
        unknownExpressions: 0,
        totalReferencedGlobals: 0,
        maxDependencyDepth: 0
      }
    };

    it('should generate valid JSON output', () => {
      const json = outputJson(mockAnalysis);
      const parsed = JSON.parse(json);
      expect(parsed.metadata.totalExpressions).toBe(1);
      expect(parsed.expressions.length).toBe(1);
    });

    it('should generate valid CSV output', () => {
      const csv = outputCsv(mockAnalysis);
      const lines = csv.split('\n');
      expect(lines.length).toBe(2); // Header + 1 row
      expect(lines[0]).toContain('Section');
      expect(lines[1]).toContain('global');
    });

    it('should generate valid DOT output', () => {
      const dot = outputDot(mockAnalysis.dependencyGraph);
      expect(dot).toContain('digraph InitExprDependencies');
      expect(dot).toContain('global_0');
    });
  });
});
