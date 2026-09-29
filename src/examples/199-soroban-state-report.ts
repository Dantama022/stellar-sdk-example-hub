import { rpc } from '@stellar/stellar-sdk';
import {
  booleanFlag,
  inspectContractState,
  keyFlags,
  numberFlag,
  parseCommonFlags,
  stableStringify,
  stringFlag,
} from '../utils/soroban-state-inspection';
const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
export interface StateReportOptions {
  contractId?: string;
  rpcUrl?: string;
  keys?: string[] | string;
  warningLedgers?: number | string;
  entryType?: string;
  limit?: number | string;
  includeRaw?: boolean;
  json?: boolean;
}
function normalizeKeys(keys: string[] | string | undefined): string[] {
  if (Array.isArray(keys)) return keys;
  if (typeof keys === 'string')
    return keys
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  return [];
}
function normalizeNumber(value: number | string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error('Numeric option must be non-negative.');
  return parsed;
}
export function parseStateReportArgs(args: string[]): StateReportOptions {
  const { positional, flags } = parseCommonFlags(args);
  return {
    contractId: positional[0],
    rpcUrl: stringFlag(flags, 'rpc-url'),
    keys: keyFlags(flags),
    warningLedgers: numberFlag(flags, 'warning-ledgers', 1000),
    entryType: stringFlag(flags, 'entry-type'),
    limit: numberFlag(flags, 'limit', 0),
    includeRaw: booleanFlag(flags, 'raw', 'include-raw'),
    json: booleanFlag(flags, 'json'),
  };
}
export async function buildStateReport(options: StateReportOptions, server?: rpc.Server) {
  if (!options.contractId) throw new Error('Missing contract ID.');
  const provider =
    server ?? new rpc.Server(options.rpcUrl ?? process.env.SOROBAN_RPC_URL ?? DEFAULT_RPC_URL);
  let entries = await inspectContractState(
    provider,
    options.contractId,
    normalizeKeys(options.keys),
    normalizeNumber(options.warningLedgers, 1000),
  );
  if (options.entryType) entries = entries.filter((entry) => entry.entryType === options.entryType);
  const duplicateCounts = new Map<string, number>();
  entries.forEach((entry) =>
    duplicateCounts.set(entry.ledgerKey, (duplicateCounts.get(entry.ledgerKey) ?? 0) + 1),
  );
  const duplicateLedgerKeys = [...duplicateCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();
  const ttlEntries = entries.filter((entry) => entry.liveUntilLedgerSeq !== undefined);
  const knownRemaining = ttlEntries
    .map((entry) => entry.remainingLedgers)
    .filter((value): value is number => value !== undefined);
  const groupedByEntryType = Object.fromEntries(
    ['contract-instance', 'persistent-data', 'temporary-data', 'other'].map((type) => [
      type,
      entries.filter((entry) => entry.entryType === type).length,
    ]),
  );
  const summary = {
    totalEntriesInspected: entries.length,
    entriesWithTtl: ttlEntries.length,
    entriesWithoutTtl: entries.length - ttlEntries.length,
    nearExpiration: entries.filter((entry) => entry.status === 'Near expiration').length,
    shortestRemainingLifetime: knownRemaining.length ? Math.min(...knownRemaining) : undefined,
    longestRemainingLifetime: knownRemaining.length ? Math.max(...knownRemaining) : undefined,
    groupedByEntryType,
    duplicateLedgerKeys,
  };
  let reportedEntries = [...entries].sort(
    (a, b) =>
      (a.remainingLedgers ?? Number.MAX_SAFE_INTEGER) -
        (b.remainingLedgers ?? Number.MAX_SAFE_INTEGER) ||
      a.entryType.localeCompare(b.entryType) ||
      a.ledgerKey.localeCompare(b.ledgerKey),
  );
  if (!options.includeRaw)
    reportedEntries = reportedEntries.map(({ rawEntry: _rawEntry, ...entry }) => entry);
  const limit = normalizeNumber(options.limit, 0);
  if (limit > 0) reportedEntries = reportedEntries.slice(0, limit);
  return {
    contractId: options.contractId,
    warningLedgers: normalizeNumber(options.warningLedgers, 1000),
    summary,
    entries: reportedEntries,
  };
}
export async function run(options: StateReportOptions = {}): Promise<void> {
  const report = await buildStateReport(options);
  if (options.json) {
    console.log(stableStringify(report));
    return;
  }
  console.log('=== Soroban Contract State Footprint & TTL Risk Report ===');
  console.log(`Contract: ${report.contractId}`);
  console.log(`Entries inspected: ${report.summary.totalEntriesInspected}`);
  console.log(`With TTL: ${report.summary.entriesWithTtl}`);
  console.log(`Without TTL: ${report.summary.entriesWithoutTtl}`);
  console.log(`Near expiration: ${report.summary.nearExpiration}`);
  console.log(
    `Shortest remaining lifetime: ${report.summary.shortestRemainingLifetime ?? 'Unknown'}`,
  );
  console.log(
    `Longest remaining lifetime: ${report.summary.longestRemainingLifetime ?? 'Unknown'}`,
  );
  report.entries.forEach((entry) =>
    console.log(
      `  ${entry.entryType} | ${entry.status} | remaining=${entry.remainingLedgers ?? 'Unknown'} | ${entry.ledgerKey}`,
    ),
  );
}
if (require.main === module)
  run(parseStateReportArgs(process.argv.slice(2))).catch((error) => {
    console.error(
      `Soroban state report failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
