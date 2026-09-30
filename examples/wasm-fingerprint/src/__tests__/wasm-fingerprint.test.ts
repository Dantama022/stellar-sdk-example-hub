import { readFileSync } from 'fs';
import { resolve } from 'path';
import { computeFingerprints, compareFingerprints } from '../wasm-fingerprint';

describe('WASM Fingerprint', () => {
  const fixturesDir = resolve(__dirname, 'fixtures');

  describe('computeFingerprints', () => {
    it('should produce identical fingerprints for identical binaries', () => {
      const wasm1 = readFileSync(resolve(fixturesDir, 'identical1.wasm'));
      const wasm2 = readFileSync(resolve(fixturesDir, 'identical2.wasm'));

      const fp1 = computeFingerprints(wasm1);
      const fp2 = computeFingerprints(wasm2);

      expect(fp1.rawBinaryFingerprint).toBe(fp2.rawBinaryFingerprint);
      expect(fp1.semanticModuleFingerprint).toBe(fp2.semanticModuleFingerprint);
      expect(fp1.typeFingerprint).toBe(fp2.typeFingerprint);
      expect(fp1.importExportFingerprint).toBe(fp2.importExportFingerprint);
      expect(fp1.codeFingerprint).toBe(fp2.codeFingerprint);
      expect(fp1.memoryTableFingerprint).toBe(fp2.memoryTableFingerprint);
      expect(fp1.globalFingerprint).toBe(fp2.globalFingerprint);
      expect(fp1.dataElementFingerprint).toBe(fp2.dataElementFingerprint);
    });

    it('should produce same semantic fingerprint for metadata-only differences', () => {
      const wasm1 = readFileSync(resolve(fixturesDir, 'metadata1.wasm'));
      const wasm2 = readFileSync(resolve(fixturesDir, 'metadata2.wasm'));

      const fp1 = computeFingerprints(wasm1);
      const fp2 = computeFingerprints(wasm2);

      expect(fp1.rawBinaryFingerprint).not.toBe(fp2.rawBinaryFingerprint);
      expect(fp1.semanticModuleFingerprint).toBe(fp2.semanticModuleFingerprint);
    });

    it('should produce different fingerprints for semantically different binaries', () => {
      const wasm1 = readFileSync(resolve(fixturesDir, 'different1.wasm'));
      const wasm2 = readFileSync(resolve(fixturesDir, 'different2.wasm'));

      const fp1 = computeFingerprints(wasm1);
      const fp2 = computeFingerprints(wasm2);

      expect(fp1.rawBinaryFingerprint).not.toBe(fp2.rawBinaryFingerprint);
      expect(fp1.semanticModuleFingerprint).not.toBe(fp2.semanticModuleFingerprint);
    });

    it('should be deterministic across multiple runs', () => {
      const wasm = readFileSync(resolve(fixturesDir, 'identical1.wasm'));

      const fp1 = computeFingerprints(wasm);
      const fp2 = computeFingerprints(wasm);

      expect(fp1.rawBinaryFingerprint).toBe(fp2.rawBinaryFingerprint);
      expect(fp1.semanticModuleFingerprint).toBe(fp2.semanticModuleFingerprint);
    });
  });

  describe('compareFingerprints', () => {
    it('should detect binary-only differences', () => {
      const wasm1 = readFileSync(resolve(fixturesDir, 'identical1.wasm'));
      const wasm2 = readFileSync(resolve(fixturesDir, 'identical2.wasm'));

      const result = compareFingerprints(wasm1, wasm2);

      expect(result.binaryMatch).toBe(true);
      expect(result.semanticMatch).toBe(true);
      expect(result.differenceType).toBe('binary-only');
      expect(result.changedComponents).toEqual([]);
    });

    it('should detect metadata-only differences', () => {
      const wasm1 = readFileSync(resolve(fixturesDir, 'metadata1.wasm'));
      const wasm2 = readFileSync(resolve(fixturesDir, 'metadata2.wasm'));

      const result = compareFingerprints(wasm1, wasm2);

      expect(result.binaryMatch).toBe(false);
      expect(result.semanticMatch).toBe(true);
      expect(result.differenceType).toBe('metadata-only');
      expect(result.changedComponents).toEqual([]);
    });

    it('should detect semantic differences', () => {
      const wasm1 = readFileSync(resolve(fixturesDir, 'different1.wasm'));
      const wasm2 = readFileSync(resolve(fixturesDir, 'different2.wasm'));

      const result = compareFingerprints(wasm1, wasm2);

      expect(result.binaryMatch).toBe(false);
      expect(result.semanticMatch).toBe(false);
      expect(result.differenceType).toBe('semantic');
      expect(result.changedComponents.length).toBeGreaterThan(0);
    });

    it('should identify changed components', () => {
      const wasm1 = readFileSync(resolve(fixturesDir, 'different1.wasm'));
      const wasm2 = readFileSync(resolve(fixturesDir, 'different2.wasm'));

      const result = compareFingerprints(wasm1, wasm2);

      expect(result.changedComponents).toContain('types');
    });
  });
});
