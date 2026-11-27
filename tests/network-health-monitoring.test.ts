/**
 * tests/network-health-monitoring.test.ts
 *
 * Unit tests for the read-only Stellar network health monitoring example.
 */

import {
  NETWORK_HEALTH_PRESETS,
  NetworkHealthConfigError,
  checkHorizonHealth,
  checkSorobanRpcHealth,
  monitorNetworkHealth,
  normalizeNetworkHealthConfig,
  runNetworkHealthCheck,
  sanitizeEndpointUrl,
} from '../src/utils/network-health';
import {
  parseNetworkHealthArgs,
  resolveNetworkHealthConfig,
  run,
} from '../src/examples/319-network-health-monitoring';

function jsonResponse(
  body: unknown,
  options: { ok?: boolean; status?: number; statusText?: string; jsonThrows?: boolean } = {},
): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    json: async () => {
      if (options.jsonThrows) throw new Error('bad json');
      return body;
    },
  } as unknown as Response;
}

function asFetch(mock: jest.Mock): typeof fetch {
  return mock as unknown as typeof fetch;
}

const HORIZON_BODY = {
  network_passphrase: 'Test SDF Network ; September 2015',
  current_protocol_version: 22,
  horizon_version: '2.39.0',
  core_version: 'stellar-core 22.0.0',
};

function healthyRpcBody(status = 'healthy') {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      status,
      latestLedger: 1234,
      oldestLedger: 1000,
    },
  };
}

function sequentialNow(values: number[]) {
  return (): number => {
    if (values.length === 0) return 0;
    return values.shift() as number;
  };
}

describe('network health monitoring', () => {
  describe('configuration', () => {
    it('validates and normalizes configured URLs', () => {
      const config = normalizeNetworkHealthConfig({
        horizonUrl: 'https://horizon-testnet.stellar.org/',
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org/',
      });

      expect(config.horizonUrl).toBe('https://horizon-testnet.stellar.org');
      expect(config.sorobanRpcUrl).toBe('https://soroban-testnet.stellar.org');
      expect(config.timeoutMs).toBe(5000);
      expect(config.checks).toBe(1);
    });

    it('rejects invalid URLs', () => {
      expect(() => normalizeNetworkHealthConfig({ horizonUrl: 'not-a-url' })).toThrow(
        NetworkHealthConfigError,
      );
      expect(() => normalizeNetworkHealthConfig({ sorobanRpcUrl: 'ftp://example.com' })).toThrow(
        NetworkHealthConfigError,
      );
    });

    it('requires at least one configured endpoint', () => {
      expect(() => normalizeNetworkHealthConfig({})).toThrow(NetworkHealthConfigError);
    });

    it('sanitizes credentials and query parameters', () => {
      expect(sanitizeEndpointUrl('https://user:secret@example.com/path?token=abc#fragment')).toBe(
        'https://example.com/path',
      );
    });

    it('keeps testnet and mainnet presets separate', () => {
      expect(NETWORK_HEALTH_PRESETS.testnet.horizonUrl).toContain('testnet');
      expect(NETWORK_HEALTH_PRESETS.testnet.sorobanRpcUrl).toContain('testnet');
      expect(NETWORK_HEALTH_PRESETS.mainnet.horizonUrl).toBe('https://horizon.stellar.org');
      expect(NETWORK_HEALTH_PRESETS.mainnet.sorobanRpcUrl).toBe(
        'https://soroban-mainnet.stellar.org',
      );
    });
  });

  describe('Horizon checks', () => {
    it('reports a healthy Horizon endpoint with valid metadata', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(HORIZON_BODY));
      const result = await checkHorizonHealth('https://horizon-testnet.stellar.org', {
        fetchImpl: asFetch(fetchImpl),
        now: sequentialNow([1000, 1000, 1048]),
        degradedThresholdMs: 1500,
      });

      expect(result.status).toBe('healthy');
      expect(result.responseTimeMs).toBe(48);
      expect(result.failureKind).toBeNull();
      expect(result.details.networkPassphrase).toContain('Test SDF Network');
      expect(result.details.horizonVersion).toBe('2.39.0');
      expect(result.details.protocolVersion).toBe(22);
      expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET' });
    });

    it('reports transport failures without throwing', async () => {
      const fetchImpl = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
      const result = await checkHorizonHealth('https://horizon-testnet.stellar.org', {
        fetchImpl: asFetch(fetchImpl),
      });

      expect(result.status).toBe('unhealthy');
      expect(result.failureKind).toBe('transport');
      expect(result.diagnostic).toContain('ECONNREFUSED');
    });

    it('reports HTTP failures with the status code', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(
          jsonResponse({}, { ok: false, status: 503, statusText: 'Service Unavailable' }),
        );
      const result = await checkHorizonHealth('https://horizon-testnet.stellar.org', {
        fetchImpl: asFetch(fetchImpl),
      });

      expect(result.status).toBe('unhealthy');
      expect(result.failureKind).toBe('http');
      expect(result.diagnostic).toContain('503');
    });

    it('reports malformed JSON responses', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}, { jsonThrows: true }));
      const result = await checkHorizonHealth('https://horizon-testnet.stellar.org', {
        fetchImpl: asFetch(fetchImpl),
      });

      expect(result.status).toBe('unhealthy');
      expect(result.failureKind).toBe('malformed-response');
    });

    it('reports malformed Horizon response shapes', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ unexpected: true }));
      const result = await checkHorizonHealth('https://horizon-testnet.stellar.org', {
        fetchImpl: asFetch(fetchImpl),
      });

      expect(result.status).toBe('unhealthy');
      expect(result.failureKind).toBe('malformed-response');
      expect(result.diagnostic).toContain('expected root metadata shape');
    });

    it('reports timeouts as unhealthy', async () => {
      const fetchImpl = jest.fn().mockReturnValue(new Promise<Response>(() => undefined));
      const result = await checkHorizonHealth('https://horizon-testnet.stellar.org', {
        fetchImpl: asFetch(fetchImpl),
        timeoutMs: 10,
      });

      expect(result.status).toBe('unhealthy');
      expect(result.failureKind).toBe('timeout');
      expect(result.responseTimeMs).toBeNull();
    });

    it('classifies slow valid responses as degraded', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(HORIZON_BODY));
      const result = await checkHorizonHealth('https://horizon-testnet.stellar.org', {
        fetchImpl: asFetch(fetchImpl),
        now: sequentialNow([1000, 1000, 3000]),
        degradedThresholdMs: 1500,
      });

      expect(result.status).toBe('degraded');
      expect(result.diagnostic).toContain('above');
    });
  });

  describe('Soroban RPC checks', () => {
    it('reports a healthy getHealth response and uses a read-only POST', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(healthyRpcBody()));
      const result = await checkSorobanRpcHealth('https://soroban-testnet.stellar.org', {
        fetchImpl: asFetch(fetchImpl),
      });

      expect(result.status).toBe('healthy');
      expect(result.details.rpcStatus).toBe('healthy');
      expect(result.details.latestLedger).toBe(1234);
      expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST' });
      const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(body.method).toBe('getHealth');
      expect(body.params).toEqual({});
    });

    it('distinguishes RPC-level errors from transport failures', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32601, message: 'Method not found' },
        }),
      );
      const result = await checkSorobanRpcHealth('https://soroban-testnet.stellar.org', {
        fetchImpl: asFetch(fetchImpl),
      });

      expect(result.status).toBe('unhealthy');
      expect(result.failureKind).toBe('rpc-error');
      expect(result.diagnostic).toContain('-32601');
    });

    it('rejects malformed RPC result shapes', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ result: {} }));
      const result = await checkSorobanRpcHealth('https://soroban-testnet.stellar.org', {
        fetchImpl: asFetch(fetchImpl),
      });

      expect(result.status).toBe('unhealthy');
      expect(result.failureKind).toBe('malformed-response');
    });

    it('classifies a non-healthy RPC status as degraded', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(healthyRpcBody('starting')));
      const result = await checkSorobanRpcHealth('https://soroban-testnet.stellar.org', {
        fetchImpl: asFetch(fetchImpl),
      });

      expect(result.status).toBe('degraded');
      expect(result.diagnostic).toContain('starting');
    });

    it('reports RPC transport failures separately', async () => {
      const fetchImpl = jest.fn().mockRejectedValue(new Error('socket hang up'));
      const result = await checkSorobanRpcHealth('https://soroban-testnet.stellar.org', {
        fetchImpl: asFetch(fetchImpl),
      });

      expect(result.status).toBe('unhealthy');
      expect(result.failureKind).toBe('transport');
    });
  });

  describe('combined reports', () => {
    it('checks both endpoints and returns healthy when both succeed', async () => {
      const fetchImpl = jest.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return jsonResponse(healthyRpcBody());
        return jsonResponse(HORIZON_BODY);
      });
      const report = await runNetworkHealthCheck(
        {
          horizonUrl: 'https://horizon-testnet.stellar.org',
          sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
        },
        { fetchImpl: asFetch(fetchImpl) },
      );

      expect(report.status).toBe('healthy');
      expect(report.endpoints).toHaveLength(2);
      expect(report.summary).toEqual({ total: 2, healthy: 2, degraded: 0, unhealthy: 0 });
      expect(report.warnings).toContain(
        'Endpoint availability does not prove ledger finality, transaction success, or complete Stellar network health.',
      );
    });

    it('does not let one endpoint failure prevent the other check', async () => {
      const fetchImpl = jest.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return jsonResponse(healthyRpcBody());
        throw new Error('horizon down');
      });
      const report = await runNetworkHealthCheck(
        {
          horizonUrl: 'https://horizon-testnet.stellar.org',
          sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
        },
        { fetchImpl: asFetch(fetchImpl) },
      );

      expect(report.endpoints).toHaveLength(2);
      expect(report.endpoints.find((endpoint) => endpoint.kind === 'horizon')?.status).toBe(
        'unhealthy',
      );
      expect(report.endpoints.find((endpoint) => endpoint.kind === 'soroban-rpc')?.status).toBe(
        'healthy',
      );
      expect(report.status).toBe('degraded');
    });

    it('reports unhealthy overall when every configured endpoint fails', async () => {
      const fetchImpl = jest.fn().mockRejectedValue(new Error('offline'));
      const report = await runNetworkHealthCheck(
        {
          horizonUrl: 'https://horizon-testnet.stellar.org',
          sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
        },
        { fetchImpl: asFetch(fetchImpl) },
      );

      expect(report.status).toBe('unhealthy');
      expect(report.summary.unhealthy).toBe(2);
    });

    it('warns when only one endpoint is configured', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(HORIZON_BODY));
      const report = await runNetworkHealthCheck(
        { horizonUrl: 'https://horizon-testnet.stellar.org' },
        { fetchImpl: asFetch(fetchImpl) },
      );

      expect(report.warnings.some((warning) => warning.includes('Only one endpoint'))).toBe(true);
    });

    it('does not expose credentials in report endpoints', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(HORIZON_BODY));
      const report = await runNetworkHealthCheck(
        { horizonUrl: 'https://user:secret@horizon-testnet.stellar.org?token=abc' },
        { fetchImpl: asFetch(fetchImpl) },
      );

      const endpoint = report.endpoints[0].endpoint;
      expect(endpoint).not.toContain('user');
      expect(endpoint).not.toContain('secret');
      expect(endpoint).not.toContain('token');
    });
  });

  describe('repeated monitoring', () => {
    it('runs the configured number of checks sequentially', async () => {
      let active = 0;
      let maxActive = 0;
      const fetchImpl = jest.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return jsonResponse(HORIZON_BODY);
      });
      const sleep = jest.fn().mockResolvedValue(undefined);
      const reports = await monitorNetworkHealth(
        {
          horizonUrl: 'https://horizon-testnet.stellar.org',
          checks: 3,
          intervalMs: 100,
        },
        { fetchImpl: asFetch(fetchImpl), sleep },
      );

      expect(reports).toHaveLength(3);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(maxActive).toBe(1);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('stops when the abort signal is already set', async () => {
      const controller = new AbortController();
      controller.abort();
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(HORIZON_BODY));
      const reports = await monitorNetworkHealth(
        { horizonUrl: 'https://horizon-testnet.stellar.org', checks: 3 },
        { fetchImpl: asFetch(fetchImpl), signal: controller.signal },
      );

      expect(reports).toHaveLength(0);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('CLI and output', () => {
    it('parses CLI flags', () => {
      expect(
        parseNetworkHealthArgs([
          '--network',
          'mainnet',
          '--horizon-url',
          'https://horizon.stellar.org',
          '--soroban-rpc-url=https://soroban-mainnet.stellar.org',
          '--timeout',
          '2500',
          '--degraded-threshold',
          '800',
          '--checks',
          '2',
          '--interval',
          '50',
          '--json',
        ]),
      ).toEqual({
        network: 'mainnet',
        horizonUrl: 'https://horizon.stellar.org',
        sorobanRpcUrl: 'https://soroban-mainnet.stellar.org',
        timeoutMs: 2500,
        degradedThresholdMs: 800,
        checks: 2,
        intervalMs: 50,
        json: true,
      });
    });

    it('rejects invalid CLI flags', () => {
      expect(() => parseNetworkHealthArgs(['--network', 'devnet'])).toThrow(/testnet/);
      expect(() => parseNetworkHealthArgs(['--timeout', '0'])).toThrow(/positive/);
      expect(() => parseNetworkHealthArgs(['--checks', '1.5'])).toThrow(/integer/);
    });

    it('resolves presets and explicit overrides', () => {
      const originalHorizon = process.env.HORIZON_URL;
      const originalRpc = process.env.SOROBAN_RPC_URL;
      delete process.env.HORIZON_URL;
      delete process.env.SOROBAN_RPC_URL;
      try {
        const config = resolveNetworkHealthConfig({
          network: 'mainnet',
          horizonUrl: 'http://localhost:8000',
        });

        expect(config.horizonUrl).toBe('http://localhost:8000');
        expect(config.sorobanRpcUrl).toBe(NETWORK_HEALTH_PRESETS.mainnet.sorobanRpcUrl);
      } finally {
        if (originalHorizon === undefined) delete process.env.HORIZON_URL;
        else process.env.HORIZON_URL = originalHorizon;
        if (originalRpc === undefined) delete process.env.SOROBAN_RPC_URL;
        else process.env.SOROBAN_RPC_URL = originalRpc;
      }
    });

    it('prints human-readable output', async () => {
      const originalFetch = global.fetch;
      global.fetch = asFetch(
        jest.fn(async (_url: string, init?: RequestInit) => {
          if (init?.method === 'POST') return jsonResponse(healthyRpcBody());
          return jsonResponse(HORIZON_BODY);
        }) as unknown as jest.Mock,
      );
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message: string) => logs.push(message);
      try {
        await run({ network: 'testnet', checks: 1 });
      } finally {
        console.log = originalLog;
        global.fetch = originalFetch;
      }

      const output = logs.join('\n');
      expect(output).toContain('Network Health Check');
      expect(output).toContain('Horizon');
      expect(output).toContain('Soroban RPC');
      expect(output).toContain('Overall:');
    });

    it('prints JSON with sanitized endpoints', async () => {
      const originalFetch = global.fetch;
      global.fetch = asFetch(
        jest.fn(async (_url: string, init?: RequestInit) => {
          if (init?.method === 'POST') return jsonResponse(healthyRpcBody());
          return jsonResponse(HORIZON_BODY);
        }) as unknown as jest.Mock,
      );
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message: string) => logs.push(message);
      try {
        await run({
          network: 'testnet',
          horizonUrl: 'https://user:secret@horizon-testnet.stellar.org?token=abc',
          sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
          json: true,
          checks: 1,
        });
      } finally {
        console.log = originalLog;
        global.fetch = originalFetch;
      }

      const parsed = JSON.parse(logs.join(''));
      expect(parsed.status).toBe('healthy');
      expect(parsed.endpoints).toHaveLength(2);
      expect(JSON.stringify(parsed)).not.toContain('secret');
      expect(JSON.stringify(parsed)).not.toContain('token=abc');
    });
  });
});
