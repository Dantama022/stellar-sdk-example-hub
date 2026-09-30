import * as fs from 'fs';
import * as path from 'path';
import { WasmNameAnalyzer } from './wasm-name-analyzer';

describe('WasmNameAnalyzer', () => {
  const analyzer = new WasmNameAnalyzer();
  const fixturesDir = path.join(__dirname, '__fixtures__', 'wasm');

  describe('analyzeWasmModule', () => {
    it('should handle WASM without name section', () => {
      const wasmBuffer = fs.readFileSync(path.join(fixturesDir, 'no-name-section.wasm'));
      const result = analyzer.analyzeWasmModule(wasmBuffer);

      expect(result.hasNameSection).toBe(false);
      expect(result.namedFunctions).toHaveLength(0);
      expect(result.unnamedFunctions).toHaveLength(result.totalFunctions);
      expect(result.functionLocals).toHaveLength(0);
      expect(result.totalNamedLocals).toBe(0);
    });

    it('should extract function names from name section', () => {
      const wasmBuffer = fs.readFileSync(path.join(fixturesDir, 'with-function-names.wasm'));
      const result = analyzer.analyzeWasmModule(wasmBuffer);

      expect(result.hasNameSection).toBe(true);
      expect(result.namedFunctions.length).toBeGreaterThan(0);
      expect(result.namedFunctions.every(fn => typeof fn.name === 'string')).toBe(true);
      expect(result.unnamedFunctions).not.toContainEqual(
        expect.objectContaining({ index: result.namedFunctions[0].index })
      );
    });

    it('should extract local names grouped by function', () => {
      const wasmBuffer = fs.readFileSync(path.join(fixturesDir, 'with-local-names.wasm'));
      const result = analyzer.analyzeWasmModule(wasmBuffer);

      expect(result.hasNameSection).toBe(true);
      expect(result.functionLocals.length).toBeGreaterThan(0);
      expect(result.totalNamedLocals).toBeGreaterThan(0);
      
      for (const funcLocal of result.functionLocals) {
        expect(funcLocal.locals.length).toBeGreaterThan(0);
        expect(funcLocal.locals.every(local => typeof local.name === 'string')).toBe(true);
      }
    });

    it('should report functions with most named locals', () => {
      const wasmBuffer = fs.readFileSync(path.join(fixturesDir, 'with-local-names.wasm'));
      const result = analyzer.analyzeWasmModule(wasmBuffer);

      if (result.functionsWithMostLocals.length > 0) {
        const maxLocals = Math.max(
          ...result.functionsWithMostLocals.map(fn => fn.localCount)
        );
        expect(result.functionsWithMostLocals.every(fn => fn.localCount === maxLocals)).toBe(true);
      }
    });

    it('should handle partial naming metadata', () => {
      const wasmBuffer = fs.readFileSync(path.join(fixturesDir, 'partial-names.wasm'));
      const result = analyzer.analyzeWasmModule(wasmBuffer);

      expect(result.hasNameSection).toBe(true);
      expect(result.namedFunctions.length).toBeLessThan(result.totalFunctions);
      expect(result.unnamedFunctions.length).toBeGreaterThan(0);
    });

    it('should handle malformed name section gracefully', () => {
      const wasmBuffer = fs.readFileSync(path.join(fixturesDir, 'malformed-name-section.wasm'));
      expect(() => analyzer.analyzeWasmModule(wasmBuffer)).not.toThrow();
    });
  });

  describe('compareWasmModules', () => {
    it('should detect added function names', () => {
      const wasm1 = fs.readFileSync(path.join(fixturesDir, 'no-name-section.wasm'));
      const wasm2 = fs.readFileSync(path.join(fixturesDir, 'with-function-names.wasm'));
      const result = analyzer.compareWasmModules(wasm1, wasm2);

      expect(result.addedFunctionNames.length).toBeGreaterThan(0);
      expect(result.removedFunctionNames).toHaveLength(0);
    });

    it('should detect removed function names', () => {
      const wasm1 = fs.readFileSync(path.join(fixturesDir, 'with-function-names.wasm'));
      const wasm2 = fs.readFileSync(path.join(fixturesDir, 'no-name-section.wasm'));
      const result = analyzer.compareWasmModules(wasm1, wasm2);

      expect(result.removedFunctionNames.length).toBeGreaterThan(0);
      expect(result.addedFunctionNames).toHaveLength(0);
    });

    it('should detect renamed functions', () => {
      const wasm1 = fs.readFileSync(path.join(fixturesDir, 'function-names-v1.wasm'));
      const wasm2 = fs.readFileSync(path.join(fixturesDir, 'function-names-v2.wasm'));
      const result = analyzer.compareWasmModules(wasm1, wasm2);

      expect(result.renamedFunctions.length).toBeGreaterThan(0);
      expect(result.renamedFunctions.every(
        rename => rename.oldName !== rename.newName
      )).toBe(true);
    });

    it('should detect added local names', () => {
      const wasm1 = fs.readFileSync(path.join(fixturesDir, 'no-local-names.wasm'));
      const wasm2 = fs.readFileSync(path.join(fixturesDir, 'with-local-names.wasm'));
      const result = analyzer.compareWasmModules(wasm1, wasm2);

      expect(result.addedLocalNames.length).toBeGreaterThan(0);
    });

    it('should detect removed local names', () => {
      const wasm1 = fs.readFileSync(path.join(fixturesDir, 'with-local-names.wasm'));
      const wasm2 = fs.readFileSync(path.join(fixturesDir, 'no-local-names.wasm'));
      const result = analyzer.compareWasmModules(wasm1, wasm2);

      expect(result.removedLocalNames.length).toBeGreaterThan(0);
    });

    it('should detect changed local names', () => {
      const wasm1 = fs.readFileSync(path.join(fixturesDir, 'local-names-v1.wasm'));
      const wasm2 = fs.readFileSync(path.join(fixturesDir, 'local-names-v2.wasm'));
      const result = analyzer.compareWasmModules(wasm1, wasm2);

      expect(result.changedLocalNames.length).toBeGreaterThan(0);
      expect(result.changedLocalNames.every(
        change => change.oldName !== change.newName
      )).toBe(true);
    });

    it('should preserve raw indexes in comparison output', () => {
      const wasm1 = fs.readFileSync(path.join(fixturesDir, 'function-names-v1.wasm'));
      const wasm2 = fs.readFileSync(path.join(fixturesDir, 'function-names-v2.wasm'));
      const result = analyzer.compareWasmModules(wasm1, wasm2);

      for (const rename of result.renamedFunctions) {
        expect(typeof rename.index).toBe('number');
      }
      for (const local of result.addedLocalNames) {
        expect(typeof local.functionIndex).toBe('number');
        expect(typeof local.index).toBe('number');
      }
    });
  });
});
