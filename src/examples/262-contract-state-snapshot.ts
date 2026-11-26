import { Asset, Networks, rpc } from '@stellar/stellar-sdk';
import chalk from 'chalk';
import {
  SnapshotCompatibilityError,
  SnapshotValidationError,
  UnsupportedHistoricalStateError,
  captureContractStateSnapshot,
  loadSnapshotFile,
  networkId,
  parseStorageKeySpecs,
  saveSnapshotFile,
  serializeSnapshot,
  type ContractStateSnapshot,
  type StorageDurability,
} from '../utils/contract-state-snapshot';
import {
  compareSnapshots,
  formatComparisonReport,
  loadExpectedChangesFile,
  type ExpectedChangeRule,
} from '../utils/contract-state-diff';

/**
 * ISSUE-417: Soroban Contract State Snapshot and Upgrade Regression Comparison
 *
 * Capture the ledger entries that make up a contract's state, normalize them,
 * fingerprint them, and compare two captures to review what changed around an
 * upgrade.
 *
 * Read-only. Nothing is signed, simulated or submitted.
 *
 * Because Soroban RPC serves current ledger state, a snapshot must be captured
 * before and after the change under review. Asking for a past ledger fails with
 * an explicit UnsupportedHistoricalStateError rather than pretending the
 * request succeeded.
 *
 * Try it:
 *   # baseline, then change the contract state, then compare
 *   CONTRACT_ID=C... SNAPSHOT_KEYS=COUNTER,Admin SNAPSHOT_OUT=baseline.json \
 *     npm run run-example 262-contract-state-snapshot
 *   CONTRACT_ID=C... SNAPSHOT_KEYS=COUNTER,Admin SNAPSHOT_BASELINE=baseline.json \
 *     UPGRADE_REVIEW=true npm run run-example 262-contract-state-snapshot
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

export interface ContractStateSnapshotParams {
  rpcUrl?: string;
  contractId?: string;
  networkPassphrase?: string;
  /** Symbol names, base64 ScVal XDR, or base64 LedgerKey XDR. */
  storageKeys?: string[];
  durability?: StorageDurability;
  /** Write the captured comparison snapshot here. */
  snapshotOut?: string;
  /** Load this snapshot as the baseline and compare the fresh capture against it. */
  baseline?: string;
  /** Requested ledger position; only the current ledger is supported. */
  requestedLedger?: number;
  upgradeReview?: boolean;
  expectedChangesFile?: string;
  json?: boolean;
}

function envFlag(name: string): boolean {
  return /^(1|true|yes)$/i.test(process.env[name] ?? '');
}

function parseDurability(value: string | undefined): StorageDurability {
  const normalized = (value ?? 'persistent').trim().toLowerCase();
  if (normalized === 'persistent' || normalized === 'temporary') return normalized;
  throw new SnapshotValidationError(
    `Invalid storage durability "${value}". Use persistent or temporary.`,
  );
}

function parseRequestedLedger(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new SnapshotValidationError('SNAPSHOT_LEDGER must be a non-negative integer.');
  }
  return parsed;
}

function printSnapshotSummary(snapshot: ContractStateSnapshot): void {
  const counts = snapshot.entries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.entryType] = (acc[entry.entryType] ?? 0) + 1;
    return acc;
  }, {});

  console.log(chalk.bold('\n=== Soroban Contract State Snapshot ==='));
  console.log(`Contract ID          : ${snapshot.contractId}`);
  console.log(`Network              : ${snapshot.network.id} (${snapshot.network.passphrase})`);
  console.log(`Ledger sequence      : ${snapshot.ledger}`);
  console.log(`Captured at          : ${snapshot.capturedAt}`);
  console.log(`WASM reference       : ${snapshot.wasmHash ?? '(not available)'}`);
  console.log(`Snapshot fingerprint : ${snapshot.snapshotFingerprint}`);
  console.log(`Entries              : ${snapshot.entries.length}`);

  const typeSummary = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${type}=${count}`)
    .join(', ');
  if (typeSummary) console.log(`Entry types          : ${typeSummary}`);

  if (snapshot.entries.length === 0) {
    console.log(
      chalk.gray(
        '  No entries were read. The contract may be undeployed or archived, or the supplied ' +
          'storage keys may not exist.',
      ),
    );
  } else {
    console.log(chalk.bold('\nInspected entries'));
    for (const entry of snapshot.entries) {
      const label = entry.keyLabel ? ` key=${entry.keyLabel}` : '';
      console.log(
        `  ${entry.entryType.padEnd(12)} ${entry.durability.padEnd(10)} ` +
          `size=${String(entry.sizeBytes).padStart(4)}B fingerprint=${entry.fingerprint.slice(
            0,
            16,
          )}${label}`,
      );
      if (entry.liveUntilLedgerSeq !== undefined) {
        console.log(`    live until ledger ${entry.liveUntilLedgerSeq}`);
      }
      if (!entry.comparable) {
        console.log(chalk.yellow(`    not comparable: ${entry.decodeErrors.join('; ')}`));
      }
    }
  }

  if (snapshot.unavailable.length > 0) {
    console.log(chalk.yellow('\nUnavailable entries'));
    for (const entry of snapshot.unavailable) {
      console.log(`  ${entry.label.padEnd(14)} ${entry.reason}: ${entry.message}`);
    }
  }

  for (const warning of snapshot.warnings) console.log(chalk.gray(`\nNote: ${warning}`));
  console.log(
    chalk.gray(
      '\nThis snapshot covers only the instance entry and the storage keys supplied. Soroban ' +
        'RPC cannot enumerate every key a contract may use.',
    ),
  );
}

async function execute(params: ContractStateSnapshotParams): Promise<void> {
  const rpcUrl = params.rpcUrl?.trim() || process.env.SOROBAN_RPC_URL?.trim() || DEFAULT_RPC_URL;
  const networkPassphrase =
    params.networkPassphrase?.trim() || process.env.NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;
  const contractId =
    params.contractId?.trim() ||
    process.env.CONTRACT_ID?.trim() ||
    Asset.native().contractId(networkPassphrase);

  const durability = parseDurability(params.durability ?? process.env.SNAPSHOT_DURABILITY);

  const keyInputs =
    params.storageKeys ??
    (process.env.SNAPSHOT_KEYS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  const storageKeys = parseStorageKeySpecs(keyInputs, durability);

  const baselineFile = params.baseline?.trim() || process.env.SNAPSHOT_BASELINE?.trim();
  const outputFile = params.snapshotOut?.trim() || process.env.SNAPSHOT_OUT?.trim();
  const expectedChangesFile =
    params.expectedChangesFile?.trim() || process.env.EXPECTED_CHANGES_FILE?.trim();
  const upgradeReview = params.upgradeReview ?? envFlag('UPGRADE_REVIEW');
  const json = params.json ?? envFlag('JSON_OUTPUT');
  const requestedLedger = parseRequestedLedger(
    params.requestedLedger ?? process.env.SNAPSHOT_LEDGER,
  );

  const server = new rpc.Server(rpcUrl);

  console.log(chalk.bold('Soroban Contract State Snapshot Example'));
  console.log(
    chalk.gray(
      'Capture contract state, fingerprint every entry, and compare two ledger positions.',
    ),
  );
  console.log(chalk.yellow('\nConfiguration'));
  console.log(`  RPC endpoint    : ${rpcUrl}`);
  console.log(`  Contract        : ${contractId}`);
  console.log(`  Network         : ${networkId(networkPassphrase)}`);
  console.log(
    `  Storage keys    : ${keyInputs.length > 0 ? keyInputs.join(', ') : '(instance only)'}`,
  );
  console.log(`  Durability      : ${durability} (applies to symbol and ScVal keys)`);
  console.log(`  Baseline        : ${baselineFile ?? '(none; capture only)'}`);
  console.log(`  Output file     : ${outputFile ?? '(none)'}`);
  console.log(`  Upgrade review  : ${upgradeReview ? 'enabled' : 'disabled'}`);
  console.log(`  Requested ledger: ${requestedLedger ?? '(current ledger)'}`);

  const expectedChanges: ExpectedChangeRule[] = expectedChangesFile
    ? loadExpectedChangesFile(expectedChangesFile)
    : [];

  const comparisonSnapshot = await captureContractStateSnapshot({
    contractId,
    networkPassphrase,
    source: server,
    storageKeys,
    requestedLedger,
  });

  if (!baselineFile) {
    if (outputFile) {
      const written = saveSnapshotFile(outputFile, comparisonSnapshot);
      console.log(chalk.green(`\nSnapshot written to ${written}`));
    }
    if (json) console.log(serializeSnapshot(comparisonSnapshot).trimEnd());
    else printSnapshotSummary(comparisonSnapshot);
    console.log(
      chalk.gray('\nTo compare later, capture again with SNAPSHOT_BASELINE pointing at this file.'),
    );
    return;
  }

  const baseline = loadSnapshotFile(baselineFile);
  const report = compareSnapshots(baseline, comparisonSnapshot, {
    upgradeReview,
    expectedChanges,
  });

  if (outputFile) {
    const written = saveSnapshotFile(outputFile, comparisonSnapshot);
    console.log(chalk.green(`\nComparison snapshot written to ${written}`));
  }

  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(`\n${formatComparisonReport(report)}`);

  const color =
    report.status === 'identical'
      ? chalk.green
      : report.status === 'unexpected-changes' || report.status === 'incomplete'
        ? chalk.red
        : chalk.yellow;
  console.log(color(`\nComparison status: ${report.status}`));
}

export async function run(params: ContractStateSnapshotParams = {}): Promise<void> {
  try {
    await execute(params);
  } catch (error: unknown) {
    if (error instanceof UnsupportedHistoricalStateError) {
      console.error(chalk.red(`\nHistorical state unavailable: ${error.message}`));
      process.exitCode = 1;
      return;
    }
    if (error instanceof SnapshotCompatibilityError) {
      console.error(chalk.red(`\nIncompatible snapshots: ${error.message}`));
      process.exitCode = 1;
      return;
    }
    if (error instanceof SnapshotValidationError) {
      console.error(chalk.red(`\nSnapshot validation failed: ${error.message}`));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
