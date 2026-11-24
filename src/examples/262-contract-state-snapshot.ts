import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { Contract, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';

/**
 * Contract State Snapshot
 *
 * Captures a point-in-time snapshot of Soroban contract ledger entries via
 * `getLedgerEntries`.  The snapshot records the contract instance, an optional
 * set of caller-supplied storage keys, and the WASM code entry if one exists.
 *
 * Key design constraints:
 *   - No historical state retrieval is assumed.  Every query targets the
 *     current ledger exposed by the RPC endpoint.  Providers that do not
 *     retain historical states are supported by design.
 *   - The snapshot format is versioned and deterministic: keys are sorted and
 *     values are canonical base64, so two identical states always produce the
 *     same JSON text.
 *   - A SHA-256 fingerprint is calculated over the stable JSON representation
 *     of each entry and of the entire snapshot.
 *   - Expired or unavailable entries are recorded as `status: 'unavailable'`
 *     rather than causing the whole snapshot to fail.
 *   - Retrieval, normalisation, snapshot persistence, and fingerprinting are
 *     kept as separate pure functions to simplify testing.
 *
 * Snapshot structure
 * ------------------
 *   version          Snapshot format version (always 1).
 *   snapshotId       Short hex string — uniquely identifies this run.
 *   contractId       The queried contract address.
 *   network          Network passphrase or short label.
 *   ledgerSequence   Sequence number of the latest ledger at capture time.
 *   capturedAt       ISO-8601 timestamp.
 *   fingerprint      SHA-256 of the stable-serialised entries array.
 *   entries          Array of SnapshotEntry objects.
 *
 * Entry status values
 * -------------------
 *   'found'          Entry was returned by the RPC server.
 *   'unavailable'    Entry was not found or the RPC call failed.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers (self-contained to avoid importing the concatenated utility
// file that has pre-existing duplicate-identifier errors under strict tsc)
// ─────────────────────────────────────────────────────────────────────────────

export type Durability = 'persistent' | 'temporary' | 'unknown';
export type JsonObject = Record<string, unknown>;

/** Recursively sort object keys and coerce non-JSON-safe scalars. */
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

/** Deterministic JSON serialisation — keys are sorted at every depth. */
export function stableStringify(value: unknown, space = 2): string {
  return JSON.stringify(sortObject(value), null, space);
}

/** Convert bigints, Buffers, and Maps to JSON-safe equivalents. */
export function makeJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `0x${Buffer.from(value).toString('hex')}`;
  }
  if (Array.isArray(value)) return value.map(makeJsonSafe);
  if (value instanceof Map) {
    return Array.from(value.entries()).map(([k, v]) => ({
      key: makeJsonSafe(k),
      value: makeJsonSafe(v),
    }));
  }
  if (value && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value as JsonObject)) out[k] = makeJsonSafe(v);
    return out;
  }
  return value;
}

/**
 * Canonicalise a base64 string: strip whitespace, re-encode to confirm it is
 * valid base64, and return the canonical form.
 */
export function normalizeBase64(value: string): string {
  const trimmed = value.trim();
  const bytes = Buffer.from(trimmed, 'base64');
  if (!trimmed || bytes.length === 0) throw new Error('empty or invalid base64');
  const canonical = bytes.toString('base64');
  if (canonical.replace(/=+$/, '') !== trimmed.replace(/=+$/, ''))
    throw new Error('invalid base64');
  return canonical;
}

/** Return the byte length of a base64-encoded blob. */
export function encodedByteSize(value: string | undefined): number {
  if (!value) return 0;
  try {
    return Buffer.from(normalizeBase64(value), 'base64').length;
  } catch {
    return Buffer.byteLength(value, 'utf8');
  }
}

/** Attempt to decode an XDR ScVal and return a JSON-safe native value. */
function decodeScValXdr(valueXdr: string | undefined): unknown {
  if (!valueXdr) return undefined;
  try {
    const scVal = xdr.ScVal.fromXDR(normalizeBase64(valueXdr), 'base64');
    return makeJsonSafe(scValToNative(scVal));
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type EntryStatus = 'found' | 'unavailable';
export type EntryRole = 'instance' | 'code' | 'storage' | 'other';

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

export interface SnapshotEntry extends CanonicalEntry {
  /** Entry role within the contract lifecycle. */
  role: EntryRole;
  /** Whether the RPC returned data for this key. */
  status: EntryStatus;
  /** Byte size of the encoded ledger key. */
  keySize: number;
  /** Byte size of the encoded ledger entry value (0 when unavailable). */
  valueSize: number;
  /** SHA-256 of the stable JSON representation of this entry. */
  fingerprint: string;
  /** Human-readable note when status is 'unavailable'. */
  unavailableReason?: string;
}

export interface ContractStateSnapshot {
  version: 1;
  snapshotId: string;
  contractId: string;
  network: string;
  ledgerSequence: number;
  capturedAt: string;
  /** SHA-256 of the stable-serialised entries array. */
  fingerprint: string;
  entries: SnapshotEntry[];
}

export interface SnapshotOptions {
  /** Soroban RPC URL. */
  rpcUrl: string;
  /** Contract address (C-encoded Stellar address). */
  contractId: string;
  /** Network passphrase or short name (used for mismatch detection). */
  network: string;
  /**
   * Additional ledger keys to query, expressed as base64-encoded XDR
   * `LedgerKey` values.
   */
  extraLedgerKeys?: string[];
  /** Where to persist the snapshot JSON.  When omitted the snapshot is only
   *  returned in-memory. */
  outputFile?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported so tests can call them directly)
// ─────────────────────────────────────────────────────────────────────────────

/** Validate a Soroban contract address (56-character C… StrKey). */
export function isValidContractId(id: string): boolean {
  return typeof id === 'string' && /^C[A-Z2-7]{55}$/.test(id);
}

/** Build the persistent `ContractData` key that stores the contract instance. */
export function buildInstanceKey(contractId: string): xdr.LedgerKey {
  const address = new Contract(contractId).address().toScAddress();
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: address,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/** Build the `ContractCode` key for a WASM hash expressed as a hex string. */
export function buildCodeKey(wasmHashHex: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHashHex, 'hex') }),
  );
}

/**
 * Extract the WASM hash from a contract instance ledger entry.
 * Returns null for built-in (non-WASM) executables.
 */
export function extractWasmHash(entryResult: rpc.Api.LedgerEntryResult): string | null {
  try {
    const ledgerEntry = entryResult.val as unknown as xdr.LedgerEntry;
    // The LedgerEntry exposes its data via a .data() accessor when present.
    const rawData =
      typeof (ledgerEntry as unknown as { data?(): unknown }).data === 'function'
        ? (ledgerEntry as unknown as { data(): unknown }).data()
        : ledgerEntry;
    const contractData = (rawData as { contractData(): { val(): xdr.ScVal } }).contractData();
    const val = contractData.val();
    if (val.switch() !== xdr.ScValType.scvContractInstance()) return null;
    const executable = val.instance().executable();
    if (executable.switch() === xdr.ContractExecutableType.contractExecutableWasm()) {
      return executable.wasmHash().toString('hex');
    }
  } catch {
    // malformed entry — not fatal
  }
  return null;
}

/**
 * Identify the `Durability` and `role` of a ledger key.
 */
export function classifyKey(keyXdr: string): { durability: Durability; role: EntryRole } {
  try {
    const parsed = xdr.LedgerKey.fromXDR(keyXdr, 'base64');
    const switchName = parsed.switch().name;
    if (switchName === 'contractCode') return { durability: 'persistent', role: 'code' };
    if (switchName === 'contractData') {
      const cd = parsed.contractData();
      const isInstance = cd.key().switch() === xdr.ScValType.scvLedgerKeyContractInstance();
      const dur: Durability = cd.durability().name === 'temporary' ? 'temporary' : 'persistent';
      return { durability: dur, role: isInstance ? 'instance' : 'storage' };
    }
    return { durability: 'unknown', role: 'other' };
  } catch {
    return { durability: 'unknown', role: 'other' };
  }
}

/** Return the ledger-key XDR type name, or 'unknown' on parse failure. */
function ledgerKeyType(keyXdr: string): string {
  try {
    return xdr.LedgerKey.fromXDR(keyXdr, 'base64').switch().name;
  } catch {
    return 'unknown';
  }
}

/** Normalise a raw integer value to a decimal string, or undefined. */
function normalizeInteger(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0)
    return String(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value.trim()))
    return BigInt(value.trim()).toString();
  return undefined;
}

/**
 * Normalise a raw entry object into a `CanonicalEntry`.
 * Accepts both the XDR-keyed shape from `buildFoundEntry` and plain objects.
 */
function normalizeRawEntry(raw: Record<string, unknown>, keyXdr: string): CanonicalEntry {
  let canonicalKey = keyXdr;
  try {
    canonicalKey = normalizeBase64(keyXdr);
    xdr.LedgerKey.fromXDR(canonicalKey, 'base64'); // validate
  } catch {
    canonicalKey = keyXdr;
  }

  const { durability } = classifyKey(canonicalKey);

  let valueXdr: string | undefined;
  if (typeof raw['valueXdr'] === 'string' && raw['valueXdr'].trim()) {
    try {
      valueXdr = normalizeBase64(raw['valueXdr']);
    } catch {
      valueXdr = raw['valueXdr'].trim();
    }
  }

  const valueDecoded = valueXdr ? decodeScValXdr(valueXdr) : undefined;

  return {
    ledgerKey: canonicalKey,
    entryType: typeof raw['entryType'] === 'string' ? raw['entryType'] : ledgerKeyType(canonicalKey),
    durability,
    lastModifiedLedgerSeq: normalizeInteger(raw['lastModifiedLedgerSeq']),
    liveUntilLedgerSeq: normalizeInteger(raw['liveUntilLedgerSeq']),
    valueXdr,
    valueDecoded,
  };
}

/** Calculate a deterministic SHA-256 fingerprint of an arbitrary value. */
export function computeFingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * Compute the per-entry fingerprint.
 * Only the stable key and value XDR (not metadata like TTL) are included so
 * that a TTL-only bump does not change the fingerprint.
 */
export function entryFingerprint(entry: Pick<SnapshotEntry, 'ledgerKey' | 'valueXdr'>): string {
  return computeFingerprint({ ledgerKey: entry.ledgerKey, valueXdr: entry.valueXdr ?? null });
}

/**
 * Build a SnapshotEntry from a raw ledger entry result returned by the RPC.
 */
export function buildFoundEntry(
  keyXdr: string,
  result: rpc.Api.LedgerEntryResult,
): SnapshotEntry {
  const ledgerEntry = result.val as unknown as xdr.LedgerEntry;
  const entryXdr = ledgerEntry.toXDR('base64');
  const { role } = classifyKey(keyXdr);
  const raw: Record<string, unknown> = {
    entryType: role === 'code' ? 'contractCode' : 'contractData',
    lastModifiedLedgerSeq: result.lastModifiedLedgerSeq,
    liveUntilLedgerSeq: (result as unknown as Record<string, unknown>)['liveUntilLedgerSeq'],
    valueXdr: entryXdr,
  };
  const canonical = normalizeRawEntry(raw, keyXdr);
  const partial = { ledgerKey: canonical.ledgerKey, valueXdr: canonical.valueXdr };
  return {
    ...canonical,
    role,
    status: 'found',
    keySize: encodedByteSize(canonical.ledgerKey),
    valueSize: encodedByteSize(entryXdr),
    fingerprint: entryFingerprint(partial),
  };
}

/** Build a SnapshotEntry for a key that could not be retrieved. */
export function buildUnavailableEntry(
  keyXdr: string,
  reason: string,
  role: EntryRole = 'other',
): SnapshotEntry {
  const { durability } = classifyKey(keyXdr);
  let canonicalKey = keyXdr;
  try {
    canonicalKey = normalizeBase64(keyXdr);
  } catch {
    // keep original
  }
  const partial = { ledgerKey: canonicalKey, valueXdr: undefined as string | undefined };
  return {
    ledgerKey: canonicalKey,
    entryType: role === 'code' ? 'contractCode' : 'contractData',
    durability,
    role,
    status: 'unavailable',
    keySize: encodedByteSize(canonicalKey),
    valueSize: 0,
    fingerprint: entryFingerprint(partial),
    unavailableReason: reason,
  };
}

/**
 * Sort and deduplicate a list of entries by ledgerKey.
 * When two entries share the same ledgerKey the found entry wins over
 * unavailable.
 */
export function consolidateEntries(entries: SnapshotEntry[]): SnapshotEntry[] {
  const seen = new Map<string, SnapshotEntry>();
  for (const entry of entries) {
    if (!seen.has(entry.ledgerKey) || entry.status === 'found') {
      seen.set(entry.ledgerKey, entry);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.ledgerKey.localeCompare(b.ledgerKey));
}

/** Compute the top-level snapshot fingerprint from the consolidated entries. */
export function snapshotFingerprint(entries: SnapshotEntry[]): string {
  return computeFingerprint(
    entries.map((e) => ({ ledgerKey: e.ledgerKey, fingerprint: e.fingerprint })),
  );
}

/**
 * Persist a snapshot to disk as pretty-printed JSON.
 * Returns the absolute path written.
 */
export function saveSnapshot(snapshot: ContractStateSnapshot, filePath: string): string {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, stableStringify(makeJsonSafe(snapshot)) + '\n', 'utf8');
  return resolved;
}

/**
 * Load and validate a snapshot from a JSON file.
 * Throws when the file is missing, malformed, or has an unsupported version.
 */
export function loadContractSnapshot(filePath: string): ContractStateSnapshot {
  const resolved = path.resolve(filePath);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err: unknown) {
    throw new Error(
      `Cannot read snapshot file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateSnapshotShape(raw);
}

/** Validate that an arbitrary value conforms to `ContractStateSnapshot`. */
export function validateSnapshotShape(raw: unknown): ContractStateSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Snapshot must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  if (obj['version'] !== 1 && obj['version'] !== '1') {
    throw new Error(`Unsupported or missing snapshot version: ${String(obj['version'])}`);
  }
  if (typeof obj['contractId'] !== 'string' || !obj['contractId']) {
    throw new Error('Snapshot is missing a contractId field.');
  }
  if (typeof obj['network'] !== 'string' || !obj['network']) {
    throw new Error('Snapshot is missing a network field.');
  }
  if (!Array.isArray(obj['entries'])) {
    throw new Error('Snapshot entries field must be an array.');
  }
  return obj as unknown as ContractStateSnapshot;
}

// ─────────────────────────────────────────────────────────────────────────────
// RPC-driven capture
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retrieve a single ledger key and return a SnapshotEntry.
 * Swallows RPC errors and marks the entry as unavailable.
 */
async function fetchEntry(
  server: rpc.Server,
  keyXdr: string,
  role: EntryRole,
): Promise<SnapshotEntry> {
  let key: xdr.LedgerKey;
  try {
    key = xdr.LedgerKey.fromXDR(keyXdr, 'base64');
  } catch (err: unknown) {
    return buildUnavailableEntry(
      keyXdr,
      `Invalid ledger key XDR: ${err instanceof Error ? err.message : String(err)}`,
      role,
    );
  }

  try {
    const result = await server.getLedgerEntries(key);
    if (!result.entries || result.entries.length === 0) {
      return buildUnavailableEntry(keyXdr, 'Entry not found on current ledger.', role);
    }
    return buildFoundEntry(keyXdr, result.entries[0]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = /archiv|expir/i.test(msg)
      ? `Entry appears archived or expired: ${msg}`
      : `RPC error: ${msg}`;
    return buildUnavailableEntry(keyXdr, reason, role);
  }
}

/**
 * Capture a full contract state snapshot from a live RPC endpoint.
 *
 * Steps:
 *   1. Query the current ledger sequence.
 *   2. Fetch the contract instance entry.
 *   3. If found, derive the WASM hash and fetch the code entry.
 *   4. Fetch any caller-supplied extra ledger keys.
 *   5. Consolidate, fingerprint, and return the snapshot.
 */
export async function captureSnapshot(options: SnapshotOptions): Promise<ContractStateSnapshot> {
  if (!isValidContractId(options.contractId)) {
    throw new Error(`Invalid contract ID: ${options.contractId}`);
  }

  const server = new rpc.Server(options.rpcUrl, { allowHttp: true });

  // 1. Current ledger sequence
  let ledgerSequence = 0;
  try {
    const latest = await server.getLatestLedger();
    ledgerSequence = latest.sequence;
  } catch (err: unknown) {
    throw new Error(
      `RPC unreachable at ${options.rpcUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const entries: SnapshotEntry[] = [];

  // 2. Contract instance
  const instanceKeyXdr = buildInstanceKey(options.contractId).toXDR('base64');
  const instanceEntry = await fetchEntry(server, instanceKeyXdr, 'instance');
  entries.push(instanceEntry);

  // 3. WASM code entry — only when the instance was found
  if (instanceEntry.status === 'found' && instanceEntry.valueXdr) {
    let wasmHash: string | null = null;
    try {
      const ledgerEntry = xdr.LedgerEntry.fromXDR(instanceEntry.valueXdr, 'base64');
      wasmHash = extractWasmHash({
        val: ledgerEntry as unknown as rpc.Api.LedgerEntryResult['val'],
        lastModifiedLedgerSeq: 0,
        key: xdr.LedgerKey.fromXDR(instanceKeyXdr, 'base64'),
      } as unknown as rpc.Api.LedgerEntryResult);
    } catch {
      // non-fatal
    }
    if (wasmHash) {
      const codeKeyXdr = buildCodeKey(wasmHash).toXDR('base64');
      entries.push(await fetchEntry(server, codeKeyXdr, 'code'));
    }
  }

  // 4. Extra caller-supplied keys
  for (const rawKey of options.extraLedgerKeys ?? []) {
    let keyXdr: string;
    try {
      keyXdr = normalizeBase64(rawKey);
    } catch {
      keyXdr = rawKey;
    }
    const { role } = classifyKey(keyXdr);
    entries.push(await fetchEntry(server, keyXdr, role === 'other' ? 'storage' : role));
  }

  // 5. Consolidate
  const consolidated = consolidateEntries(entries);

  const snapshot: ContractStateSnapshot = {
    version: 1,
    snapshotId: createHash('sha256')
      .update(`${options.contractId}:${ledgerSequence}:${Date.now()}`)
      .digest('hex')
      .slice(0, 16),
    contractId: options.contractId,
    network: options.network,
    ledgerSequence,
    capturedAt: new Date().toISOString(),
    fingerprint: snapshotFingerprint(consolidated),
    entries: consolidated,
  };

  if (options.outputFile) {
    saveSnapshot(snapshot, options.outputFile);
  }

  return snapshot;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function run(
  params: {
    rpcUrl?: string;
    contractId?: string;
    network?: string;
    extraLedgerKeys?: string[];
    outputFile?: string;
  } = {},
): Promise<ContractStateSnapshot> {
  const rpcUrl =
    params.rpcUrl ??
    process.env['SOROBAN_RPC_URL'] ??
    'https://soroban-testnet.stellar.org';
  const contractId = params.contractId ?? process.argv[3] ?? '';
  const network = params.network ?? process.env['STELLAR_NETWORK'] ?? 'testnet';
  const outputFile = params.outputFile ?? process.argv[4];

  const snapshot = await captureSnapshot({
    rpcUrl,
    contractId,
    network,
    extraLedgerKeys: params.extraLedgerKeys,
    outputFile,
  });

  console.log(stableStringify(makeJsonSafe(snapshot)));
  return snapshot;
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
