/**
 * ScVal encoding. Assumes input has already passed validator.ts; if it has
 * not, it throws EncodingError instead of producing a wrong value.
 *
 * ScVal is the typed value a Soroban host understands. XDR is its binary wire
 * format; `toXDR('base64')` is what ends up inside a transaction. Every value
 * below is built with an explicit constructor so the wire type never depends
 * on how JavaScript happens to represent the input.
 */

import { Address, XdrLargeInt, scValToBigInt, xdr } from '@stellar/stellar-sdk';
import type { ArgType, FunctionDefinition } from './schema';
import { formatType } from './schema';
import { intRange, isIntKind, mapEntries, parseBytesInput, parseIntegerInput } from './validator';

export class EncodingError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'EncodingError';
  }
}

function toInteger(kind: string, value: unknown, path: string): bigint {
  if (!isIntKind(kind)) throw new EncodingError(path, `${kind} is not an integer type`);
  const parsed = parseIntegerInput(value);
  if (!parsed.ok) throw new EncodingError(path, `cannot read ${String(value)} as ${kind}`);
  const { min, max } = intRange(kind);
  if (parsed.value < min || parsed.value > max) throw new EncodingError(path, `${parsed.value} is outside ${kind} range`);
  return parsed.value;
}

/** Soroban requires map keys in ascending order; compare ints numerically, text/bytes lexicographically. */
function compareKeys(a: xdr.ScVal, b: xdr.ScVal): number {
  const rank = (v: xdr.ScVal) => v.switch().value;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const bytesOf = (v: xdr.ScVal): Uint8Array | null => {
    switch (v.switch().name) {
      case 'scvSymbol':
        return Buffer.from(v.sym());
      case 'scvString':
        return Buffer.from(v.str());
      case 'scvBytes':
        return v.bytes();
      default:
        return null;
    }
  };
  const ab = bytesOf(a);
  const bb = bytesOf(b);
  if (ab && bb) return Buffer.compare(Buffer.from(ab), Buffer.from(bb));
  try {
    const na = bigOf(a);
    const nb = bigOf(b);
    if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  } catch {
    // fall through to byte comparison
  }
  return Buffer.compare(a.toXDR(), b.toXDR());
}

function bigOf(v: xdr.ScVal): bigint | null {
  switch (v.switch().name) {
    case 'scvU32':
      return BigInt(v.u32());
    case 'scvI32':
      return BigInt(v.i32());
    case 'scvU64':
    case 'scvI64':
    case 'scvU128':
    case 'scvI128':
    case 'scvU256':
    case 'scvI256':
      return scValToBigInt(v);
    default:
      return null;
  }
}

function sortedMap(entries: Array<{ key: xdr.ScVal; val: xdr.ScVal }>): xdr.ScVal {
  const sorted = entries.slice().sort((x, y) => compareKeys(x.key, y.key));
  return xdr.ScVal.scvMap(sorted.map((e) => new xdr.ScMapEntry({ key: e.key, val: e.val })));
}

export function encodeValue(type: ArgType, value: unknown, path: string): xdr.ScVal {
  switch (type.kind) {
    case 'bool':
      if (typeof value !== 'boolean') throw new EncodingError(path, 'expected a boolean');
      return xdr.ScVal.scvBool(value);
    case 'u32':
      return xdr.ScVal.scvU32(Number(toInteger('u32', value, path)));
    case 'i32':
      return xdr.ScVal.scvI32(Number(toInteger('i32', value, path)));
    case 'u64':
    case 'i64':
    case 'u128':
    case 'i128':
    case 'u256':
    case 'i256':
      // XdrLargeInt takes the exact wire type; the bigint is never narrowed.
      return new XdrLargeInt(type.kind, toInteger(type.kind, value, path)).toScVal();
    case 'string':
      if (typeof value !== 'string') throw new EncodingError(path, 'expected a string');
      return xdr.ScVal.scvString(value);
    case 'symbol':
      if (typeof value !== 'string' || !/^[A-Za-z0-9_]{1,32}$/.test(value)) throw new EncodingError(path, 'invalid symbol');
      return xdr.ScVal.scvSymbol(value);
    case 'bytes':
    case 'bytesN': {
      const bytes = parseBytesInput(value);
      if (!bytes) throw new EncodingError(path, 'expected bytes (Uint8Array or hex string)');
      if (type.kind === 'bytesN' && bytes.length !== type.length) throw new EncodingError(path, `expected ${type.length} bytes`);
      return xdr.ScVal.scvBytes(Buffer.from(bytes));
    }
    case 'address':
      try {
        return new Address(value as string).toScVal();
      } catch (err) {
        throw new EncodingError(path, `invalid address (${(err as Error).message})`);
      }
    case 'option':
      return value === null || value === undefined ? xdr.ScVal.scvVoid() : encodeValue(type.value, value, path);
    case 'vec':
      if (!Array.isArray(value)) throw new EncodingError(path, 'expected an array');
      return xdr.ScVal.scvVec(value.map((v, i) => encodeValue(type.element, v, `${path}[${i}]`)));
    case 'tuple':
      if (!Array.isArray(value) || value.length !== type.elements.length) throw new EncodingError(path, `expected ${type.elements.length} elements`);
      return xdr.ScVal.scvVec(type.elements.map((t, i) => encodeValue(t, value[i], `${path}[${i}]`)));
    case 'map': {
      const entries = mapEntries(value);
      if (!entries) throw new EncodingError(path, 'expected a map');
      return sortedMap(entries.map(([k, v], i) => ({
        key: encodeValue(type.key, k, `${path}.key[${i}]`),
        val: encodeValue(type.value, v, `${path}[${i}]`),
      })));
    }
    case 'struct': {
      // #[contracttype] structs are maps keyed by field name (Symbol), in sorted order.
      const obj = value as Record<string, unknown>;
      if (typeof obj !== 'object' || obj === null) throw new EncodingError(path, 'expected an object');
      return sortedMap(type.fields.map((f) => ({
        key: xdr.ScVal.scvSymbol(f.name),
        val: encodeValue(f.type, obj[f.name], `${path}.${f.name}`),
      })));
    }
    case 'enum': {
      const c = type.cases.find((x) => x.name === value || x.value === value);
      if (!c) throw new EncodingError(path, `unknown ${formatType(type)} case ${String(value)}`);
      return xdr.ScVal.scvU32(c.value);
    }
    case 'union': {
      const tag = typeof value === 'string' ? value : (value as { tag?: string }).tag;
      const values = typeof value === 'string' ? [] : ((value as { values?: unknown[] }).values ?? []);
      const c = type.cases.find((x) => x.name === tag);
      if (!c || values.length !== c.values.length) throw new EncodingError(path, `invalid ${formatType(type)} value`);
      return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(c.name), ...c.values.map((t, i) => encodeValue(t, values[i], `${path}.${c.name}[${i}]`))]);
    }
  }
}

export interface EncodedArgument {
  name: string;
  scVal: xdr.ScVal;
  /** Wire type, e.g. `scvU128`. */
  scValType: string;
  xdrBase64: string;
}

/** Encode all arguments in definition order (the order the contract expects). */
export function encodeArguments(def: FunctionDefinition, input: Record<string, unknown>): EncodedArgument[] {
  return def.args.map((arg) => {
    const scVal = encodeValue(arg.type, input[arg.name], arg.name);
    return { name: arg.name, scVal, scValType: scVal.switch().name, xdrBase64: scVal.toXDR('base64') };
  });
}
