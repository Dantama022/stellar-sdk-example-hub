/**
 * Structural type validation of a decoded value against an expected type.
 *
 * This checks *shape*: wire types, integer ranges, struct fields, enum cases.
 * It cannot tell whether a value is semantically right (a balance that is
 * negative-but-valid i128, a price from the wrong oracle, ...). That is
 * application-level validation and is deliberately out of scope.
 *
 * Decoding errors never appear here: a value that could not be decoded is
 * `inconclusive`, not a mismatch.
 */

import type { DecodedNode } from './decoder';
import { formatType, type ExpectedType } from './types';

export interface TypeMismatch {
  /** Value path, e.g. `$.balances[2]`. */
  path: string;
  expected: string;
  actual: string;
  message: string;
}

export type ValidationStatus = 'valid' | 'mismatch' | 'inconclusive';

export interface ValidationResult {
  status: ValidationStatus;
  mismatches: TypeMismatch[];
  /** Why validation could not decide, when `inconclusive`. */
  reason?: string;
}

const WIRE_FOR_KIND: Record<string, string> = {
  void: 'scvVoid',
  bool: 'scvBool',
  u32: 'scvU32',
  i32: 'scvI32',
  u64: 'scvU64',
  i64: 'scvI64',
  u128: 'scvU128',
  i128: 'scvI128',
  u256: 'scvU256',
  i256: 'scvI256',
  timepoint: 'scvTimepoint',
  duration: 'scvDuration',
  string: 'scvString',
  symbol: 'scvSymbol',
  bytes: 'scvBytes',
  bytesN: 'scvBytes',
  address: 'scvAddress',
};

const BITS: Record<string, { bits: number; signed: boolean }> = {
  u32: { bits: 32, signed: false },
  i32: { bits: 32, signed: true },
  u64: { bits: 64, signed: false },
  i64: { bits: 64, signed: true },
  u128: { bits: 128, signed: false },
  i128: { bits: 128, signed: true },
  u256: { bits: 256, signed: false },
  i256: { bits: 256, signed: true },
  timepoint: { bits: 64, signed: false },
  duration: { bits: 64, signed: false },
};

function range(kind: string): { min: bigint; max: bigint } {
  const { bits, signed } = BITS[kind];
  return signed ? { min: -(1n << BigInt(bits - 1)), max: (1n << BigInt(bits - 1)) - 1n } : { min: 0n, max: (1n << BigInt(bits)) - 1n };
}

function mismatch(out: TypeMismatch[], path: string, expected: ExpectedType | string, actual: string, message: string): void {
  out.push({ path, expected: typeof expected === 'string' ? expected : formatType(expected), actual, message });
}

function check(type: ExpectedType, node: DecodedNode, path: string, out: TypeMismatch[]): void {
  if (node.unsupportedRaw !== undefined) {
    mismatch(out, path, type, node.scType, `${path}: value is ${node.scType}, which could not be decoded, so it cannot be checked`);
    return;
  }

  const wrongWire = (): void => mismatch(out, path, type, node.scType, `${path}: expected ${formatType(type)} but the value is ${node.scType}`);

  switch (type.kind) {
    case 'option':
      if (node.scType === 'scvVoid') return;
      check(type.value, node, path, out);
      return;
    case 'vec': {
      if (node.scType !== 'scvVec' || !node.items) return wrongWire();
      node.items.forEach((n, i) => check(type.element, n, `${path}[${i}]`, out));
      return;
    }
    case 'tuple': {
      if (node.scType !== 'scvVec' || !node.items) return wrongWire();
      if (node.items.length !== type.elements.length) {
        mismatch(out, path, type, `${node.items.length} elements`, `${path}: expected ${type.elements.length} elements, found ${node.items.length}`);
        return;
      }
      type.elements.forEach((t, i) => check(t, (node.items as DecodedNode[])[i], `${path}[${i}]`, out));
      return;
    }
    case 'map': {
      if (node.scType !== 'scvMap' || !node.entries) return wrongWire();
      node.entries.forEach((e, i) => {
        check(type.key, e.key, `${path}.key[${i}]`, out);
        check(type.value, e.value, `${path}[${i}]`, out);
      });
      return;
    }
    case 'struct': {
      if (node.scType !== 'scvMap' || !node.entries) return wrongWire();
      const byName = new Map<string, DecodedNode>();
      for (const e of node.entries) {
        if (e.key.scType !== 'scvSymbol' || typeof e.key.value !== 'string') {
          mismatch(out, path, type, e.key.scType, `${path}: struct keys must be symbols, found ${e.key.scType}`);
          continue;
        }
        byName.set(e.key.value, e.value);
      }
      for (const f of type.fields) {
        const n = byName.get(f.name);
        if (!n) {
          if (f.type.kind === 'option') continue;
          mismatch(out, `${path}.${f.name}`, f.type, 'missing', `${path}.${f.name}: missing field (expected ${formatType(f.type)})`);
        } else check(f.type, n, `${path}.${f.name}`, out);
      }
      const known = new Set(type.fields.map((f) => f.name));
      for (const key of byName.keys()) {
        if (!known.has(key)) mismatch(out, `${path}.${key}`, type, 'unexpected', `${path}.${key}: unexpected field not in ${formatType(type)}`);
      }
      return;
    }
    case 'enum': {
      if (node.scType !== 'scvU32' || typeof node.value !== 'number') return wrongWire();
      const value = node.value;
      if (!type.cases.some((c) => c.value === value)) {
        mismatch(out, path, type, String(value), `${path}: ${value} is not a case of ${formatType(type)} (${type.cases.map((c) => `${c.name}=${c.value}`).join(', ')})`);
      }
      return;
    }
    case 'union': {
      if (node.scType !== 'scvVec' || !node.items || node.items.length === 0) return wrongWire();
      const tag = node.items[0];
      if (tag.scType !== 'scvSymbol' || typeof tag.value !== 'string') {
        mismatch(out, path, type, tag.scType, `${path}: union tag must be a symbol`);
        return;
      }
      const c = type.cases.find((x) => x.name === tag.value);
      if (!c) {
        mismatch(out, path, type, String(tag.value), `${path}: "${String(tag.value)}" is not a case of ${formatType(type)}`);
        return;
      }
      const payload = node.items.slice(1);
      if (payload.length !== c.values.length) {
        mismatch(out, path, type, `${payload.length} values`, `${path}: case "${c.name}" carries ${c.values.length} value(s), found ${payload.length}`);
        return;
      }
      c.values.forEach((t, i) => check(t, payload[i], `${path}.${c.name}[${i}]`, out));
      return;
    }
    default: {
      const wire = WIRE_FOR_KIND[type.kind];
      if (!wire) {
        mismatch(out, path, type, node.scType, `${path}: unsupported expected kind ${type.kind}`);
        return;
      }
      if (node.scType !== wire) return wrongWire();
      if (type.kind === 'bytesN') {
        const len = node.value instanceof Uint8Array ? node.value.length : -1;
        if (len !== type.length) mismatch(out, path, type, `${len} bytes`, `${path}: expected ${type.length} bytes, found ${len}`);
        return;
      }
      if (type.kind in BITS) {
        const v = node.value;
        if (typeof v !== 'bigint' && typeof v !== 'number') return wrongWire();
        const { min, max } = range(type.kind);
        const big = BigInt(v);
        if (big < min || big > max) mismatch(out, path, type, big.toString(), `${path}: ${big} is outside ${type.kind} range [${min}, ${max}]`);
      }
    }
  }
}

export function validateReturnType(node: DecodedNode | undefined, expected: ExpectedType | undefined): ValidationResult {
  if (!expected) {
    return { status: 'inconclusive', mismatches: [], reason: 'no expected return type was provided or derivable, so the value was decoded but not validated' };
  }
  if (!node) {
    return { status: 'inconclusive', mismatches: [], reason: 'the value could not be decoded, so it cannot be validated' };
  }
  const mismatches: TypeMismatch[] = [];
  check(expected, node, '$', mismatches);
  // Anything that failed to decode is a decoding problem, not a type mismatch.
  const onlyUndecodable = mismatches.length > 0 && mismatches.every((m) => m.actual !== 'missing' && /could not be decoded/.test(m.message));
  if (onlyUndecodable) {
    return { status: 'inconclusive', mismatches: [], reason: 'part of the value could not be decoded; fix decoding before judging the type' };
  }
  return { status: mismatches.length === 0 ? 'valid' : 'mismatch', mismatches };
}
