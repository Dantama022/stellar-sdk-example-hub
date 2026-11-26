import { Networks } from '@stellar/stellar-sdk';

export interface NetworkConfig {
  networkName: string;
  expectedPassphrase: string;
  horizonUrl?: string;
  sorobanRpcUrl?: string;
  timeoutMs?: number;
}

export interface ValidationIssue {
  field: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface ConfigValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  sanitizedHorizonUrl?: string;
  sanitizedSorobanRpcUrl?: string;
}

export interface EndpointCheckResult {
  service: 'horizon' | 'soroban_rpc';
  configured: boolean;
  sanitizedUrl?: string;
  reachable: boolean;
  status: 'ok' | 'http_error' | 'timeout' | 'connection_error' | 'unsupported_method' | 'malformed_response' | 'not_configured';
  httpStatus?: number;
  reportedPassphrase?: string;
  metadata: Record<string, string | number | boolean>;
  error?: string;
}

export interface NetworkConsistencyFinding {
  kind: 'confirmed_mismatch' | 'insufficient_information' | 'warning' | 'verified_match';
  service: 'config' | 'horizon' | 'soroban_rpc';
  message: string;
  recommendedAction?: string;
}

export interface NetworkCompatibilityReport {
  networkName: string;
  expectedPassphrase: string;
  validation: ConfigValidationResult;
  horizon?: EndpointCheckResult;
  sorobanRpc?: EndpointCheckResult;
  findings: NetworkConsistencyFinding[];
  uncompletedChecks: string[];
  overallStatus: 'compatible' | 'mismatch_detected' | 'incomplete_verification' | 'invalid_configuration';
  limitations: string[];
}

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

export type HttpFetcher = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<HttpResponseLike>;

export interface NetworkCompatibilityParams {
  networkName?: string;
  expectedPassphrase?: string;
  horizonUrl?: string;
  sorobanRpcUrl?: string;
  timeoutMs?: number | string;
  json?: boolean | string;
}

const KNOWN_NETWORK_PASSPHRASES: Record<string, string> = {
  public: Networks.PUBLIC,
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  sandbox: Networks.SANDBOX,
  standalone: Networks.STANDALONE,
};

const SENSITIVE_QUERY_PARAMS = new Set([
  'token',
  'api_key',
  'apikey',
  'key',
  'secret',
  'password',
  'auth',
  'access_token',
]);

export function redactUrlCredentials(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '***' : '';
      parsed.password = parsed.password ? '***' : '';
    }
    for (const param of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAMS.has(param.toLowerCase())) {
        parsed.searchParams.set(param, '***');
      }
    }
    return parsed.toString();
  } catch {
    return rawUrl.replace(/(https?:\/\/)([^/@\s]+)@/gi, '$1***@');
  }
}

export function redactSecretsInText(text: string): string {
  return text
    .replace(/(https?:\/\/)([^/@\s]+)@/gi, '$1***@')
    .replace(/([?&](?:token|api_key|apikey|key|secret|password|auth|access_token)=)[^&\s]+/gi, '$1***');
}

function validateEndpointUrl(
  rawUrl: string,
  field: 'horizonUrl' | 'sorobanRpcUrl',
  issues: ValidationIssue[],
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    issues.push({
      field,
      severity: 'error',
      message: `${field} is not a valid URL (${redactSecretsInText(rawUrl)}).`,
    });
    return undefined;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    issues.push({
      field,
      severity: 'error',
      message: `${field} uses unsupported URL scheme "${parsed.protocol}"; only http: and https: are supported.`,
    });
    return redactUrlCredentials(rawUrl);
  }

  if (parsed.username || parsed.password) {
    issues.push({
      field,
      severity: 'warning',
      message: `${field} contains embedded URL credentials; credentials have been redacted from diagnostics.`,
    });
  }

  return redactUrlCredentials(rawUrl);
}

export function validateNetworkConfig(config: NetworkConfig): ConfigValidationResult {
  const issues: ValidationIssue[] = [];

  if (!config.networkName || config.networkName.trim() === '') {
    issues.push({
      field: 'networkName',
      severity: 'error',
      message: 'networkName is required.',
    });
  }

  if (!config.expectedPassphrase || config.expectedPassphrase.trim() === '') {
    issues.push({
      field: 'expectedPassphrase',
      severity: 'error',
      message: 'expectedPassphrase is required.',
    });
  }

  if (!config.horizonUrl && !config.sorobanRpcUrl) {
    issues.push({
      field: 'endpoints',
      severity: 'error',
      message: 'At least one endpoint (horizonUrl or sorobanRpcUrl) must be configured.',
    });
  }

  if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)) {
    issues.push({
      field: 'timeoutMs',
      severity: 'error',
      message: 'timeoutMs must be a positive finite number.',
    });
  }

  const sanitizedHorizonUrl = config.horizonUrl
    ? validateEndpointUrl(config.horizonUrl, 'horizonUrl', issues)
    : undefined;
  const sanitizedSorobanRpcUrl = config.sorobanRpcUrl
    ? validateEndpointUrl(config.sorobanRpcUrl, 'sorobanRpcUrl', issues)
    : undefined;

  const normalizedName = config.networkName?.trim().toLowerCase() ?? '';
  const knownPassphrase = KNOWN_NETWORK_PASSPHRASES[normalizedName];
  if (knownPassphrase && config.expectedPassphrase && config.expectedPassphrase !== knownPassphrase) {
    issues.push({
      field: 'expectedPassphrase',
      severity: 'error',
      message: `networkName "${config.networkName}" conflicts with expectedPassphrase "${config.expectedPassphrase}".`,
    });
  }

  const isTestLikeName = ['testnet', 'futurenet', 'sandbox', 'standalone', 'local', 'dev'].some((k) =>
    normalizedName.includes(k),
  );
  if (isTestLikeName && sanitizedHorizonUrl) {
    try {
      const host = new URL(sanitizedHorizonUrl).hostname.toLowerCase();
      if (host === 'horizon.stellar.org') {
        issues.push({
          field: 'horizonUrl',
          severity: 'error',
          message: `Production Horizon endpoint (${host}) is configured under test environment label "${config.networkName}".`,
        });
      }
    } catch {
      // Invalid URL already recorded above
    }
  }

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    issues,
    sanitizedHorizonUrl,
    sanitizedSorobanRpcUrl,
  };
}

function defaultHttpFetcher(): HttpFetcher {
  return (url, init) => fetch(url, init) as Promise<HttpResponseLike>;
}

async function fetchWithTimeout(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number,
  fetcher: HttpFetcher,
): Promise<HttpResponseLike> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function classifyFetchError(error: unknown): { status: 'timeout' | 'connection_error'; message: string } {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const safeMessage = redactSecretsInText(rawMessage);
  if (
    (error instanceof Error && error.name === 'AbortError') ||
    /abort|timed?\s*out/i.test(safeMessage)
  ) {
    return { status: 'timeout', message: `Request timed out: ${safeMessage}` };
  }
  return { status: 'connection_error', message: `Connection failed: ${safeMessage}` };
}

export async function checkHorizonEndpoint(
  horizonUrl: string,
  timeoutMs = 5000,
  fetcher: HttpFetcher = defaultHttpFetcher(),
): Promise<EndpointCheckResult> {
  const sanitizedUrl = redactUrlCredentials(horizonUrl);
  const rootUrl = horizonUrl.replace(/\/+$/, '') + '/';

  try {
    const response = await fetchWithTimeout(
      rootUrl,
      { method: 'GET', headers: { Accept: 'application/json' } },
      timeoutMs,
      fetcher,
    );

    if (!response.ok) {
      return {
        service: 'horizon',
        configured: true,
        sanitizedUrl,
        reachable: true,
        status: 'http_error',
        httpStatus: response.status,
        metadata: {},
        error: `Horizon returned HTTP ${response.status}`,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        service: 'horizon',
        configured: true,
        sanitizedUrl,
        reachable: true,
        status: 'malformed_response',
        httpStatus: response.status,
        metadata: {},
        error: 'Horizon returned non-JSON or malformed JSON response.',
      };
    }

    if (!body || typeof body !== 'object') {
      return {
        service: 'horizon',
        configured: true,
        sanitizedUrl,
        reachable: true,
        status: 'malformed_response',
        httpStatus: response.status,
        metadata: {},
        error: 'Horizon response body was not a JSON object.',
      };
    }

    const record = body as Record<string, unknown>;
    const reportedPassphrase =
      typeof record.network_passphrase === 'string' ? record.network_passphrase : undefined;

    const metadata: Record<string, string | number | boolean> = {};
    if (typeof record.horizon_version === 'string') metadata.horizonVersion = record.horizon_version;
    if (typeof record.core_version === 'string') metadata.coreVersion = record.core_version;
    if (typeof record.history_latest_ledger === 'number') {
      metadata.historyLatestLedger = record.history_latest_ledger;
    }

    return {
      service: 'horizon',
      configured: true,
      sanitizedUrl,
      reachable: true,
      status: 'ok',
      httpStatus: response.status,
      reportedPassphrase,
      metadata,
    };
  } catch (error) {
    const classified = classifyFetchError(error);
    return {
      service: 'horizon',
      configured: true,
      sanitizedUrl,
      reachable: false,
      status: classified.status,
      metadata: {},
      error: classified.message,
    };
  }
}

export async function checkSorobanRpcEndpoint(
  sorobanRpcUrl: string,
  timeoutMs = 5000,
  fetcher: HttpFetcher = defaultHttpFetcher(),
): Promise<EndpointCheckResult> {
  const sanitizedUrl = redactUrlCredentials(sorobanRpcUrl);

  try {
    const response = await fetchWithTimeout(
      sorobanRpcUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getNetwork' }),
      },
      timeoutMs,
      fetcher,
    );

    if (!response.ok) {
      return {
        service: 'soroban_rpc',
        configured: true,
        sanitizedUrl,
        reachable: true,
        status: 'http_error',
        httpStatus: response.status,
        metadata: {},
        error: `Soroban RPC returned HTTP ${response.status}`,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        service: 'soroban_rpc',
        configured: true,
        sanitizedUrl,
        reachable: true,
        status: 'malformed_response',
        httpStatus: response.status,
        metadata: {},
        error: 'Soroban RPC returned non-JSON or malformed JSON response.',
      };
    }

    if (!body || typeof body !== 'object') {
      return {
        service: 'soroban_rpc',
        configured: true,
        sanitizedUrl,
        reachable: true,
        status: 'malformed_response',
        httpStatus: response.status,
        metadata: {},
        error: 'Soroban RPC response was not a JSON object.',
      };
    }

    const rpc = body as { result?: Record<string, unknown>; error?: { code?: number; message?: string } };
    if (rpc.error) {
      const isMethodNotFound = rpc.error.code === -32601 || /method not found/i.test(rpc.error.message ?? '');
      return {
        service: 'soroban_rpc',
        configured: true,
        sanitizedUrl,
        reachable: true,
        status: isMethodNotFound ? 'unsupported_method' : 'malformed_response',
        httpStatus: response.status,
        metadata: rpc.error.code !== undefined ? { rpcErrorCode: rpc.error.code } : {},
        error: redactSecretsInText(rpc.error.message ?? 'JSON-RPC error returned by Soroban RPC.'),
      };
    }

    const result = rpc.result;
    if (!result || typeof result !== 'object') {
      return {
        service: 'soroban_rpc',
        configured: true,
        sanitizedUrl,
        reachable: true,
        status: 'malformed_response',
        httpStatus: response.status,
        metadata: {},
        error: 'Soroban RPC getNetwork response missing result object.',
      };
    }

    const reportedPassphrase = typeof result.passphrase === 'string' ? result.passphrase : undefined;
    const metadata: Record<string, string | number | boolean> = {};
    if (typeof result.protocolVersion === 'number' || typeof result.protocolVersion === 'string') {
      metadata.protocolVersion = result.protocolVersion;
    }
    if (typeof result.friendbotUrl === 'string') {
      metadata.friendbotUrl = redactUrlCredentials(result.friendbotUrl);
    }

    return {
      service: 'soroban_rpc',
      configured: true,
      sanitizedUrl,
      reachable: true,
      status: 'ok',
      httpStatus: response.status,
      reportedPassphrase,
      metadata,
    };
  } catch (error) {
    const classified = classifyFetchError(error);
    return {
      service: 'soroban_rpc',
      configured: true,
      sanitizedUrl,
      reachable: false,
      status: classified.status,
      metadata: {},
      error: classified.message,
    };
  }
}

export function analyzeNetworkConsistency(
  config: NetworkConfig,
  validation: ConfigValidationResult,
  horizon?: EndpointCheckResult,
  sorobanRpc?: EndpointCheckResult,
): NetworkCompatibilityReport {
  const findings: NetworkConsistencyFinding[] = [];
  const uncompletedChecks: string[] = [];

  for (const issue of validation.issues) {
    findings.push({
      kind: issue.severity === 'error' ? 'confirmed_mismatch' : 'warning',
      service: 'config',
      message: issue.message,
      recommendedAction: `Review "${issue.field}" in your network configuration.`,
    });
  }

  const evaluateEndpoint = (endpoint: EndpointCheckResult | undefined, label: string) => {
    if (!endpoint) return;
    if (endpoint.status !== 'ok') {
      uncompletedChecks.push(`${label} network identity check could not be completed (${endpoint.status}).`);
      findings.push({
        kind: 'insufficient_information',
        service: endpoint.service,
        message: `${label} did not return verifiable network metadata (${endpoint.error ?? endpoint.status}).`,
      });
      return;
    }

    if (!endpoint.reportedPassphrase) {
      uncompletedChecks.push(`${label} responded but did not include a network passphrase.`);
      findings.push({
        kind: 'insufficient_information',
        service: endpoint.service,
        message: `${label} is reachable, but its response lacked network_passphrase/passphrase; network identity is unverified.`,
      });
      return;
    }

    if (endpoint.reportedPassphrase !== config.expectedPassphrase) {
      findings.push({
        kind: 'confirmed_mismatch',
        service: endpoint.service,
        message: `${label} reported passphrase "${endpoint.reportedPassphrase}", which does not match expected "${config.expectedPassphrase}".`,
        recommendedAction: `Update ${label} URL or expectedPassphrase so both target the same Stellar network.`,
      });
    } else {
      findings.push({
        kind: 'verified_match',
        service: endpoint.service,
        message: `${label} confirmed network passphrase "${endpoint.reportedPassphrase}".`,
      });
    }
  };

  evaluateEndpoint(horizon, 'Horizon');
  evaluateEndpoint(sorobanRpc, 'Soroban RPC');

  if (
    horizon?.status === 'ok' &&
    sorobanRpc?.status === 'ok' &&
    horizon.reportedPassphrase &&
    sorobanRpc.reportedPassphrase &&
    horizon.reportedPassphrase !== sorobanRpc.reportedPassphrase
  ) {
    findings.push({
      kind: 'confirmed_mismatch',
      service: 'config',
      message: `Horizon ("${horizon.reportedPassphrase}") and Soroban RPC ("${sorobanRpc.reportedPassphrase}") point to different Stellar networks.`,
      recommendedAction: 'Align both endpoints to the same Stellar network.',
    });
  }

  const hasMismatch = findings.some((f) => f.kind === 'confirmed_mismatch');
  let overallStatus: NetworkCompatibilityReport['overallStatus'];
  if (!validation.valid) {
    overallStatus = 'invalid_configuration';
  } else if (hasMismatch) {
    overallStatus = 'mismatch_detected';
  } else if (uncompletedChecks.length > 0) {
    overallStatus = 'incomplete_verification';
  } else {
    overallStatus = 'compatible';
  }

  return {
    networkName: config.networkName,
    expectedPassphrase: config.expectedPassphrase,
    validation,
    horizon,
    sorobanRpc,
    findings,
    uncompletedChecks,
    overallStatus,
    limitations: [
      'Endpoint reachability alone does not prove network identity or compatibility with every SDK operation.',
      'A user-supplied networkName is only a label and does not verify the remote service.',
    ],
  };
}

export async function runNetworkCompatibilityCheck(
  config: NetworkConfig,
  fetcher: HttpFetcher = defaultHttpFetcher(),
): Promise<NetworkCompatibilityReport> {
  const validation = validateNetworkConfig(config);
  const timeoutMs = config.timeoutMs ?? 5000;

  let horizon: EndpointCheckResult | undefined;
  let sorobanRpc: EndpointCheckResult | undefined;

  if (validation.valid) {
    if (config.horizonUrl) {
      horizon = await checkHorizonEndpoint(config.horizonUrl, timeoutMs, fetcher);
    }
    if (config.sorobanRpcUrl) {
      sorobanRpc = await checkSorobanRpcEndpoint(config.sorobanRpcUrl, timeoutMs, fetcher);
    }
  }

  return analyzeNetworkConsistency(config, validation, horizon, sorobanRpc);
}

export function formatNetworkCompatibilityReport(report: NetworkCompatibilityReport): string {
  const lines: string[] = [
    '=== Stellar Network Configuration & Endpoint Compatibility Report ===',
    `Network label: ${report.networkName}`,
    `Expected passphrase: ${report.expectedPassphrase}`,
    `Overall status: ${report.overallStatus}`,
    '',
    `Configuration valid: ${report.validation.valid}`,
  ];

  if (report.horizon) {
    lines.push(
      `Horizon (${report.horizon.sanitizedUrl}): status=${report.horizon.status}, reachable=${report.horizon.reachable}, passphrase=${report.horizon.reportedPassphrase ?? 'unavailable'}`,
    );
  }
  if (report.sorobanRpc) {
    lines.push(
      `Soroban RPC (${report.sorobanRpc.sanitizedUrl}): status=${report.sorobanRpc.status}, reachable=${report.sorobanRpc.reachable}, passphrase=${report.sorobanRpc.reportedPassphrase ?? 'unavailable'}`,
    );
  }

  lines.push('', 'Findings:');
  for (const f of report.findings) {
    lines.push(`  - [${f.kind}] (${f.service}) ${f.message}`);
  }

  if (report.uncompletedChecks.length > 0) {
    lines.push('', 'Uncompleted Checks:');
    for (const check of report.uncompletedChecks) {
      lines.push(`  - ${check}`);
    }
  }

  return lines.join('\n');
}

export async function run(params: NetworkCompatibilityParams = {}): Promise<void> {
  const config: NetworkConfig = {
    networkName: params.networkName || process.env.STELLAR_NETWORK || 'testnet',
    expectedPassphrase:
      params.expectedPassphrase || process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET,
    horizonUrl: params.horizonUrl ?? (process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org'),
    sorobanRpcUrl: params.sorobanRpcUrl ?? (process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'),
    timeoutMs: params.timeoutMs ? Number(params.timeoutMs) : 5000,
  };
  const json = params.json === true || params.json === 'true' || process.env.JSON_OUTPUT === 'true';

  const report = await runNetworkCompatibilityCheck(config);
  console.log(json ? JSON.stringify(report, null, 2) : formatNetworkCompatibilityReport(report));
}
