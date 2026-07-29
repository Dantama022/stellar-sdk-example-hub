import { scValToNative, xdr } from '@stellar/stellar-sdk';

/** A decoded ScVal with its XDR type name and JSON-safe native value. */
export interface DecodedScVal {
  xdrType: string;
  rawXdr: string;
  value: unknown;
  decoded: boolean;
  error?: string;
}

/** Side-by-side raw XDR and decoded representation for display. */
export interface ScValComparison {
  xdrType: string;
  rawXdr: string;
  decodedDisplay: string;
  decoded: boolean;
}

const UNSUPPORTED_XDR_TYPES = new Set(['scvContractInstanceWasm', 'scvLedgerKeyContractInstance']);

/** Returns the XDR discriminant name for an ScVal, or "unknown" on failure. */
export function getScValXdrType(scVal: xdr.ScVal): string {
  try {
    const discriminant = (scVal as unknown as { switch?: () => { name?: string } }).switch?.();
    return discriminant?.name ?? String(discriminant ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

/**
 * Converts decoded native values into JSON-safe representations.
 *
 * BigInts become strings, byte buffers become hex, and Maps become plain objects.
 */
export function formatNativeValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString('hex')}`;
  }

  if (Array.isArray(value)) {
    return value.map(formatNativeValue);
  }

  if (value instanceof Map) {
    const entries: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) {
      entries[String(formatNativeValue(key))] = formatNativeValue(entry);
    }
    return entries;
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = formatNativeValue(entry);
    }
    return out;
  }

  return value;
}

/** Decodes one ScVal without throwing; unsupported types are reported gracefully. */
export function decodeScVal(scVal: xdr.ScVal | undefined): DecodedScVal {
  if (!scVal) {
    return { xdrType: 'void', rawXdr: '', value: null, decoded: true };
  }

  const xdrType = getScValXdrType(scVal);
  let rawXdr = '';
  try {
    rawXdr = scVal.toXDR('base64');
  } catch {
    rawXdr = '(could not serialize)';
  }

  if (UNSUPPORTED_XDR_TYPES.has(xdrType)) {
    return {
      xdrType,
      rawXdr,
      value: null,
      decoded: false,
      error: `ScVal type "${xdrType}" is not supported for native decoding in this example`,
    };
  }

  try {
    return {
      xdrType,
      rawXdr,
      value: formatNativeValue(scValToNative(scVal)),
      decoded: true,
    };
  } catch (error: any) {
    return {
      xdrType,
      rawXdr,
      value: null,
      decoded: false,
      error: error?.message || String(error),
    };
  }
}

/** Renders a decoded value as a single-line human-readable string. */
export function renderDecodedValue(decoded: DecodedScVal): string {
  if (!decoded.decoded) {
    return `<undecodable: ${decoded.error ?? 'unknown error'}>`;
  }
  if (typeof decoded.value === 'string') {
    return `"${decoded.value}"`;
  }
  if (decoded.value === null || decoded.value === undefined) {
    return 'void';
  }
  return JSON.stringify(decoded.value);
}

/** Builds a raw-vs-decoded comparison row for console output. */
export function compareScVal(scVal: xdr.ScVal | undefined): ScValComparison {
  const decoded = decodeScVal(scVal);
  return {
    xdrType: decoded.xdrType,
    rawXdr: decoded.rawXdr,
    decodedDisplay: renderDecodedValue(decoded),
    decoded: decoded.decoded,
  };
}

/** Decodes an event topic tuple in order. */
export function decodeTopics(topics: xdr.ScVal[] | undefined): DecodedScVal[] {
  return (topics ?? []).map(decodeScVal);
}

/** Decodes an event data payload. */
export function decodePayload(value: xdr.ScVal | undefined): DecodedScVal {
  return decodeScVal(value);
}

/** Formats topics and payload with raw XDR shown alongside decoded values. */
export function formatEventDecodingReport(options: {
  contractId: string;
  ledger: number;
  txHash: string;
  topics: xdr.ScVal[];
  value?: xdr.ScVal;
}): string {
  const lines: string[] = [];
  lines.push('=== Soroban Contract Event Decoding ===');
  lines.push(`Contract ID     : ${options.contractId}`);
  lines.push(`Ledger sequence : ${options.ledger}`);
  lines.push(`Transaction hash: ${options.txHash}`);
  lines.push('');
  lines.push('Topics (indexed):');

  const topicDecoded = decodeTopics(options.topics);
  if (topicDecoded.length === 0) {
    lines.push('  (none)');
  } else {
    topicDecoded.forEach((topic, index) => {
      lines.push(`  [${index}] type=${topic.xdrType}`);
      lines.push(`      raw XDR : ${topic.rawXdr}`);
      lines.push(`      decoded : ${renderDecodedValue(topic)}`);
    });
  }

  lines.push('');
  lines.push('Payload (data):');
  const payload = decodePayload(options.value);
  lines.push(`  type=${payload.xdrType}`);
  lines.push(`  raw XDR : ${payload.rawXdr}`);
  lines.push(`  decoded : ${renderDecodedValue(payload)}`);

  return lines.join('\n');
}
