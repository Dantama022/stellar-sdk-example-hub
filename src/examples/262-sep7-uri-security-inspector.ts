/**
 * 262 — SEP-7 URI validation and transaction request security inspector (issue #594).
 *
 * Parses a `web+stellar:` URI (SEP-7), validates the `pay` or `tx` request it
 * carries, decodes any transaction XDR with the SDK, inspects the callback and
 * network parameters, and produces a report with a severity per finding.
 *
 * It is an inspector only: it never signs, never submits, never fetches the
 * `origin_domain` stellar.toml and never contacts the callback URL. Because of
 * that, a request `signature` is reported as *unverified*: confirming it needs
 * the URI_REQUEST_SIGNING_KEY published by the origin domain.
 *
 * Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 */
import {
  FeeBumpTransaction,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

// ── Types ────────────────────────────────────────────────────────────────────

export type Severity = 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
}

export type Sep7Operation = 'pay' | 'tx';

export interface ParsedSep7Uri {
  original: string;
  operation: string;
  params: Map<string, string>;
  /** Keys whose raw value contained a literal `+`, which URL decoding turns into a space. */
  plusDecoded: string[];
}

export interface InspectOptions {
  /** Passphrase the wallet is configured for. Defaults to Public Network (the SEP-7 default). */
  expectedNetworkPassphrase?: string;
  /** Operation types considered expected inside a `tx` request. */
  allowedOperations?: string[];
  /** Total fee (stroops) above which a `tx` request is flagged. */
  maxFeeStroops?: number;
}

export interface Sep7Report {
  uri: string;
  operation: string | null;
  parsed: boolean;
  destination?: string;
  asset?: string;
  amount?: string;
  memo?: { type: string; value: string };
  transaction?: {
    decoded: boolean;
    source?: string;
    feeStroops?: string;
    operations?: string[];
    timeBounds?: { minTime: string; maxTime: string } | null;
  };
  network: { passphrase: string; expected: string; matches: boolean };
  callback?: { url: string; scheme: string };
  originDomain?: string;
  signature: 'absent' | 'present-unverified';
  findings: Finding[];
  status: 'valid' | 'valid-with-warnings' | 'invalid';
}

// ── Constants ────────────────────────────────────────────────────────────────

const SCHEME = 'web+stellar:';
const SUPPORTED: readonly Sep7Operation[] = ['pay', 'tx'];
const PAY_PARAMS = new Set([
  'destination',
  'amount',
  'asset_code',
  'asset_issuer',
  'memo',
  'memo_type',
  'callback',
  'msg',
  'network_passphrase',
  'origin_domain',
  'signature',
]);
const TX_PARAMS = new Set([
  'xdr',
  'replace',
  'callback',
  'pubkey',
  'chain',
  'msg',
  'network_passphrase',
  'origin_domain',
  'signature',
]);
const MEMO_TYPES = new Set(['MEMO_TEXT', 'MEMO_ID', 'MEMO_HASH', 'MEMO_RETURN']);
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const STROOPS_PER_UNIT = 10_000_000n;
const MAX_MSG_LENGTH = 300;

/** Operations a payment-style transaction request normally contains. */
export const DEFAULT_ALLOWED_OPERATIONS = [
  'payment',
  'pathPaymentStrictSend',
  'pathPaymentStrictReceive',
  'createAccount',
  'changeTrust',
];

/** Operations that can hand over control of an account or its assets. */
const HIGH_RISK_OPERATIONS = new Set([
  'setOptions',
  'accountMerge',
  'setTrustLineFlags',
  'allowTrust',
  'revokeSponsorship',
  'clawback',
  'clawbackClaimableBalance',
]);

// ── 1. Parsing ───────────────────────────────────────────────────────────────

export class Sep7ParseError extends Error {}

/**
 * Parse a SEP-7 URI with the WHATWG URL parser. Each query value is decoded
 * exactly once. Malformed percent-encoding and duplicate keys are rejected
 * rather than silently repaired.
 */
export function parseSep7Uri(uri: string): ParsedSep7Uri {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new Sep7ParseError('Not a valid URI');
  }
  if (url.protocol !== SCHEME) throw new Sep7ParseError(`Scheme must be ${SCHEME}`);

  const raw = url.search.replace(/^\?/, '');
  const params = new Map<string, string>();
  const plusDecoded: string[] = [];
  for (const pair of raw ? raw.split('&') : []) {
    const separator = pair.indexOf('=');
    const rawKey = separator === -1 ? pair : pair.slice(0, separator);
    const rawValue = separator === -1 ? '' : pair.slice(separator + 1);
    let key: string;
    let value: string;
    try {
      // Same rule as URLSearchParams ('+' is a space), but strict about bad escapes.
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      throw new Sep7ParseError(`Malformed percent-encoding in parameter "${rawKey}"`);
    }
    if (params.has(key)) throw new Sep7ParseError(`Duplicate parameter "${key}"`);
    if (rawValue.includes('+')) plusDecoded.push(key);
    params.set(key, value);
  }
  return { original: uri, operation: url.pathname, params, plusDecoded };
}

// ── 2–4. Validation ──────────────────────────────────────────────────────────

function isAccount(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value) || StrKey.isValidMed25519PublicKey(value);
}

function validateAmount(value: string, findings: Finding[]): void {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(value);
  if (!match) {
    findings.push({
      severity: 'high',
      code: 'invalid-amount',
      message: `Amount "${value}" is not a positive decimal with at most 7 places`,
    });
    return;
  }
  const stroops = BigInt(match[1]) * STROOPS_PER_UNIT + BigInt((match[2] ?? '').padEnd(7, '0'));
  if (stroops === 0n)
    findings.push({
      severity: 'high',
      code: 'invalid-amount',
      message: 'Amount must be greater than zero',
    });
  else if (stroops > MAX_INT64)
    findings.push({
      severity: 'high',
      code: 'invalid-amount',
      message: 'Amount exceeds the Stellar int64 limit',
    });
}

function validateAsset(params: Map<string, string>, findings: Finding[]): string {
  const code = params.get('asset_code');
  const issuer = params.get('asset_issuer');
  if (code === undefined) {
    if (issuer !== undefined)
      findings.push({
        severity: 'high',
        code: 'invalid-asset',
        message: 'asset_issuer given without asset_code',
      });
    return 'native (XLM)';
  }
  if (!/^[A-Za-z0-9]{1,12}$/.test(code)) {
    findings.push({
      severity: 'high',
      code: 'invalid-asset',
      message: `asset_code "${code}" must be 1-12 alphanumeric characters`,
    });
  }
  if (issuer === undefined) {
    findings.push({
      severity: 'high',
      code: 'invalid-asset',
      message: 'asset_code requires asset_issuer',
    });
  } else if (!StrKey.isValidEd25519PublicKey(issuer)) {
    findings.push({
      severity: 'high',
      code: 'invalid-asset',
      message: 'asset_issuer is not a valid G... account',
    });
  }
  return `${code}:${issuer ?? '?'}`;
}

function validateMemo(params: Map<string, string>, findings: Finding[]): Sep7Report['memo'] {
  const value = params.get('memo');
  const type = params.get('memo_type');
  if (value === undefined) {
    if (type !== undefined)
      findings.push({
        severity: 'medium',
        code: 'invalid-memo',
        message: 'memo_type given without memo',
      });
    return undefined;
  }
  const memoType = type ?? 'MEMO_TEXT';
  if (!MEMO_TYPES.has(memoType)) {
    findings.push({
      severity: 'high',
      code: 'invalid-memo-type',
      message: `memo_type "${memoType}" is not one of ${[...MEMO_TYPES].join(', ')}`,
    });
    return { type: memoType, value };
  }
  if (memoType === 'MEMO_TEXT' && Buffer.byteLength(value, 'utf8') > 28) {
    findings.push({
      severity: 'high',
      code: 'invalid-memo',
      message: 'MEMO_TEXT is longer than 28 bytes',
    });
  }
  if (memoType === 'MEMO_ID' && (!/^\d+$/.test(value) || BigInt(value) > MAX_UINT64)) {
    findings.push({
      severity: 'high',
      code: 'invalid-memo',
      message: 'MEMO_ID must be an unsigned 64-bit integer',
    });
  }
  if (memoType === 'MEMO_HASH' || memoType === 'MEMO_RETURN') {
    // SEP-7 carries hash memos base64-encoded.
    const bytes = /^[A-Za-z0-9+/]+={0,2}$/.test(value)
      ? Buffer.from(value, 'base64')
      : Buffer.alloc(0);
    if (bytes.length !== 32)
      findings.push({
        severity: 'high',
        code: 'invalid-memo',
        message: `${memoType} must be 32 bytes, base64-encoded`,
      });
  }
  return { type: memoType, value };
}

function inspectTransaction(
  params: Map<string, string>,
  passphrase: string,
  options: Required<InspectOptions>,
  findings: Finding[],
): Sep7Report['transaction'] {
  const envelope = params.get('xdr');
  if (envelope === undefined) return undefined;
  let tx: Transaction | FeeBumpTransaction;
  try {
    tx = TransactionBuilder.fromXDR(envelope, passphrase);
  } catch {
    findings.push({
      severity: 'high',
      code: 'malformed-xdr',
      message: 'xdr is not a decodable transaction envelope',
    });
    return { decoded: false };
  }

  const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
  if (tx instanceof FeeBumpTransaction) {
    findings.push({
      severity: 'medium',
      code: 'fee-bump',
      message: `Fee-bump envelope: fees are paid by ${tx.feeSource}`,
    });
  }
  const operations = inner.operations.map((op) => op.type);
  for (const op of inner.operations) {
    if (HIGH_RISK_OPERATIONS.has(op.type)) {
      findings.push({
        severity: 'high',
        code: 'unexpected-operation',
        message: `${op.type} can change account control or asset authorization`,
      });
    } else if (!options.allowedOperations.includes(op.type)) {
      findings.push({
        severity: 'medium',
        code: 'unexpected-operation',
        message: `${op.type} is not in the allowed operation list`,
      });
    }
    if (op.source && op.source !== inner.source) {
      findings.push({
        severity: 'medium',
        code: 'operation-source',
        message: `${op.type} runs as a different source account: ${op.source}`,
      });
    }
  }
  const pubkey = params.get('pubkey');
  if (pubkey !== undefined && pubkey !== inner.source) {
    findings.push({
      severity: 'medium',
      code: 'pubkey-mismatch',
      message: 'pubkey does not match the transaction source account',
    });
  }

  const fee = BigInt(tx.fee);
  if (fee > BigInt(options.maxFeeStroops)) {
    findings.push({
      severity: 'medium',
      code: 'high-fee',
      message: `Fee ${fee} stroops exceeds the configured ${options.maxFeeStroops}`,
    });
  }
  const bounds = inner.timeBounds ?? null;
  if (!bounds || bounds.maxTime === '0') {
    findings.push({
      severity: 'low',
      code: 'no-expiry',
      message:
        'Transaction has no upper time bound and stays valid until its sequence number is used',
    });
  }
  if (inner.signatures.length > 0) {
    findings.push({
      severity: 'info',
      code: 'pre-signed',
      message: `Envelope already carries ${inner.signatures.length} signature(s)`,
    });
  }
  return {
    decoded: true,
    source: inner.source,
    feeStroops: fee.toString(),
    operations,
    timeBounds: bounds,
  };
}

function inspectCallback(value: string | undefined, findings: Finding[]): Sep7Report['callback'] {
  if (value === undefined) return undefined;
  // SEP-7: the callback value is "url:" followed by the URL; nothing is ever requested here.
  if (!value.startsWith('url:')) {
    findings.push({
      severity: 'high',
      code: 'invalid-callback',
      message: 'callback must start with "url:"',
    });
    return { url: value, scheme: 'unknown' };
  }
  let url: URL;
  try {
    url = new URL(value.slice(4));
  } catch {
    findings.push({
      severity: 'high',
      code: 'invalid-callback',
      message: 'callback URL is not a valid absolute URL',
    });
    return { url: value.slice(4), scheme: 'unknown' };
  }
  if (url.protocol !== 'https:') {
    findings.push({
      severity: 'high',
      code: 'insecure-callback',
      message: `callback uses ${url.protocol} instead of https: and could expose the signed transaction`,
    });
  }
  if (url.username || url.password) {
    findings.push({
      severity: 'medium',
      code: 'callback-credentials',
      message: 'callback URL embeds credentials',
    });
  }
  findings.push({
    severity: 'info',
    code: 'external-callback',
    message: `Signed transaction would be POSTed to ${url.host}; confirm you trust it`,
  });
  return { url: redactUrl(url), scheme: url.protocol.replace(':', '') };
}

// ── 5. Security analysis ─────────────────────────────────────────────────────

export function inspectSep7Uri(uri: string, opts: InspectOptions = {}): Sep7Report {
  const options: Required<InspectOptions> = {
    expectedNetworkPassphrase: opts.expectedNetworkPassphrase ?? Networks.PUBLIC,
    allowedOperations: opts.allowedOperations ?? DEFAULT_ALLOWED_OPERATIONS,
    maxFeeStroops: opts.maxFeeStroops ?? 1_000_000,
  };
  const findings: Finding[] = [];
  const network: Sep7Report['network'] = {
    passphrase: Networks.PUBLIC,
    expected: options.expectedNetworkPassphrase,
    matches: true,
  };

  let parsed: ParsedSep7Uri;
  try {
    parsed = parseSep7Uri(uri);
  } catch (error) {
    findings.push({ severity: 'high', code: 'parse-error', message: (error as Error).message });
    return finalize({
      uri: redactUri(uri),
      operation: null,
      parsed: false,
      network,
      signature: 'absent',
      findings,
    });
  }
  const { params } = parsed;
  const report: Omit<Sep7Report, 'status'> = {
    uri: redactUri(uri),
    operation: parsed.operation,
    parsed: true,
    network,
    signature: params.has('signature') ? 'present-unverified' : 'absent',
    findings,
  };

  if (!(SUPPORTED as readonly string[]).includes(parsed.operation)) {
    findings.push({
      severity: 'high',
      code: 'unsupported-operation',
      message: `Unsupported SEP-7 operation "${parsed.operation}" (expected pay or tx)`,
    });
    return finalize(report);
  }
  const known = parsed.operation === 'pay' ? PAY_PARAMS : TX_PARAMS;
  for (const key of params.keys()) {
    if (!known.has(key))
      findings.push({
        severity: 'low',
        code: 'unknown-parameter',
        message: `Unknown parameter "${key}" is ignored`,
      });
  }
  for (const key of parsed.plusDecoded) {
    findings.push({
      severity: 'medium',
      code: 'plus-in-value',
      message: `"${key}" contains a literal "+", decoded as a space; it should be percent-encoded as %2B`,
    });
  }

  network.passphrase = params.get('network_passphrase') ?? Networks.PUBLIC;
  network.matches = network.passphrase === options.expectedNetworkPassphrase;
  if (!network.matches) {
    findings.push({
      severity: 'high',
      code: 'network-mismatch',
      message: `Request targets "${network.passphrase}" but the wallet expects "${options.expectedNetworkPassphrase}"`,
    });
  }

  const msg = params.get('msg');
  if (msg !== undefined && msg.length > MAX_MSG_LENGTH) {
    findings.push({
      severity: 'low',
      code: 'long-message',
      message: `msg exceeds ${MAX_MSG_LENGTH} characters`,
    });
  }
  report.originDomain = params.get('origin_domain');
  if (report.originDomain !== undefined && !params.has('signature')) {
    findings.push({
      severity: 'high',
      code: 'unsigned-origin',
      message: 'origin_domain is set but the request has no signature',
    });
  }
  if (params.has('signature')) {
    findings.push({
      severity: 'info',
      code: 'signature-unverified',
      message: "Signature not verified: needs the origin domain's URI_REQUEST_SIGNING_KEY",
    });
  }
  report.callback = inspectCallback(params.get('callback'), findings);

  if (parsed.operation === 'pay') {
    const destination = params.get('destination');
    if (destination === undefined) {
      findings.push({
        severity: 'high',
        code: 'missing-parameter',
        message: 'pay requires destination',
      });
    } else {
      report.destination = destination;
      if (!isAccount(destination)) {
        findings.push({
          severity: 'high',
          code: 'invalid-destination',
          message: 'destination is not a valid G... or M... account',
        });
      }
    }
    report.asset = validateAsset(params, findings);
    const amount = params.get('amount');
    if (amount === undefined) {
      findings.push({
        severity: 'info',
        code: 'open-amount',
        message: 'No amount: the wallet will ask the user to enter one',
      });
    } else {
      report.amount = amount;
      validateAmount(amount, findings);
    }
    report.memo = validateMemo(params, findings);
  } else {
    if (!params.has('xdr')) {
      findings.push({ severity: 'high', code: 'missing-parameter', message: 'tx requires xdr' });
    }
    report.transaction = inspectTransaction(params, network.passphrase, options, findings);
    if (params.has('replace')) {
      findings.push({
        severity: 'medium',
        code: 'replace-fields',
        message:
          'replace asks the wallet to fill in fields; review the final transaction before signing',
      });
    }
    if (params.has('chain')) {
      findings.push({
        severity: 'low',
        code: 'chained-request',
        message: 'chain embeds another SEP-7 request, which is not inspected here',
      });
    }
  }
  return finalize(report);
}

function finalize(report: Omit<Sep7Report, 'status'>): Sep7Report {
  const status = report.findings.some((f) => f.severity === 'high')
    ? 'invalid'
    : report.findings.some((f) => f.severity === 'medium')
      ? 'valid-with-warnings'
      : 'valid';
  return { ...report, status };
}

// ── 6. Reporting (with redaction) ────────────────────────────────────────────

function redactUrl(url: URL): string {
  const copy = new URL(url.href);
  copy.username = copy.username ? 'REDACTED' : '';
  copy.password = '';
  copy.search = copy.search ? '?REDACTED' : '';
  return copy.href;
}

/** Redact the request signature, callback query/credentials and abbreviate transaction XDR. */
export function redactUri(uri: string): string {
  return uri
    .replace(/([?&]signature=)[^&]*/g, '$1REDACTED')
    .replace(/([?&]xdr=)([^&]{0,16})[^&]*/g, (_m, key: string, head: string) => `${key}${head}...`)
    .replace(/([?&]callback=)([^&]*)/g, (_m, key: string, value: string) => {
      try {
        const decoded = decodeURIComponent(value);
        return decoded.startsWith('url:')
          ? `${key}${encodeURIComponent(`url:${redactUrl(new URL(decoded.slice(4)))}`)}`
          : `${key}REDACTED`;
      } catch {
        return `${key}REDACTED`;
      }
    });
}

export function formatReport(report: Sep7Report): string {
  const lines = [
    `SEP-7 URI inspection: ${report.status.toUpperCase()}`,
    `  URI:         ${report.uri}`,
    `  Operation:   ${report.operation ?? '(unparsed)'}`,
    `  Parsed:      ${report.parsed}`,
    `  Network:     ${report.network.passphrase} (${report.network.matches ? 'matches' : 'MISMATCH'})`,
  ];
  if (report.destination) lines.push(`  Destination: ${report.destination}`);
  if (report.asset) lines.push(`  Asset:       ${report.asset}`);
  if (report.amount) lines.push(`  Amount:      ${report.amount}`);
  if (report.memo) lines.push(`  Memo:        ${report.memo.type} ${report.memo.value}`);
  if (report.transaction) {
    const t = report.transaction;
    lines.push(`  XDR:         ${t.decoded ? 'decoded' : 'NOT decodable'}`);
    if (t.decoded) {
      lines.push(
        `  Source:      ${t.source}`,
        `  Fee:         ${t.feeStroops} stroops`,
        `  Operations:  ${t.operations?.join(', ')}`,
      );
    }
  }
  if (report.callback) lines.push(`  Callback:    ${report.callback.url}`);
  lines.push(`  Signature:   ${report.signature}`, '  Findings:');
  if (!report.findings.length) lines.push('    (none)');
  for (const f of report.findings)
    lines.push(`    [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
  lines.push('  Nothing was signed, submitted or fetched.');
  return lines.join('\n');
}

// ── Runner entry point ───────────────────────────────────────────────────────

/** Deterministic demo request used when no URI is given. */
const DEMO_URI =
  'web+stellar:pay?destination=GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO' +
  '&amount=120.1234567&memo=skdjfasf&msg=pay%20me%20with%20lumens';

export async function run(params: { uri?: string; json?: boolean } = {}): Promise<void> {
  const uri = params.uri || process.env.SEP7_URI || process.argv[3] || DEMO_URI;
  const report = inspectSep7Uri(uri, {
    expectedNetworkPassphrase: process.env.NETWORK_PASSPHRASE || Networks.PUBLIC,
  });
  console.log(
    params.json || process.env.JSON === '1'
      ? JSON.stringify(report, null, 2)
      : formatReport(report),
  );
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
