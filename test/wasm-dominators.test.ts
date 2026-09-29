import { WASMAnalyzer } from '../src/analyzer/wasm-analyzer';
import { readFileSync } from 'fs';
import { expect } from 'chai';

describe('WASM Dominator Analysis', () => {
  it('should analyze simple function', () => {
    const wasmBuffer = readFileSync('test/fixtures/simple.wasm');
    const analyzer = new WASMAnalyzer(wasmBuffer);
    const result = analyzer.analyze();

    expect(result.functions.length).to.be.greaterThan(0);
    expect(result.functions[0].cfg.blocks.length).to.be.greaterThan(0);
  });

  it('should handle conditional branches', () => {
    const wasmBuffer = readFileSync('test/fixtures/conditional.wasm');
    const analyzer = new WASMAnalyzer(wasmBuffer);
    const result = analyzer.analyze();

    const func = result.functions[0];
    expect(func.cfg.blocks.some(b => b.instructions.includes('if'))).to.be.true;
  });

  it('should identify unreachable blocks', () => {
    const wasmBuffer = readFileSync('test/fixtures/unreachable.wasm');
    const analyzer = new WASMAnalyzer(wasmBuffer);
    const result = analyzer.analyze();

    const func = result.functions[0];
    expect(func.metrics.unreachableBlocks.length).to.be.greaterThan(0);
  });

  it('should calculate dominator depths correctly', () => {
    const wasmBuffer = readFileSync('test/fixtures/loop.wasm');
    const analyzer = new WASMAnalyzer(wasmBuffer);
    const result = analyzer.analyze();

    const func = result.functions[0];
    expect(func.metrics.maxDepth).to.be.greaterThan(0);
  });
});