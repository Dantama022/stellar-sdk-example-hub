import fs from 'fs';
import path from 'path';
import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';

export type StateDurability = 'persistent' | 'temporary' | 'unknown';

export interface SnapshotWarning {
  index: number;
  ledgerKey?: string;
  message: string;
}

export interface NormalizedStateEntry {
  index: number;
  ledgerKey: string;
  canonicalLedgerKey: string;
  ledgerEntryType: string;
  contractId?: string;
  durability: StateDurability;
  keyXdr?: string;
  keyDecoded?: unknown;
  valueXdr?: string;
  valueDecoded?: unknown;
  valueScValType?: string;
  lastModifiedLedgerSeq?: bigint;
  liveUntilLedgerSeq?: bigint;
  decodeErrors: string[];
}

export interface NormalizedStateSnapshot {
  ledger?: bigint;
  entries: NormalizedStateEntry[];
  warnings: SnapshotWarning[];
}

export interface ScValNode {
  path: string;
  depth: number;
  type: string;
  value: unknown;
  rawXdr?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function parseLedgerSequence(value: unknown): bigint | undefined {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return undefined;
}

export function bigintToJson(value: bigint | undefined): string | undefined {
  return value === undefined ? undefined : value.toString();
}

export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Map) {
    return Array.from(value.entries()).map(([key, entry]) => [jsonSafe(key), jsonSafe(entry)]);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== undefined) out[key] = jsonSafe(entry);
    }
    return out;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (typeof input === 'bigint') return input.toString();
    if (Buffer.isBuffer(input)) return `0x${input.toString('hex')}`;
    if (input instanceof Uint8Array) return `0x${Buffer.from(input).toString('hex')}`;
    if (Array.isArray(input)) return input.map(normalize);
    if (input instanceof Map) {
      return Array.from(input.entries())
        .map(([key, entry]) => [normalize(key), normalize(entry)] as [unknown, unknown])
        .sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])));
    }
    if (input && typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        out[key] = normalize(obj[key]);
      }
      return out;
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

export function renderValue(value: unknown): string {
  if (value === undefined) return '(unavailable)';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  try {
    return stableStringify(value);
  } catch {
    return String(value);
  }
}

export function normalizeScValType(typeName: string | undefined): string {
  if (!typeName) return 'unknown';
  const trimmed = typeName.trim();
  if (!trimmed) return 'unknown';
  if (trimmed.startsWith('scv') && trimmed.length > 3) {
    return trimmed
      .slice(3)
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase();
  }
  return trimmed.replace(/_/g, '-').toLowerCase();
}

function getSwitchName(value: any): string | undefined {
  try {
    const result = typeof value?.switch === 'function' ? value.switch() : undefined;
    return result?.name ?? (typeof result === 'string' ? result : undefined);
  } catch {
    return undefined;
  }
}

function getScValType(scVal: any): string {
  return normalizeScValType(getSwitchName(scVal));
}

function decodeScValNative(scVal: any): unknown {
  return jsonSafe(scValToNative(scVal as xdr.ScVal));
}

function parseScValXdr(valueXdr: string): any | undefined {
  try {
    return xdr.ScVal.fromXDR(valueXdr, 'base64');
  } catch {
    return undefined;
  }
}

function decodeContractId(scAddress: any): string | undefined {
  try {
    return Address.fromScAddress(scAddress).toString();
  } catch {
    return undefined;
  }
}

function normalizeDurability(value: unknown): StateDurability {
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (lowered.includes('persistent')) return 'persistent';
    if (lowered.includes('temporary')) return 'temporary';
  }
  return 'unknown';
}

function decodeLedgerKey(ledgerKey: string): {
  canonicalLedgerKey?: string;
  ledgerEntryType?: string;
  contractId?: string;
  durability?: StateDurability;
  keyXdr?: string;
  keyDecoded?: unknown;
  keyScVal?: any;
  error?: string;
} {
  try {
    const decoded: any = xdr.LedgerKey.fromXDR(ledgerKey, 'base64');
    const canonicalLedgerKey = decoded.toXDR('base64');
    const switchName = getSwitchName(decoded) ?? 'unknown';
    const ledgerEntryType = switchName
      .replace(/^ledgerKey/i, '')
      .replace(/^contractData$/i, 'contractData');

    if (switchName === 'contractData') {
      const contractData = decoded.contractData();
      const keyScVal = contractData.key();
      const keyXdr = keyScVal.toXDR('base64');
      let keyDecoded: unknown;
      try {
        keyDecoded = decodeScValNative(keyScVal);
      } catch {
        keyDecoded = undefined;
      }
      return {
        canonicalLedgerKey,
        ledgerEntryType,
        contractId: decodeContractId(contractData.contract()),
        durability: normalizeDurability(getSwitchName(contractData.durability())),
        keyXdr,
        keyDecoded,
        keyScVal,
      };
    }

    return { canonicalLedgerKey, ledgerEntryType };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function decodeValueXdr(valueXdr: string): {
  decoded?: unknown;
  type?: string;
  scVal?: any;
  error?: string;
} {
  const scVal = parseScValXdr(valueXdr);
  if (!scVal) return { error: 'valueXdr is not valid ScVal base64 XDR' };
  try {
    return {
      decoded: decodeScValNative(scVal),
      type: getScValType(scVal),
      scVal,
    };
  } catch (error: unknown) {
    return {
      type: getScValType(scVal),
      scVal,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function normalizeStateEntry(raw: unknown, index: number): NormalizedStateEntry | null {
  const obj = asRecord(raw);
  if (!obj) return null;

  const rawLedgerKey =
    typeof obj.ledgerKey === 'string'
      ? obj.ledgerKey.trim()
      : typeof obj.ledger_key === 'string'
        ? obj.ledger_key.trim()
        : '';

  const contractIdFromJson =
    typeof obj.contractId === 'string'
      ? obj.contractId.trim()
      : typeof obj.contract_id === 'string'
        ? obj.contract_id.trim()
        : undefined;

  const durabilityFromJson = normalizeDurability(obj.durability);
  const entryTypeFromJson =
    typeof obj.ledgerEntryType === 'string'
      ? obj.ledgerEntryType.trim()
      : typeof obj.entryType === 'string'
        ? obj.entryType.trim()
        : typeof obj.type === 'string'
          ? obj.type.trim()
          : '';

  const decodeErrors: string[] = [];
  const ledgerDecoded = rawLedgerKey ? decodeLedgerKey(rawLedgerKey) : {};
  if (rawLedgerKey && ledgerDecoded.error) {
    decodeErrors.push(`ledgerKey: ${ledgerDecoded.error}`);
  }

  const keyXdrFromJson = typeof obj.keyXdr === 'string' ? obj.keyXdr.trim() : undefined;
  let keyDecodedFromJson = obj.keyDecoded ?? obj.key;
  let keyTypeFromJson = typeof obj.keyType === 'string' ? obj.keyType : undefined;

  if (keyXdrFromJson && keyDecodedFromJson === undefined) {
    const parsedKeyScVal = parseScValXdr(keyXdrFromJson);
    if (parsedKeyScVal) {
      keyTypeFromJson = getScValType(parsedKeyScVal);
      try {
        keyDecodedFromJson = decodeScValNative(parsedKeyScVal);
      } catch {
        keyDecodedFromJson = undefined;
      }
    }
  }

  const valueXdr =
    typeof obj.valueXdr === 'string'
      ? obj.valueXdr.trim()
      : typeof obj.value_xdr === 'string'
        ? obj.value_xdr.trim()
        : undefined;

  const valueDecodedFromJson = obj.valueDecoded ?? obj.value;
  const valueTypeFromJson =
    typeof obj.valueScValType === 'string'
      ? normalizeScValType(obj.valueScValType)
      : typeof obj.valueType === 'string'
        ? normalizeScValType(obj.valueType)
        : undefined;

  let valueDecoded = valueDecodedFromJson;
  let valueScValType = valueTypeFromJson;
  if (valueXdr) {
    const decoded = decodeValueXdr(valueXdr);
    valueScValType = decoded.type ?? valueScValType;
    if (valueDecoded === undefined && decoded.decoded !== undefined) valueDecoded = decoded.decoded;
    if (decoded.error) decodeErrors.push(`valueXdr: ${decoded.error}`);
  }

  const lastModifiedLedgerSeq =
    parseLedgerSequence(obj.lastModifiedLedgerSeq) ??
    parseLedgerSequence(obj.last_modified_ledger_seq);
  const liveUntilLedgerSeq =
    parseLedgerSequence(obj.liveUntilLedgerSeq) ?? parseLedgerSequence(obj.live_until_ledger_seq);

  const contractId = ledgerDecoded.contractId ?? contractIdFromJson;
  const durability =
    ledgerDecoded.durability && ledgerDecoded.durability !== 'unknown'
      ? ledgerDecoded.durability
      : durabilityFromJson;
  const ledgerEntryType = ledgerDecoded.ledgerEntryType ?? (entryTypeFromJson || 'unknown');
  const keyXdr = ledgerDecoded.keyXdr ?? keyXdrFromJson;
  const keyDecoded = ledgerDecoded.keyDecoded ?? keyDecodedFromJson;

  const syntheticKey = stableStringify({
    contractId: contractId ?? null,
    durability,
    keyXdr: keyXdr ?? null,
    keyDecoded: keyDecoded ?? null,
    index,
  });

  const canonicalLedgerKey = ledgerDecoded.canonicalLedgerKey ?? (rawLedgerKey || syntheticKey);
  const ledgerKey = rawLedgerKey || canonicalLedgerKey;

  if (!rawLedgerKey && !keyXdr && keyDecoded === undefined) {
    decodeErrors.push('entry has no ledgerKey or decodable key information');
  }

  if (!valueScValType && valueDecoded !== undefined) {
    if (typeof valueDecoded === 'string') valueScValType = keyTypeFromJson ?? 'string';
    else if (typeof valueDecoded === 'boolean') valueScValType = 'bool';
    else if (typeof valueDecoded === 'number' || typeof valueDecoded === 'bigint') {
      valueScValType = 'integer';
    } else if (Array.isArray(valueDecoded)) valueScValType = 'vec';
    else if (valueDecoded && typeof valueDecoded === 'object') valueScValType = 'map';
  }

  return {
    index,
    ledgerKey,
    canonicalLedgerKey,
    ledgerEntryType,
    contractId: contractId || undefined,
    durability,
    keyXdr,
    keyDecoded: jsonSafe(keyDecoded),
    valueXdr,
    valueDecoded: jsonSafe(valueDecoded),
    valueScValType,
    lastModifiedLedgerSeq,
    liveUntilLedgerSeq,
    decodeErrors,
  };
}

export function parseStateSnapshot(raw: unknown, label = 'snapshot'): NormalizedStateSnapshot {
  let ledger: bigint | undefined;
  let rawEntries: unknown[];

  if (Array.isArray(raw)) {
    rawEntries = raw;
  } else {
    const obj = asRecord(raw);
    if (!obj) throw new Error(`Snapshot "${label}" must be an array or object.`);
    if (!Array.isArray(obj.entries)) {
      throw new Error(`Snapshot "${label}" object form requires an "entries" array.`);
    }
    rawEntries = obj.entries;
    ledger = parseLedgerSequence(obj.ledger) ?? parseLedgerSequence(obj.ledgerSequence);
  }

  const entries: NormalizedStateEntry[] = [];
  const warnings: SnapshotWarning[] = [];

  rawEntries.forEach((entry, index) => {
    const normalized = normalizeStateEntry(entry, index);
    if (!normalized) {
      warnings.push({ index, message: 'entry is not an object and was skipped' });
      return;
    }
    entries.push(normalized);
    for (const message of normalized.decodeErrors) {
      warnings.push({ index, ledgerKey: normalized.ledgerKey, message });
    }
  });

  entries.sort((a, b) => {
    const contractCompare = (a.contractId ?? '').localeCompare(b.contractId ?? '');
    if (contractCompare !== 0) return contractCompare;
    const durabilityCompare = a.durability.localeCompare(b.durability);
    if (durabilityCompare !== 0) return durabilityCompare;
    return a.canonicalLedgerKey.localeCompare(b.canonicalLedgerKey);
  });

  return { ledger, entries, warnings };
}

export function loadStateSnapshot(filePath: string): NormalizedStateSnapshot {
  const resolved = path.resolve(filePath);
  let text: string;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (error: unknown) {
    throw new Error(
      `Cannot read snapshot file "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error(
      `Snapshot file "${filePath}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseStateSnapshot(raw, filePath);
}

export function filterStateEntries(
  entries: NormalizedStateEntry[],
  options: {
    contractId?: string;
    durability?: StateDurability;
    entryType?: string;
  },
): NormalizedStateEntry[] {
  const contractId = options.contractId?.trim();
  const entryType = options.entryType?.trim().toLowerCase();
  return entries.filter((entry) => {
    if (contractId && entry.contractId !== contractId) return false;
    if (options.durability && entry.durability !== options.durability) return false;
    if (entryType && entry.ledgerEntryType.toLowerCase() !== entryType) return false;
    return true;
  });
}

export function countBy<T>(items: T[], selector: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = selector(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function averageBigInt(values: bigint[], decimalPlaces = 2): string | undefined {
  if (values.length === 0) return undefined;
  const total = values.reduce((sum, value) => sum + value, 0n);
  const count = BigInt(values.length);
  const whole = total / count;
  const remainder = total % count;
  if (remainder === 0n || decimalPlaces <= 0) return whole.toString();
  const scale = 10n ** BigInt(decimalPlaces);
  const fraction = (remainder * scale) / count;
  return `${whole}.${fraction.toString().padStart(decimalPlaces, '0')}`;
}

function childNodes(scVal: any): Array<{ suffix: string; value: any }> {
  const type = getScValType(scVal);
  if (type === 'vec') {
    try {
      const values: any[] = scVal.vec() ?? [];
      return values.map((value, index) => ({ suffix: `[${index}]`, value }));
    } catch {
      return [];
    }
  }
  if (type === 'map') {
    try {
      const entries: any[] = scVal.map() ?? [];
      const out: Array<{ suffix: string; value: any }> = [];
      entries.forEach((entry, index) => {
        out.push({ suffix: `.map[${index}].key`, value: entry.key() });
        out.push({ suffix: `.map[${index}].value`, value: entry.val() });
      });
      return out;
    } catch {
      return [];
    }
  }
  if (type === 'contract-instance') {
    try {
      const instance = scVal.instance();
      const storage = instance.storage?.() ?? instance.storage ?? [];
      const out: Array<{ suffix: string; value: any }> = [];
      if (Array.isArray(storage)) {
        storage.forEach((entry: any, index: number) => {
          const key = typeof entry.key === 'function' ? entry.key() : entry.key;
          const val = typeof entry.val === 'function' ? entry.val() : entry.val;
          if (key) out.push({ suffix: `.storage[${index}].key`, value: key });
          if (val) out.push({ suffix: `.storage[${index}].value`, value: val });
        });
      }
      return out;
    } catch {
      return [];
    }
  }
  return [];
}

export function walkScValXdr(
  valueXdr: string,
  options: { maxDepth?: number } = {},
): { nodes: ScValNode[]; error?: string } {
  const root = parseScValXdr(valueXdr);
  if (!root) return { nodes: [], error: 'invalid ScVal base64 XDR' };

  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const nodes: ScValNode[] = [];

  const visit = (current: any, nodePath: string, depth: number): void => {
    const type = getScValType(current);
    let value: unknown;
    try {
      value = decodeScValNative(current);
    } catch {
      value = undefined;
    }
    let rawXdr: string | undefined;
    try {
      rawXdr = current.toXDR('base64');
    } catch {
      rawXdr = undefined;
    }
    nodes.push({ path: nodePath, depth, type, value, rawXdr });
    if (depth >= maxDepth) return;
    for (const child of childNodes(current)) {
      visit(child.value, `${nodePath}${child.suffix}`, depth + 1);
    }
  };

  visit(root, '$', 0);
  return { nodes };
}

export function normalizeDecodedQuery(query: string): unknown {
  const trimmed = query.trim();
  if (!trimmed) return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return BigInt(trimmed);
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export function parseCliFlags(args: string[]): {
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const equalsIndex = token.indexOf('=');
    if (equalsIndex > 2) {
      flags[token.slice(2, equalsIndex)] = token.slice(equalsIndex + 1);
      continue;
    }

    const key = token.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return { positional, flags };
}

export function flagString(
  flags: Record<string, string | boolean>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = flags[name];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

export function flagBoolean(flags: Record<string, string | boolean>, ...names: string[]): boolean {
  for (const name of names) {
    const value = flags[name];
    if (value === true || value === 'true') return true;
  }
  return false;
}

export function parseDurability(value: string | undefined): StateDurability | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === 'persistent' || normalized === 'temporary') return normalized;
  throw new Error(`Invalid durability "${value}". Use persistent or temporary.`);
}

export function parseNonNegativeBigIntFlag(
  value: string | undefined,
  label: string,
): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative integer.`);
  return BigInt(value);
}

export function parseNonNegativeNumberFlag(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return numberValue;
}

export function tryCanonicalLedgerKey(input: string): string | undefined {
  try {
    return xdr.LedgerKey.fromXDR(input.trim(), 'base64').toXDR('base64');
  } catch {
    return undefined;
  }
}
