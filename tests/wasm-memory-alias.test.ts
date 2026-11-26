/**
 * tests/wasm-memory-alias.test.ts
 *
 * Unit tests for the offline WASM memory-alias analysis (ISSUE-271).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  WasmMemoryAliasValidationError,
  analyzeMemoryAlias,
  compareMemoryAliasReports,
} from '../src/utils/wasm-memory-alias';
import {
  compareMemoryAliasFiles,
  parseMemoryAliasArgs,
  run,
  toCsv,
} from '../src/examples/271-wasm-memory-alias';

// ---------------------------------------------------------------------------
// Binary helpers
// ---------------------------------------------------------------------------

function u32le(value: number): number[] {
  const bytes: number[] = [];
  let current = value >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (current !== 0);
  return bytes;
}

function sleb32(value: number): number[] {
  const bytes: number[] = [];
  let current = value | 0;
  let more = true;
  while (more) {
    let byte = current & 0x7f;
    current >>= 7;
    const signBit = (byte & 0x40) !== 0;
    more = !((current === 0 && !signBit) || (current === -1 && signBit));
    if (more) byte |= 0x80;
    bytes.push(byte);
  }
  return bytes;
}

function section(id: number, payload: number[]): number[] {
  return [id, ...u32le(payload.length), ...payload];
}

const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

interface BodySpec {
  code: number[];
  locals?: Array<{ count: number; type: number }>;
}

function buildWasm(bodies: Array<BodySpec | number[]>, options: { memory?: boolean } = {}): Buffer {
  const normalized: BodySpec[] = bodies.map((body) =>
    Array.isArray(body) ? { code: body } : body,
  );
  const typeCount = normalized.length;
  const typeSection = section(1, [typeCount, ...normalized.flatMap(() => [0x60, 0x00, 0x00])]);
  const funcSection = section(3, [typeCount, ...new Array(typeCount).fill(0x00)]);

  const sections: number[] = [...WASM_HEADER, ...typeSection, ...funcSection];

  if (options.memory !== false) {
    sections.push(...section(5, [0x01, 0x00, 0x01]));
  }

  const codePayload: number[] = [typeCount];
  for (const body of normalized) {
    const locals = body.locals ?? [];
    const localBytes: number[] = [locals.length];
    for (const group of locals) {
      localBytes.push(...u32le(group.count), group.type);
    }
    const full = [...localBytes, ...body.code, 0x0b];
    codePayload.push(...u32le(full.length), ...full);
  }
  sections.push(...section(10, codePayload));

  return Buffer.from(sections);
}

function tmpFile(buf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-memory-alias-'));
  const file = path.join(dir, 'test.wasm');
  fs.writeFileSync(file, buf);
  return file;
}

// ---------------------------------------------------------------------------
// Opcodes and helpers
// ---------------------------------------------------------------------------

const END = 0x0b;
const BLOCK = 0x02;
const LOOP = 0x03;
const IF = 0x04;
const ELSE = 0x05;
const EMPTY_BLOCK_TYPE = 0x40;
const UNREACHABLE = 0x00;
const I32_CONST = 0x41;
const I32_ADD = 0x6a;
const I32_AND = 0x71;
const LOCAL_GET = 0x20;
const I32_LOAD = 0x28;
const I32_LOAD8_U = 0x2d;
const I32_STORE = 0x36;

function i32Const(value: number): number[] {
  return [I32_CONST, ...sleb32(value)];
}

function load(opcode: number, offset = 0, align = 2, memoryIndex?: number): number[] {
  if (memoryIndex !== undefined) {
    return [opcode, 0x40 | align, ...u32le(memoryIndex), ...u32le(offset)];
  }
  return [opcode, align, ...u32le(offset)];
}

function store(opcode: number, offset = 0, align = 2, memoryIndex?: number): number[] {
  return load(opcode, offset, align, memoryIndex);
}

function addressAt(value: number, opcode = I32_LOAD, offset = 0): number[] {
  return [...i32Const(value), ...load(opcode, offset)];
}

function storeAt(value: number, storedValue: number, offset = 0): number[] {
  return [...i32Const(value), ...i32Const(storedValue), ...store(I32_STORE, offset)];
}

function singleFnWasm(code: number[], locals?: Array<{ count: number; type: number }>): string {
  return tmpFile(buildWasm([{ code, locals }]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wasm-memory-alias', () => {
  describe('address reconstruction', () => {
    it('records exact address, width, alignment, and static offset', () => {
      const file = singleFnWasm(addressAt(100, I32_LOAD, 4));
      const report = analyzeMemoryAlias(file);
      const access = report.accesses[0];

      expect(access.opcode).toBe('i32.load');
      expect(access.accessType).toBe('load');
      expect(access.width).toBe(4);
      expect(access.alignment).toBe(4);
      expect(access.staticOffset).toBe(4);
      expect(access.memoryIndex).toBe(0);
      expect(access.address.kind).toBe('exact');
      expect(access.address.exactAddress).toBe(104);
      expect(access.address.expression).toBe('0x68');
      expect(report.statistics.addressClassCounts.exact).toBe(1);
    });

    it('records a range-bounded address for a masked base', () => {
      const file = singleFnWasm([
        LOCAL_GET,
        0x00,
        ...i32Const(0xff),
        I32_AND,
        ...load(I32_LOAD, 0, 0),
      ]);
      const report = analyzeMemoryAlias(file);
      const access = report.accesses[0];

      expect(access.address.kind).toBe('range');
      expect(access.address.rangeMin).toBe(0);
      expect(access.address.rangeMax).toBe(255);
      expect(report.statistics.addressClassCounts.range).toBe(1);
    });

    it('records a symbolic address for a local.get base', () => {
      const file = singleFnWasm([LOCAL_GET, 0x00, ...load(I32_LOAD)]);
      const report = analyzeMemoryAlias(file);
      const access = report.accesses[0];

      expect(access.address.kind).toBe('symbolic');
      expect(access.address.baseSymbol).toBe('local:0');
      expect(access.address.baseAddend).toBe(0);
    });

    it('records an unknown address when symbolic bases are combined', () => {
      const file = singleFnWasm([LOCAL_GET, 0x00, LOCAL_GET, 0x01, I32_ADD, ...load(I32_LOAD)]);
      const report = analyzeMemoryAlias(file);
      const access = report.accesses[0];

      expect(access.address.kind).toBe('unknown');
      expect(report.statistics.addressClassCounts.unknown).toBe(1);
    });

    it('records an explicit memory index from a multi-memory memarg', () => {
      const file = singleFnWasm([...i32Const(100), ...load(I32_LOAD, 0, 2, 1)]);
      const report = analyzeMemoryAlias(file);
      expect(report.accesses[0].memoryIndex).toBe(1);
    });
  });

  describe('alias classification', () => {
    it('classifies identical static addresses as must-alias', () => {
      const file = singleFnWasm([...addressAt(100), ...addressAt(100)]);
      const report = analyzeMemoryAlias(file);
      const pair = report.pairs[0];

      expect(pair.alias).toBe('must-alias');
      expect(pair.relationship).toBe('read-read');
      expect(pair.potentialConflict).toBe(false);
      expect(pair.overlappingBytes).toBe(4);
      expect(report.statistics.mustAliasPairs).toBe(1);
    });

    it('classifies two reads over the same range as must-alias without conflict', () => {
      const file = singleFnWasm([...addressAt(100, I32_LOAD), ...addressAt(100, I32_LOAD)]);
      const report = analyzeMemoryAlias(file);

      expect(report.pairs[0].alias).toBe('must-alias');
      expect(report.pairs[0].potentialConflict).toBe(false);
    });

    it('detects read/write overlap and a potential conflict', () => {
      const file = singleFnWasm([...addressAt(100), ...storeAt(102, 7)]);
      const report = analyzeMemoryAlias(file);
      const pair = report.pairs[0];

      expect(pair.alias).toBe('may-alias');
      expect(pair.relationship).toBe('read-write');
      expect(pair.potentialConflict).toBe(true);
      expect(pair.overlappingBytes).toBe(2);
      expect(report.statistics.potentialReadWriteConflicts).toBe(1);
    });

    it('detects write/write overlap and a potential conflict', () => {
      const file = singleFnWasm([...storeAt(100, 1), ...storeAt(102, 2)]);
      const report = analyzeMemoryAlias(file);
      const pair = report.pairs[0];

      expect(pair.alias).toBe('may-alias');
      expect(pair.relationship).toBe('write-write');
      expect(pair.potentialConflict).toBe(true);
    });

    it('detects partially overlapping ranges with different widths', () => {
      const file = singleFnWasm([...addressAt(100, I32_LOAD8_U), ...addressAt(100, I32_LOAD)]);
      const report = analyzeMemoryAlias(file);
      const pair = report.pairs[0];

      expect(pair.alias).toBe('may-alias');
      expect(pair.overlappingBytes).toBe(1);
      expect(report.pairs[0].accessA.width).toBe(1);
      expect(report.pairs[0].accessB.width).toBe(4);
    });

    it('classifies disjoint static ranges as no-alias', () => {
      const file = singleFnWasm([...addressAt(100), ...addressAt(200)]);
      const report = analyzeMemoryAlias(file);
      const pair = report.pairs[0];

      expect(pair.alias).toBe('no-alias');
      expect(pair.potentialConflict).toBe(false);
      expect(pair.overlappingBytes).toBe(0);
      expect(report.statistics.noAliasPairs).toBe(1);
    });

    it('classifies unknown/dynamic addresses as unknown', () => {
      const code = [LOCAL_GET, 0x00, LOCAL_GET, 0x01, I32_ADD, ...load(I32_LOAD)];
      const file = singleFnWasm([...code, ...code]);
      const report = analyzeMemoryAlias(file);

      expect(report.pairs[0].alias).toBe('unknown');
      expect(report.statistics.unknownRelationships).toBe(1);
    });

    it('uses statically known offsets in overlap calculations', () => {
      const file = singleFnWasm([...addressAt(100, I32_LOAD, 0), ...addressAt(100, I32_LOAD, 4)]);
      const report = analyzeMemoryAlias(file);

      expect(report.accesses[0].address.exactAddress).toBe(100);
      expect(report.accesses[1].address.exactAddress).toBe(104);
      expect(report.pairs[0].alias).toBe('no-alias');
    });

    it('compares exact addresses across basic blocks', () => {
      const file = singleFnWasm([
        BLOCK,
        EMPTY_BLOCK_TYPE,
        ...addressAt(100),
        END,
        ...addressAt(100),
      ]);
      const report = analyzeMemoryAlias(file);
      const pair = report.pairs[0];

      expect(pair.sameBlock).toBe(false);
      expect(pair.alias).toBe('must-alias');
    });

    it('compares exact addresses across branches', () => {
      const file = singleFnWasm([
        ...i32Const(1),
        IF,
        EMPTY_BLOCK_TYPE,
        ...addressAt(100),
        ELSE,
        ...addressAt(100),
        END,
      ]);
      const report = analyzeMemoryAlias(file);

      expect(report.pairs[0].alias).toBe('must-alias');
      expect(report.pairs[0].sameBlock).toBe(false);
    });

    it('handles loop-carried symbolic accesses conservatively', () => {
      const file = singleFnWasm([
        LOOP,
        EMPTY_BLOCK_TYPE,
        LOCAL_GET,
        0x00,
        ...load(I32_LOAD, 0, 0),
        LOCAL_GET,
        0x00,
        ...load(I32_LOAD, 4, 0),
        END,
      ]);
      const report = analyzeMemoryAlias(file);
      const pair = report.pairs[0];

      expect(report.accesses.every((access) => access.loopContext)).toBe(true);
      expect(pair.alias).toBe('may-alias');
      expect(pair.reason).toContain('loop');
    });

    it('keeps exact loop accesses must-alias', () => {
      const file = singleFnWasm([
        LOOP,
        EMPTY_BLOCK_TYPE,
        ...addressAt(100),
        ...addressAt(100),
        END,
      ]);
      const report = analyzeMemoryAlias(file);

      expect(report.pairs[0].alias).toBe('must-alias');
    });
  });

  describe('statistics and grouping', () => {
    it('reports per-function statistics and relationship groups', () => {
      const file = tmpFile(
        buildWasm([
          { code: [...addressAt(100), ...addressAt(100)] },
          { code: [...addressAt(200), ...storeAt(200, 1)] },
        ]),
      );
      const report = analyzeMemoryAlias(file);

      expect(report.functions).toHaveLength(2);
      expect(report.functions[0].totalAccesses).toBe(2);
      expect(report.functions[0].mustAliasPairs).toBe(1);
      expect(report.functions[1].potentialConflicts).toBe(1);
      expect(Object.keys(report.relationshipsByFunctionPair).sort()).toEqual(['0:0', '1:1']);
      expect(Object.keys(report.relationshipsByMemoryRegion).length).toBeGreaterThan(0);
      expect(report.statistics.functionsWithLargestAliasingAccessSets.length).toBeGreaterThan(0);
    });

    it('reports zero pairs for a single access', () => {
      const file = singleFnWasm(addressAt(100));
      const report = analyzeMemoryAlias(file);

      expect(report.statistics.totalMemoryAccesses).toBe(1);
      expect(report.statistics.totalAccessPairsCompared).toBe(0);
      expect(report.pairs).toHaveLength(0);
    });

    it('handles a module with no code section', () => {
      const file = tmpFile(Buffer.from(WASM_HEADER));
      const report = analyzeMemoryAlias(file);

      expect(report.valid).toBe(true);
      expect(report.accesses).toHaveLength(0);
      expect(report.pairs).toHaveLength(0);
      expect(report.functions).toHaveLength(0);
    });
  });

  describe('filtering and comparison', () => {
    it('filters by function index', () => {
      const file = tmpFile(
        buildWasm([
          { code: [...addressAt(100), ...addressAt(100)] },
          { code: [...addressAt(200), ...addressAt(200)] },
        ]),
      );
      const report = analyzeMemoryAlias(file, { functionIndex: 1 });

      expect(report.accesses.every((access) => access.functionIndex === 1)).toBe(true);
      expect(report.functions).toHaveLength(1);
    });

    it('filters by access type', () => {
      const file = singleFnWasm([...addressAt(100), ...storeAt(100, 1)]);
      const report = analyzeMemoryAlias(file, { accessType: 'store' });

      expect(report.accesses).toHaveLength(1);
      expect(report.accesses[0].accessType).toBe('store');
    });

    it('filters by memory range', () => {
      const file = singleFnWasm([...addressAt(100), ...addressAt(200), ...addressAt(300)]);
      const report = analyzeMemoryAlias(file, { minAddress: 150, maxAddress: 250 });

      expect(report.accesses).toHaveLength(1);
      expect(report.accesses[0].address.exactAddress).toBe(200);
    });

    it('filters by alias classification', () => {
      const file = singleFnWasm([...addressAt(100), ...addressAt(100), ...addressAt(200)]);
      const report = analyzeMemoryAlias(file, { aliasClassification: 'no-alias' });

      expect(report.pairs.every((pair) => pair.alias === 'no-alias')).toBe(true);
      expect(report.pairs.length).toBeGreaterThan(0);
    });

    it('truncates pair comparisons deterministically at the configured limit', () => {
      const accesses: number[] = [];
      for (let i = 0; i < 10; i += 1) accesses.push(...addressAt(i * 100));
      const file = singleFnWasm(accesses);
      const report = analyzeMemoryAlias(file, { maxPairComparisons: 5 });

      expect(report.statistics.pairComparisonsTruncated).toBe(true);
      expect(report.statistics.pairComparisonLimit).toBe(5);
      expect(report.statistics.pairComparisonsPerformed).toBe(5);
      expect(report.statistics.totalAccessPairsCompared).toBe(5);
      expect(report.warnings.some((warning) => warning.includes('limit'))).toBe(true);
    });

    it('compares two artifacts and detects changed classifications', () => {
      const before = singleFnWasm([...addressAt(100), ...addressAt(200)]);
      const after = singleFnWasm([...addressAt(100), ...addressAt(100)]);
      const result = compareMemoryAliasReports(before, after);

      expect(result.comparison.changedAliasClassifications).toHaveLength(1);
      expect(result.comparison.changedAliasClassifications[0].before.alias).toBe('no-alias');
      expect(result.comparison.changedAliasClassifications[0].after.alias).toBe('must-alias');
    });

    it('compares two artifacts and detects added, removed, and new conflicts', () => {
      const before = singleFnWasm([...addressAt(100)]);
      const after = singleFnWasm([...addressAt(100), ...storeAt(100, 1)]);
      const result = compareMemoryAliasFiles(before, after);

      expect(result.comparison.addedAliasRelationships.length).toBe(1);
      expect(result.comparison.removedAliasRelationships).toHaveLength(0);
      expect(result.comparison.newlyIntroducedConflicts.length).toBe(1);
      expect(result.comparison.totalPairDelta).toBe(1);
    });

    it('reports no changes for identical artifacts', () => {
      const file = singleFnWasm([...addressAt(100), ...addressAt(100)]);
      const result = compareMemoryAliasReports(file, file);

      expect(result.comparison.addedAliasRelationships).toHaveLength(0);
      expect(result.comparison.removedAliasRelationships).toHaveLength(0);
      expect(result.comparison.changedAliasClassifications).toHaveLength(0);
      expect(result.comparison.newlyIntroducedConflicts).toHaveLength(0);
    });
  });

  describe('output formats', () => {
    it('produces valid JSON through run()', async () => {
      const file = singleFnWasm([...addressAt(100), ...storeAt(102, 1)]);
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message: string) => logs.push(message);
      try {
        await run({ wasmFile: file, json: true });
      } finally {
        console.log = originalLog;
      }
      const parsed = JSON.parse(logs.join(''));
      expect(parsed.valid).toBe(true);
      expect(parsed.statistics.totalMemoryAccesses).toBe(2);
      expect(parsed.pairs).toHaveLength(1);
    });

    it('produces CSV with one row per alias pair', () => {
      const file = singleFnWasm([...addressAt(100), ...storeAt(102, 1)]);
      const report = analyzeMemoryAlias(file);
      const lines = toCsv(report.pairs).split('\n');

      expect(lines[0]).toBe(
        'functionA,blockA,instructionA,accessTypeA,functionB,blockB,instructionB,accessTypeB,memoryIndex,alias,relationship,sameBlock,sameFunction,overlappingBytes,potentialConflict,addressA,addressB,widthA,widthB',
      );
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('may-alias');
      expect(lines[1]).toContain('read-write');
    });

    it('produces only a CSV header when there are no pairs', () => {
      const file = singleFnWasm(addressAt(100));
      const report = analyzeMemoryAlias(file);
      expect(toCsv(report.pairs).split('\n')).toHaveLength(1);
    });

    it('prints human-readable output by default', async () => {
      const file = singleFnWasm([...addressAt(100), ...storeAt(102, 1)]);
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message: string) => logs.push(message);
      try {
        await run({ wasmFile: file });
      } finally {
        console.log = originalLog;
      }
      expect(logs.join('\n')).toContain('WASM Memory Alias Analysis');
    });

    it('throws a usage error when no file is provided', async () => {
      await expect(run({})).rejects.toThrow(/Usage/);
    });

    it('parses CLI filters', () => {
      expect(
        parseMemoryAliasArgs([
          'a.wasm',
          'b.wasm',
          '--json',
          '--csv',
          '--function',
          '2',
          '--type',
          'store',
          '--min-address=10',
          '--max-address',
          '20',
          '--alias',
          'may-alias',
          '--max-pairs',
          '100',
        ]),
      ).toEqual({
        wasmFile: 'a.wasm',
        compareFile: 'b.wasm',
        json: true,
        csv: true,
        options: {
          functionIndex: 2,
          accessType: 'store',
          minAddress: 10,
          maxAddress: 20,
          aliasClassification: 'may-alias',
          maxPairComparisons: 100,
        },
      });
      expect(() => parseMemoryAliasArgs(['a.wasm', '--type', 'invalid'])).toThrow(/load/);
      expect(() => parseMemoryAliasArgs(['a.wasm', 'b.wasm', 'c.wasm'])).toThrow(/Usage/);
    });
  });

  describe('robustness', () => {
    it('throws WasmMemoryAliasValidationError for malformed magic bytes', () => {
      const file = tmpFile(Buffer.from([0x00, 0x61, 0x73, 0x00, 0x01, 0x00, 0x00, 0x00]));
      expect(() => analyzeMemoryAlias(file)).toThrow(WasmMemoryAliasValidationError);
    });

    it('throws WasmMemoryAliasValidationError for truncated input', () => {
      const file = tmpFile(Buffer.from([0x00, 0x61]));
      expect(() => analyzeMemoryAlias(file)).toThrow(WasmMemoryAliasValidationError);
    });

    it('throws WasmMemoryAliasValidationError for a missing file', () => {
      expect(() => analyzeMemoryAlias('/nonexistent/memory-alias.wasm')).toThrow(
        WasmMemoryAliasValidationError,
      );
    });

    it('does not crash on an unsupported SIMD prefix', () => {
      const file = singleFnWasm([0xfd, ...addressAt(100)]);
      const report = analyzeMemoryAlias(file);

      expect(report.warnings.length).toBe(1);
      expect(report.warnings[0]).toContain('SIMD');
      expect(report.accesses).toHaveLength(0);
    });

    it('is deterministic across repeated runs', () => {
      const file = singleFnWasm([
        ...addressAt(100),
        ...addressAt(100),
        ...addressAt(200),
        ...storeAt(200, 1),
      ]);
      const first = analyzeMemoryAlias(file);
      const second = analyzeMemoryAlias(file);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it('never executes WASM and still analyzes code after a trap instruction', () => {
      const file = singleFnWasm([UNREACHABLE, ...addressAt(100), ...addressAt(100)]);
      const report = analyzeMemoryAlias(file);

      expect(report.valid).toBe(true);
      expect(report.accesses.length).toBeGreaterThan(0);
    });

    it('analyzes large access sets without uncontrolled growth', () => {
      const accesses: number[] = [];
      for (let i = 0; i < 200; i += 1) accesses.push(...addressAt(i * 16));
      const file = singleFnWasm(accesses);
      const report = analyzeMemoryAlias(file, { maxPairComparisons: 1000 });

      expect(report.statistics.pairComparisonsTruncated).toBe(true);
      expect(report.statistics.pairComparisonsPerformed).toBe(1000);
      expect(report.pairs.length).toBeLessThanOrEqual(1000);
    });
  });
});
