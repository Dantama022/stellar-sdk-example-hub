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
export interface TtlOptions {
  contractId?: string;
  rpcUrl?: string;
  keys?: string[] | string;
  warningLedgers?: number | string;
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
    throw new Error('warningLedgers must be non-negative.');
  return parsed;
}
export function parseTtlArgs(args: string[]): TtlOptions {
  const { positional, flags } = parseCommonFlags(args);
  return {
    contractId: positional[0],
    rpcUrl: stringFlag(flags, 'rpc-url'),
    keys: keyFlags(flags),
    warningLedgers: numberFlag(flags, 'warning-ledgers', 1000),
    json: booleanFlag(flags, 'json'),
  };
}
export async function buildTtlReport(options: TtlOptions, server?: rpc.Server) {
  if (!options.contractId) throw new Error('Missing contract ID.');
  const provider =
    server ?? new rpc.Server(options.rpcUrl ?? process.env.SOROBAN_RPC_URL ?? DEFAULT_RPC_URL);
  const warningLedgers = normalizeNumber(options.warningLedgers, 1000);
  const entries = await inspectContractState(
    provider,
    options.contractId,
    normalizeKeys(options.keys),
    warningLedgers,
  );
  return { contractId: options.contractId, warningLedgers, entries };
}
export async function run(options: TtlOptions = {}): Promise<void> {
  const report = await buildTtlReport(options);
  if (options.json) {
    console.log(stableStringify(report));
    return;
  }
  console.log('=== Soroban Contract TTL Analysis ===');
  console.log(`Contract: ${report.contractId}`);
  console.log(`Warning threshold: ${report.warningLedgers} ledgers`);
  for (const entry of report.entries) {
    console.log(`\n${entry.entryType}`);
    console.log(`Ledger key: ${entry.ledgerKey}`);
    console.log(`Current ledger: ${entry.currentLedger}`);
    console.log(`Live-until ledger: ${entry.liveUntilLedgerSeq ?? 'Unknown'}`);
    console.log(`Remaining ledgers: ${entry.remainingLedgers ?? 'Unknown'}`);
    console.log(`Status: ${entry.status}`);
    if (entry.error) console.log(`Diagnostic: ${entry.error}`);
  }
}
if (require.main === module)
  run(parseTtlArgs(process.argv.slice(2))).catch((error) => {
    console.error(
      `Soroban TTL inspection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
