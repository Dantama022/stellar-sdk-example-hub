/**
 * Tests for ISSUE-267 (WASM memory access pattern analysis).
 *
 * The analyzer decodes the artifact and inspects the load and store
 * instructions. It never instantiates or executes a module, which the last
 * describe block verifies explicitly.
 */

import {
  accessKey,
  analyzeMemoryAccesses,
  analyzeMemoryAccessFile,
  compareMemoryAccesses,
  computeFunctionStats,
  formatMemoryAccessComparison,
  formatMemoryAccessReport,
  memoryAccessToCsv,
  widthLabel,
} from '../src/wasm/memoryAccess';
import * as memoryAccessModule from '../src/wasm/memoryAccess';
import { parseWasmModule, WasmParseError } from '../src/wasm/wasmBinary';
import { buildModule, op } from './helpers/wasmFixtures';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Builds a module with a single function from the given instruction bytes. */
function single(body: number[]): Buffer {
  return buildModule({ bodies: [body] });
}

describe('ISSUE-267: WASM memory access pattern analysis', () => {
  // ─── Basics ────────────────────────────────────────────────────────────────

  describe('analyzeMemoryAccesses', () => {
    it('reports no accesses for a module without memory instructions', () => {
      const report = analyzeMemoryAccesses(parseWasmModule(single([...op.i32Const(1)])), 'a.wasm');

      expect(report.accesses).toHaveLength(0);
      expect(report.totals.totalAccesses).toBe(0);
      expect(report.totals.totalLoads).toBe(0);
      expect(report.totals.totalStores).toBe(0);
      expect(report.functions[0].accessPattern).toBe('none');
    });

    it('detects a simple load', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Load(2, 4)])),
        'a.wasm',
      );

      expect(report.accesses).toHaveLength(1);
      expect(report.accesses[0].opcode).toBe('i32.load');
      expect(report.accesses[0].accessType).toBe('load');
      expect(report.accesses[0].widthBits).toBe(32);
      expect(report.accesses[0].widthLabel).toBe('word');
      expect(report.accesses[0].staticOffset).toBe(4);
      expect(report.accesses[0].alignment).toBe(2);
      expect(report.accesses[0].alignmentBytes).toBe(4);
      expect(report.accesses[0].memoryIndex).toBe(0);
      expect(report.totals.totalLoads).toBe(1);
    });

    it('detects a simple store', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Const(42), ...op.i32Store(2, 8)])),
        'a.wasm',
      );

      expect(report.accesses).toHaveLength(1);
      expect(report.accesses[0].opcode).toBe('i32.store');
      expect(report.accesses[0].accessType).toBe('store');
      expect(report.accesses[0].staticOffset).toBe(8);
      expect(report.totals.totalStores).toBe(1);
    });

    it('detects multiple load widths', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(
          single([
            ...op.i32Const(0),
            ...op.i32Load(2, 0),
            ...op.drop(),
            ...op.i64Load(3, 0),
            ...op.drop(),
            ...op.f32Load(2, 0),
            ...op.drop(),
            ...op.i32Load8S(0, 0),
            ...op.drop(),
            ...op.i32Load16U(1, 0),
            ...op.drop(),
          ]),
        ),
        'a.wasm',
      );

      expect(report.accesses).toHaveLength(5);
      expect(report.accesses.map((access) => access.widthBits)).toEqual([32, 64, 32, 8, 16]);
      expect(report.functions[0].uniqueWidths).toEqual([8, 16, 32, 64]);
      expect(report.totals.byWidth.byte).toBe(1);
      expect(report.totals.byWidth['half-word']).toBe(1);
    });

    it('detects multiple store widths', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(
          single([
            ...op.i32Const(0),
            ...op.i32Const(1),
            ...op.i32Store8(0, 0),
            ...op.i32Const(0),
            ...op.i32Const(1),
            ...op.i32Store16(1, 0),
            ...op.i32Const(0),
            ...op.i32Const(1),
            ...op.i64Store32(2, 0),
          ]),
        ),
        'a.wasm',
      );

      expect(report.accesses).toHaveLength(3);
      expect(report.accesses.every((access) => access.accessType === 'store')).toBe(true);
      expect(report.totals.byWidth['half-word']).toBe(1);
    });

    it('records the static offset of every access', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(
          single([
            ...op.i32Const(0),
            ...op.i32Load(2, 12),
            ...op.drop(),
            ...op.i32Const(0),
            ...op.i32Const(1),
            ...op.i32Store(2, 20),
          ]),
        ),
        'a.wasm',
      );

      expect(report.accesses.map((access) => access.staticOffset)).toEqual([12, 20]);
      expect(report.functions[0].uniqueStaticOffsets).toEqual([12, 20]);
      expect(report.functions[0].maxStaticOffset).toBe(20);
      expect(report.totals.maxStaticOffset).toBe(20);
    });

    it('recognises a statically known base address', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(16), ...op.i32Load(2, 4)])),
        'a.wasm',
      );

      expect(report.accesses[0].addressType).toBe('static');
      expect(report.accesses[0].baseAddress).toBe('16');
      expect(report.accesses[0].effectiveAddress).toBe('20');
      expect(report.totals.staticAddresses).toBe(1);
      expect(report.totals.dynamicAddresses).toBe(0);
    });

    it('marks a runtime dependent address as dynamic', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(single([...op.localGet(0), ...op.i32Load(2, 4)])),
        'a.wasm',
      );

      expect(report.accesses[0].addressType).toBe('dynamic');
      expect(report.accesses[0].baseAddress).toBeUndefined();
      expect(report.accesses[0].effectiveAddress).toBeUndefined();
      expect(report.totals.dynamicAddresses).toBe(1);
    });

    it('resolves a base address through a constant local', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(
          single([...op.i32Const(64), ...op.localSet(0), ...op.localGet(0), ...op.i32Load(2, 0)]),
        ),
        'a.wasm',
      );

      expect(report.accesses[0].addressType).toBe('static');
      expect(report.accesses[0].baseAddress).toBe('64');
    });

    it('records the alignment metadata of an access', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i64Load(3, 0)])),
        'a.wasm',
      );

      expect(report.accesses[0].alignment).toBe(3);
      expect(report.accesses[0].alignmentBytes).toBe(8);
    });

    it('classifies a function that only reads memory', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Load(2, 0)])),
        'a.wasm',
      );

      expect(report.functions[0].accessPattern).toBe('read-only');
      expect(report.totals.readOnlyFunctions).toBe(1);
      expect(report.totals.writeOnlyFunctions).toBe(0);
    });

    it('classifies a function that only writes memory', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Const(1), ...op.i32Store(2, 0)])),
        'a.wasm',
      );

      expect(report.functions[0].accessPattern).toBe('write-only');
      expect(report.totals.writeOnlyFunctions).toBe(1);
    });

    it('classifies a function that both reads and writes memory', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(
          single([
            ...op.i32Const(0),
            ...op.i32Load(2, 0),
            ...op.drop(),
            ...op.i32Const(0),
            ...op.i32Const(1),
            ...op.i32Store(2, 0),
          ]),
        ),
        'a.wasm',
      );

      expect(report.functions[0].accessPattern).toBe('read-write');
      expect(report.totals.readWriteFunctions).toBe(1);
    });

    it('does not crash on an unsupported instruction', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(
          single([
            ...op.i32Const(0),
            ...op.i32Load(2, 0),
            ...op.drop(),
            ...[0xfc, 0x0a, 0x00, 0x00],
          ]),
        ),
        'a.wasm',
      );

      expect(report.accesses).toHaveLength(1);
      expect(report.accesses[0].opcode).toBe('i32.load');
    });
  });

  // ─── Statistics ────────────────────────────────────────────────────────────

  describe('statistics', () => {
    it('computes per-function statistics', () => {
      const module = buildModule({
        bodies: [
          [...op.i32Const(0), ...op.i32Load(2, 0), ...op.drop()],
          [
            ...op.i32Const(0),
            ...op.i32Load(2, 0),
            ...op.drop(),
            ...op.i32Const(0),
            ...op.i32Const(1),
            ...op.i32Store(2, 0),
          ],
        ],
      });
      const report = analyzeMemoryAccesses(parseWasmModule(module), 'a.wasm');

      expect(report.functions).toHaveLength(2);
      expect(report.functions[0].totalLoads).toBe(1);
      expect(report.functions[0].totalStores).toBe(0);
      expect(report.functions[0].totalAccesses).toBe(1);
      expect(report.functions[0].readWriteRatio).toBe(1);
      expect(report.functions[1].totalLoads).toBe(1);
      expect(report.functions[1].totalStores).toBe(1);
      expect(report.functions[1].readWriteRatio).toBe(1);
      expect(report.functions[1].uniqueWidths).toEqual([32]);
    });

    it('computes module-level statistics', () => {
      const module = buildModule({
        bodies: [
          [...op.i32Const(0), ...op.i32Load(2, 0), ...op.drop()],
          [...op.i32Const(0), ...op.i32Const(1), ...op.i32Store(2, 4)],
        ],
      });
      const report = analyzeMemoryAccesses(parseWasmModule(module), 'a.wasm');

      expect(report.totals.totalFunctions).toBe(2);
      expect(report.totals.functionsWithMemoryAccess).toBe(2);
      expect(report.totals.totalAccesses).toBe(2);
      expect(report.totals.totalLoads).toBe(1);
      expect(report.totals.totalStores).toBe(1);
      expect(report.totals.uniqueStaticOffsets).toBe(2);
      expect(report.totals.byOpcode['i32.load']).toBe(1);
      expect(report.totals.byOpcode['i32.store']).toBe(1);
    });

    it('ranks the functions with the highest number of accesses', () => {
      const module = buildModule({
        bodies: [
          [...op.i32Const(0), ...op.i32Load(2, 0), ...op.drop()],
          [
            ...op.i32Const(0),
            ...op.i32Load(2, 0),
            ...op.drop(),
            ...op.i32Const(0),
            ...op.i32Load(2, 4),
            ...op.drop(),
          ],
        ],
      });
      const report = analyzeMemoryAccesses(parseWasmModule(module), 'a.wasm');

      expect(report.topFunctionsByAccessCount[0].functionIndex).toBe(1);
      expect(report.topFunctionsByAccessCount[0].count).toBe(2);
    });

    it('ranks the functions with the highest read/write ratio', () => {
      const module = buildModule({
        bodies: [
          [...op.i32Const(0), ...op.i32Load(2, 0), ...op.drop()],
          [
            ...op.i32Const(0),
            ...op.i32Load(2, 0),
            ...op.drop(),
            ...op.i32Const(0),
            ...op.i32Const(1),
            ...op.i32Store(2, 0),
          ],
        ],
      });
      const report = analyzeMemoryAccesses(parseWasmModule(module), 'a.wasm');

      expect(report.topFunctionsByReadWriteRatio[0].functionIndex).toBe(0);
      expect(report.topFunctionsByReadWriteRatio[0].readWriteRatio).toBe(1);
    });

    it('reports the most frequently reused static offsets', () => {
      const module = buildModule({
        bodies: [
          [
            ...op.i32Const(0),
            ...op.i32Load(2, 16),
            ...op.drop(),
            ...op.i32Const(0),
            ...op.i32Load(2, 16),
            ...op.drop(),
            ...op.i32Const(0),
            ...op.i32Load(2, 32),
            ...op.drop(),
          ],
        ],
      });
      const report = analyzeMemoryAccesses(parseWasmModule(module), 'a.wasm');

      expect(report.frequentlyUsedOffsets[0].offset).toBe(16);
      expect(report.frequentlyUsedOffsets[0].count).toBe(2);
      expect(report.frequentlyUsedOffsets[1].offset).toBe(32);
    });

    it('groups the accesses by opcode and width', () => {
      const module = buildModule({
        bodies: [
          [
            ...op.i32Const(0),
            ...op.i32Load(2, 0),
            ...op.drop(),
            ...op.i32Const(0),
            ...op.i32Load8U(0, 0),
            ...op.drop(),
          ],
        ],
      });
      const report = analyzeMemoryAccesses(parseWasmModule(module), 'a.wasm');

      expect(report.totals.byOpcodeAndWidth['i32.load:32']).toBe(1);
      expect(report.totals.byOpcodeAndWidth['i32.load8_u:8']).toBe(1);
    });

    it('computes function statistics from a normalized record', () => {
      const stats = computeFunctionStats(3, 'func_3', [
        {
          functionIndex: 3,
          functionName: 'func_3',
          blockIndex: 0,
          instructionIndex: 0,
          ordinal: 0,
          opcode: 'i32.load',
          accessType: 'load',
          valueType: 'i32',
          widthBits: 32,
          widthLabel: 'word',
          alignment: 2,
          alignmentBytes: 4,
          staticOffset: 8,
          memoryIndex: 0,
          addressType: 'dynamic',
        },
        {
          functionIndex: 3,
          functionName: 'func_3',
          blockIndex: 0,
          instructionIndex: 1,
          ordinal: 1,
          opcode: 'i32.store',
          accessType: 'store',
          valueType: 'i32',
          widthBits: 32,
          widthLabel: 'word',
          alignment: 2,
          alignmentBytes: 4,
          staticOffset: 8,
          memoryIndex: 0,
          addressType: 'dynamic',
        },
      ]);

      expect(stats.totalLoads).toBe(1);
      expect(stats.totalStores).toBe(1);
      expect(stats.totalAccesses).toBe(2);
      expect(stats.readWriteRatio).toBe(1);
      expect(stats.accessPattern).toBe('read-write');
      expect(stats.maxStaticOffset).toBe(8);
    });

    it('maps the access widths to readable labels', () => {
      expect(widthLabel(8)).toBe('byte');
      expect(widthLabel(16)).toBe('half-word');
      expect(widthLabel(32)).toBe('word');
      expect(widthLabel(64)).toBe('double-word');
      expect(widthLabel(128)).toBe('vector');
    });
  });

  // ─── Output formats ────────────────────────────────────────────────────────

  describe('output formats', () => {
    it('renders a human-readable report', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Load(2, 0)])),
        'a.wasm',
      );
      const text = formatMemoryAccessReport(report);

      expect(text).toContain('WASM memory access analysis');
      expect(text).toContain('Total memory accesses');
      expect(text).toContain('Per-function statistics');
    });

    it('renders one CSV row per normalized access', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(
          single([
            ...op.i32Const(0),
            ...op.i32Load(2, 0),
            ...op.drop(),
            ...op.i32Const(0),
            ...op.i32Const(1),
            ...op.i32Store(2, 0),
          ]),
        ),
        'a.wasm',
      );
      const csv = memoryAccessToCsv(report);
      const rows = csv.trim().split('\n');

      expect(rows[0]).toContain('function_index');
      expect(rows).toHaveLength(report.accesses.length + 1);
    });

    it('produces a JSON-serializable report', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Load(2, 0)])),
        'a.wasm',
      );
      const json = JSON.parse(JSON.stringify(report));

      expect(json.totals.totalAccesses).toBe(1);
      expect(json.accesses[0].opcode).toBe('i32.load');
    });
  });

  // ─── Comparison mode ───────────────────────────────────────────────────────

  describe('compareMemoryAccesses', () => {
    it('reports an added access site', () => {
      const before = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Load(2, 0)])),
        'old.wasm',
      );
      const after = analyzeMemoryAccesses(
        parseWasmModule(
          single([
            ...op.i32Const(0),
            ...op.i32Load(2, 0),
            ...op.drop(),
            ...op.i32Const(0),
            ...op.i32Load(2, 8),
            ...op.drop(),
          ]),
        ),
        'new.wasm',
      );
      const comparison = compareMemoryAccesses(before, after);

      expect(comparison.addedAccesses).toHaveLength(1);
      expect(comparison.removedAccesses).toHaveLength(0);
      expect(comparison.summary.added).toBe(1);
    });

    it('reports a removed access site', () => {
      const before = analyzeMemoryAccesses(
        parseWasmModule(
          single([
            ...op.i32Const(0),
            ...op.i32Load(2, 0),
            ...op.drop(),
            ...op.i32Const(0),
            ...op.i32Load(2, 8),
            ...op.drop(),
          ]),
        ),
        'old.wasm',
      );
      const after = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Load(2, 0)])),
        'new.wasm',
      );
      const comparison = compareMemoryAccesses(before, after);

      expect(comparison.removedAccesses).toHaveLength(1);
      expect(comparison.summary.removed).toBe(1);
    });

    it('reports a changed load/store operation', () => {
      const before = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Load(2, 0)])),
        'old.wasm',
      );
      const after = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Const(1), ...op.i32Store(2, 0)])),
        'new.wasm',
      );
      const comparison = compareMemoryAccesses(before, after);

      expect(comparison.changedAccessType).toHaveLength(1);
      expect(comparison.changedAccessType[0].oldAccess?.accessType).toBe('load');
      expect(comparison.changedAccessType[0].newAccess?.accessType).toBe('store');
    });

    it('reports a changed access width', () => {
      const before = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Load(2, 0)])),
        'old.wasm',
      );
      const after = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Load8U(0, 0)])),
        'new.wasm',
      );
      const comparison = compareMemoryAccesses(before, after);

      expect(comparison.changedWidth).toHaveLength(1);
      expect(comparison.changedWidth[0].oldAccess?.widthBits).toBe(32);
      expect(comparison.changedWidth[0].newAccess?.widthBits).toBe(8);
    });

    it('reports a changed static offset', () => {
      const before = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Load(2, 0)])),
        'old.wasm',
      );
      const after = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Load(2, 12)])),
        'new.wasm',
      );
      const comparison = compareMemoryAccesses(before, after);

      expect(comparison.changedStaticOffset).toHaveLength(1);
      expect(comparison.changedStaticOffset[0].oldAccess?.staticOffset).toBe(0);
      expect(comparison.changedStaticOffset[0].newAccess?.staticOffset).toBe(12);
    });

    it('reports functions with newly introduced memory access', () => {
      const before = analyzeMemoryAccesses(parseWasmModule(single([])), 'old.wasm');
      const after = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Load(2, 0)])),
        'new.wasm',
      );
      const comparison = compareMemoryAccesses(before, after);

      expect(comparison.functionsWithNewAccess).toEqual([0]);
    });

    it('renders a human-readable comparison', () => {
      const before = analyzeMemoryAccesses(parseWasmModule(single([])), 'old.wasm');
      const after = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Load(2, 0)])),
        'new.wasm',
      );
      const text = formatMemoryAccessComparison(compareMemoryAccesses(before, after));

      expect(text).toContain('WASM memory access comparison');
      expect(text).toContain('Added access sites');
    });

    it('builds a stable key for an access site', () => {
      const report = analyzeMemoryAccesses(
        parseWasmModule(single([...op.i32Const(0), ...op.i32Load(2, 0)])),
        'a.wasm',
      );
      expect(accessKey(report.accesses[0])).toBe('0#0');
    });
  });

  // ─── Files, determinism and the offline guarantee ─────────────────────────

  describe('files, determinism and the offline guarantee', () => {
    it('analyzes a file from disk', () => {
      const file = path.join(os.tmpdir(), `memory-access-${Date.now()}.wasm`);
      fs.writeFileSync(file, single([...op.i32Const(0), ...op.i32Load(2, 0)]));
      const report = analyzeMemoryAccessFile(file);

      expect(report.totals.totalAccesses).toBe(1);
      expect(report.file).toBe(file);
    });

    it('rejects a malformed artifact', () => {
      const file = path.join(os.tmpdir(), `memory-access-invalid-${Date.now()}.wasm`);
      fs.writeFileSync(file, Buffer.from('not wasm'));
      expect(() => analyzeMemoryAccessFile(file)).toThrow(WasmParseError);
    });

    it('is deterministic for the same artifact', () => {
      const module = single([
        ...op.i32Const(0),
        ...op.i32Load(2, 0),
        ...op.drop(),
        ...op.i32Const(4),
        ...op.i32Const(1),
        ...op.i32Store(2, 8),
      ]);
      const first = analyzeMemoryAccesses(parseWasmModule(module), 'a.wasm');
      const second = analyzeMemoryAccesses(parseWasmModule(module), 'a.wasm');

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it('does not expose any execute or instantiate symbol', () => {
      const exported = Object.keys(memoryAccessModule);
      expect(exported).not.toContain('instantiate');
      expect(exported.some((key: string) => key.toLowerCase().includes('execute'))).toBe(false);
    });

    it('rejects a JavaScript source file instead of running it', () => {
      const js = Buffer.from('function main() { return 1; }\n', 'utf8');
      expect(() => analyzeMemoryAccesses(parseWasmModule(js), 'a.wasm')).toThrow(WasmParseError);
    });
  });
});
