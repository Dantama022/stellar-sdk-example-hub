import { Networks } from '@stellar/stellar-sdk';
import { assertSameNetwork, buildUnsignedDemo, guardedSign, guardedSubmit, probeHorizon, safeEndpoint, validateNetwork } from '../src/examples/326-network-passphrase-safety';

const config = { label: 'testnet' as const, passphrase: Networks.TESTNET, horizonUrl: 'https://horizon-testnet.stellar.org' };

test('validates testnet and public separately', () => {
  expect(validateNetwork(config)).toEqual(config);
  expect(validateNetwork({ label: 'public', passphrase: Networks.PUBLIC_NETWORK, horizonUrl: 'https://horizon.stellar.org' }).label).toBe('public');
});
test('rejects missing, malformed, wrong or credential-bearing configuration', () => {
  expect(() => validateNetwork({ ...config, passphrase: '' })).toThrow('Missing');
  expect(() => validateNetwork({ ...config, horizonUrl: 'not-a-url' })).toThrow('Invalid');
  expect(() => validateNetwork({ ...config, passphrase: Networks.PUBLIC_NETWORK })).toThrow('mismatch');
  expect(() => validateNetwork({ ...config, horizonUrl: 'https://secret:secret@example.org/token?q=private' })).toThrow('credentials');
  expect(safeEndpoint('https://secret:secret@example.org/secret?key=xyz')).toBe('https://example.org');
});
test('blocks callbacks when the intended network is wrong', async () => {
  const tx = buildUnsignedDemo(config);
  const sign = jest.fn();
  const send = jest.fn();
  expect(() => guardedSign(tx, config, Networks.PUBLIC_NETWORK, sign)).toThrow('mismatch');
  expect(sign).not.toHaveBeenCalled();
  await expect(guardedSubmit(tx, config, Networks.PUBLIC_NETWORK, send)).rejects.toThrow('mismatch');
  expect(send).not.toHaveBeenCalled();
  expect(() => assertSameNetwork(Networks.TESTNET, Networks.PUBLIC_NETWORK)).toThrow();
});
test('probes network identity separately from reachability', async () => {
  const f = jest.fn(async () => ({ ok: true, json: async () => ({ network_passphrase: Networks.TESTNET }) })) as unknown as typeof fetch;
  await expect(probeHorizon(config, f)).resolves.toBeUndefined();
  const wrong = jest.fn(async () => ({ ok: true, json: async () => ({ network_passphrase: Networks.PUBLIC_NETWORK }) })) as unknown as typeof fetch;
  await expect(probeHorizon(config, wrong)).rejects.toThrow('mismatch');
  const failed = jest.fn(async () => { throw new Error('secret'); }) as unknown as typeof fetch;
  await expect(probeHorizon(config, failed)).rejects.toThrow('connection or timeout');
});
