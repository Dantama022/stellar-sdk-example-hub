import { Keypair, Networks } from '@stellar/stellar-sdk';

import {
  NETWORK_PRESETS,
  buildDemoPaymentTransaction,
  explainNetworkSignatureBinding,
  inferNetworkFromHorizonUrl,
  inferNetworkFromPassphrase,
  normalizeNetworkName,
  resolveNetworkConfiguration,
  validateNetworkConfiguration,
} from '../src/examples/60-network-configuration';
import { examples } from '../src/runner/catalog';

describe('ISSUE-060: Network Configuration Unit Tests', () => {
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
    delete process.env.STELLAR_NETWORK;
    delete process.env.NETWORK;
    delete process.env.HORIZON_URL;
    delete process.env.SOROBAN_RPC_URL;
    delete process.env.NETWORK_PASSPHRASE;
  });

  it('registers the example in the catalog', () => {
    expect(examples['60-network-configuration']).toBeDefined();
    expect(examples['60-network-configuration'].name).toBe('60-network-configuration');
  });

  it('normalizes common network labels', () => {
    expect(normalizeNetworkName('testnet')).toBe('testnet');
    expect(normalizeNetworkName('TEST')).toBe('testnet');
    expect(normalizeNetworkName('mainnet')).toBe('mainnet');
    expect(normalizeNetworkName('public')).toBe('mainnet');
    expect(normalizeNetworkName('nope')).toBeNull();
  });

  it('infers network from Horizon URLs and passphrases', () => {
    expect(inferNetworkFromHorizonUrl('https://horizon-testnet.stellar.org')).toBe('testnet');
    expect(inferNetworkFromHorizonUrl('https://horizon.stellar.org')).toBe('mainnet');
    expect(inferNetworkFromPassphrase(Networks.TESTNET)).toBe('testnet');
    expect(inferNetworkFromPassphrase(Networks.PUBLIC)).toBe('mainnet');
    expect(inferNetworkFromPassphrase('Private Network')).toBeNull();
  });

  it('resolves Testnet defaults when nothing is configured', () => {
    delete process.env.STELLAR_NETWORK;
    delete process.env.NETWORK;
    delete process.env.HORIZON_URL;
    delete process.env.SOROBAN_RPC_URL;
    delete process.env.NETWORK_PASSPHRASE;
    process.argv = ['node', 'runner.ts', '60-network-configuration'];

    const config = resolveNetworkConfiguration();
    expect(config.network).toBe('testnet');
    expect(config.horizonUrl).toBe(NETWORK_PRESETS.testnet.horizonUrl);
    expect(config.sorobanRpcUrl).toBe(NETWORK_PRESETS.testnet.sorobanRpcUrl);
    expect(config.networkPassphrase).toBe(Networks.TESTNET);
  });

  it('resolves Mainnet from params and environment variables', () => {
    const fromParams = resolveNetworkConfiguration({ network: 'mainnet' });
    expect(fromParams.network).toBe('mainnet');
    expect(fromParams.horizonUrl).toBe(NETWORK_PRESETS.mainnet.horizonUrl);
    expect(fromParams.networkPassphrase).toBe(Networks.PUBLIC);

    process.env.STELLAR_NETWORK = 'mainnet';
    process.argv = ['node', 'runner.ts', '60-network-configuration'];
    const fromEnv = resolveNetworkConfiguration();
    expect(fromEnv.network).toBe('mainnet');
    expect(fromEnv.sorobanRpcUrl).toBe(NETWORK_PRESETS.mainnet.sorobanRpcUrl);
  });

  it('resolves network from CLI argument', () => {
    process.argv = ['node', 'runner.ts', '60-network-configuration', 'mainnet'];
    const config = resolveNetworkConfiguration();
    expect(config.network).toBe('mainnet');
    expect(config.source).toContain('CLI');
  });

  it('detects mismatched Horizon URL and selected network', () => {
    const message = validateNetworkConfiguration({
      network: 'testnet',
      horizonUrl: NETWORK_PRESETS.mainnet.horizonUrl,
      sorobanRpcUrl: NETWORK_PRESETS.testnet.sorobanRpcUrl,
      networkPassphrase: Networks.TESTNET,
    });

    expect(message).toMatch(/Horizon URL looks like mainnet/i);
  });

  it('detects mismatched passphrase and selected network', () => {
    const message = validateNetworkConfiguration({
      network: 'mainnet',
      horizonUrl: NETWORK_PRESETS.mainnet.horizonUrl,
      sorobanRpcUrl: NETWORK_PRESETS.mainnet.sorobanRpcUrl,
      networkPassphrase: Networks.TESTNET,
    });

    expect(message).toMatch(/Network passphrase does not match/i);
  });

  it('detects mismatched Soroban RPC endpoint', () => {
    const message = validateNetworkConfiguration({
      network: 'mainnet',
      horizonUrl: NETWORK_PRESETS.mainnet.horizonUrl,
      sorobanRpcUrl: NETWORK_PRESETS.testnet.sorobanRpcUrl,
      networkPassphrase: Networks.PUBLIC,
    });

    expect(message).toMatch(/Soroban RPC URL looks like Testnet/i);
  });

  it('accepts coherent Testnet and Mainnet configurations', () => {
    expect(
      validateNetworkConfiguration({
        network: 'testnet',
        horizonUrl: NETWORK_PRESETS.testnet.horizonUrl,
        sorobanRpcUrl: NETWORK_PRESETS.testnet.sorobanRpcUrl,
        networkPassphrase: Networks.TESTNET,
      }),
    ).toBeNull();

    expect(
      validateNetworkConfiguration({
        network: 'mainnet',
        horizonUrl: NETWORK_PRESETS.mainnet.horizonUrl,
        sorobanRpcUrl: NETWORK_PRESETS.mainnet.sorobanRpcUrl,
        networkPassphrase: Networks.PUBLIC,
      }),
    ).toBeNull();
  });

  it('builds TransactionBuilder transactions whose hashes differ by passphrase', () => {
    const source = Keypair.random().publicKey();
    const destination = Keypair.random().publicKey();

    const testnetTx = buildDemoPaymentTransaction(Networks.TESTNET, source, destination);
    const mainnetTx = buildDemoPaymentTransaction(Networks.PUBLIC, source, destination);

    const testnetHash = testnetTx.hash().toString('hex');
    const mainnetHash = mainnetTx.hash().toString('hex');

    expect(testnetHash).not.toEqual(mainnetHash);
    expect(testnetTx.networkPassphrase).toBe(Networks.TESTNET);
    expect(mainnetTx.networkPassphrase).toBe(Networks.PUBLIC);

    const explanation = explainNetworkSignatureBinding(testnetHash, mainnetHash);
    expect(explanation).toContain('tx_bad_auth');
    expect(explanation).toContain(testnetHash);
    expect(explanation).toContain(mainnetHash);
  });
});
