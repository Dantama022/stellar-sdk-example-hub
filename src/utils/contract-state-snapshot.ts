import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Address, Networks, rpc, scValToNative, StrKey, xdr } from '@stellar/stellar-sdk';

/**
 * ISSUE-417: Soroban contract state snapshots
 *
 * This module captures the ledger entries that make up a contract's observable
 * state, normalizes them into a deterministic JSON representation, and assigns
 * SHA-256 fingerprints so two captures can be compared without trusting object
 * property order or JSON serializer behavior.
 *
 * Important boundary: Soroban RPC's `getLedgerEntries` and `getContractData`
 * read the *current* ledger state. They do not expose arbitrary historical
 * ledger positions. A snapshot records the ledger sequence at capture time, but
 * "capture at ledger N in the past" is not possible with standard Soroban RPC;
 * the caller gets `UnsupportedHistoricalStateError` instead of a silently
 * mislabeled snapshot. Historical state needs an archival/indexing provider.
 *
 * Also, a contract can store data in shapes this module cannot enumerate from
 * RPC alone. There is no RPC method that lists every storage key of a
 * contract, so callers must name the keys they want inspected. The contract
 * instance entry is always fetched because its address is derived from the
 * contract ID.
 */

export const SNAPSHOT_FORMAT = 'stellar-sdk-example-hub/contract-state-snapshot';
export const SNAPSHOT_VERSION = 1 as const;

export type SnapshotEntryType = 'instance' | 'persistent' | 'temporary' | 'contractCode' | 'other';

export type SnapshotDurability = 'instance' | 'persistent' | 'temporary' | 'unknown';
export type StorageDurability = 'persistent' | 'temporary';
export type UnavailableReason = 'not-found' | 'archived' | 'rpc-error';

export interface SnapshotEntry {
  /** SHA-256 of the canonical ledger-key XDR. Stable across captures. */
  keyId: string;
  /** Canonical base64 LedgerKey XDR. */
  ledgerKey: string;
  ledgerEntryType: string;
  entryType: SnapshotEntryType;
  durability: SnapshotDurability;
  contractId?: string;
  keyXdr?: string;
  keyDecoded?: unknown;
  keyLabel?: string;
  valueXdr?: string;
  valueDecoded?: unknown;
  valueScValType?: string;
  sizeBytes: number;
  lastModifiedLedgerSeq?: number;
  liveUntilLedgerSeq?: number;
  /** SHA-256 over ledger key, entry type, durability and encoded value. */
  fingerprint: string;
  /** False when the value could not be normalized reliably. */
  comparable: boolean;
  decodeErrors: string[];
}

export interface UnavailableSnapshotEntry {
  keyId: string;
  ledgerKey: string;
  label: string;
  reason: UnavailableReason;
  message: string;
}

export interface ContractStateSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  contractId: string;
  network: {
    id: string;
    passphrase: string;
  };
  ledger: number;
  capturedAt: string;
  wasmHash?: string;
  entries: SnapshotEntry[];
  unavailable: UnavailableSnapshotEntry[];
  /**
   * SHA-256 over the contract ID and the sorted entry fingerprints. It covers
   * state content, not the capture time or ledger sequence.
   */
  snapshotFingerprint: string;
  warnings: string[];
}

export interface StorageKeySpec {
  key: xdr.ScVal;
  durability: StorageDurability;
  label: string;
}

/**
 * The subset of `rpc.Server` used for retrieval. Keeping it structural makes
 * the capture logic testable without a live network.
 */
export interface ContractStateSource {
  getLatestLedger(): Promise<{ sequence: number }>;
  getContractData(
    contractId: string,
    key: xdr.ScVal,
    durability: rpc.Durability,
  ): Promise<rpc.Api.LedgerEntryResult>;
  getLedgerEntries(
    ...keys: xdr.LedgerKey[]
  ): Promise<{ entries: rpc.Api.LedgerEntryResult[]; latestLedger: number }>;
}

export interface CaptureContractStateOptions {
  contractId: string;
  networkPassphrase: string;
  source: ContractStateSource;
  /** Optional storage keys to inspect, in addition to the instance entry. */
  storageKeys?: StorageKeySpec[];
  /** Include the contractCode entry referenced by the instance, when found. */
  includeContractCode?: boolean;
  /**
   * Ledger sequence the caller believes it is capturing. Only the current
   * ledger is supported; anything else raises UnsupportedHistoricalStateError.
   */
  requestedLedger?: number;
  /** Fixed capture timestamp, primarily for deterministic tests. */
  capturedAt?: string;
}

export class SnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotValidationError';
  }
}

export class SnapshotCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotCompatibilityError';
  }
}

export class UnsupportedHistoricalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedHistoricalStateError';
  }
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value instanceof Map) {
    return Array.from(value.entries()).map(([key, child]) => [toJsonSafe(key), toJsonSafe(child)]);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child !== undefined) out[key] = toJsonSafe(child);
    }
    return out;
  }
  return value;
}

function toCanonicalValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return value.map(toCanonicalValue);
  if (value instanceof Map) {
    return Array.from(value.entries())
      .map(([key, child]) => [toCanonicalValue(key), toCanonicalValue(child)])
      .sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = toCanonicalValue(child);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic JSON: object keys are sorted recursively, bigints and byte
 * arrays are encoded explicitly. Never use plain JSON.stringify for
 * fingerprints.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

export function networkId(passphrase: string): string {
  if (passphrase === Networks.PUBLIC) return 'mainnet';
  if (passphrase === Networks.TESTNET) return 'testnet';
  if (passphrase === Networks.FUTURENET) return 'futurenet';
  if (passphrase === 'Standalone Network ; February 2017') return 'standalone';
  return 'custom';
}

export function isValidContractId(contractId: string): boolean {
  return typeof contractId === 'string' && StrKey.isValidContract(contractId);
}

export function buildContractDataKey(
  contractId: string,
  key: xdr.ScVal,
  durability: StorageDurability,
): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key,
      durability:
        durability === 'temporary'
          ? xdr.ContractDataDurability.temporary()
          : xdr.ContractDataDurability.persistent(),
    }),
  );
}

export function buildInstanceKey(contractId: string): xdr.LedgerKey {
  return buildContractDataKey(contractId, xdr.ScVal.scvLedgerKeyContractInstance(), 'persistent');
}

export function buildContractCodeKey(wasmHashHex: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHashHex, 'hex') }),
  );
}

export function ledgerKeyId(ledgerKey: xdr.LedgerKey): string {
  return sha256Hex(ledgerKey.toXDR('base64'));
}

/**
 * Accept symbol names, base64 ScVal XDR, or base64 LedgerKey XDR. A LedgerKey
 * supplies its own durability and contract; a bare ScVal or symbol uses the
 * caller's default durability.
 */
export function parseStorageKeySpecs(
  values: string[],
  defaultDurability: StorageDurability,
): StorageKeySpec[] {
  const specs: StorageKeySpec[] = [];
  const seen = new Set<string>();

  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;

    let spec: StorageKeySpec;
    try {
      const ledgerKey = xdr.LedgerKey.fromXDR(value, 'base64');
      if (ledgerKey.switch() !== xdr.LedgerEntryType.contractData()) {
        throw new Error('LedgerKey is not a contractData key');
      }
      const data = ledgerKey.contractData();
      const durability =
        data.durability() === xdr.ContractDataDurability.temporary() ? 'temporary' : 'persistent';
      spec = {
        key: data.key(),
        durability,
        label: `ledgerKey:${sha256Hex(ledgerKey.toXDR('base64')).slice(0, 12)}`,
      };
    } catch {
      let key: xdr.ScVal | undefined;
      try {
        key = xdr.ScVal.fromXDR(value, 'base64');
      } catch {
        key = undefined;
      }
      spec = {
        key: key ?? xdr.ScVal.scvSymbol(value),
        durability: defaultDurability,
        label: key ? `scval:${sha256Hex(key.toXDR('base64')).slice(0, 12)}` : value,
      };
    }

    const identity = `${spec.durability}:${spec.key.toXDR('base64')}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    specs.push(spec);
  }

  return specs;
}

function decodeValue(value: xdr.ScVal): {
  decoded?: unknown;
  type?: string;
  error?: string;
} {
  const type = normalizeScValType(value.switch().name);
  try {
    return { decoded: toJsonSafe(scValToNative(value)), type };
  } catch (error: unknown) {
    return {
      type,
      error: `value could not be decoded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function normalizeScValType(typeName: string | undefined): string {
  if (!typeName) return 'unknown';
  return typeName.startsWith('scv')
    ? typeName
        .slice(3)
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase()
    : typeName.toLowerCase();
}

function extractWasmHash(data: xdr.LedgerEntryData): string | undefined {
  try {
    if (data.switch() !== xdr.LedgerEntryType.contractData()) return undefined;
    const value = data.contractData().val();
    if (value.switch() !== xdr.ScValType.scvContractInstance()) return undefined;
    const executable = value.instance().executable();
    if (executable.switch().name !== 'contractExecutableWasm') return undefined;
    return executable.wasmHash().toString('hex');
  } catch {
    return undefined;
  }
}

function decodeContractId(address: xdr.ScAddress): string | undefined {
  try {
    return Address.fromScAddress(address).toString();
  } catch {
    return undefined;
  }
}

/**
 * Turn one RPC ledger entry into the portable representation. `fallbackKey` is
 * used only if the RPC result omits its ledger key.
 */
export function normalizeLedgerEntry(
  result: rpc.Api.LedgerEntryResult,
  fallbackKey?: xdr.LedgerKey,
  label?: string,
): SnapshotEntry | null {
  const ledgerKey = result.key ?? fallbackKey;
  if (!ledgerKey) return null;

  const canonicalKey = ledgerKey.toXDR('base64');
  const data = result.val;
  const decodeErrors: string[] = [];

  let entryType: SnapshotEntryType = 'other';
  let durability: SnapshotDurability = 'unknown';
  let contractId: string | undefined;
  let keyXdr: string | undefined;
  let keyDecoded: unknown;
  let valueXdr: string | undefined;
  let valueDecoded: unknown;
  let valueScValType: string | undefined;
  let sizeBytes = 0;
  let comparable = true;
  let codeHash: string | undefined;

  if (data.switch() === xdr.LedgerEntryType.contractData()) {
    const contractData = data.contractData();
    contractId = decodeContractId(contractData.contract());
    const key = contractData.key();
    keyXdr = key.toXDR('base64');
    keyDecoded = toJsonSafe(safeNative(key));
    valueXdr = contractData.val().toXDR('base64');
    sizeBytes = Buffer.from(valueXdr, 'base64').length;

    const decoded = decodeValue(contractData.val());
    valueDecoded = decoded.decoded;
    valueScValType = decoded.type;
    if (decoded.error) {
      decodeErrors.push(decoded.error);
      comparable = false;
    }

    if (key.switch() === xdr.ScValType.scvLedgerKeyContractInstance()) {
      entryType = 'instance';
      durability = 'instance';
    } else if (contractData.durability() === xdr.ContractDataDurability.temporary()) {
      entryType = 'temporary';
      durability = 'temporary';
    } else {
      entryType = 'persistent';
      durability = 'persistent';
    }
  } else if (data.switch() === xdr.LedgerEntryType.contractCode()) {
    const code = data.contractCode();
    entryType = 'contractCode';
    codeHash = code.hash().toString('hex');
    sizeBytes = code.code().length;
    valueDecoded = { codeHash, codeSizeBytes: sizeBytes };
    valueScValType = 'wasm';
    keyDecoded = { codeHash };
  } else {
    decodeErrors.push(`unsupported ledger entry type: ${data.switch().name}`);
    comparable = false;
  }

  const fingerprint = fingerprintEntry({
    ledgerKey: canonicalKey,
    entryType,
    durability,
    keyXdr,
    valueXdr,
    codeHash,
  });

  return {
    keyId: sha256Hex(canonicalKey),
    ledgerKey: canonicalKey,
    ledgerEntryType: data.switch().name,
    entryType,
    durability,
    contractId,
    keyXdr,
    keyDecoded,
    keyLabel: label,
    valueXdr,
    valueDecoded,
    valueScValType,
    sizeBytes,
    lastModifiedLedgerSeq: result.lastModifiedLedgerSeq,
    liveUntilLedgerSeq: result.liveUntilLedgerSeq,
    fingerprint,
    comparable,
    decodeErrors,
  };
}

function safeNative(value: xdr.ScVal): unknown {
  try {
    return scValToNative(value);
  } catch {
    return undefined;
  }
}

/**
 * Entry fingerprint input. Deliberately excludes lastModifiedLedgerSeq,
 * liveUntilLedgerSeq and decoded JSON so rent/TTL changes do not masquerade as
 * value changes, and JSON property order cannot affect the hash.
 */
export function fingerprintEntry(parts: {
  ledgerKey: string;
  entryType: string;
  durability: string;
  keyXdr?: string;
  valueXdr?: string;
  codeHash?: string;
}): string {
  return sha256Hex(
    canonicalJson({
      ledgerKey: parts.ledgerKey,
      entryType: parts.entryType,
      durability: parts.durability,
      keyXdr: parts.keyXdr ?? null,
      valueXdr: parts.valueXdr ?? null,
      codeHash: parts.codeHash ?? null,
    }),
  );
}

export function fingerprintSnapshot(contractId: string, entries: SnapshotEntry[]): string {
  return sha256Hex(
    canonicalJson({
      contractId,
      entries: entries.map((entry) => entry.fingerprint).sort(),
    }),
  );
}

function classifyUnavailable(error: unknown): UnavailableReason {
  const message = String((error as { message?: unknown })?.message ?? error).toLowerCase();
  if (message.includes('archiv') || message.includes('expired') || message.includes('live until')) {
    return 'archived';
  }
  if (
    message.includes('not found') ||
    message.includes('could not obtain') ||
    message.includes('not available') ||
    message.includes('missing')
  ) {
    return 'not-found';
  }
  return 'rpc-error';
}

async function fetchEntry(
  source: ContractStateSource,
  contractId: string,
  spec: StorageKeySpec,
  entries: SnapshotEntry[],
  unavailable: UnavailableSnapshotEntry[],
): Promise<void> {
  const ledgerKey = buildContractDataKey(contractId, spec.key, spec.durability);
  try {
    const result = await source.getContractData(
      contractId,
      spec.key,
      spec.durability === 'temporary' ? rpc.Durability.Temporary : rpc.Durability.Persistent,
    );
    const normalized = normalizeLedgerEntry(result, ledgerKey, spec.label);
    if (normalized) entries.push(normalized);
  } catch (error: unknown) {
    unavailable.push({
      keyId: ledgerKeyId(ledgerKey),
      ledgerKey: ledgerKey.toXDR('base64'),
      label: spec.label,
      reason: classifyUnavailable(error),
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Capture the current observable state of one contract. Missing optional
 * entries are recorded as unavailable rather than aborting the capture, so a
 * later comparison can distinguish "removed" from "could not read".
 */
export async function captureContractStateSnapshot(
  options: CaptureContractStateOptions,
): Promise<ContractStateSnapshot> {
  if (!isValidContractId(options.contractId)) {
    throw new SnapshotValidationError(
      `Invalid contract ID "${options.contractId}". Expected a C... Stellar contract address.`,
    );
  }
  if (!options.networkPassphrase?.trim()) {
    throw new SnapshotValidationError('A network passphrase is required.');
  }

  let latestLedger: number;
  try {
    const latest = await options.source.getLatestLedger();
    latestLedger = latest.sequence;
  } catch (error: unknown) {
    throw new Error(
      `RPC failure fetching the latest ledger: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!Number.isSafeInteger(latestLedger) || latestLedger < 0) {
    throw new Error(`RPC returned an invalid latest ledger sequence: ${latestLedger}`);
  }

  if (options.requestedLedger !== undefined) {
    if (!Number.isSafeInteger(options.requestedLedger) || options.requestedLedger < 0) {
      throw new SnapshotValidationError('requestedLedger must be a non-negative integer.');
    }
    if (options.requestedLedger !== latestLedger) {
      throw new UnsupportedHistoricalStateError(
        `Cannot capture contract state at ledger ${options.requestedLedger}: Soroban RPC ` +
          `getLedgerEntries/getContractData read current ledger state only (latest ledger is ` +
          `${latestLedger}). Historical ledger state requires an archival or indexing provider. ` +
          'Omit the ledger override, or set it to the current ledger.',
      );
    }
  }

  const entries: SnapshotEntry[] = [];
  const unavailable: UnavailableSnapshotEntry[] = [];
  const warnings: string[] = [];
  let wasmHash: string | undefined;

  const instanceKey = buildInstanceKey(options.contractId);
  try {
    const instance = await options.source.getContractData(
      options.contractId,
      xdr.ScVal.scvLedgerKeyContractInstance(),
      rpc.Durability.Persistent,
    );
    const normalized = normalizeLedgerEntry(instance, instanceKey, 'instance');
    if (normalized) {
      entries.push(normalized);
      wasmHash = extractWasmHash(instance.val);
    }
  } catch (error: unknown) {
    unavailable.push({
      keyId: ledgerKeyId(instanceKey),
      ledgerKey: instanceKey.toXDR('base64'),
      label: 'instance',
      reason: classifyUnavailable(error),
      message: error instanceof Error ? error.message : String(error),
    });
    warnings.push(
      'The contract instance entry could not be read. The contract may be undeployed, ' +
        'archived, or the RPC endpoint may not serve this network.',
    );
  }

  if (options.includeContractCode !== false && wasmHash) {
    const codeKey = buildContractCodeKey(wasmHash);
    try {
      const response = await options.source.getLedgerEntries(codeKey);
      const codeEntry = response.entries[0];
      if (codeEntry) {
        const normalized = normalizeLedgerEntry(codeEntry, codeKey, 'contract code');
        if (normalized) entries.push(normalized);
      } else {
        unavailable.push({
          keyId: ledgerKeyId(codeKey),
          ledgerKey: codeKey.toXDR('base64'),
          label: 'contract code',
          reason: 'not-found',
          message: 'The instance references this WASM hash, but the code entry was not returned.',
        });
      }
    } catch (error: unknown) {
      unavailable.push({
        keyId: ledgerKeyId(codeKey),
        ledgerKey: codeKey.toXDR('base64'),
        label: 'contract code',
        reason: classifyUnavailable(error),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const spec of options.storageKeys ?? []) {
    await fetchEntry(options.source, options.contractId, spec, entries, unavailable);
  }

  if (!options.storageKeys || options.storageKeys.length === 0) {
    warnings.push(
      'No storage keys were supplied. Only the contract instance (and its code) was captured; ' +
        'Soroban RPC cannot enumerate all storage keys for a contract.',
    );
  }

  const deduped: SnapshotEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.keyId)) {
      warnings.push(`Duplicate ledger entry for key ${entry.keyId.slice(0, 12)} was ignored.`);
      continue;
    }
    seen.add(entry.keyId);
    deduped.push(entry);
  }
  deduped.sort((a, b) => a.keyId.localeCompare(b.keyId));
  unavailable.sort((a, b) => a.keyId.localeCompare(b.keyId));

  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    contractId: options.contractId,
    network: {
      id: networkId(options.networkPassphrase),
      passphrase: options.networkPassphrase,
    },
    ledger: latestLedger,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    wasmHash,
    entries: deduped,
    unavailable,
    snapshotFingerprint: fingerprintSnapshot(options.contractId, deduped),
    warnings,
  };
}

export function serializeSnapshot(snapshot: ContractStateSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SnapshotValidationError(`${field} must be a non-empty string.`);
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SnapshotValidationError(`${field} must be a non-negative integer.`);
  }
  return value;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  return requireInteger(value, field);
}

function requireHex(value: unknown, field: string, length = 64): string {
  const text = requireString(value, field);
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(text)) {
    throw new SnapshotValidationError(`${field} must be ${length} lowercase hex characters.`);
  }
  return text;
}

const ENTRY_TYPES: SnapshotEntryType[] = [
  'instance',
  'persistent',
  'temporary',
  'contractCode',
  'other',
];

/** Derive the storage category independently of the serialized entryType. */
function classifyLedgerKeyCategory(ledgerKey: xdr.LedgerKey): SnapshotEntryType {
  if (ledgerKey.switch() === xdr.LedgerEntryType.contractCode()) return 'contractCode';
  if (ledgerKey.switch() !== xdr.LedgerEntryType.contractData()) return 'other';
  const contractData = ledgerKey.contractData();
  if (contractData.key().switch() === xdr.ScValType.scvLedgerKeyContractInstance()) {
    return 'instance';
  }
  return contractData.durability() === xdr.ContractDataDurability.temporary()
    ? 'temporary'
    : 'persistent';
}
const DURABILITIES: SnapshotDurability[] = ['instance', 'persistent', 'temporary', 'unknown'];
const UNAVAILABLE_REASONS: UnavailableReason[] = ['not-found', 'archived', 'rpc-error'];

function parseSnapshotEntry(raw: unknown, index: number): SnapshotEntry {
  if (!isRecord(raw)) {
    throw new SnapshotValidationError(`entries[${index}] must be an object.`);
  }

  const ledgerKeyText = requireString(raw.ledgerKey, `entries[${index}].ledgerKey`);
  let ledgerKey: xdr.LedgerKey;
  try {
    ledgerKey = xdr.LedgerKey.fromXDR(ledgerKeyText, 'base64');
  } catch {
    throw new SnapshotValidationError(`entries[${index}].ledgerKey is not valid LedgerKey XDR.`);
  }
  const canonicalKey = ledgerKey.toXDR('base64');

  for (const field of ['keyXdr', 'valueXdr'] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new SnapshotValidationError(`entries[${index}].${field} must be a string.`);
    }
    try {
      xdr.ScVal.fromXDR(value, 'base64');
    } catch {
      throw new SnapshotValidationError(
        `entries[${index}].${field} is not valid ScVal base64 XDR.`,
      );
    }
  }

  const expectedKeyId = sha256Hex(canonicalKey);
  const keyId = requireHex(raw.keyId, `entries[${index}].keyId`);
  if (keyId !== expectedKeyId) {
    throw new SnapshotValidationError(
      `entries[${index}].keyId does not match its ledgerKey (expected ${expectedKeyId}).`,
    );
  }

  const entryType = requireString(raw.entryType, `entries[${index}].entryType`);
  if (!ENTRY_TYPES.includes(entryType as SnapshotEntryType)) {
    throw new SnapshotValidationError(`entries[${index}].entryType is not supported.`);
  }
  if (entryType !== classifyLedgerKeyCategory(ledgerKey)) {
    throw new SnapshotValidationError(
      `entries[${index}].entryType does not match its ledger key category.`,
    );
  }
  const durability = requireString(raw.durability, `entries[${index}].durability`);
  if (!DURABILITIES.includes(durability as SnapshotDurability)) {
    throw new SnapshotValidationError(`entries[${index}].durability is not supported.`);
  }

  const contractId =
    raw.contractId === undefined
      ? undefined
      : requireString(raw.contractId, `entries[${index}].contractId`);
  if (contractId !== undefined && !isValidContractId(contractId)) {
    throw new SnapshotValidationError(`entries[${index}].contractId is not a valid contract ID.`);
  }

  const fingerprint = requireHex(raw.fingerprint, `entries[${index}].fingerprint`);
  const expectedFingerprint = fingerprintEntry({
    ledgerKey: canonicalKey,
    entryType,
    durability,
    keyXdr: typeof raw.keyXdr === 'string' ? raw.keyXdr : undefined,
    valueXdr: typeof raw.valueXdr === 'string' ? raw.valueXdr : undefined,
    codeHash:
      isRecord(raw.valueDecoded) && typeof raw.valueDecoded.codeHash === 'string'
        ? raw.valueDecoded.codeHash
        : undefined,
  });
  if (fingerprint !== expectedFingerprint) {
    throw new SnapshotValidationError(
      `entries[${index}].fingerprint does not match its normalized content.`,
    );
  }

  if (typeof raw.comparable !== 'boolean') {
    throw new SnapshotValidationError(`entries[${index}].comparable must be a boolean.`);
  }
  if (
    !Array.isArray(raw.decodeErrors) ||
    raw.decodeErrors.some((item) => typeof item !== 'string')
  ) {
    throw new SnapshotValidationError(`entries[${index}].decodeErrors must be a string array.`);
  }

  return {
    keyId,
    ledgerKey: canonicalKey,
    ledgerEntryType: requireString(raw.ledgerEntryType, `entries[${index}].ledgerEntryType`),
    entryType: entryType as SnapshotEntryType,
    durability: durability as SnapshotDurability,
    contractId,
    keyXdr: typeof raw.keyXdr === 'string' ? raw.keyXdr : undefined,
    keyDecoded: raw.keyDecoded,
    keyLabel: typeof raw.keyLabel === 'string' ? raw.keyLabel : undefined,
    valueXdr: typeof raw.valueXdr === 'string' ? raw.valueXdr : undefined,
    valueDecoded: raw.valueDecoded,
    valueScValType: typeof raw.valueScValType === 'string' ? raw.valueScValType : undefined,
    sizeBytes: requireInteger(raw.sizeBytes, `entries[${index}].sizeBytes`),
    lastModifiedLedgerSeq: optionalInteger(
      raw.lastModifiedLedgerSeq,
      `entries[${index}].lastModifiedLedgerSeq`,
    ),
    liveUntilLedgerSeq: optionalInteger(
      raw.liveUntilLedgerSeq,
      `entries[${index}].liveUntilLedgerSeq`,
    ),
    fingerprint,
    comparable: raw.comparable,
    decodeErrors: raw.decodeErrors as string[],
  };
}

function parseUnavailableEntry(raw: unknown, index: number): UnavailableSnapshotEntry {
  if (!isRecord(raw)) {
    throw new SnapshotValidationError(`unavailable[${index}] must be an object.`);
  }
  const ledgerKeyText = requireString(raw.ledgerKey, `unavailable[${index}].ledgerKey`);
  let ledgerKey: xdr.LedgerKey;
  try {
    ledgerKey = xdr.LedgerKey.fromXDR(ledgerKeyText, 'base64');
  } catch {
    throw new SnapshotValidationError(
      `unavailable[${index}].ledgerKey is not valid LedgerKey XDR.`,
    );
  }
  const expectedKeyId = sha256Hex(ledgerKey.toXDR('base64'));
  const keyId = requireHex(raw.keyId, `unavailable[${index}].keyId`);
  if (keyId !== expectedKeyId) {
    throw new SnapshotValidationError(`unavailable[${index}].keyId does not match its ledgerKey.`);
  }
  const reason = requireString(raw.reason, `unavailable[${index}].reason`);
  if (!UNAVAILABLE_REASONS.includes(reason as UnavailableReason)) {
    throw new SnapshotValidationError(`unavailable[${index}].reason is not supported.`);
  }
  return {
    keyId,
    ledgerKey: ledgerKey.toXDR('base64'),
    label: requireString(raw.label, `unavailable[${index}].label`),
    reason: reason as UnavailableReason,
    message: requireString(raw.message, `unavailable[${index}].message`),
  };
}

/**
 * Validate and normalize a serialized snapshot. Structural problems, unknown
 * formats/versions, duplicate keys and fingerprint mismatches are rejected
 * rather than compared.
 */
export function parseSnapshot(raw: unknown, label = 'snapshot'): ContractStateSnapshot {
  if (!isRecord(raw)) {
    throw new SnapshotValidationError(`Snapshot "${label}" must be a JSON object.`);
  }
  if (raw.format !== SNAPSHOT_FORMAT) {
    throw new SnapshotValidationError(
      `Snapshot "${label}" has an unsupported format. Expected "${SNAPSHOT_FORMAT}".`,
    );
  }
  if (raw.version !== SNAPSHOT_VERSION) {
    throw new SnapshotValidationError(
      `Snapshot "${label}" has unsupported version ${String(raw.version)}. ` +
        `This example supports version ${SNAPSHOT_VERSION}.`,
    );
  }

  const contractId = requireString(raw.contractId, 'contractId');
  if (!isValidContractId(contractId)) {
    throw new SnapshotValidationError(`Snapshot "${label}" has an invalid contract ID.`);
  }

  if (!isRecord(raw.network)) {
    throw new SnapshotValidationError(`Snapshot "${label}" is missing network metadata.`);
  }
  const network = {
    id: requireString(raw.network.id, 'network.id'),
    passphrase: requireString(raw.network.passphrase, 'network.passphrase'),
  };
  if (network.id !== networkId(network.passphrase)) {
    throw new SnapshotValidationError(
      `Snapshot "${label}" network.id does not match its network passphrase.`,
    );
  }

  const ledger = requireInteger(raw.ledger, 'ledger');
  const capturedAt = requireString(raw.capturedAt, 'capturedAt');
  if (Number.isNaN(Date.parse(capturedAt))) {
    throw new SnapshotValidationError('capturedAt must be an ISO-8601 timestamp.');
  }

  if (!Array.isArray(raw.entries)) {
    throw new SnapshotValidationError(`Snapshot "${label}" requires an entries array.`);
  }
  const entries = raw.entries.map(parseSnapshotEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.keyId)) {
      throw new SnapshotValidationError(
        `Snapshot "${label}" contains duplicate entry keyId ${entry.keyId.slice(0, 12)}.`,
      );
    }
    seen.add(entry.keyId);
  }
  entries.sort((a, b) => a.keyId.localeCompare(b.keyId));

  const unavailableRaw = raw.unavailable ?? [];
  if (!Array.isArray(unavailableRaw)) {
    throw new SnapshotValidationError(`Snapshot "${label}" unavailable must be an array.`);
  }
  const unavailable = unavailableRaw.map(parseUnavailableEntry);
  unavailable.sort((a, b) => a.keyId.localeCompare(b.keyId));

  if (raw.wasmHash !== undefined) {
    requireHex(raw.wasmHash, 'wasmHash');
  }
  if (!Array.isArray(raw.warnings) || raw.warnings.some((item) => typeof item !== 'string')) {
    throw new SnapshotValidationError(`Snapshot "${label}" warnings must be a string array.`);
  }

  const snapshotFingerprint = requireHex(raw.snapshotFingerprint, 'snapshotFingerprint');
  const expected = fingerprintSnapshot(contractId, entries);
  if (snapshotFingerprint !== expected) {
    throw new SnapshotValidationError(
      `Snapshot "${label}" fingerprint does not match its entries.`,
    );
  }

  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    contractId,
    network,
    ledger,
    capturedAt,
    wasmHash: raw.wasmHash as string | undefined,
    entries,
    unavailable,
    snapshotFingerprint,
    warnings: raw.warnings as string[],
  };
}

export function loadSnapshotFile(filePath: string): ContractStateSnapshot {
  const resolved = path.resolve(filePath);

  let text: string;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (error: unknown) {
    throw new SnapshotValidationError(
      `Cannot read snapshot "${filePath}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error: unknown) {
    throw new SnapshotValidationError(
      `Snapshot "${filePath}" is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return parseSnapshot(raw, filePath);
}

export function saveSnapshotFile(filePath: string, snapshot: ContractStateSnapshot): string {
  const resolved = path.resolve(filePath);
  fs.writeFileSync(resolved, serializeSnapshot(snapshot), 'utf8');
  return resolved;
}
