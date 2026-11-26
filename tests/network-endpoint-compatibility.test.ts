import { Networks } from '@stellar/stellar-sdk';
import {
  checkHorizonEndpoint,
  checkSorobanRpcEndpoint,
  formatNetworkCompatibilityReport,
  HttpFetcher,
  redactSecretsInText,
  redactUrlCredentials,
  runNetworkCompatibilityCheck,
  validateNetworkConfig,
} from '../src/examples/263-network-endpoint-compatibility';
import { examples } from '../src/runner/catalog';

describe('263-network-endpoint-compatibility', () => {
  it('validates a healthy testnet configuration and verifies Horizon and Soroban RPC', async () => {
    const fetcher: HttpFetcher = async (url) => {
      if (url.includes('horizon-testnet')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              network_passphrase: Networks.TESTNET,
              horizon_version: '2.30.0',
              core_version: 'v21.0.0',
              history_latest_ledger: 123456,
            };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            jsonrpc: '2.0',
            id: 1,
            result: {
              passphrase: Networks.TESTNET,
              protocolVersion: 21,
            },
          };
        },
      };
    };

    const report = await runNetworkCompatibilityCheck(
      {
        networkName: 'testnet',
        expectedPassphrase: Networks.TESTNET,
        horizonUrl: 'https://horizon-testnet.stellar.org',
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
        timeoutMs: 3000,
      },
      fetcher,
    );

    expect(report.validation.valid).toBe(true);
    expect(report.overallStatus).toBe('compatible');
    expect(report.horizon?.status).toBe('ok');
    expect(report.sorobanRpc?.status).toBe('ok');
    expect(report.findings.filter((f) => f.kind === 'verified_match')).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(report)).overallStatus).toBe('compatible');
  });

  it('rejects missing fields, invalid URLs, unsupported schemes, and conflicting settings', () => {
    const missing = validateNetworkConfig({
      networkName: '',
      expectedPassphrase: '',
    });
    expect(missing.valid).toBe(false);
    expect(missing.issues.some((i) => i.field === 'networkName')).toBe(true);
    expect(missing.issues.some((i) => i.field === 'expectedPassphrase')).toBe(true);
    expect(missing.issues.some((i) => i.field === 'endpoints')).toBe(true);

    const invalidScheme = validateNetworkConfig({
      networkName: 'testnet',
      expectedPassphrase: Networks.TESTNET,
      horizonUrl: 'ftp://horizon-testnet.stellar.org',
      sorobanRpcUrl: 'not-a-url',
    });
    expect(invalidScheme.valid).toBe(false);
    expect(invalidScheme.issues.some((i) => i.message.includes('unsupported URL scheme'))).toBe(true);
    expect(invalidScheme.issues.some((i) => i.field === 'sorobanRpcUrl')).toBe(true);

    const prodInTest = validateNetworkConfig({
      networkName: 'testnet',
      expectedPassphrase: Networks.TESTNET,
      horizonUrl: 'https://horizon.stellar.org',
    });
    expect(prodInTest.valid).toBe(false);
    expect(prodInTest.issues.some((i) => i.message.includes('Production Horizon endpoint'))).toBe(true);
  });

  it('handles connection failures, timeouts, and unsupported RPC methods', async () => {
    const timeoutFetcher: HttpFetcher = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };
    const horizonTimeout = await checkHorizonEndpoint('https://horizon-testnet.stellar.org', 100, timeoutFetcher);
    expect(horizonTimeout.reachable).toBe(false);
    expect(horizonTimeout.status).toBe('timeout');

    const unsupportedRpcFetcher: HttpFetcher = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32601, message: 'Method not found' },
        };
      },
    });
    const rpcResult = await checkSorobanRpcEndpoint('https://soroban-testnet.stellar.org', 100, unsupportedRpcFetcher);
    expect(rpcResult.reachable).toBe(true);
    expect(rpcResult.status).toBe('unsupported_method');
  });

  it('detects confirmed network mismatches and insufficient metadata separately', async () => {
    const mismatchFetcher: HttpFetcher = async (url) => {
      if (url.includes('horizon')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { network_passphrase: Networks.PUBLIC };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { jsonrpc: '2.0', id: 1, result: {} };
        },
      };
    };

    const report = await runNetworkCompatibilityCheck(
      {
        networkName: 'custom-env',
        expectedPassphrase: Networks.TESTNET,
        horizonUrl: 'https://custom-horizon.example.com',
        sorobanRpcUrl: 'https://custom-rpc.example.com',
      },
      mismatchFetcher,
    );

    expect(report.overallStatus).toBe('mismatch_detected');
    expect(report.findings.some((f) => f.kind === 'confirmed_mismatch' && f.service === 'horizon')).toBe(true);
    expect(report.findings.some((f) => f.kind === 'insufficient_information' && f.service === 'soroban_rpc')).toBe(
      true,
    );
    expect(formatNetworkCompatibilityReport(report)).toContain('Uncompleted Checks:');
  });

  it('redacts embedded URL credentials and query secrets in reports and error messages', async () => {
    const secretUrl = 'https://alice:supersecret@rpc.example.com/soroban?api_key=mysecretkey';
    expect(redactUrlCredentials(secretUrl)).toBe('https://***:***@rpc.example.com/soroban?api_key=***');
    expect(redactSecretsInText(`Failed to reach ${secretUrl}`)).not.toContain('supersecret');
    expect(redactSecretsInText(`Failed to reach ${secretUrl}`)).not.toContain('mysecretkey');

    const failingFetcher: HttpFetcher = async () => {
      throw new Error(`connect ECONNREFUSED https://alice:supersecret@rpc.example.com?token=tok123`);
    };
    const report = await runNetworkCompatibilityCheck(
      {
        networkName: 'testnet',
        expectedPassphrase: Networks.TESTNET,
        sorobanRpcUrl: secretUrl,
      },
      failingFetcher,
    );

    const text = formatNetworkCompatibilityReport(report);
    const jsonText = JSON.stringify(report);
    expect(text).not.toContain('supersecret');
    expect(text).not.toContain('mysecretkey');
    expect(jsonText).not.toContain('supersecret');
    expect(jsonText).not.toContain('tok123');
  });

  it('is registered in the example catalog', () => {
    expect(examples['263-network-endpoint-compatibility']).toBeDefined();
  });
});
