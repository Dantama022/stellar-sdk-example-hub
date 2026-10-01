import assert from 'assert';
import { readFileSync } from 'fs';
import { parseWasmModule } from '@stellar/stellar-sdk';
import { analyzeWasmProvenance } from '../index.js';

describe('WASM Provenance Analyzer', () => {
  it('should extract complete producer metadata', async () => {
    const wasm = readFileSync('./test/fixtures/complete-producers.wasm');
    const module = parseWasmModule(wasm);
    const result = await analyzeWasmProvenance('./test/fixtures/complete-producers.wasm');

    assert.strictEqual(result.producers.length, 2);
    assert.strictEqual(result.producers[0].name, 'rustc');
    assert.strictEqual(result.producers[0].version, '1.75.0');
    assert.strictEqual(result.producers[0].category, 'compiler');
    assert.deepStrictEqual(result.producers[0].fields, {});

    assert.strictEqual(result.producers[1].name, 'wasm-opt');
    assert.strictEqual(result.producers[1].version, '116.0.0');
    assert.strictEqual(result.producers[1].category, 'linker');
  });

  it('should handle partial producer metadata', async () => {
    const result = await analyzeWasmProvenance('./test/fixtures/partial-producers.wasm');

    assert.strictEqual(result.producers.length, 1);
    assert.strictEqual(result.producers[0].name, 'rustc');
    assert.strictEqual(result.producers[0].version, 'unknown');
  });

  it('should report missing producer metadata', async () => {
    const result = await analyzeWasmProvenance('./test/fixtures/no-producers.wasm');

    assert.strictEqual(result.producers.length, 0);
  });

  it('should handle malformed producer metadata gracefully', async () => {
    const result = await analyzeWasmProvenance('./test/fixtures/malformed-producers.wasm');

    assert.strictEqual(result.producers.length, 1);
    assert.strictEqual(result.producers[0].name, 'rustc');
  });

  it('should calculate module statistics correctly', async () => {
    const result = await analyzeWasmProvenance('./test/fixtures/complete-producers.wasm');

    assert.strictEqual(result.moduleInfo.version, 1);
    assert.strictEqual(result.moduleInfo.functionCount, 4);
    assert.strictEqual(result.moduleInfo.importCount, 2);
    assert.strictEqual(result.moduleInfo.exportCount, 2);
    assert.ok(result.moduleInfo.codeSize > 0);
    assert.strictEqual(result.moduleInfo.hasCustomSections, true);
  });

  it('should generate a valid fingerprint', async () => {
    const result = await analyzeWasmProvenance('./test/fixtures/complete-producers.wasm');

    assert.ok(result.fingerprint.startsWith('sha256-'));
    assert.ok(result.fingerprint.length > 10);
  });

  it('should compare two artifacts correctly', async () => {
    const result = await analyzeWasmProvenance(
      './test/fixtures/complete-producers.wasm',
      './test/fixtures/partial-producers.wasm'
    );

    assert.ok(result.file1);
    assert.ok(result.file2);
    assert.ok(result.comparison);
    assert.strictEqual(result.comparison.added.length, 0);
    assert.strictEqual(result.comparison.removed.length, 1);
    assert.strictEqual(result.comparison.changed.length, 0);
  });

  it('should output JSON when requested', async () => {
    const result = await analyzeWasmProvenance('./test/fixtures/complete-producers.wasm', null, { json: true });

    assert.ok(typeof result === 'object');
    assert.ok(result.moduleInfo);
    assert.ok(result.producers);
    assert.ok(result.rawProducers);
    assert.ok(result.fingerprint);
  });
});