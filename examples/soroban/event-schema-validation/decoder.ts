/**
 * decoder.ts
 *
 * Decodes Soroban ScVal values from event topics and event data payloads into
 * human-readable TypeScript representations.
 *
 * Design principles:
 * - Never throw. Unsupported or malformed values are returned as `decoded: false`.
 * - Preserve raw XDR for every value regardless of whether decoding succeeded.
 * - BigInts and byte buffers are converted to JSON-safe strings so callers can
 *   serialise decoded output directly.
 * - Topics and event data are decoded through the same path so the report is
 *   consistent.
 */

import { Address, Contract, scValToNative, xdr } from '@stellar/stellar-sdk';
import { RawEventRecord } from './event-query';

// ─── types ───────────────────────────────────────────────────────────────────

/** The result of decoding one ScVal. */
export interface DecodedValue {
  /** XDR discriminant name, e.g. "scvSymbol", "scvI128". */
  xdrType: string;
  /** Base64-encoded XDR for the original value. Empty string if serialisation failed. */
  rawXdr: string;
  /** Decoded, JSON-safe representation. null for void or on decoding failure. */
  value: unknown;
  /** True when `scValToNative` succeeded. */
  decoded: boolean;
  /** Error message when `decoded` is false. */
  error?: string;
}

/** A fully parsed event record ready for schema validation and reporting. */
export interface ParsedEventRecord {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  contractId: string;
  /** Decoded event name, taken from the first symbol topic. null if unavailable. */
  eventName: string | null;
  topics: DecodedValue[];
  value: DecodedValue;
  inSuccessfulContractCall: boolean;
  pagingToken: string;
}

// ─── ScVal type name ──────────────────────────────────────────────────────────

/** Returns the XDR discriminant name for an ScVal, e.g. "scvSymbol". */
export function getScValType(scVal: xdr.ScVal): string {
  try {
    const discriminant = (scVal as unknown as { switch?: () => { name?: string } }).switch?.();
    return discriminant?.name ?? String(discriminant ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

// ─── JSON-safe conversion ─────────────────────────────────────────────────────

/**
 * Converts decoded native values into forms that JSON.stringify can handle.
 *
 * - BigInt → string
 * - Uint8Array / Buffer → "0x..." hex string
 * - Array → recursively formatted array
 * - Map → plain object (keys formatted)
 * - Plain object → recursively formatted object
 * - null / undefined / primitives → unchanged
 */
export function formatNativeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'bigint') return value.toString();

  if (value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString('hex')}`;
  }

  if (Array.isArray(value)) {
    return value.map(formatNativeValue);
  }

  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      obj[String(formatNativeValue(k))] = formatNativeValue(v);
    }
    return obj;
  }

  if (typeof value === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = formatNativeValue(v);
    }
    return obj;
  }

  return value;
}

// ─── ScVal decoder ────────────────────────────────────────────────────────────

/**
 * ScVal types that `scValToNative` does not support.
 * Raw XDR is preserved; `decoded` is false.
 */
const UNSUPPORTED_TYPES = new Set([
  'scvContractInstanceWasm',
  'scvLedgerKeyContractInstance',
  'scvLedgerKeyNonce',
]);

/**
 * Decodes a single ScVal without throwing.
 *
 * Undefined input is treated as `scvVoid`.
 * Unsupported types and XDR decode failures set `decoded: false` and preserve
 * raw XDR for debugging.
 */
export function decodeScVal(scVal: xdr.ScVal | undefined): DecodedValue {
  if (!scVal) {
    return { xdrType: 'void', rawXdr: '', value: null, decoded: true };
  }

  const xdrType = getScValType(scVal);
  let rawXdr = '';
  try {
    rawXdr = scVal.toXDR('base64');
  } catch {
    rawXdr = '(could not serialize)';
  }

  if (UNSUPPORTED_TYPES.has(xdrType)) {
    return {
      xdrType,
      rawXdr,
      value: null,
      decoded: false,
      error: `ScVal type "${xdrType}" is not supported for native decoding`,
    };
  }

  try {
    const native = scValToNative(scVal);
    return { xdrType, rawXdr, value: formatNativeValue(native), decoded: true };
  } catch (err: unknown) {
    return {
      xdrType,
      rawXdr,
      value: null,
      decoded: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Renders a decoded value as a short human-readable string for display.
 *
 * - Void → "void"
 * - Undecoded → "undecodable (<xdrType>)"
 * - Strings and symbols → quoted
 * - Objects, arrays → JSON
 * - Everything else → String()
 */
export function renderDecodedValue(decoded: DecodedValue): string {
  if (decoded.xdrType === 'void') return 'void';
  if (!decoded.decoded) return `undecodable (${decoded.xdrType})`;

  const v = decoded.value;
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}

// ─── address extraction ────────────────────────────────────────────────────────

/**
 * Extracts a contract strkey from a Contract instance, a plain strkey string,
 * or an Address. Returns an empty string for unrecognised inputs.
 */
export function extractContractId(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (input instanceof Contract) {
    try {
      return input.address().toString();
    } catch {
      return '';
    }
  }
  if (input instanceof Address) {
    try {
      return input.toString();
    } catch {
      return '';
    }
  }
  return '';
}

// ─── event name ───────────────────────────────────────────────────────────────

/**
 * Extracts the event name from a list of decoded topics.
 * By convention, Soroban events place a symbol as their first topic.
 * Returns null when the first topic is not a symbol.
 */
export function extractEventName(topics: DecodedValue[]): string | null {
  if (!topics.length) return null;
  const first = topics[0];
  if (first.xdrType === 'scvSymbol' && first.decoded && typeof first.value === 'string') {
    return first.value;
  }
  return null;
}

// ─── full record parser ───────────────────────────────────────────────────────

/**
 * Parses a raw RPC event record into a typed, decoded structure.
 *
 * - All topics are decoded individually.
 * - The event data payload is decoded.
 * - The event name is extracted from the first symbol topic.
 * - `inSuccessfulContractCall` defaults to true when absent.
 * - `contractId` is extracted from whatever the server returned.
 */
export function parseEventRecord(raw: RawEventRecord): ParsedEventRecord {
  const topics = (raw.topic ?? []).map(decodeScVal);
  const value = decodeScVal(raw.value);
  const contractId = extractContractId(raw.contractId) || '';

  return {
    id: raw.id,
    type: raw.type,
    ledger: raw.ledger,
    ledgerClosedAt: raw.ledgerClosedAt,
    txHash: raw.txHash,
    contractId,
    eventName: extractEventName(topics),
    topics,
    value,
    inSuccessfulContractCall: raw.inSuccessfulContractCall ?? true,
    pagingToken: raw.pagingToken,
  };
}
