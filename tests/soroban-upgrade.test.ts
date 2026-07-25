import { computeWasmHash } from '../src/examples/23-soroban-upgrade';

describe('Soroban upgrade helpers', () => {
  it('computes the SHA-256 WASM hash used for installs', () => {
    const wasm = Buffer.from('test-wasm');
    const hash = computeWasmHash(wasm);
    expect(hash).toHaveLength(32);
    expect(hash.equals(computeWasmHash(wasm))).toBe(true);
  });
});
