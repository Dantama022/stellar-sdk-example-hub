import * as fs from 'fs';
import * as path from 'path';
import { StrKey, scValToNative, xdr } from '@stellar/stellar-sdk';

export type Durability = 'persistent' | 'temporary' | 'unknown';
export type JsonObject = Record<string, unknown>;

export interface CanonicalEntry {
  ledgerKey: string;
  entryType: string;
  contractId?: string;
  durability: Durability;
  lastModifiedLedgerSeq?: string;
  liveUntilLedgerSeq?: string;
  valueXdr?: string;
  valueDecoded?: unknown;
}

export interface CanonicalSnapshot {
  version: 1;
  ledger?: string;
  entries: CanonicalEntry[];
}

export interface DecodedMetrics {
  decoded: boolean;
  type: string;
  value?: unknown;
  collectionSize: number;
  maxDepth: number;
  error?: string;
}

export function stableStringify(value: unknown, space = 2): string {
  return JSON.stringify(sortObject(value), null, space);
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    const out: JsonObject = {};
    for (const key of Object.keys(value as JsonObject).sort()) {
      const child = (value as JsonObject)[key];
      if (child !== undefined) out[key] = sortObject(child);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function parseJsonPreservingLargeIntegers(text: string): unknown {
  // JSON.parse would round integer literals beyond Number.MAX_SAFE_INTEGER.
  // Quote large integer tokens outside strings before parsing.
  let out = '';
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const start = i;
      if (text[i] === '-') i += 1;
      while (i < text.length && /[0-9]/.test(text[i])) i += 1;
      const token = text.slice(start, i);
      const next = text[i] ?? '';
      if (!next || !/[.eE]/.test(next)) {
        try {
          const n = BigInt(token);
          if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) {
            out += JSON.stringify(token);
            continue;
          }
        } catch {
          // Let JSON.parse report malformed input.
        }
      }
      out += token;
      continue;
    }
    out += ch;
    i += 1;
  }
  return JSON.parse(out);
}

export function readJsonFile(filePath: string): { text: string; raw: unknown } {
  const resolved = path.resolve(filePath);
  const text = fs.readFileSync(resolved, 'utf8');
  return { text, raw: parseJsonPreservingLargeIntegers(text) };
}

export function normalizeInteger(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative safe integer or decimal string`);
    }
    return String(value);
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value.trim())) {
    return BigInt(value.trim()).toString();
  }
  throw new Error(`${field} must be a non-negative integer`);
}

export function normalizeBase64(value: string): string {
  const trimmed = value.trim();
  const bytes = Buffer.from(trimmed, 'base64');
  if (!trimmed || bytes.length === 0) throw new Error('empty or invalid base64');
  const canonical = bytes.toString('base64');
  const comparable = trimmed.replace(/=+$/, '');
  if (canonical.replace(/=+$/, '') !== comparable) throw new Error('invalid base64');
  return canonical;
}

export function encodedByteSize(value: string | undefined): number {
  if (!value) return 0;
  try {
    return Buffer.from(normalizeBase64(value), 'base64').length;
  } catch {
    return Buffer.byteLength(value, 'utf8');
  }
}

export function normalizeLedgerKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('ledgerKey is required');
  const trimmed = value.trim();
  try {
    const canonical = normalizeBase64(trimmed);
    const parsed = xdr.LedgerKey.fromXDR(canonical, 'base64');
    return parsed.toXDR('base64');
  } catch {
    return trimmed;
  }
}

export function ledgerKeyType(ledgerKey: string): string {
  try {
    const parsed = xdr.LedgerKey.fromXDR(ledgerKey, 'base64');
    return parsed.switch().name;
  } catch {
    return 'unknown';
  }
}

export function decodeScValXdr(valueXdr: string | undefined): DecodedMetrics {
  if (!valueXdr) {
    return {
      decoded: false,
      type: 'unknown',
      collectionSize: 0,
      maxDepth: 0,
      error: 'missing valueXdr',
    };
  }
  try {
    const canonical = normalizeBase64(valueXdr);
    const scVal = xdr.ScVal.fromXDR(canonical, 'base64');
    const type = scVal.switch().name;
    const native = makeJsonSafe(scValToNative(scVal));
    const metrics = inspectDecoded(native);
    return { decoded: true, type, value: native, ...metrics };
  } catch (error: unknown) {
    return {
      decoded: false,
      type: 'unknown',
      collectionSize: 0,
      maxDepth: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function makeJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `0x${Buffer.from(value).toString('hex')}`;
  }
  if (Array.isArray(value)) return value.map(makeJsonSafe);
  if (value instanceof Map) {
    return Array.from(value.entries()).map(([key, child]) => ({
      key: makeJsonSafe(key),
      value: makeJsonSafe(child),
    }));
  }
  if (value && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value as JsonObject)) out[key] = makeJsonSafe(child);
    return out;
  }
  return value;
}

export function inspectDecoded(value: unknown): { collectionSize: number; maxDepth: number } {
  function walk(node: unknown, depth: number): { size: number; depth: number } {
    if (Array.isArray(node)) {
      let size = node.length;
      let maxDepth = depth;
      for (const child of node) {
        const nested = walk(child, depth + 1);
        size += nested.size;
        maxDepth = Math.max(maxDepth, nested.depth);
      }
      return { size, depth: maxDepth };
    }
    if (node && typeof node === 'object') {
      const values = Object.values(node as JsonObject);
      let size = values.length;
      let maxDepth = depth;
      for (const child of values) {
        const nested = walk(child, depth + 1);
        size += nested.size;
        maxDepth = Math.max(maxDepth, nested.depth);
      }
      return { size, depth: maxDepth };
    }
    return { size: 0, depth };
  }
  const result = walk(value, 0);
  return { collectionSize: result.size, maxDepth: result.depth };
}

export function decodedValueSize(value: unknown): number {
  return Buffer.byteLength(stableStringify(makeJsonSafe(value), 0), 'utf8');
}

export function normalizeDurability(value: unknown): Durability {
  if (typeof value !== 'string') return 'unknown';
  const lowered = value.trim().toLowerCase();
  if (lowered === 'persistent') return 'persistent';
  if (lowered === 'temporary') return 'temporary';
  return 'unknown';
}

export function normalizeContractId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('contractId must be a string');
  return value.trim();
}

function normalizeDecoded(value: unknown): unknown {
  if (typeof value === 'string') {
    return value;
  }
  return sortObject(makeJsonSafe(value));
}

export function normalizeEntry(raw: unknown): CanonicalEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('entry must be an object');
  const obj = raw as JsonObject;
  const ledgerKey = normalizeLedgerKey(obj.ledgerKey ?? obj.keyXdr ?? obj.key);
  let valueXdr: string | undefined;
  if (typeof obj.valueXdr === 'string' && obj.valueXdr.trim()) {
    try {
      valueXdr = normalizeBase64(obj.valueXdr);
    } catch {
      valueXdr = obj.valueXdr.trim();
    }
  }
  const decodedFromXdr = decodeScValXdr(valueXdr);
  const valueDecoded =
    obj.valueDecoded !== undefined
      ? normalizeDecoded(obj.valueDecoded)
      : decodedFromXdr.decoded
        ? decodedFromXdr.value
        : undefined;
  return {
    ledgerKey,
    entryType:
      typeof obj.entryType === 'string' && obj.entryType.trim()
        ? obj.entryType.trim()
        : ledgerKeyType(ledgerKey),
    contractId: normalizeContractId(obj.contractId),
    durability: normalizeDurability(obj.durability),
    lastModifiedLedgerSeq: normalizeInteger(obj.lastModifiedLedgerSeq, 'lastModifiedLedgerSeq'),
    liveUntilLedgerSeq: normalizeInteger(obj.liveUntilLedgerSeq, 'liveUntilLedgerSeq'),
    valueXdr,
    valueDecoded,
  };
}

export function parseSnapshot(raw: unknown): CanonicalSnapshot {
  if (Array.isArray(raw)) {
    return { version: 1, entries: raw.map(normalizeEntry).sort(compareEntries) };
  }
  if (!raw || typeof raw !== 'object') throw new Error('snapshot must be an object or entry array');
  const obj = raw as JsonObject;
  if (obj.version !== undefined && obj.version !== 1 && obj.version !== '1') {
    throw new Error(`unsupported snapshot version: ${String(obj.version)}`);
  }
  if (!Array.isArray(obj.entries)) throw new Error('snapshot object requires an entries array');
  return {
    version: 1,
    ledger: normalizeInteger(obj.ledger ?? obj.ledgerSeq, 'ledger'),
    entries: obj.entries.map(normalizeEntry).sort(compareEntries),
  };
}

export function loadSnapshot(filePath: string): CanonicalSnapshot {
  return parseSnapshot(readJsonFile(filePath).raw);
}

export function compareEntries(a: CanonicalEntry, b: CanonicalEntry): number {
  return (
    a.ledgerKey.localeCompare(b.ledgerKey) ||
    (a.contractId ?? '').localeCompare(b.contractId ?? '') ||
    a.durability.localeCompare(b.durability)
  );
}

export function filterEntries(
  entries: CanonicalEntry[],
  contractId?: string,
  durability?: string,
): CanonicalEntry[] {
  const durabilityFilter = durability?.toLowerCase();
  return entries.filter(
    (entry) =>
      (!contractId || entry.contractId === contractId) &&
      (!durabilityFilter || entry.durability === durabilityFilter),
  );
}

export function validateContractId(contractId: string | undefined): boolean {
  return contractId === undefined || StrKey.isValidContract(contractId);
}

export function bigIntCompare(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  const aa = BigInt(a);
  const bb = BigInt(b);
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

export function remainingTtl(
  liveUntilLedgerSeq: string | undefined,
  referenceLedger: string | undefined,
): string | undefined {
  if (liveUntilLedgerSeq === undefined || referenceLedger === undefined) return undefined;
  return (BigInt(liveUntilLedgerSeq) - BigInt(referenceLedger)).toString();
}

export function duplicateKeys(entries: CanonicalEntry[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.ledgerKey)) dup.add(entry.ledgerKey);
    seen.add(entry.ledgerKey);
  }
  return [...dup].sort();
}

export function valuesConflict(entry: CanonicalEntry): boolean {
  if (!entry.valueXdr || entry.valueDecoded === undefined) return false;
  const decoded = decodeScValXdr(entry.valueXdr);
  if (!decoded.decoded) return false;
  return (
    stableStringify(decoded.value, 0) !== stableStringify(normalizeDecoded(entry.valueDecoded), 0)
  );
}

export function parseFlags(args: string[]): {
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    const key = token.replace(/^-+/, '');
    const next = args[i + 1];
    if (!next || next.startsWith('-')) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return { positional, flags };
}

export function getFlag(
  flags: Record<string, string | boolean>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = flags[name];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

export function hasFlag(flags: Record<string, string | boolean>, ...names: string[]): boolean {
  return names.some((name) => flags[name] === true || typeof flags[name] === 'string');
}

export function requirePositiveInt(
  value: string | undefined,
  label: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is too large`);
  return parsed;
}

export function averageBigInts(values: string[]): string | undefined {
  if (values.length === 0) return undefined;
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  const scale = 100n;
  const scaled = (total * scale) / BigInt(values.length);
  return `${scaled / scale}.${(scaled % scale).toString().padStart(2, '0')}`;
}
