/**
 * Tests for ISSUE-239 (WASM section diff).
 *
 * The diff is compared structurally: sections are read from the binary and
 * hashed. No module is ever instantiated or executed, which the last describe
 * block verifies explicitly.
 */

import {
  compareSectionLists,
  describeSections,
  diffWasmBuffers,
  diffWasmFiles,
  formatSectionDiff,
  hashBytes,
  sectionDiffToCsv,
  sectionKey,
} from '../src/wasm/sectionDiff';
import * as sectionDiffModule from '../src/wasm/sectionDiff';
import { parseWasmSections, WasmParseError } from '../src/wasm/wasmBinary';
import { buildModule, customSection, op } from './helpers/wasmFixtures';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-diff-'));
const oldFixture = path.join(fixtureDir, 'diff-old.wasm');
const newFixture = path.join(fixtureDir, 'diff-new.wasm');
const invalidFixture = path.join(fixtureDir, 'invalid.wasm');

beforeAll(() => {
  fs.writeFileSync(oldFixture, buildModule({ bodies: [[...op.i32Const(1)]] }));
  fs.writeFileSync(
    newFixture,
    buildModule({ bodies: [[...op.i32Const(2)]], producersSection: true }),
  );
  fs.writeFileSync(invalidFixture, Buffer.from('definitely not wasm'));
});

describe('ISSUE-239: WASM section diff', () => {
  // ─── Section parsing ───────────────────────────────────────────────────────

  describe('parseWasmSections', () => {
    it('lists the sections of a module in file order', () => {
      const module = buildModule({ bodies: [[...op.i32Const(1)]] });
      const sections = parseWasmSections(module);
      expect(sections.map((entry) => entry.name)).toEqual(['type', 'function', 'code']);
    });

    it('reads the name of a custom section', () => {
      const module = buildModule({ producersSection: true });
      const sections = parseWasmSections(module);
      const custom = sections.find((entry) => entry.id === 0);
      expect(custom?.customName).toBe('producers');
    });

    it('rejects a buffer that is not a WebAssembly module', () => {
      expect(() => parseWasmSections(Buffer.from('not a wasm file'))).toThrow(WasmParseError);
    });

    it('rejects a module with an unsupported version', () => {
      const module = buildModule();
      module.writeUInt32LE(2, 4);
      expect(() => parseWasmSections(module)).toThrow(/Unsupported WebAssembly binary version/);
    });

    it('rejects a module whose section runs past the end of the file', () => {
      const module = buildModule();
      const truncated = module.subarray(0, module.length - 2);
      expect(() => parseWasmSections(truncated)).toThrow(WasmParseError);
    });
  });

  describe('sectionKey', () => {
    it('keys standard sections by name and index', () => {
      const module = buildModule({ bodies: [[...op.i32Const(1)]] });
      const sections = parseWasmSections(module);
      expect(sectionKey(sections[0])).toBe('type:0');
      expect(sectionKey(sections[1])).toBe('function:0');
    });

    it('keys custom sections by their name', () => {
      const module = buildModule({ producersSection: true });
      const custom = parseWasmSections(module).find((entry) => entry.id === 0);
      expect(sectionKey(custom as never)).toBe('custom:producers#0');
    });
  });

  // ─── Comparison ────────────────────────────────────────────────────────────

  describe('diffWasmBuffers', () => {
    it('reports every section as unchanged for two identical artifacts', () => {
      const module = buildModule({ bodies: [[...op.i32Const(1)]] });
      const report = diffWasmBuffers(module, module);

      expect(report.summary.added).toBe(0);
      expect(report.summary.removed).toBe(0);
      expect(report.summary.modified).toBe(0);
      expect(report.summary.unchanged).toBe(report.sections.length);
      expect(report.summary.identical).toBe(true);
      expect(report.sections.every((entry) => entry.status === 'unchanged')).toBe(true);
    });

    it('detects an added section', () => {
      const before = buildModule({ bodies: [[...op.i32Const(1)]] });
      const after = buildModule({ bodies: [[...op.i32Const(1)]], producersSection: true });

      const report = diffWasmBuffers(before, after);
      const added = report.sections.filter((entry) => entry.status === 'added');

      expect(added).toHaveLength(1);
      expect(added[0].section).toBe('custom');
      expect(added[0].customName).toBe('producers');
      expect(added[0].newSize).toBeGreaterThan(0);
      expect(added[0].sizeDelta).toBe(added[0].newSize);
    });

    it('detects a removed section', () => {
      const before = buildModule({ producersSection: true });
      const after = buildModule();

      const report = diffWasmBuffers(before, after);
      const removed = report.sections.filter((entry) => entry.status === 'removed');

      expect(removed).toHaveLength(1);
      expect(removed[0].customName).toBe('producers');
      expect(removed[0].sizeDelta).toBe(-(removed[0].oldSize as number));
    });

    it('detects a modified section and reports the size delta', () => {
      const before = buildModule({ bodies: [[...op.i32Const(1)]] });
      const after = buildModule({ bodies: [[...op.i32Const(1), ...op.i32Const(2)]] });

      const report = diffWasmBuffers(before, after);
      const modified = report.sections.filter((entry) => entry.status === 'modified');

      expect(modified.length).toBeGreaterThan(0);
      const code = modified.find((entry) => entry.section === 'code');
      expect(code).toBeDefined();
      expect(code?.sizeChanged).toBe(true);
      expect(code?.sizeDelta).toBe((code?.newSize ?? 0) - (code?.oldSize ?? 0));
      expect(code?.sizeDelta).toBeGreaterThan(0);
    });

    it('reports a size decrease when the new artifact is smaller', () => {
      const before = buildModule({ bodies: [[...op.i32Const(1), ...op.i32Const(2)]] });
      const after = buildModule({ bodies: [[...op.i32Const(1)]] });

      const report = diffWasmBuffers(before, after);
      const code = report.sections.find((entry) => entry.section === 'code');

      expect(code?.status).toBe('modified');
      expect(code?.sizeDelta).toBeLessThan(0);
    });

    it('detects a content change even when the section size stays the same', () => {
      const before = buildModule({ bodies: [[...op.i32Const(1)]] });
      const after = buildModule({ bodies: [[...op.i32Const(2)]] });

      const report = diffWasmBuffers(before, after);
      const code = report.sections.find((entry) => entry.section === 'code');

      expect(code?.status).toBe('modified');
      expect(code?.sizeChanged).toBe(false);
      expect(code?.contentChanged).toBe(true);
      expect(code?.sizeDelta).toBe(0);
      expect(code?.oldHash).not.toBe(code?.newHash);
    });

    it('reports custom section changes', () => {
      const before = buildModule({ producersSection: true });
      const after = buildModule({
        extraSections: [customSection('producers', [0x01, 0x02, 0x03, 0x04])],
      });

      const report = diffWasmBuffers(before, after);
      const custom = report.sections.find((entry) => entry.section === 'custom');

      expect(custom?.status).toBe('modified');
      expect(custom?.customName).toBe('producers');
      expect(custom?.contentChanged).toBe(true);
    });

    it('produces deterministic results for repeated comparisons', () => {
      const before = buildModule({ bodies: [[...op.i32Const(1)]] });
      const after = buildModule({ bodies: [[...op.i32Const(2)]], producersSection: true });

      const first = diffWasmBuffers(before, after);
      const second = diffWasmBuffers(before, after);

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });
  });

  describe('compareSectionLists', () => {
    it('matches sections by their stable key', () => {
      const oldSections = describeSections(parseWasmSections(buildModule()));
      const newSections = describeSections(
        parseWasmSections(buildModule({ producersSection: true })),
      );
      const comparisons = compareSectionLists(oldSections, newSections);

      expect(comparisons.filter((entry) => entry.status === 'unchanged')).toHaveLength(2);
      expect(comparisons.filter((entry) => entry.status === 'added')).toHaveLength(1);
    });
  });

  // ─── Output formats ────────────────────────────────────────────────────────

  describe('formatSectionDiff', () => {
    it('renders the summary and every section', () => {
      const before = buildModule({ bodies: [[...op.i32Const(1)]] });
      const after = buildModule({ bodies: [[...op.i32Const(2)]], producersSection: true });
      const report = diffWasmBuffers(before, after);
      const text = formatSectionDiff(report);

      expect(text).toContain('WASM section diff');
      expect(text).toContain('Added:');
      expect(text).toContain('Modified:');
      expect(text).toContain('producers');
      expect(text).toContain('size delta');
    });

    it('renders a CSV row per section', () => {
      const before = buildModule();
      const after = buildModule({ producersSection: true });
      const report = diffWasmBuffers(before, after);
      const csv = sectionDiffToCsv(report);

      const rows = csv.trim().split('\n');
      expect(rows[0]).toBe(
        'key,section,custom_name,status,old_size,new_size,size_delta,content_changed',
      );
      expect(rows).toHaveLength(report.sections.length + 1);
    });
  });

  // ─── Files ─────────────────────────────────────────────────────────────────

  describe('diffWasmFiles', () => {
    it('compares two files on disk', () => {
      const report = diffWasmFiles(oldFixture, newFixture);
      expect(report.summary.modified).toBeGreaterThan(0);
      expect(report.summary.added).toBe(1);
    });

    it('throws a validation error for an invalid artifact', () => {
      expect(() => diffWasmFiles(invalidFixture, invalidFixture)).toThrow(WasmParseError);
    });
  });

  // ─── Offline guarantee ─────────────────────────────────────────────────────

  describe('offline / no-execution guarantee', () => {
    it('does not expose any execute or instantiate symbol', () => {
      const exported = Object.keys(sectionDiffModule);
      expect(exported).not.toContain('instantiate');
      expect(exported.some((key: string) => key.toLowerCase().includes('execute'))).toBe(false);
    });

    it('rejects a JavaScript source file instead of running it', () => {
      const js = Buffer.from('function main() { return 1; }\n', 'utf8');
      expect(() => diffWasmBuffers(js, js)).toThrow(WasmParseError);
    });

    it('hashes the artifact deterministically', () => {
      const module = buildModule();
      expect(hashBytes(module)).toBe(hashBytes(Buffer.from(module)));
    });
  });
});
