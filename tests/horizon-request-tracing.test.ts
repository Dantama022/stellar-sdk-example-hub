import {
  computeLatency,
  describeError,
  extractHttpStatus,
  HorizonRequestTracer,
  median,
  sanitizeDiagnostic,
  summarizeTraces,
  timeoutAfter,
  type RequestTrace,
} from '../src/examples/172-horizon-request-tracing';
import { examples } from '../src/runner/catalog';

const SECRET_SEED = 'SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4';
const PUBLIC_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

function trace(overrides: Partial<RequestTrace> = {}): RequestTrace {
  return {
    resource: 'GET /ledgers',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:00.100Z',
    durationMs: 100,
    httpStatus: 200,
    success: true,
    attempts: 1,
    retried: false,
    slow: false,
    error: null,
    ...overrides,
  };
}

describe('Issue #232 / ISSUE-172: sanitization', () => {
  it('redacts Stellar secret seeds', () => {
    const sanitized = sanitizeDiagnostic(`failed with seed ${SECRET_SEED}`);
    expect(sanitized).not.toContain(SECRET_SEED);
    expect(sanitized).toContain('[REDACTED_SECRET_KEY]');
  });

  it('keeps public keys intact so traces stay useful', () => {
    expect(sanitizeDiagnostic(`account ${PUBLIC_KEY} not found`)).toContain(PUBLIC_KEY);
  });

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc-DEF_123';
    const sanitized = sanitizeDiagnostic(`Authorization: Bearer ${jwt}`);
    expect(sanitized).not.toContain(jwt);
    expect(sanitized).toContain('[REDACTED_JWT]');
  });

  it('redacts sensitive query parameters case-insensitively', () => {
    const sanitized = sanitizeDiagnostic(
      'GET /accounts?token=abc123&API_KEY=xyz789&secret=hunter2&cursor=42',
    );
    expect(sanitized).not.toContain('abc123');
    expect(sanitized).not.toContain('xyz789');
    expect(sanitized).not.toContain('hunter2');
    expect(sanitized).toContain('cursor=42');
  });

  it('leaves ordinary diagnostics unchanged', () => {
    expect(sanitizeDiagnostic('GET /ledgers?limit=1')).toBe('GET /ledgers?limit=1');
  });
});

describe('Issue #232 / ISSUE-172: error inspection', () => {
  it('extracts an HTTP status from Horizon error shapes', () => {
    expect(extractHttpStatus({ response: { status: 404 } })).toBe(404);
    expect(extractHttpStatus({ status: 429 })).toBe(429);
    expect(extractHttpStatus(new Error('network down'))).toBeNull();
    expect(extractHttpStatus(null)).toBeNull();
  });

  it('describes and sanitizes thrown values', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError(new Error(`leaked ${SECRET_SEED}`))).toContain('[REDACTED_SECRET_KEY]');
  });
});

describe('Issue #232 / ISSUE-172: latency aggregation', () => {
  it('computes the median for odd and even sets', () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 30, 20])).toBe(25);
    expect(median([])).toBe(0);
  });

  it('aggregates min, max, average, and median latency', () => {
    const stats = computeLatency([
      trace({ durationMs: 100 }),
      trace({ durationMs: 300 }),
      trace({ durationMs: 200 }),
    ]);
    expect(stats).toEqual({ count: 3, minMs: 100, maxMs: 300, averageMs: 200, medianMs: 200 });
  });

  it('includes failed requests in latency statistics', () => {
    const stats = computeLatency([
      trace({ durationMs: 50 }),
      trace({ durationMs: 5000, success: false }),
    ]);
    expect(stats.count).toBe(2);
    expect(stats.maxMs).toBe(5000);
  });

  it('returns zeroed statistics with no traces', () => {
    expect(computeLatency([])).toEqual({
      count: 0,
      minMs: 0,
      maxMs: 0,
      averageMs: 0,
      medianMs: 0,
    });
  });
});

describe('Issue #232 / ISSUE-172: diagnostic summary', () => {
  it('counts successes, failures, retries, attempts, and slow requests', () => {
    const summary = summarizeTraces(
      [
        trace(),
        trace({ success: false, httpStatus: 404, error: 'not found', attempts: 2, retried: true }),
        trace({ durationMs: 2500, slow: true }),
      ],
      { horizonUrl: 'https://horizon-testnet.stellar.org', slowThresholdMs: 1000, timeoutMs: 5000 },
    );
    expect(summary.totalRequests).toBe(3);
    expect(summary.successfulRequests).toBe(2);
    expect(summary.failedRequests).toBe(1);
    expect(summary.retriedRequests).toBe(1);
    expect(summary.totalAttempts).toBe(4);
    expect(summary.slowRequests).toBe(1);
  });

  it('produces structured JSON metrics', () => {
    const parsed = JSON.parse(
      JSON.stringify(
        summarizeTraces([trace()], {
          horizonUrl: 'https://horizon-testnet.stellar.org',
          slowThresholdMs: 1000,
          timeoutMs: 5000,
        }),
      ),
    );
    expect(parsed.latency.count).toBe(1);
    expect(parsed.traces[0].resource).toBe('GET /ledgers');
  });
});

describe('Issue #232 / ISSUE-172: tracer', () => {
  it('traces a successful request with timing and status', async () => {
    const tracer = new HorizonRequestTracer();
    const result = await tracer.trace('GET /ledgers', async () => ({ records: [1] }));

    expect(result).toEqual({ records: [1] });
    const traces = tracer.getTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0].success).toBe(true);
    expect(traces[0].httpStatus).toBe(200);
    expect(traces[0].attempts).toBe(1);
    expect(traces[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(traces[0].completedAt)).toBeGreaterThanOrEqual(
      Date.parse(traces[0].startedAt),
    );
  });

  it('traces an HTTP error and preserves its status', async () => {
    const tracer = new HorizonRequestTracer({ maxAttempts: 1 });
    const result = await tracer.trace('GET /accounts/x', async () => {
      throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
    });

    expect(result).toBeNull();
    const [recorded] = tracer.getTraces();
    expect(recorded.success).toBe(false);
    expect(recorded.httpStatus).toBe(404);
    expect(recorded.error).toBe('Not Found');
  });

  it('traces a network error with no HTTP status', async () => {
    const tracer = new HorizonRequestTracer({ maxAttempts: 1 });
    await tracer.trace('GET /ledgers', async () => {
      throw new Error('getaddrinfo ENOTFOUND horizon.invalid');
    });

    const [recorded] = tracer.getTraces();
    expect(recorded.httpStatus).toBeNull();
    expect(recorded.error).toMatch(/ENOTFOUND/);
  });

  it('retries a failing request and records the attempt count', async () => {
    const tracer = new HorizonRequestTracer({ maxAttempts: 3, retryBackoffMs: 1 });
    let calls = 0;
    const result = await tracer.trace('GET /ledgers', async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    });

    expect(result).toBe('ok');
    const [recorded] = tracer.getTraces();
    expect(recorded.attempts).toBe(3);
    expect(recorded.retried).toBe(true);
    expect(recorded.success).toBe(true);
  });

  it('records a single trace covering all exhausted attempts', async () => {
    const tracer = new HorizonRequestTracer({ maxAttempts: 2, retryBackoffMs: 1 });
    await tracer.trace('GET /ledgers', async () => {
      throw new Error('always fails');
    });

    const traces = tracer.getTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0].attempts).toBe(2);
    expect(traces[0].success).toBe(false);
  });

  it('times out a hanging request instead of waiting forever', async () => {
    const tracer = new HorizonRequestTracer({ timeoutMs: 20, maxAttempts: 1 });
    const result = await tracer.trace(
      'GET /ledgers',
      () => new Promise(() => undefined) as Promise<unknown>,
    );

    expect(result).toBeNull();
    const [recorded] = tracer.getTraces();
    expect(recorded.success).toBe(false);
    expect(recorded.error).toMatch(/timed out after 20ms/);
  });

  it('flags requests at or above the slow threshold', async () => {
    const tracer = new HorizonRequestTracer({ slowRequestMs: 0 });
    await tracer.trace('GET /ledgers', async () => 'fast');
    expect(tracer.getTraces()[0].slow).toBe(true);
  });

  it('sanitizes the resource label', async () => {
    const tracer = new HorizonRequestTracer();
    await tracer.trace('GET /accounts?token=supersecret', async () => 'ok');
    expect(tracer.getTraces()[0].resource).not.toContain('supersecret');
  });

  it('summarizes everything traced so far', async () => {
    const tracer = new HorizonRequestTracer({ maxAttempts: 1, timeoutMs: 500 });
    await tracer.trace('GET /ledgers', async () => 'ok');
    await tracer.trace('GET /fee_stats', async () => {
      throw new Error('boom');
    });

    const summary = tracer.summarize('https://horizon-testnet.stellar.org');
    expect(summary.totalRequests).toBe(2);
    expect(summary.successfulRequests).toBe(1);
    expect(summary.failedRequests).toBe(1);
    expect(summary.timeoutMs).toBe(500);
    expect(summary.latency.count).toBe(2);
  });

  it('returns a defensive copy of its traces', async () => {
    const tracer = new HorizonRequestTracer();
    await tracer.trace('GET /ledgers', async () => 'ok');
    tracer.getTraces().push(trace());
    expect(tracer.getTraces()).toHaveLength(1);
  });

  it('rejects after the configured timeout', async () => {
    await expect(timeoutAfter(5, 'GET /ledgers')).rejects.toThrow(/timed out after 5ms/);
  });
});

describe('Issue #232 / ISSUE-172: runner registration', () => {
  it('registers the example with timeout, threshold, and verbose parameters', () => {
    const entry = examples['172-horizon-request-tracing'];
    expect(entry).toBeDefined();
    expect(typeof entry.run).toBe('function');
    expect(entry.params?.map((param) => param.name)).toEqual([
      'timeoutMs',
      'slowRequestMs',
      'verbose',
    ]);
  });
});
