import { scValToNative, xdr } from '@stellar/stellar-sdk';
import * as fs from 'fs';

export type Durability = 'persistent' | 'temporary' | 'unknown';
export type JsonObject = Record<string, unknown>;
export interface SnapshotEntry {
  ledgerKey: string;
  contractId?: string;
  durability: Durability;
  entryType: string;
  valueXdr?: string;
  valueDecoded?: unknown;
  lastModifiedLedgerSeq?: string;
  liveUntilLedgerSeq?: string;
}
export interface Snapshot {
  ledger?: string;
  version?: string;
  entries: SnapshotEntry[];
}
export interface NodeAnalysis {
  type: string;
  scalar: boolean;
  composite: boolean;
  depth: number;
  vectorSizes: number[];
  mapSizes: number[];
  emptyVectors: number;
  emptyMaps: number;
  scalarCount: number;
  compositeCount: number;
  mapTypePairs: Record<string, number>;
  pattern: string;
}

export function stableStringify(value: unknown, space = 2): string {
  return JSON.stringify(sortValue(value), null, space);
}
function sortValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: JsonObject = {};
    for (const key of Object.keys(value as JsonObject).sort()) {
      const child = (value as JsonObject)[key];
      if (child !== undefined) out[key] = sortValue(child);
    }
    return out;
  }
  return value;
}
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array || Buffer.isBuffer(value))
    return `0x${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Map)
    return Array.from(value.entries()).map(([key, v]) => ({
      key: jsonSafe(key),
      value: jsonSafe(v),
    }));
  if (value && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value as JsonObject)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

export function parseJsonPreservingLargeIntegers(text: string): unknown {
  let out = '',
    i = 0,
    inString = false,
    escaped = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const start = i;
      if (text[i] === '-') i++;
      while (i < text.length && /[0-9]/.test(text[i])) i++;
      const token = text.slice(start, i);
      const next = text[i] ?? '';
      if (!/[.eE]/.test(next)) {
        try {
          const n = BigInt(token);
          if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) {
            out += JSON.stringify(token);
            continue;
          }
        } catch {
          // Malformed numeric tokens are left for JSON.parse to reject.
        }
      }
      out += token;
      continue;
    }
    out += ch;
    i++;
  }
  return JSON.parse(out);
}
export function normalizeInteger(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value) || value < 0)
      throw new Error(`${field} must be a non-negative safe integer or decimal string`);
    return String(value);
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value.trim()))
    return BigInt(value.trim()).toString();
  throw new Error(`${field} must be a non-negative integer`);
}
export function normalizeDurability(value: unknown): Durability {
  if (typeof value !== 'string') return 'unknown';
  const v = value.trim().toLowerCase();
  return v === 'persistent' || v === 'temporary' ? v : 'unknown';
}
export function normalizeLedgerKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('ledgerKey is required');
  const v = value.trim();
  try {
    return xdr.LedgerKey.fromXDR(v, 'base64').toXDR('base64');
  } catch {
    return v;
  }
}
export function decodeScVal(valueXdr: string | undefined): {
  decoded: boolean;
  type: string;
  value?: unknown;
  error?: string;
} {
  if (!valueXdr) return { decoded: false, type: 'unknown', error: 'missing valueXdr' };
  try {
    const sc = xdr.ScVal.fromXDR(valueXdr, 'base64');
    return { decoded: true, type: sc.switch().name, value: jsonSafe(scValToNative(sc)) };
  } catch (error: unknown) {
    return {
      decoded: false,
      type: 'unknown',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
export function normalizeEntry(raw: unknown): SnapshotEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('snapshot entry must be an object');
  const o = raw as JsonObject;
  const ledgerKey = normalizeLedgerKey(o.ledgerKey ?? o.keyXdr ?? o.key);
  const valueXdr =
    typeof o.valueXdr === 'string' && o.valueXdr.trim() ? o.valueXdr.trim() : undefined;
  const decoded = decodeScVal(valueXdr);
  return {
    ledgerKey,
    contractId: typeof o.contractId === 'string' ? o.contractId.trim() : undefined,
    durability: normalizeDurability(o.durability),
    entryType:
      typeof o.entryType === 'string' && o.entryType.trim() ? o.entryType.trim() : 'contract-data',
    valueXdr,
    valueDecoded:
      o.valueDecoded !== undefined ? sortValue(jsonSafe(o.valueDecoded)) : decoded.value,
    lastModifiedLedgerSeq: normalizeInteger(o.lastModifiedLedgerSeq, 'lastModifiedLedgerSeq'),
    liveUntilLedgerSeq: normalizeInteger(o.liveUntilLedgerSeq, 'liveUntilLedgerSeq'),
  };
}
export function normalizeSnapshot(raw: unknown): Snapshot {
  if (Array.isArray(raw)) return { entries: raw.map(normalizeEntry).sort(compareEntries) };
  if (!raw || typeof raw !== 'object') throw new Error('snapshot must be an object or array');
  const o = raw as JsonObject;
  if (!Array.isArray(o.entries)) throw new Error('snapshot object requires an entries array');
  return {
    ledger: normalizeInteger(o.ledger ?? o.ledgerSeq, 'ledger'),
    version: o.version === undefined ? undefined : String(o.version),
    entries: o.entries.map(normalizeEntry).sort(compareEntries),
  };
}
export function readSnapshotFile(file: string): Snapshot {
  return normalizeSnapshot(parseJsonPreservingLargeIntegers(fs.readFileSync(file, 'utf8')));
}
export function compareEntries(a: SnapshotEntry, b: SnapshotEntry): number {
  return (
    a.ledgerKey.localeCompare(b.ledgerKey) ||
    (a.contractId ?? '').localeCompare(b.contractId ?? '') ||
    a.durability.localeCompare(b.durability)
  );
}
export function filterEntries(
  entries: SnapshotEntry[],
  contractId?: string,
  durability?: string,
): SnapshotEntry[] {
  const d = durability?.toLowerCase();
  return entries.filter(
    (e) => (!contractId || e.contractId === contractId) && (!d || e.durability === d),
  );
}
function nativeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'vector';
  if (v && typeof v === 'object') return 'map';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number' || typeof v === 'bigint') return 'integer';
  if (typeof v === 'string') return 'string';
  return typeof v;
}
export function analyzeStructure(
  value: unknown,
  maxDepth = Number.POSITIVE_INFINITY,
): NodeAnalysis {
  const a: NodeAnalysis = {
    type: nativeType(value),
    scalar: false,
    composite: false,
    depth: 0,
    vectorSizes: [],
    mapSizes: [],
    emptyVectors: 0,
    emptyMaps: 0,
    scalarCount: 0,
    compositeCount: 0,
    mapTypePairs: {},
    pattern: '',
  };
  function walk(node: unknown, depth: number): string {
    a.depth = Math.max(a.depth, depth);
    const type = nativeType(node);
    if (depth >= maxDepth && (Array.isArray(node) || (node && typeof node === 'object'))) {
      a.compositeCount++;
      return `${type}<depth-limit>`;
    }
    if (Array.isArray(node)) {
      a.compositeCount++;
      a.vectorSizes.push(node.length);
      if (node.length === 0) a.emptyVectors++;
      return `vector[${node.map((c) => walk(c, depth + 1)).join(',')}]`;
    }
    if (node && typeof node === 'object') {
      a.compositeCount++;
      const pairs = Object.entries(node as JsonObject).sort(([x], [y]) => x.localeCompare(y));
      a.mapSizes.push(pairs.length);
      if (pairs.length === 0) a.emptyMaps++;
      const parts: string[] = [];
      for (const [k, v] of pairs) {
        const pair = `${nativeType(k)}->${nativeType(v)}`;
        a.mapTypePairs[pair] = (a.mapTypePairs[pair] ?? 0) + 1;
        parts.push(`${k}:${walk(v, depth + 1)}`);
      }
      return `map{${parts.join(',')}}`;
    }
    a.scalarCount++;
    return type;
  }
  a.pattern = walk(value, 0);
  a.scalar = a.compositeCount === 0;
  a.composite = !a.scalar;
  a.mapTypePairs = Object.fromEntries(
    Object.entries(a.mapTypePairs).sort(([x], [y]) => x.localeCompare(y)),
  );
  return a;
}
export interface SchemaNode {
  observedTypes: string[];
  inferred: boolean;
  optional?: boolean;
  fields?: Record<string, SchemaNode>;
  element?: SchemaNode;
  conflicts?: string[];
  depth: number;
}
export function inferSchema(values: unknown[], maxDepth = 10, depth = 0): SchemaNode {
  const types = [...new Set(values.map(nativeType))].sort();
  const conflicts = types.length > 1 ? types : undefined;
  if (depth >= maxDepth) return { observedTypes: types, inferred: true, conflicts, depth };
  const objects = values.filter(
    (v): v is JsonObject => Boolean(v) && typeof v === 'object' && !Array.isArray(v),
  );
  if (objects.length === values.length && objects.length) {
    const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))].sort();
    const fields: Record<string, SchemaNode> = {};
    for (const key of keys) {
      const present = objects.filter((o) => Object.prototype.hasOwnProperty.call(o, key));
      fields[key] = {
        ...inferSchema(
          present.map((o) => o[key]),
          maxDepth,
          depth + 1,
        ),
        optional: present.length !== objects.length,
      };
    }
    return { observedTypes: types, inferred: true, fields, conflicts, depth };
  }
  const arrays = values.filter(Array.isArray) as unknown[][];
  if (arrays.length === values.length && arrays.length) {
    const elements = arrays.flat();
    return {
      observedTypes: types,
      inferred: true,
      element: elements.length
        ? inferSchema(elements, maxDepth, depth + 1)
        : { observedTypes: [], inferred: true, depth: depth + 1 },
      conflicts,
      depth,
    };
  }
  return { observedTypes: types, inferred: true, conflicts, depth };
}
export function duplicateKeys(entries: SnapshotEntry[]): string[] {
  const seen = new Set<string>(),
    dup = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.ledgerKey)) dup.add(e.ledgerKey);
    seen.add(e.ledgerKey);
  }
  return [...dup].sort();
}
export function entriesEquivalent(a: SnapshotEntry, b: SnapshotEntry): boolean {
  return stableStringify(a, 0) === stableStringify(b, 0);
}
export function representationsConflict(entry: SnapshotEntry): boolean {
  if (!entry.valueXdr || entry.valueDecoded === undefined) return false;
  const d = decodeScVal(entry.valueXdr);
  return d.decoded && stableStringify(d.value, 0) !== stableStringify(entry.valueDecoded, 0);
}
export function ttlRelationshipInvalid(entry: SnapshotEntry): boolean {
  return Boolean(
    entry.lastModifiedLedgerSeq &&
    entry.liveUntilLedgerSeq &&
    BigInt(entry.liveUntilLedgerSeq) < BigInt(entry.lastModifiedLedgerSeq),
  );
}
export function ledgerRelationshipInvalid(snapshot: Snapshot, entry: SnapshotEntry): boolean {
  return Boolean(
    snapshot.ledger &&
    entry.lastModifiedLedgerSeq &&
    BigInt(entry.lastModifiedLedgerSeq) > BigInt(snapshot.ledger),
  );
}
export function parseFlags(args: string[]): {
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [],
    flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!t.startsWith('-')) {
      positional.push(t);
      continue;
    }
    const k = t.replace(/^-+/, '');
    const n = args[i + 1];
    if (!n || n.startsWith('-')) flags[k] = true;
    else {
      flags[k] = n;
      i++;
    }
  }
  return { positional, flags };
}
export function getFlag(
  flags: Record<string, string | boolean>,
  ...names: string[]
): string | undefined {
  for (const n of names) {
    const v = flags[n];
    if (typeof v === 'string') return v;
  }
  return undefined;
}
export function hasFlag(flags: Record<string, string | boolean>, ...names: string[]): boolean {
  return names.some((n) => flags[n] === true || typeof flags[n] === 'string');
}
export function positiveInt(value: string | undefined, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive integer`);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${label} is too large`);
  return n;
}
