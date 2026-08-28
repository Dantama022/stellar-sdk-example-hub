import { Address, nativeToScVal, scValToNative, StrKey, xdr } from '@stellar/stellar-sdk';

/** Supported JavaScript input types for Soroban ScVal encoding. */
export type ScValJsInput =
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | Buffer
  | null
  | { __type: string; value: unknown }
  | ScValJsInput[]
  | Map<ScValJsInput, ScValJsInput>
  | { [key: string]: ScValJsInput };

export interface ScValTypeHint {
  type: string;
  element?: ScValTypeHint;
  key?: ScValTypeHint;
  value?: ScValTypeHint;
}

export interface SerializationResult {
  scVal: xdr.ScVal;
  rawXdr: string;
  xdrType: string;
}

export interface RoundTripResult<T = unknown> {
  original: T;
  encoded: SerializationResult;
  decoded: unknown;
  matches: boolean;
}

const INTEGER_TYPES = new Set(['u32', 'i32', 'u64', 'i64', 'u128', 'i128', 'u256', 'i256']);

/** Encodes a JavaScript value to an ScVal using an explicit type hint. */
export function jsToScVal(value: unknown, hint: ScValTypeHint): xdr.ScVal {
  if (hint.type === 'option') {
    if (value === null || value === undefined) {
      return xdr.ScVal.scvVoid();
    }
    return jsToScVal(value, hint.element ?? { type: 'val' });
  }

  if (INTEGER_TYPES.has(hint.type) && typeof value === 'number') {
    return nativeToScVal(BigInt(value), { type: hint.type as any });
  }

  return nativeToScVal(value as any, hint as any);
}

/** Decodes an ScVal into a JSON-safe JavaScript value. */
export function scValToJs(scVal: xdr.ScVal): unknown {
  const native = scValToNative(scVal);
  return formatJsValue(native);
}

/** Converts native SDK values into JSON-safe representations. */
export function formatJsValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return value.map(formatJsValue);
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) {
      out[String(formatJsValue(key))] = formatJsValue(entry);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = formatJsValue(entry);
    }
    return out;
  }
  return value;
}

/** Serializes a value and returns the ScVal plus base64 XDR. */
export function serializeValue(value: unknown, hint: ScValTypeHint): SerializationResult {
  const scVal = jsToScVal(value, hint);
  return {
    scVal,
    rawXdr: scVal.toXDR('base64'),
    xdrType: scVal.switch().name,
  };
}

/** Encodes then decodes a value and reports whether the round-trip matches. */
export function roundTrip<T>(value: T, hint: ScValTypeHint): RoundTripResult<T> {
  const encoded = serializeValue(value, hint);
  const decoded = scValToJs(encoded.scVal);
  const matches = stableStringify(decoded) === stableStringify(formatJsValue(value));
  return { original: value, encoded, decoded, matches };
}

/** Stable JSON comparison helper for round-trip checks. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === 'bigint') return current.toString();
    if (current instanceof Uint8Array) return `0x${Buffer.from(current).toString('hex')}`;
    return current;
  });
}

/** Encodes a Stellar address string to scvAddress. */
export function encodeAddress(value: string): xdr.ScVal {
  if (!StrKey.isValidEd25519PublicKey(value) && !StrKey.isValidContract(value)) {
    throw new TypeError(`Invalid Stellar address: ${value}`);
  }
  return Address.fromString(value).toScVal();
}

/** Encodes nested map/vector structures from plain JS objects. */
export function encodeNested(value: Record<string, unknown>): xdr.ScVal {
  const entries = Object.entries(value).map(([key, entry]) => {
    if (typeof entry === 'boolean') {
      return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: xdr.ScVal.scvBool(entry) });
    }
    if (typeof entry === 'number') {
      return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: xdr.ScVal.scvU32(entry) });
    }
    if (typeof entry === 'string') {
      return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: xdr.ScVal.scvString(entry) });
    }
    if (typeof entry === 'bigint') {
      return new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol(key),
        val: nativeToScVal(entry, { type: 'i128' }),
      });
    }
    if (Array.isArray(entry)) {
      return new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol(key),
        val: nativeToScVal(entry, { type: 'vec', element: { type: 'u32' } } as ScValTypeHint),
      });
    }
    if (entry && typeof entry === 'object') {
      return new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol(key),
        val: encodeNested(entry as Record<string, unknown>),
      });
    }
    throw new TypeError(`Unsupported nested value for key "${key}"`);
  });

  return xdr.ScVal.scvMap(entries);
}

/** Returns a human-readable explanation when a JS type cannot be encoded. */
export function describeUnsupportedJsType(value: unknown): string {
  if (value === undefined) {
    return 'undefined is not encodable; use null with an Option<T> hint or omit the field.';
  }
  if (typeof value === 'function') {
    return 'Functions cannot be encoded as ScVal.';
  }
  if (value instanceof Date) {
    return 'Date objects are not supported; encode as a u64 timestamp or ISO string.';
  }
  return `Type "${Object.prototype.toString.call(value)}" is not supported by nativeToScVal.`;
}

/** Attempts encoding and returns either a SerializationResult or an error message. */
export function trySerialize(
  value: unknown,
  hint: ScValTypeHint,
): { ok: true; result: SerializationResult } | { ok: false; error: string } {
  try {
    return { ok: true, result: serializeValue(value, hint) };
  } catch (error: any) {
    return { ok: false, error: error?.message || describeUnsupportedJsType(value) };
  }
}
