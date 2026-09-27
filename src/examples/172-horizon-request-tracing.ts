/**
 * 172-horizon-request-tracing: Horizon Request Tracing and Diagnostics
 *
 * OVERVIEW
 * --------
 * A single application workflow can issue a dozen Horizon requests. When one of
 * them fails or turns slow, the useful questions are always the same: which
 * resource was called, how long did it take, what came back, and was it retried?
 *
 * This example wraps Horizon calls in a small tracing layer that answers those
 * questions without changing how the calls themselves are written.
 *
 * WHAT IS TRACED
 * --------------
 * Each traced call records start time, end time, duration, the resource label,
 * an HTTP status where one is available, success or failure, the attempt count,
 * and a sanitized error message. From those records the tracer derives request
 * counts, failure counts, and min/max/average/median latency.
 *
 * TIMEOUTS AND RETRIES
 * --------------------
 * Horizon calls are raced against a configurable timeout so a hung connection
 * cannot stall the workflow indefinitely. Note that the timeout abandons the
 * *wait*, not the underlying HTTP request — the SDK does not expose a cancel
 * signal here, so the socket closes on its own. Failed attempts are retried up
 * to a configurable count with a fixed backoff, and every attempt is counted so
 * a request that only succeeded on its third try is visible as such.
 *
 * MEDIAN VS AVERAGE
 * -------------------
 * Both are reported because they fail differently. One very slow request drags
 * the average far above what a typical call costs, while the median stays
 * representative; comparing the two is often the fastest way to spot a single
 * outlier hiding in an otherwise healthy set.
 *
 * SANITIZATION
 * ------------
 * Diagnostic output is scrubbed before logging. Stellar secret seeds (`S…`),
 * JWTs, and common `token`/`secret`/`authorization`/`api_key` query parameters
 * are redacted, so a trace can be pasted into a bug report. Sanitization is a
 * safety net, not a licence to feed credentials through the tracer.
 *
 * This example is read-only and submits nothing to the network.
 */

import { Horizon, Keypair } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SLOW_REQUEST_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 250;
const UNREACHABLE_HORIZON_URL = 'https://horizon-testnet.stellar.invalid';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface RequestTrace {
  resource: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  httpStatus: number | null;
  success: boolean;
  attempts: number;
  retried: boolean;
  slow: boolean;
  error: string | null;
}

export interface LatencyStatistics {
  count: number;
  minMs: number;
  maxMs: number;
  averageMs: number;
  medianMs: number;
}

export interface DiagnosticSummary {
  horizonUrl: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  retriedRequests: number;
  totalAttempts: number;
  slowRequests: number;
  slowThresholdMs: number;
  timeoutMs: number;
  latency: LatencyStatistics;
  traces: RequestTrace[];
}

export interface TracerOptions {
  timeoutMs?: number;
  slowRequestMs?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
  verbose?: boolean;
}

export interface RunParams {
  timeoutMs?: string | number;
  slowRequestMs?: string | number;
  verbose?: boolean | string;
  json?: boolean | string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sanitization
// ──────────────────────────────────────────────────────────────────────────────

const SECRET_SEED_PATTERN = /\bS[A-Z2-7]{55}\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const SENSITIVE_QUERY_PATTERN = /\b(token|secret|password|api[_-]?key|authorization)=([^&\s"']+)/gi;

/**
 * Redacts credentials that can appear in Horizon error text or request URLs.
 *
 * Public keys (`G…`) are deliberately left intact: they are public ledger
 * identifiers and removing them would make traces useless for debugging.
 */
export function sanitizeDiagnostic(value: string): string {
  return value
    .replace(SECRET_SEED_PATTERN, '[REDACTED_SECRET_KEY]')
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(SENSITIVE_QUERY_PATTERN, (_match, key: string) => `${key}=[REDACTED]`);
}

/**
 * Extracts an HTTP status from a Horizon SDK error.
 *
 * The SDK surfaces the status in different places depending on whether the
 * failure came from Horizon itself (`response.status`) or from the underlying
 * transport, so several shapes are probed before giving up.
 */
export function extractHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as {
    response?: { status?: number };
    status?: number;
  };
  return candidate.response?.status ?? candidate.status ?? null;
}

/** Pulls a readable message out of an unknown thrown value, then sanitizes it. */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeDiagnostic(raw);
}

// ──────────────────────────────────────────────────────────────────────────────
// Latency statistics
// ──────────────────────────────────────────────────────────────────────────────

/** Median of a numeric list; even-length lists average the two middle values. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Aggregates latency across traces.
 *
 * Failed requests are included: a request that took four seconds to time out is
 * exactly the kind of latency worth reporting, and excluding it would make a
 * failing endpoint look faster than a working one.
 */
export function computeLatency(traces: RequestTrace[]): LatencyStatistics {
  const durations = traces.map((trace) => trace.durationMs);
  if (durations.length === 0) {
    return { count: 0, minMs: 0, maxMs: 0, averageMs: 0, medianMs: 0 };
  }

  return {
    count: durations.length,
    minMs: Math.min(...durations),
    maxMs: Math.max(...durations),
    averageMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
    medianMs: median(durations),
  };
}

/** Builds the aggregate diagnostic summary from a trace set. */
export function summarizeTraces(
  traces: RequestTrace[],
  options: { horizonUrl: string; slowThresholdMs: number; timeoutMs: number },
): DiagnosticSummary {
  return {
    horizonUrl: options.horizonUrl,
    totalRequests: traces.length,
    successfulRequests: traces.filter((trace) => trace.success).length,
    failedRequests: traces.filter((trace) => !trace.success).length,
    retriedRequests: traces.filter((trace) => trace.retried).length,
    totalAttempts: traces.reduce((sum, trace) => sum + trace.attempts, 0),
    slowRequests: traces.filter((trace) => trace.slow).length,
    slowThresholdMs: options.slowThresholdMs,
    timeoutMs: options.timeoutMs,
    latency: computeLatency(traces),
    traces,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tracer
// ──────────────────────────────────────────────────────────────────────────────

/** Rejects after `ms`, used to bound how long a Horizon call is awaited. */
export function timeoutAfter(ms: number, resource: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Request to ${resource} timed out after ${ms}ms`)),
      ms,
    );
    // Do not hold the event loop open on account of a pending timeout.
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Records timing and outcome for each traced Horizon call.
 *
 * The tracer is deliberately transport-agnostic: it wraps any promise-returning
 * thunk rather than patching the SDK's HTTP client, so the same wrapper works
 * for Horizon builders, raw fetches, or a mock in a test.
 */
export class HorizonRequestTracer {
  private readonly traces: RequestTrace[] = [];
  private readonly timeoutMs: number;
  private readonly slowRequestMs: number;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number;
  private readonly verbose: boolean;

  constructor(options: TracerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.slowRequestMs = options.slowRequestMs ?? DEFAULT_SLOW_REQUEST_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.retryBackoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS;
    this.verbose = options.verbose ?? false;
  }

  /** All traces recorded so far, in call order. */
  getTraces(): RequestTrace[] {
    return [...this.traces];
  }

  /**
   * Executes `operation`, recording one trace covering all of its attempts.
   *
   * Resolves with the operation's value on success and with `null` on final
   * failure: a diagnostic wrapper that threw would defeat its own purpose by
   * aborting the workflow it is meant to be observing.
   */
  async trace<T>(resource: string, operation: () => Promise<T>): Promise<T | null> {
    const startedAt = new Date();
    const start = Date.now();
    let attempts = 0;
    let lastError: unknown = null;

    while (attempts < this.maxAttempts) {
      attempts += 1;
      try {
        const result = await Promise.race([operation(), timeoutAfter(this.timeoutMs, resource)]);
        this.record(resource, startedAt, start, attempts, null, true);
        return result as T;
      } catch (error: unknown) {
        lastError = error;
        if (attempts < this.maxAttempts) {
          if (this.verbose) {
            console.log(
              `  retrying ${resource} after attempt ${attempts}: ${describeError(error)}`,
            );
          }
          await delay(this.retryBackoffMs);
        }
      }
    }

    this.record(resource, startedAt, start, attempts, lastError, false);
    return null;
  }

  private record(
    resource: string,
    startedAt: Date,
    start: number,
    attempts: number,
    error: unknown,
    success: boolean,
  ): void {
    const durationMs = Date.now() - start;
    const trace: RequestTrace = {
      resource: sanitizeDiagnostic(resource),
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs,
      httpStatus: success ? 200 : extractHttpStatus(error),
      success,
      attempts,
      retried: attempts > 1,
      slow: durationMs >= this.slowRequestMs,
      error: success ? null : describeError(error),
    };

    this.traces.push(trace);

    if (this.verbose) {
      console.log(
        `  [${trace.success ? 'ok ' : 'ERR'}] ${trace.resource} ` +
          `${trace.durationMs}ms attempts=${trace.attempts}` +
          `${trace.slow ? ' SLOW' : ''}` +
          `${trace.error ? ` error=${trace.error}` : ''}`,
      );
    }
  }

  /** Aggregate summary over everything traced so far. */
  summarize(horizonUrl: string): DiagnosticSummary {
    return summarizeTraces(this.traces, {
      horizonUrl,
      slowThresholdMs: this.slowRequestMs,
      timeoutMs: this.timeoutMs,
    });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Display
// ──────────────────────────────────────────────────────────────────────────────

function displaySummary(summary: DiagnosticSummary): void {
  console.log('\n=== Horizon Request Diagnostics ===');
  console.log(`  Horizon:         ${summary.horizonUrl}`);
  console.log(`  Timeout:         ${summary.timeoutMs}ms`);
  console.log(`  Slow threshold:  ${summary.slowThresholdMs}ms`);

  console.log('\n── Request Counts ─────────────────────────────────────────');
  console.log(`  Total requests:  ${summary.totalRequests}`);
  console.log(`  Successful:      ${summary.successfulRequests}`);
  console.log(`  Failed:          ${summary.failedRequests}`);
  console.log(`  Retried:         ${summary.retriedRequests}`);
  console.log(`  Total attempts:  ${summary.totalAttempts}`);
  console.log(`  Slow requests:   ${summary.slowRequests}`);

  console.log('\n── Latency ────────────────────────────────────────────────');
  console.log(`  Minimum: ${summary.latency.minMs}ms`);
  console.log(`  Maximum: ${summary.latency.maxMs}ms`);
  console.log(`  Average: ${summary.latency.averageMs.toFixed(2)}ms`);
  console.log(`  Median:  ${summary.latency.medianMs.toFixed(2)}ms`);

  console.log('\n── Per-Request Traces ─────────────────────────────────────');
  summary.traces.forEach((trace, index) => {
    console.log(
      `  ${index + 1}. ${trace.resource}` +
        `\n     status=${trace.httpStatus ?? 'n/a'} success=${trace.success}` +
        ` duration=${trace.durationMs}ms attempts=${trace.attempts}${trace.slow ? ' SLOW' : ''}` +
        `\n     started=${trace.startedAt} completed=${trace.completedAt}` +
        (trace.error ? `\n     error=${trace.error}` : ''),
    );
  });

  const slow = summary.traces.filter((trace) => trace.slow);
  if (slow.length > 0) {
    console.log('\n── Slow Requests ──────────────────────────────────────────');
    slow.forEach((trace) =>
      console.log(`  ${trace.resource}: ${trace.durationMs}ms (>= ${summary.slowThresholdMs}ms)`),
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

function wantsJson(params: RunParams): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.OUTPUT_FORMAT === 'json' ||
    process.argv.includes('--json')
  );
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Runs the Horizon request tracing example.
 */
export async function run(params: RunParams = {}): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL ?? DEFAULT_HORIZON_URL;
  const outputJson = wantsJson(params);
  const timeoutMs = parsePositiveInt(
    params.timeoutMs ?? process.env.REQUEST_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const slowRequestMs = parsePositiveInt(
    params.slowRequestMs ?? process.env.SLOW_REQUEST_MS,
    DEFAULT_SLOW_REQUEST_MS,
  );
  const verbose =
    params.verbose === true || params.verbose === 'true' || process.argv.includes('--verbose');

  console.log('Starting Horizon Request Tracing Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log(`Timeout: ${timeoutMs}ms · Slow threshold: ${slowRequestMs}ms · Verbose: ${verbose}`);

  const server = new Horizon.Server(horizonUrl);
  const tracer = new HorizonRequestTracer({ timeoutMs, slowRequestMs, verbose });

  console.log('\nTracing Horizon resources...');

  // A spread of resource types, so the summary covers more than one endpoint.
  await tracer.trace('GET /ledgers?order=desc&limit=1', () =>
    server.ledgers().order('desc').limit(1).call(),
  );
  await tracer.trace('GET /transactions?order=desc&limit=5', () =>
    server.transactions().order('desc').limit(5).call(),
  );
  await tracer.trace('GET /operations?order=desc&limit=5', () =>
    server.operations().order('desc').limit(5).call(),
  );
  await tracer.trace('GET /fee_stats', () => server.feeStats());

  // A freshly generated key is well-formed but has never been funded, so Horizon
  // answers 404. This shows how an HTTP error is traced and how the status is
  // preserved alongside the timing.
  const unfundedAccountId = Keypair.random().publicKey();
  await tracer.trace('GET /accounts/{unfunded} (expected 404)', () =>
    server.loadAccount(unfundedAccountId),
  );

  // A deliberately unresolvable host shows a transport-level failure and, with
  // retries enabled, produces a trace with attempts > 1.
  const unreachable = new Horizon.Server(UNREACHABLE_HORIZON_URL, { allowHttp: false });
  await tracer.trace('GET /ledgers on unreachable host (expected network error)', () =>
    unreachable.ledgers().limit(1).call(),
  );

  const summary = tracer.summarize(horizonUrl);

  if (outputJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  displaySummary(summary);

  console.log('\n── Notes ──────────────────────────────────────────────────');
  console.log('  • Traces are sanitized: secret seeds, JWTs, and token params are redacted.');
  console.log('  • Failed requests are included in latency statistics on purpose.');
  console.log('  • Compare median against average to spot a single slow outlier.');
  console.log('  • The timeout bounds the wait, not the underlying socket.');
  console.log('\nHorizon request tracing completed.');
}
