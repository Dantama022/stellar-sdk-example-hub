/**
 * Read-only Stellar service health monitoring.
 *
 * The checks in this module only issue lightweight read-only requests:
 *   - Horizon: GET / (the Horizon root metadata endpoint)
 *   - Soroban RPC: JSON-RPC getHealth
 *
 * No transactions are constructed or submitted, and no credentials are sent.
 */

export type NetworkEndpointKind = 'horizon' | 'soroban-rpc';
export type NetworkHealthStatus = 'healthy' | 'degraded' | 'unhealthy';
export type NetworkHealthFailureKind =
  'timeout' | 'transport' | 'http' | 'malformed-response' | 'rpc-error' | null;

export interface NetworkHealthConfig {
  horizonUrl?: string;
  sorobanRpcUrl?: string;
  timeoutMs?: number;
  degradedThresholdMs?: number;
  checks?: number;
  intervalMs?: number;
}

export interface NetworkEndpointHealth {
  name: string;
  kind: NetworkEndpointKind;
  endpoint: string;
  status: NetworkHealthStatus;
  responseTimeMs: number | null;
  failureKind: NetworkHealthFailureKind;
  diagnostic: string;
  checkedAt: string;
  details: Record<string, string | number | null>;
}

export interface NetworkHealthReport {
  checkedAt: string;
  status: NetworkHealthStatus;
  endpoints: NetworkEndpointHealth[];
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    unhealthy: number;
  };
  warnings: string[];
}

export interface NetworkHealthDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export class NetworkHealthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkHealthConfigError';
  }
}

class NetworkHealthTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkHealthTimeoutError';
  }
}

export const NETWORK_HEALTH_PRESETS = {
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  },
  mainnet: {
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://soroban-mainnet.stellar.org',
  },
} as const;

export type NetworkPresetName = keyof typeof NETWORK_HEALTH_PRESETS;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_DEGRADED_THRESHOLD_MS = 2_000;
const DEFAULT_INTERVAL_MS = 1_000;
const HEALTH_WARNING =
  'Endpoint availability does not prove ledger finality, transaction success, or complete Stellar network health.';

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function validateEndpointUrl(rawUrl: string, label: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new NetworkHealthConfigError(`Missing ${label} URL.`);
  }
  if (!isHttpUrl(trimmed)) {
    throw new NetworkHealthConfigError(
      `Invalid ${label} URL "${rawUrl}". Use an http:// or https:// URL.`,
    );
  }
  return new URL(trimmed).toString().replace(/\/$/, '');
}

export function sanitizeEndpointUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return rawUrl.split('?')[0].split('#')[0].replace(/\/$/, '');
  }
}

function positiveNumber(
  value: number | undefined,
  fallback: number,
  label: string,
  allowZero = false,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || (allowZero ? resolved < 0 : resolved <= 0)) {
    throw new NetworkHealthConfigError(
      `${label} must be ${allowZero ? 'a non-negative' : 'a positive'} number.`,
    );
  }
  return resolved;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new NetworkHealthConfigError(`${label} must be a positive integer.`);
  }
  return resolved;
}

export function normalizeNetworkHealthConfig(config: NetworkHealthConfig): {
  horizonUrl: string | null;
  sorobanRpcUrl: string | null;
  timeoutMs: number;
  degradedThresholdMs: number;
  checks: number;
  intervalMs: number;
} {
  const horizonUrl = config.horizonUrl?.trim()
    ? validateEndpointUrl(config.horizonUrl, 'Horizon')
    : null;
  const sorobanRpcUrl = config.sorobanRpcUrl?.trim()
    ? validateEndpointUrl(config.sorobanRpcUrl, 'Soroban RPC')
    : null;

  if (!horizonUrl && !sorobanRpcUrl) {
    throw new NetworkHealthConfigError('Configure at least one of horizonUrl or sorobanRpcUrl.');
  }

  return {
    horizonUrl,
    sorobanRpcUrl,
    timeoutMs: positiveNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs'),
    degradedThresholdMs: positiveNumber(
      config.degradedThresholdMs,
      DEFAULT_DEGRADED_THRESHOLD_MS,
      'degradedThresholdMs',
      true,
    ),
    checks: positiveInteger(config.checks, 1, 'checks'),
    intervalMs: positiveNumber(config.intervalMs, DEFAULT_INTERVAL_MS, 'intervalMs', true),
  };
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new NetworkHealthTimeoutError(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      timeoutPromise,
    ]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new NetworkHealthTimeoutError(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function responseTime(startedAt: number, now: () => number): number {
  return Math.max(0, Math.round(now() - startedAt));
}

function failureResult(params: {
  name: string;
  kind: NetworkEndpointKind;
  endpoint: string;
  failureKind: NetworkHealthFailureKind;
  diagnostic: string;
  checkedAt: string;
  responseTimeMs: number | null;
}): NetworkEndpointHealth {
  return {
    name: params.name,
    kind: params.kind,
    endpoint: sanitizeEndpointUrl(params.endpoint),
    status: 'unhealthy',
    responseTimeMs: params.responseTimeMs,
    failureKind: params.failureKind,
    diagnostic: params.diagnostic,
    checkedAt: params.checkedAt,
    details: {},
  };
}

function classifyValidResponse(
  responseTimeMs: number,
  degradedThresholdMs: number,
  extraDegradedReason: string | null,
  healthyDiagnostic: string,
): { status: NetworkHealthStatus; diagnostic: string } {
  if (extraDegradedReason) {
    return { status: 'degraded', diagnostic: extraDegradedReason };
  }
  if (responseTimeMs > degradedThresholdMs) {
    return {
      status: 'degraded',
      diagnostic: `Responded in ${responseTimeMs}ms, above the ${degradedThresholdMs}ms degraded threshold.`,
    };
  }
  return { status: 'healthy', diagnostic: healthyDiagnostic };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function checkHorizonHealth(
  rawUrl: string,
  options: {
    timeoutMs?: number;
    degradedThresholdMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<NetworkEndpointHealth> {
  const endpoint = validateEndpointUrl(rawUrl, 'Horizon');
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const degradedThresholdMs = positiveNumber(
    options.degradedThresholdMs,
    DEFAULT_DEGRADED_THRESHOLD_MS,
    'degradedThresholdMs',
    true,
  );
  const checkedAt = nowIso(now);
  const startedAt = now();

  let response: Response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      `${endpoint}/`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      timeoutMs,
    );
  } catch (error) {
    const isTimeout = error instanceof NetworkHealthTimeoutError;
    return failureResult({
      name: 'Horizon',
      kind: 'horizon',
      endpoint,
      failureKind: isTimeout ? 'timeout' : 'transport',
      diagnostic: isTimeout ? errorMessage(error) : `Transport failure: ${errorMessage(error)}`,
      checkedAt,
      responseTimeMs: null,
    });
  }

  const responseTimeMs = responseTime(startedAt, now);
  if (!response.ok) {
    return failureResult({
      name: 'Horizon',
      kind: 'horizon',
      endpoint,
      failureKind: 'http',
      diagnostic: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      checkedAt,
      responseTimeMs,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return failureResult({
      name: 'Horizon',
      kind: 'horizon',
      endpoint,
      failureKind: 'malformed-response',
      diagnostic: 'Horizon response was not valid JSON.',
      checkedAt,
      responseTimeMs,
    });
  }

  if (!isRecord(payload) || typeof payload.network_passphrase !== 'string') {
    return failureResult({
      name: 'Horizon',
      kind: 'horizon',
      endpoint,
      failureKind: 'malformed-response',
      diagnostic: 'Horizon response did not match the expected root metadata shape.',
      checkedAt,
      responseTimeMs,
    });
  }

  const classification = classifyValidResponse(
    responseTimeMs,
    degradedThresholdMs,
    null,
    'Horizon root metadata returned a valid response.',
  );

  return {
    name: 'Horizon',
    kind: 'horizon',
    endpoint: sanitizeEndpointUrl(endpoint),
    status: classification.status,
    responseTimeMs,
    failureKind: null,
    diagnostic: classification.diagnostic,
    checkedAt,
    details: {
      networkPassphrase: payload.network_passphrase,
      horizonVersion: typeof payload.horizon_version === 'string' ? payload.horizon_version : null,
      protocolVersion:
        typeof payload.current_protocol_version === 'number'
          ? payload.current_protocol_version
          : typeof payload.protocol_version === 'number'
            ? payload.protocol_version
            : null,
      coreVersion: typeof payload.core_version === 'string' ? payload.core_version : null,
    },
  };
}

export async function checkSorobanRpcHealth(
  rawUrl: string,
  options: {
    timeoutMs?: number;
    degradedThresholdMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<NetworkEndpointHealth> {
  const endpoint = validateEndpointUrl(rawUrl, 'Soroban RPC');
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const degradedThresholdMs = positiveNumber(
    options.degradedThresholdMs,
    DEFAULT_DEGRADED_THRESHOLD_MS,
    'degradedThresholdMs',
    true,
  );
  const checkedAt = nowIso(now);
  const startedAt = now();

  let response: Response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      endpoint,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getHealth',
          params: {},
        }),
      },
      timeoutMs,
    );
  } catch (error) {
    const isTimeout = error instanceof NetworkHealthTimeoutError;
    return failureResult({
      name: 'Soroban RPC',
      kind: 'soroban-rpc',
      endpoint,
      failureKind: isTimeout ? 'timeout' : 'transport',
      diagnostic: isTimeout ? errorMessage(error) : `Transport failure: ${errorMessage(error)}`,
      checkedAt,
      responseTimeMs: null,
    });
  }

  const responseTimeMs = responseTime(startedAt, now);
  if (!response.ok) {
    return failureResult({
      name: 'Soroban RPC',
      kind: 'soroban-rpc',
      endpoint,
      failureKind: 'http',
      diagnostic: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      checkedAt,
      responseTimeMs,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return failureResult({
      name: 'Soroban RPC',
      kind: 'soroban-rpc',
      endpoint,
      failureKind: 'malformed-response',
      diagnostic: 'Soroban RPC response was not valid JSON.',
      checkedAt,
      responseTimeMs,
    });
  }

  if (!isRecord(payload)) {
    return failureResult({
      name: 'Soroban RPC',
      kind: 'soroban-rpc',
      endpoint,
      failureKind: 'malformed-response',
      diagnostic: 'Soroban RPC response was not a JSON-RPC object.',
      checkedAt,
      responseTimeMs,
    });
  }

  if (payload.error !== undefined) {
    const rpcError = isRecord(payload.error) ? payload.error : {};
    const code = typeof rpcError.code === 'number' ? rpcError.code : 'unknown';
    const message = typeof rpcError.message === 'string' ? rpcError.message : 'Unknown RPC error';
    return failureResult({
      name: 'Soroban RPC',
      kind: 'soroban-rpc',
      endpoint,
      failureKind: 'rpc-error',
      diagnostic: `RPC error ${code}: ${message}`,
      checkedAt,
      responseTimeMs,
    });
  }

  if (!isRecord(payload.result) || typeof payload.result.status !== 'string') {
    return failureResult({
      name: 'Soroban RPC',
      kind: 'soroban-rpc',
      endpoint,
      failureKind: 'malformed-response',
      diagnostic: 'Soroban RPC getHealth result did not include a status string.',
      checkedAt,
      responseTimeMs,
    });
  }

  const rpcStatus = payload.result.status;
  const extraDegradedReason =
    rpcStatus === 'healthy' ? null : `Soroban RPC health status is "${rpcStatus}".`;
  const classification = classifyValidResponse(
    responseTimeMs,
    degradedThresholdMs,
    extraDegradedReason,
    'Soroban RPC getHealth returned a healthy response.',
  );

  return {
    name: 'Soroban RPC',
    kind: 'soroban-rpc',
    endpoint: sanitizeEndpointUrl(endpoint),
    status: classification.status,
    responseTimeMs,
    failureKind: null,
    diagnostic: classification.diagnostic,
    checkedAt,
    details: {
      rpcStatus,
      latestLedger:
        typeof payload.result.latestLedger === 'number'
          ? payload.result.latestLedger
          : typeof payload.result.latestLedger === 'string'
            ? payload.result.latestLedger
            : null,
      oldestLedger:
        typeof payload.result.oldestLedger === 'number'
          ? payload.result.oldestLedger
          : typeof payload.result.oldestLedger === 'string'
            ? payload.result.oldestLedger
            : null,
    },
  };
}

function overallStatus(endpoints: NetworkEndpointHealth[]): NetworkHealthStatus {
  if (endpoints.length === 0) return 'unhealthy';
  const healthy = endpoints.filter((endpoint) => endpoint.status === 'healthy').length;
  const unhealthy = endpoints.filter((endpoint) => endpoint.status === 'unhealthy').length;
  if (unhealthy === endpoints.length) return 'unhealthy';
  if (healthy === endpoints.length) return 'healthy';
  return 'degraded';
}

export async function runNetworkHealthCheck(
  config: NetworkHealthConfig,
  deps: NetworkHealthDeps = {},
): Promise<NetworkHealthReport> {
  const normalized = normalizeNetworkHealthConfig(config);
  const now = deps.now ?? Date.now;
  const checkedAt = nowIso(now);
  const endpointChecks: Array<Promise<NetworkEndpointHealth>> = [];

  if (normalized.horizonUrl) {
    endpointChecks.push(
      checkHorizonHealth(normalized.horizonUrl, {
        timeoutMs: normalized.timeoutMs,
        degradedThresholdMs: normalized.degradedThresholdMs,
        fetchImpl: deps.fetchImpl,
        now,
      }),
    );
  }

  if (normalized.sorobanRpcUrl) {
    endpointChecks.push(
      checkSorobanRpcHealth(normalized.sorobanRpcUrl, {
        timeoutMs: normalized.timeoutMs,
        degradedThresholdMs: normalized.degradedThresholdMs,
        fetchImpl: deps.fetchImpl,
        now,
      }),
    );
  }

  const endpoints = await Promise.all(endpointChecks);
  const summary = {
    total: endpoints.length,
    healthy: endpoints.filter((endpoint) => endpoint.status === 'healthy').length,
    degraded: endpoints.filter((endpoint) => endpoint.status === 'degraded').length,
    unhealthy: endpoints.filter((endpoint) => endpoint.status === 'unhealthy').length,
  };
  const warnings = [HEALTH_WARNING];
  if (summary.unhealthy > 0) {
    warnings.push(
      'One or more configured endpoints are unhealthy; other configured checks were still completed independently.',
    );
  }
  if (summary.total === 1) {
    warnings.push(
      'Only one endpoint was configured; the overall result reflects that endpoint, not the Stellar network as a whole.',
    );
  }

  return {
    checkedAt,
    status: overallStatus(endpoints),
    endpoints,
    summary,
    warnings,
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function monitorNetworkHealth(
  config: NetworkHealthConfig,
  deps: NetworkHealthDeps = {},
): Promise<NetworkHealthReport[]> {
  const normalized = normalizeNetworkHealthConfig(config);
  const reports: NetworkHealthReport[] = [];
  const sleep = deps.sleep ?? defaultSleep;

  for (let i = 0; i < normalized.checks; i += 1) {
    if (deps.signal?.aborted) break;
    reports.push(
      await runNetworkHealthCheck(
        {
          horizonUrl: normalized.horizonUrl ?? undefined,
          sorobanRpcUrl: normalized.sorobanRpcUrl ?? undefined,
          timeoutMs: normalized.timeoutMs,
          degradedThresholdMs: normalized.degradedThresholdMs,
        },
        deps,
      ),
    );
    if (i < normalized.checks - 1 && normalized.intervalMs > 0) {
      await sleep(normalized.intervalMs);
    }
  }

  return reports;
}
