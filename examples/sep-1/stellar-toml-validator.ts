/**
 * ISSUE-402: SEP-1 stellar.toml schema validation and service endpoint audit.
 *
 * Retrieves a domain's `/.well-known/stellar.toml`, parses it with a maintained
 * TOML parser, validates the fields defined by SEP-1, and prints a severity
 * tagged report. The example is read-only: it never signs a transaction and it
 * never calls a published service endpoint unless `checkEndpoints` is enabled.
 *
 * Usage:
 *   npx ts-node examples/sep-1/stellar-toml-validator.ts --domain example.org
 *   npx ts-node examples/sep-1/stellar-toml-validator.ts --domain example.org \
 *     --expected-network "Public Global Stellar Network ; September 2015" --json
 *
 * The pure functions in this module are exported so tests can run against the
 * deterministic fixtures in `examples/sep-1/fixtures/` without network access.
 */

import { parse as parseToml } from 'toml';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  code: string;
  severity: Severity;
  field?: string;
  message: string;
}

export type StellarTomlDocument = Record<string, unknown>;

export interface RetrievalResult {
  url: string;
  ok: boolean;
  status?: number;
  contentType?: string | null;
  text?: string;
  error?: string;
}

export interface ParseResult {
  ok: boolean;
  error?: string;
  document?: StellarTomlDocument;
}

export interface NetworkConsistency {
  declared: string | null;
  expected: string | null;
  consistent: boolean | null;
}

export interface ValidationReport {
  domain: string;
  retrieval: RetrievalResult;
  parse: ParseResult;
  network: NetworkConsistency;
  findings: Finding[];
  counts: { errors: number; warnings: number; infos: number };
  overall: 'pass' | 'warnings' | 'fail';
}

export interface ValidationOptions {
  expectedNetworkPassphrase?: string;
  /** Disabled by default. When enabled, performs short HEAD requests only. */
  checkEndpoints?: boolean;
  timeoutMs?: number;
  fetcher?: FetchLike;
  endpointFetcher?: FetchLike;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

const SERVICE_ENDPOINT_FIELDS = [
  'HORIZON_URL',
  'FEDERATION_SERVER',
  'AUTH_SERVER',
  'WEB_AUTH_ENDPOINT',
  'TRANSFER_SERVER',
  'KYC_SERVER',
  'DEPOSIT_SERVER',
  'WITHDRAW_SERVER',
  'DIRECTORY_SERVER',
] as const;

const PUBLIC_KEY_RE = /^G[A-Z2-7]{55}$/;
const ASSET_CODE_RE = /^[A-Za-z0-9]{1,12}$/;

/** Removes a scheme, path, query and port from a user supplied domain. */
export function normalizeDomain(input: string): string {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new Error('A domain is required');

  let host = trimmed.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
  host = host.split('@').pop() ?? '';
  host = host.replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase();

  if (!host || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..')) {
    throw new Error(`Invalid domain: ${input}`);
  }
  return host;
}

export function buildStellarTomlUrl(domain: string): string {
  return `https://${normalizeDomain(domain)}/.well-known/stellar.toml`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Retrieves the document without trusting HTML error pages as TOML. */
export async function fetchStellarToml(
  domain: string,
  options: Pick<ValidationOptions, 'timeoutMs' | 'fetcher'> = {},
): Promise<RetrievalResult> {
  const url = buildStellarTomlUrl(domain);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  const fetcher: FetchLike =
    options.fetcher ?? ((target, init) => globalThis.fetch(target, init as RequestInit));

  try {
    const response = await fetcher(url, {
      headers: { Accept: 'application/toml, text/plain, text/toml;q=0.9, */*;q=0.1' },
      signal: controller.signal,
    });
    const contentType = response.headers?.get('content-type') ?? null;
    const base: RetrievalResult = { url, ok: false, status: response.status, contentType };

    if (!response.ok) {
      return { ...base, error: `HTTP ${response.status} while retrieving stellar.toml` };
    }
    if (contentType && /html|xml|json/i.test(contentType)) {
      return { ...base, error: `Unexpected content type: ${contentType}` };
    }

    const text = await response.text();
    if (/^\s*<(!doctype|html|xml)/i.test(text)) {
      return { ...base, error: 'Response looks like an HTML/XML error page, not TOML' };
    }
    return { ...base, ok: true, text };
  } catch (error) {
    return { url, ok: false, error: `stellar.toml retrieval failed: ${errorMessage(error)}` };
  } finally {
    clearTimeout(timeout);
  }
}

/** Parses TOML with the maintained `toml` parser, never a hand-rolled parser. */
export function parseStellarToml(text: string): ParseResult {
  try {
    const parsed: unknown = parseToml(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'stellar.toml root must be a table' };
    }
    return { ok: true, document: parsed as StellarTomlDocument };
  } catch (error) {
    return { ok: false, error: `Malformed TOML: ${errorMessage(error)}` };
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function add(findings: Finding[], finding: Finding): void {
  findings.push(finding);
}

function validateServiceUrl(value: unknown, field: string, findings: Finding[]): string | null {
  const raw = asString(value);
  if (!raw) {
    add(findings, {
      code: 'endpoint-missing',
      severity: 'warning',
      field,
      message: `${field} is missing or empty`,
    });
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    add(findings, {
      code: 'endpoint-invalid-url',
      severity: 'error',
      field,
      message: `${field} is not a valid absolute URL: ${raw}`,
    });
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    add(findings, {
      code: 'endpoint-scheme',
      severity: 'error',
      field,
      message: `${field} uses unsupported scheme ${parsed.protocol}`,
    });
    return null;
  }
  if (!parsed.hostname) {
    add(findings, {
      code: 'endpoint-invalid-url',
      severity: 'error',
      field,
      message: `${field} has no hostname`,
    });
    return null;
  }
  if (parsed.protocol === 'http:') {
    add(findings, {
      code: 'endpoint-insecure',
      severity: 'warning',
      field,
      message: `${field} uses plain HTTP; prefer HTTPS for metadata and service discovery`,
    });
  }
  if (parsed.username || parsed.password) {
    add(findings, {
      code: 'endpoint-credentials',
      severity: 'warning',
      field,
      message: `${field} embeds credentials in the URL`,
    });
  }
  return raw;
}

function validateAccounts(value: unknown, findings: Finding[]): void {
  const accounts = asArray(value);
  if (!accounts) {
    add(findings, {
      code: 'accounts-type',
      severity: 'error',
      field: 'ACCOUNTS',
      message: 'ACCOUNTS must be an array when present',
    });
    return;
  }
  accounts.forEach((account, index) => {
    const key = asString(account);
    if (!key || !PUBLIC_KEY_RE.test(key)) {
      add(findings, {
        code: 'account-invalid-key',
        severity: 'error',
        field: `ACCOUNTS[${index}]`,
        message: 'ACCOUNT entry is not a valid Stellar public key (G + 55 base32 characters)',
      });
    }
  });
}

function validateCurrencies(value: unknown, findings: Finding[]): void {
  const currencies = asArray(value);
  if (!currencies) {
    add(findings, {
      code: 'currencies-type',
      severity: 'error',
      field: 'CURRENCIES',
      message: 'CURRENCIES must be an array when present',
    });
    return;
  }

  const seen = new Set<string>();
  currencies.forEach((entry, index) => {
    const field = `CURRENCIES[${index}]`;
    const record = asRecord(entry);
    if (!record) {
      add(findings, {
        code: 'asset-malformed',
        severity: 'error',
        field,
        message: 'Currency entry must be a TOML table',
      });
      return;
    }

    const code = asString(record.code);
    if (!code || !ASSET_CODE_RE.test(code)) {
      add(findings, {
        code: 'asset-code-invalid',
        severity: 'error',
        field: `${field}.code`,
        message: 'Currency code must be 1-12 alphanumeric characters',
      });
      return;
    }

    const issuer = asString(record.issuer);
    if (issuer && !PUBLIC_KEY_RE.test(issuer)) {
      add(findings, {
        code: 'asset-issuer-invalid',
        severity: 'error',
        field: `${field}.issuer`,
        message: 'Currency issuer is not a valid Stellar public key',
      });
    }
    if (!issuer) {
      add(findings, {
        code: 'asset-issuer-absent',
        severity: 'warning',
        field: `${field}.issuer`,
        message:
          'No issuer declared; this may be a native or non-issued asset, so do not assume an issued Stellar asset',
      });
    }
    if (asString(record.name) === null) {
      add(findings, {
        code: 'asset-name-missing',
        severity: 'info',
        field: `${field}.name`,
        message: 'Currency has no display name',
      });
    }

    const identity = `${code}:${issuer ?? '<none>'}`;
    if (seen.has(identity)) {
      add(findings, {
        code: 'asset-duplicate',
        severity: 'error',
        field,
        message: `Duplicate asset declaration for ${identity}`,
      });
    } else {
      seen.add(identity);
    }
  });
}

function validatePrincipals(value: unknown, findings: Finding[]): void {
  const principals = asArray(value);
  if (!principals) {
    add(findings, {
      code: 'principals-type',
      severity: 'warning',
      field: 'PRINCIPALS',
      message: 'PRINCIPALS must be an array when present',
    });
    return;
  }
  principals.forEach((entry, index) => {
    if (!asRecord(entry)) {
      add(findings, {
        code: 'principal-malformed',
        severity: 'warning',
        field: `PRINCIPALS[${index}]`,
        message: 'Principal entry must be a TOML table',
      });
    }
  });
}

/** Optionally performs a bounded HEAD request for a published endpoint. */
async function probeEndpoints(
  endpoints: Array<string | null>,
  findings: Finding[],
  options: ValidationOptions,
): Promise<void> {
  if (!options.checkEndpoints) return;
  const fetcher = options.endpointFetcher ?? options.fetcher;
  for (const raw of endpoints) {
    if (!raw) continue;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(options.timeoutMs ?? 8000, 8000));
    try {
      const activeFetcher: FetchLike =
        fetcher ?? ((target, init) => globalThis.fetch(target, init as RequestInit));
      const response = await activeFetcher(raw, { method: 'HEAD', signal: controller.signal });
      add(findings, {
        code: 'endpoint-probe',
        severity: response.ok ? 'info' : 'warning',
        field: raw,
        message: `Endpoint probe returned HTTP ${response.status}`,
      });
    } catch (error) {
      add(findings, {
        code: 'endpoint-probe-failed',
        severity: 'warning',
        field: raw,
        message: `Endpoint probe failed: ${errorMessage(error)}`,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Validates a parsed SEP-1 document. Required/optional semantics follow SEP-1:
 * SIGNING_KEY is required, NETWORK_PASSPHRASE and the endpoint fields are
 * expected but their absence is reported as a warning rather than assumed
 * fatal, and ACCOUNTS/CURRENCIES/DOCUMENTATION/PRINCIPALS are optional.
 */
export async function validateStellarToml(
  document: StellarTomlDocument,
  options: ValidationOptions = {},
): Promise<{ findings: Finding[]; network: NetworkConsistency }> {
  const findings: Finding[] = [];
  const expected = asString(options.expectedNetworkPassphrase);
  const declared = asString(document.NETWORK_PASSPHRASE);

  if (!declared) {
    add(findings, {
      code: expected ? 'network-missing-expected' : 'network-missing',
      severity: expected ? 'error' : 'warning',
      field: 'NETWORK_PASSPHRASE',
      message: expected
        ? 'NETWORK_PASSPHRASE is missing but an expected network was supplied'
        : 'NETWORK_PASSPHRASE is missing; network consistency cannot be verified',
    });
  }
  const consistent = expected && declared ? expected === declared : null;
  if (declared && expected && !consistent) {
    add(findings, {
      code: 'network-mismatch',
      severity: 'error',
      field: 'NETWORK_PASSPHRASE',
      message: `Declared network "${declared}" does not match expected network "${expected}"`,
    });
  }
  if (declared && !expected) {
    add(findings, {
      code: 'network-declared',
      severity: 'info',
      field: 'NETWORK_PASSPHRASE',
      message: `Declared network: ${declared}`,
    });
  }

  const signingKey = asString(document.SIGNING_KEY);
  if (!signingKey) {
    add(findings, {
      code: 'signing-key-missing',
      severity: 'error',
      field: 'SIGNING_KEY',
      message: 'SIGNING_KEY is required by SEP-1',
    });
  } else if (!PUBLIC_KEY_RE.test(signingKey)) {
    add(findings, {
      code: 'signing-key-invalid',
      severity: 'error',
      field: 'SIGNING_KEY',
      message: 'SIGNING_KEY is not a valid Stellar public key',
    });
  }

  if (document.ACCOUNTS !== undefined) validateAccounts(document.ACCOUNTS, findings);
  if (document.CURRENCIES !== undefined) validateCurrencies(document.CURRENCIES, findings);
  if (document.PRINCIPALS !== undefined) validatePrincipals(document.PRINCIPALS, findings);

  const documentation = asString(document.DOCUMENTATION);
  if (documentation) {
    try {
      const url = new URL(documentation);
      if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new Error(`unsupported scheme ${url.protocol}`);
      if (url.protocol === 'http:') {
        add(findings, {
          code: 'documentation-insecure',
          severity: 'warning',
          field: 'DOCUMENTATION',
          message: 'DOCUMENTATION uses plain HTTP',
        });
      }
    } catch (error) {
      add(findings, {
        code: 'documentation-invalid',
        severity: 'warning',
        field: 'DOCUMENTATION',
        message: `DOCUMENTATION is not a usable URL: ${errorMessage(error)}`,
      });
    }
  }

  const endpoints: Array<string | null> = [];
  for (const field of SERVICE_ENDPOINT_FIELDS) {
    // Absent optional endpoints are not findings; an endpoint declared with an
    // empty value is reported by validateServiceUrl as a missing value.
    if (document[field] !== undefined) {
      endpoints.push(validateServiceUrl(document[field], field, findings));
    }
  }
  await probeEndpoints(endpoints, findings, options);

  return {
    findings,
    network: { declared: declared ?? null, expected: expected ?? null, consistent },
  };
}

export function buildReport(
  domain: string,
  retrieval: RetrievalResult,
  parsed: ParseResult,
  validation: { findings: Finding[]; network: NetworkConsistency },
): ValidationReport {
  const findings = [
    ...(parsed.ok
      ? []
      : [
          {
            code: 'toml-parse-failed',
            severity: 'error' as const,
            message: parsed.error ?? 'Unknown parse error',
          },
        ]),
    ...validation.findings,
  ];
  if (!retrieval.ok && retrieval.error) {
    findings.unshift({ code: 'retrieval-failed', severity: 'error', message: retrieval.error });
  }
  const counts = {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    infos: findings.filter((f) => f.severity === 'info').length,
  };
  return {
    domain,
    retrieval,
    parse: parsed,
    network: validation.network,
    findings,
    counts,
    overall: counts.errors > 0 ? 'fail' : counts.warnings > 0 ? 'warnings' : 'pass',
  };
}

/** Runs the whole audit: retrieve -> parse -> validate -> report. */
export async function auditStellarToml(
  domain: string,
  options: ValidationOptions = {},
): Promise<ValidationReport> {
  const normalized = normalizeDomain(domain);
  const retrieval = await fetchStellarToml(normalized, options);
  if (!retrieval.ok || retrieval.text === undefined) {
    return buildReport(
      normalized,
      retrieval,
      { ok: false, error: retrieval.error ?? 'No document retrieved' },
      {
        findings: [],
        network: {
          declared: null,
          expected: asString(options.expectedNetworkPassphrase),
          consistent: null,
        },
      },
    );
  }
  const parsed = parseStellarToml(retrieval.text);
  if (!parsed.ok || !parsed.document) {
    return buildReport(normalized, retrieval, parsed, {
      findings: [],
      network: {
        declared: null,
        expected: asString(options.expectedNetworkPassphrase),
        consistent: null,
      },
    });
  }
  const validation = await validateStellarToml(parsed.document, options);
  return buildReport(normalized, retrieval, parsed, validation);
}

const SEVERITY_LABEL: Record<Severity, string> = {
  error: 'ERROR',
  warning: 'WARN ',
  info: 'INFO ',
};

export function formatReport(report: ValidationReport): string {
  const lines: string[] = [
    `SEP-1 stellar.toml validation report`,
    `Domain:      ${report.domain}`,
    `URL:         ${report.retrieval.url}`,
    `Retrieved:   ${report.retrieval.ok ? `yes (HTTP ${report.retrieval.status ?? '?'})` : `no (${report.retrieval.error ?? 'unknown error'})`}`,
    `Parsed:      ${report.parse.ok ? 'yes' : `no (${report.parse.error ?? 'unknown error'})`}`,
    `Network:     declared=${report.network.declared ?? '<missing>'} expected=${report.network.expected ?? '<none>'} consistent=${report.network.consistent === null ? 'unknown' : report.network.consistent ? 'yes' : 'no'}`,
    `Findings:    ${report.counts.errors} error(s), ${report.counts.warnings} warning(s), ${report.counts.infos} info`,
    `Overall:     ${report.overall.toUpperCase()}`,
    '',
  ];
  for (const finding of report.findings) {
    const location = finding.field ? ` [${finding.field}]` : '';
    lines.push(
      `${SEVERITY_LABEL[finding.severity]}${location} ${finding.code}: ${finding.message}`,
    );
  }
  lines.push('', 'Structural validation does not prove that published metadata is trustworthy.');
  return lines.join('\n');
}

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function run(params?: any): Promise<void> {
  const args = (params?.args as string[] | undefined) ?? process.argv.slice(2);
  const domain = params?.domain ?? argumentValue(args, '--domain');
  if (!domain) {
    console.log(
      'Usage: stellar-toml-validator --domain <domain> [--expected-network <passphrase>] [--json] [--check-endpoints]',
    );
    return;
  }
  const report = await auditStellarToml(domain, {
    expectedNetworkPassphrase: params?.expectedNetwork ?? argumentValue(args, '--expected-network'),
    checkEndpoints: params?.checkEndpoints ?? args.includes('--check-endpoints'),
  });
  if (params?.json ?? args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
  if (report.overall === 'fail' && (params?.failOnError ?? args.includes('--fail-on-error'))) {
    process.exitCode = 1;
  }
}
