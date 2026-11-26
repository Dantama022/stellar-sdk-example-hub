/**
 * Input validation. Pure: it never builds ScVal or touches the network.
 *
 * Application inputs are plain JavaScript values:
 *  - integers: bigint, decimal string, or a safe-integer number (never an
 *    unsafe number: that has already lost precision before we see it)
 *  - bytes: Uint8Array/Buffer or a hex string
 *  - map: Map, array of [key, value] pairs, or a plain object (string keys)
 *  - struct: plain object, union: `"Case"` or `{ tag: "Case", values: [...] }`
 */

import { StrKey } from '@stellar/stellar-sdk';
import { formatType, type ArgType, type FunctionDefinition, type PrimitiveKind } from './schema';

export type IssueCode =
  | 'MISSING_ARGUMENT'
  | 'UNEXPECTED_ARGUMENT'
  | 'TYPE_MISMATCH'
  | 'OUT_OF_RANGE'
  | 'PRECISION_LOSS'
  | 'INVALID_ADDRESS'
  | 'INVALID_LENGTH'
  | 'UNKNOWN_VARIANT'
  | 'MISSING_FIELD'
  | 'UNEXPECTED_FIELD'
  | 'DUPLICATE_KEY';

export interface ValidationIssue {
  code: IssueCode;
  /** Argument path, e.g. `amount` or `recipients[2].address`. */
  path: string;
  expected: string;
  message: string;
  severity: 'error' | 'warning';
}

type IntKind = Extract<PrimitiveKind, 'u32' | 'i32' | 'u64' | 'i64' | 'u128' | 'i128' | 'u256' | 'i256'>;

const INT_BITS: Record<IntKind, { bits: number; signed: boolean }> = {
  u32: { bits: 32, signed: false },
  i32: { bits: 32, signed: true },
  u64: { bits: 64, signed: false },
  i64: { bits: 64, signed: true },
  u128: { bits: 128, signed: false },
  i128: { bits: 128, signed: true },
  u256: { bits: 256, signed: false },
  i256: { bits: 256, signed: true },
};

export function isIntKind(kind: string): kind is IntKind {
  return kind in INT_BITS;
}

export function intRange(kind: IntKind): { min: bigint; max: bigint } {
  const { bits, signed } = INT_BITS[kind];
  return signed
    ? { min: -(1n << BigInt(bits - 1)), max: (1n << BigInt(bits - 1)) - 1n }
    : { min: 0n, max: (1n << BigInt(bits)) - 1n };
}

export type IntegerParse =
  | { ok: true; value: bigint }
  | { ok: false; reason: 'type' | 'precision' };

/** Parse an application integer without ever routing it through an unsafe JS number. */
export function parseIntegerInput(input: unknown): IntegerParse {
  if (typeof input === 'bigint') return { ok: true, value: input };
  if (typeof input === 'number') {
    if (!Number.isInteger(input)) return { ok: false, reason: 'type' };
    if (!Number.isSafeInteger(input)) return { ok: false, reason: 'precision' };
    return { ok: true, value: BigInt(input) };
  }
  if (typeof input === 'string' && /^-?\d+$/.test(input.trim())) return { ok: true, value: BigInt(input.trim()) };
  return { ok: false, reason: 'type' };
}

export function parseBytesInput(input: unknown): Uint8Array | null {
  if (input instanceof Uint8Array) return input;
  if (typeof input === 'string' && /^(0x)?([0-9a-fA-F]{2})*$/.test(input)) {
    return Uint8Array.from(Buffer.from(input.replace(/^0x/, ''), 'hex'));
  }
  return null;
}

export function isValidAddress(input: unknown): input is string {
  return typeof input === 'string' && (StrKey.isValidEd25519PublicKey(input) || StrKey.isValidContract(input));
}

/** Entries of a map input as [key, value] pairs, or null when the shape is not a map. */
export function mapEntries(input: unknown): Array<[unknown, unknown]> | null {
  if (input instanceof Map) return Array.from(input.entries());
  if (Array.isArray(input) && input.every((e) => Array.isArray(e) && e.length === 2)) {
    return input as Array<[unknown, unknown]>;
  }
  if (typeof input === 'object' && input !== null && !Array.isArray(input) && !(input instanceof Uint8Array)) {
    return Object.entries(input as Record<string, unknown>);
  }
  return null;
}

export function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Uint8Array) return 'bytes';
  return typeof v;
}

function issue(
  code: IssueCode,
  path: string,
  type: ArgType | string,
  message: string,
  severity: 'error' | 'warning' = 'error',
): ValidationIssue {
  return { code, path, expected: typeof type === 'string' ? type : formatType(type), message, severity };
}

export function validateValue(type: ArgType, value: unknown, path: string, out: ValidationIssue[]): void {
  const mismatch = (): void => {
    out.push(issue('TYPE_MISMATCH', path, type, `${path}: expected ${formatType(type)}, got ${describeValue(value)}`));
  };

  switch (type.kind) {
    case 'bool':
      if (typeof value !== 'boolean') mismatch();
      return;
    case 'string':
      if (typeof value !== 'string') mismatch();
      return;
    case 'symbol':
      if (typeof value !== 'string') return mismatch();
      if (!/^[A-Za-z0-9_]{1,32}$/.test(value)) {
        out.push(issue('INVALID_LENGTH', path, type, `${path}: symbols are 1-32 characters of [A-Za-z0-9_]`));
      }
      return;
    case 'address':
      if (typeof value !== 'string') return mismatch();
      if (!isValidAddress(value)) out.push(issue('INVALID_ADDRESS', path, type, `${path}: "${value}" is not a valid account (G...) or contract (C...) address`));
      return;
    case 'bytes':
    case 'bytesN': {
      const bytes = parseBytesInput(value);
      if (!bytes) return mismatch();
      if (type.kind === 'bytesN' && bytes.length !== type.length) {
        out.push(issue('INVALID_LENGTH', path, type, `${path}: expected exactly ${type.length} bytes, got ${bytes.length}`));
      }
      return;
    }
    case 'option':
      if (value === null || value === undefined) return;
      validateValue(type.value, value, path, out);
      return;
    case 'vec':
      if (!Array.isArray(value)) return mismatch();
      value.forEach((v, i) => validateValue(type.element, v, `${path}[${i}]`, out));
      return;
    case 'tuple':
      if (!Array.isArray(value)) return mismatch();
      if (value.length !== type.elements.length) {
        out.push(issue('INVALID_LENGTH', path, type, `${path}: expected ${type.elements.length} elements, got ${value.length}`));
        return;
      }
      type.elements.forEach((t, i) => validateValue(t, value[i], `${path}[${i}]`, out));
      return;
    case 'map': {
      const entries = mapEntries(value);
      if (!entries) return mismatch();
      const seen = new Set<string>();
      entries.forEach(([k, v], i) => {
        validateValue(type.key, k, `${path}.key[${i}]`, out);
        validateValue(type.value, v, `${path}[${i}]`, out);
        const id = `${describeValue(k)}:${String(k)}`;
        if (seen.has(id)) out.push(issue('DUPLICATE_KEY', path, type, `${path}: duplicate map key ${String(k)}`));
        seen.add(id);
      });
      return;
    }
    case 'struct': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return mismatch();
      const obj = value as Record<string, unknown>;
      for (const f of type.fields) {
        if (!(f.name in obj)) {
          if (f.type.kind === 'option') continue;
          out.push(issue('MISSING_FIELD', `${path}.${f.name}`, f.type, `${path}.${f.name}: missing field (expected ${formatType(f.type)})`));
        } else validateValue(f.type, obj[f.name], `${path}.${f.name}`, out);
      }
      const known = new Set(type.fields.map((f) => f.name));
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) out.push(issue('UNEXPECTED_FIELD', `${path}.${key}`, type, `${path}.${key}: unexpected field`));
      }
      return;
    }
    case 'enum': {
      const byName = type.cases.find((c) => c.name === value);
      const byValue = typeof value === 'number' && type.cases.some((c) => c.value === value);
      if (!byName && !byValue) {
        out.push(issue('UNKNOWN_VARIANT', path, type, `${path}: ${String(value)} is not one of ${type.cases.map((c) => `${c.name}(${c.value})`).join(', ')}`));
      }
      return;
    }
    case 'union': {
      const tag = typeof value === 'string' ? value : (value as { tag?: unknown } | null)?.tag;
      const values = typeof value === 'string' ? [] : ((value as { values?: unknown[] } | null)?.values ?? []);
      if (typeof tag !== 'string') return mismatch();
      const c = type.cases.find((x) => x.name === tag);
      if (!c) {
        out.push(issue('UNKNOWN_VARIANT', path, type, `${path}: "${tag}" is not one of ${type.cases.map((x) => x.name).join(', ')}`));
        return;
      }
      if (!Array.isArray(values) || values.length !== c.values.length) {
        out.push(issue('INVALID_LENGTH', path, type, `${path}: case "${tag}" takes ${c.values.length} value(s), got ${Array.isArray(values) ? values.length : 'invalid'}`));
        return;
      }
      c.values.forEach((t, i) => validateValue(t, values[i], `${path}.${tag}[${i}]`, out));
      return;
    }
    default: {
      // Integer kinds.
      const kind = type.kind;
      if (!isIntKind(kind)) return mismatch();
      const parsed = parseIntegerInput(value);
      if (!parsed.ok) {
        if (parsed.reason === 'precision') {
          out.push(issue('PRECISION_LOSS', path, kind, `${path}: ${String(value)} is not a safe JavaScript integer; pass a bigint or a decimal string instead`));
        } else mismatch();
        return;
      }
      const { min, max } = intRange(kind);
      if (parsed.value < min || parsed.value > max) {
        out.push(issue('OUT_OF_RANGE', path, kind, `${path}: ${parsed.value} is outside ${kind} range [${min}, ${max}]`));
      }
    }
  }
}

/** Validate every argument of a call against a function definition. */
export function validateArguments(def: FunctionDefinition, input: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const arg of def.args) {
    if (!(arg.name in input) || input[arg.name] === undefined) {
      if (arg.type.kind === 'option') continue;
      issues.push(issue('MISSING_ARGUMENT', arg.name, arg.type, `${arg.name}: required argument is missing (expected ${formatType(arg.type)})`));
      continue;
    }
    validateValue(arg.type, input[arg.name], arg.name, issues);
  }
  const known = new Set(def.args.map((a) => a.name));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      issues.push({ code: 'UNEXPECTED_ARGUMENT', path: key, expected: '(none)', message: `${key}: not an argument of ${def.name}`, severity: 'error' });
    }
  }
  return issues;
}
