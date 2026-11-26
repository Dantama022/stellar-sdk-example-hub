/**
 * Diagnostic extraction and redaction.
 *
 * Pulls whatever structured information is available out of an error or RPC
 * response without assuming any provider returns the same fields. Anything
 * absent is simply left undefined.
 */

import { StrKey, scValToNative, xdr } from '@stellar/stellar-sdk';

export interface HostError {
  /** ScErrorType name without the `sce` prefix, e.g. `Contract`, `Budget`, `Auth`. */
  type: string;
  /** Numeric contract error (`#12`) or ScErrorCode name (`ExceededLimit`). */
  code: string;
}

export interface DiagnosticEventSummary {
  type: string;
  contractId?: string;
  topics: unknown[];
  data: unknown;
}

export interface Diagnostics {
  message: string;
  errorName?: string;
  errorCode?: string;
  httpStatus?: number;
  rpcStatus?: string;
  transactionHash?: string;
  latestLedger?: number;
  hostError?: HostError;
  contractErrorCode?: number;
  transactionResultCode?: string;
  operationResultCodes: string[];
  diagnosticEvents: DiagnosticEventSummary[];
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SENSITIVE_KEY = /secret|private|seed|mnemonic|passw|token|api[-_]?key|authorization|signature|signer|cookie|credential|bearer/i;
const STELLAR_SECRET = /\bS[A-D][A-Z2-7]{54}\b/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const URL_SECRET = /([?&](?:api[-_]?key|token|access_token|key|secret|signature)=)[^&\s]+/gi;
const BASE64_BLOB = /\b[A-Za-z0-9+/]{200,}={0,2}/g;

export const REDACTED = '[REDACTED]';

export function redactString(text: string): string {
  return text
    .replace(STELLAR_SECRET, REDACTED)
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(URL_SECRET, `$1${REDACTED}`)
    // Long base64 blobs are typically envelopes carrying signatures or auth entries.
    .replace(BASE64_BLOB, '[REDACTED-XDR]');
}

/** Deep redaction for plain objects/arrays. Never mutates its input. */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1));
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactSensitive(v, depth + 1);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const HOST_ERROR = /Error\((Contract|WasmVm|Context|Storage|Object|Crypto|Events|Budget|Value|Auth),\s*(#?\w+)\)/;

/** Parse the host's `Error(<Type>, <Code>)` notation out of free text. */
export function parseHostError(text: string): HostError | undefined {
  const m = HOST_ERROR.exec(text);
  return m ? { type: m[1], code: m[2] } : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  const rec = asRecord(error);
  if (rec) {
    for (const key of ['message', 'error', 'detail', 'title']) {
      if (typeof rec[key] === 'string') return rec[key] as string;
    }
    const response = asRecord(rec.response);
    const data = asRecord(response?.data);
    if (typeof data?.message === 'string') return data.message;
    if (typeof data?.title === 'string') return data.title;
  }
  return error === undefined || error === null ? '' : String(error);
}

export interface ParsedTransactionResult {
  transactionResultCode?: string;
  /** Names such as `opInner`, `opBadAuth`. */
  operationResultCodes: string[];
  /** Names of the inner result of each operation, e.g. `invokeHostFunctionTrapped`. */
  innerResultCodes: string[];
}

/** Read a TransactionResult given as XDR object or base64. Returns undefined when unreadable. */
export function parseTransactionResult(input: unknown): ParsedTransactionResult | undefined {
  try {
    const result =
      typeof input === 'string'
        ? xdr.TransactionResult.fromXDR(input, 'base64')
        : (input as xdr.TransactionResult | undefined);
    if (!result || typeof result.result !== 'function') return undefined;

    const outer = result.result();
    let transactionResultCode: string = outer.switch().name;
    let operations: xdr.OperationResult[] | undefined;
    if (transactionResultCode === 'txFailed' || transactionResultCode === 'txSuccess') {
      operations = outer.results();
    } else if (transactionResultCode === 'txFeeBumpInnerFailed' || transactionResultCode === 'txFeeBumpInnerSuccess') {
      const inner = outer.innerResultPair().result().result();
      transactionResultCode = `${transactionResultCode}/${inner.switch().name}`;
      if (inner.switch().name === 'txFailed' || inner.switch().name === 'txSuccess') operations = inner.results();
    }

    const operationResultCodes: string[] = [];
    const innerResultCodes: string[] = [];
    for (const op of operations ?? []) {
      operationResultCodes.push(op.switch().name);
      if (op.switch().name === 'opInner') {
        const tr = op.tr();
        const kind = tr.switch().name;
        if (kind === 'invokeHostFunction') innerResultCodes.push(tr.invokeHostFunctionResult().switch().name);
        else if (kind === 'extendFootprintTtl') innerResultCodes.push(tr.extendFootprintTtlResult().switch().name);
        else if (kind === 'restoreFootprint') innerResultCodes.push(tr.restoreFootprintResult().switch().name);
        else innerResultCodes.push(kind);
      }
    }
    return { transactionResultCode, operationResultCodes, innerResultCodes };
  } catch {
    return undefined;
  }
}

function toEvent(raw: unknown): xdr.DiagnosticEvent | undefined {
  try {
    if (typeof raw === 'string') return xdr.DiagnosticEvent.fromXDR(raw, 'base64');
    if (raw && typeof (raw as xdr.DiagnosticEvent).event === 'function') return raw as xdr.DiagnosticEvent;
  } catch {
    // unreadable event: skip
  }
  return undefined;
}

function safeNative(val: xdr.ScVal): unknown {
  try {
    const n = scValToNative(val);
    return typeof n === 'bigint' ? n.toString() : redactSensitive(n);
  } catch {
    return `<${val.switch().name}>`;
  }
}

/** Summarise diagnostic events (objects or base64 XDR), capped to keep reports small. */
export function summarizeDiagnosticEvents(raw: unknown, max = 20): DiagnosticEventSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: DiagnosticEventSummary[] = [];
  for (const item of raw.slice(0, max)) {
    const de = toEvent(item);
    if (!de) continue;
    const ev = de.event();
    const body = ev.body().v0();
    const id = ev.contractId();
    out.push({
      type: ev.type().name,
      contractId: id ? StrKey.encodeContract(Buffer.from(id)) : undefined,
      topics: body.topics().map(safeNative),
      data: safeNative(body.data()),
    });
  }
  return out;
}

/** Collect diagnostics from an error and/or RPC response. */
export function extractDiagnostics(input: { error?: unknown; response?: unknown; transactionHash?: string }): Diagnostics {
  const err = asRecord(input.error);
  const res = asRecord(input.response);
  const errResponse = asRecord(err?.response);

  const messageParts = [errorMessage(input.error), typeof res?.error === 'string' ? res.error : ''].filter(Boolean);
  const message = redactString(messageParts.join(' | '));

  const errorResult = res?.errorResult ?? res?.errorResultXdr ?? res?.resultXdr;
  const parsed = parseTransactionResult(errorResult);
  const host = parseHostError(messageParts.join(' '));
  const contractErrorCode = host?.type === 'Contract' && host.code.startsWith('#') ? Number(host.code.slice(1)) : undefined;

  const status =
    typeof errResponse?.status === 'number'
      ? errResponse.status
      : typeof err?.status === 'number'
        ? err.status
        : typeof err?.statusCode === 'number'
          ? err.statusCode
          : undefined;

  return {
    message,
    errorName: input.error instanceof Error ? input.error.name : typeof err?.name === 'string' ? err.name : undefined,
    errorCode: typeof err?.code === 'string' ? err.code : undefined,
    httpStatus: status,
    rpcStatus: typeof res?.status === 'string' ? res.status : undefined,
    transactionHash: input.transactionHash ?? (typeof res?.hash === 'string' ? res.hash : typeof res?.txHash === 'string' ? res.txHash : undefined),
    latestLedger: typeof res?.latestLedger === 'number' ? res.latestLedger : undefined,
    hostError: host,
    contractErrorCode: Number.isFinite(contractErrorCode) ? contractErrorCode : undefined,
    transactionResultCode: parsed?.transactionResultCode,
    operationResultCodes: [...(parsed?.operationResultCodes ?? []), ...(parsed?.innerResultCodes ?? [])],
    diagnosticEvents: summarizeDiagnosticEvents(res?.diagnosticEvents ?? res?.diagnosticEventsXdr ?? res?.events),
  };
}
