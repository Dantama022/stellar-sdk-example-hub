import { Contract, xdr, rpc } from '@stellar/stellar-sdk';
import chalk from 'chalk';

// ---------------------------------------------------------------------------
// Public helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Validate a Soroban contract ID (56-character Stellar C-address). */
export function isValidContractId(id: string): boolean {
  if (typeof id !== 'string') return false;
  return /^C[A-Z2-7]{55}$/.test(id);
}

/** Build the LedgerKey for a ContractInstance entry. */
export function buildContractInstanceKey(contractId: string): xdr.LedgerKey {
  const contractAddress = new Contract(contractId).address().toScAddress();
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractAddress,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/** Build the LedgerKey for a ContractCode entry given a hex code hash. */
export function buildContractCodeKey(codeHashHex: string): xdr.LedgerKey {
  const hashBytes = Buffer.from(codeHashHex, 'hex');
  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: hashBytes }),
  );
}

/**
 * Extract the code hash (hex) from a ContractInstance ledger entry.
 * Returns null when the contract uses a built-in (non-WASM) executable.
 */
export function extractCodeHash(entry: rpc.Api.LedgerEntryResult): string | null {
  const ledgerEntry = entry.val as xdr.LedgerEntry;
  try {
    const contractData = ledgerEntry.data().contractData();
    const val = contractData.val();
    if (val.switch() !== xdr.ScValType.scvContractInstance()) return null;
    const executable = val.instance().executable();
    if (executable.switch() === xdr.ContractExecutableType.contractExecutableWasm()) {
      return executable.wasmHash().toString('hex');
    }
  } catch {
    // not a contract-data shape
  }
  return null;
}

/**
 * Determine whether a contract appears active based on TTL vs current ledger.
 * Returns 'active', 'expiring_soon' (< 1000 ledgers remaining), 'expired', or 'unknown'.
 */
export function classifyContractState(
  liveUntilLedger: number | null,
  currentLedger: number,
): 'active' | 'expiring_soon' | 'expired' | 'unknown' {
  if (liveUntilLedger === null) return 'unknown';
  const remaining = liveUntilLedger - currentLedger;
  if (remaining <= 0) return 'expired';
  if (remaining < 1000) return 'expiring_soon';
  return 'active';
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface DeploymentInspectionReport {
  contractId: string;
  network: string;
  currentLedger: number;
  /** 'found' | 'not_found' | 'archived' | 'error' */
  contractLedgerState: 'found' | 'not_found' | 'archived' | 'error';
  instanceLastModifiedLedger: number | null;
  instanceLiveUntilLedger: number | null;
  codeHash: string | null;
  codeLastModifiedLedger: number | null;
  codeLiveUntilLedger: number | null;
  contractActive: 'active' | 'expiring_soon' | 'expired' | 'unknown';
  instanceXdr: string | null;
  codeXdr: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Core inspection logic
// ---------------------------------------------------------------------------

export async function inspectContractDeployment(
  server: rpc.Server,
  contractId: string,
  network: string,
): Promise<DeploymentInspectionReport> {
  const report: DeploymentInspectionReport = {
    contractId,
    network,
    currentLedger: 0,
    contractLedgerState: 'error',
    instanceLastModifiedLedger: null,
    instanceLiveUntilLedger: null,
    codeHash: null,
    codeLastModifiedLedger: null,
    codeLiveUntilLedger: null,
    contractActive: 'unknown',
    instanceXdr: null,
    codeXdr: null,
    error: null,
  };

  // 1. Current ledger
  try {
    const latest = await server.getLatestLedger();
    report.currentLedger = latest.sequence;
  } catch (err: any) {
    report.error = `RPC failure fetching latest ledger: ${err.message}`;
    return report;
  }

  // 2. Contract instance ledger entry
  const instanceKey = buildContractInstanceKey(contractId);
  let instanceEntry: rpc.Api.LedgerEntryResult | null = null;

  try {
    const instanceResult = await server.getLedgerEntries(instanceKey);
    if (!instanceResult.entries || instanceResult.entries.length === 0) {
      report.contractLedgerState = 'not_found';
      report.error = `Contract not found on ledger: ${contractId}`;
      return report;
    }
    instanceEntry = instanceResult.entries[0];
  } catch (err: any) {
    const msg: string = err.message ?? '';
    // Archived/expired entries often surface as a specific RPC error
    if (msg.toLowerCase().includes('archiv') || msg.toLowerCase().includes('expir')) {
      report.contractLedgerState = 'archived';
      report.error = `Contract appears archived or expired: ${msg}`;
    } else {
      report.error = `RPC failure fetching contract instance: ${msg}`;
    }
    return report;
  }

  report.contractLedgerState = 'found';
  report.instanceLastModifiedLedger = instanceEntry.lastModifiedLedgerSeq ?? null;
  report.instanceLiveUntilLedger = (instanceEntry as any).liveUntilLedgerSeq ?? null;
  report.instanceXdr = (instanceEntry.val as xdr.LedgerEntry).toXDR('base64');

  // Detect archived state by TTL: if liveUntilLedger is set and already past
  if (
    report.instanceLiveUntilLedger !== null &&
    report.instanceLiveUntilLedger < report.currentLedger
  ) {
    report.contractLedgerState = 'archived';
  }

  report.contractActive = classifyContractState(
    report.instanceLiveUntilLedger,
    report.currentLedger,
  );

  // 3. Extract code hash
  const codeHash = extractCodeHash(instanceEntry);
  report.codeHash = codeHash;

  if (codeHash === null) {
    // Built-in / native contract — no separate code entry
    return report;
  }

  // 4. Contract code ledger entry (best-effort)
  const codeKey = buildContractCodeKey(codeHash);
  try {
    const codeResult = await server.getLedgerEntries(codeKey);
    if (codeResult.entries && codeResult.entries.length > 0) {
      const codeEntry = codeResult.entries[0];
      report.codeLastModifiedLedger = codeEntry.lastModifiedLedgerSeq ?? null;
      report.codeLiveUntilLedger = (codeEntry as any).liveUntilLedgerSeq ?? null;
      report.codeXdr = (codeEntry.val as xdr.LedgerEntry).toXDR('base64');
    }
  } catch (err: any) {
    // Code entry missing is not fatal — note but continue
    report.error = `RPC failure fetching contract code entry: ${err.message}`;
  }

  return report;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function stateLabel(state: DeploymentInspectionReport['contractActive']): string {
  switch (state) {
    case 'active':
      return chalk.green('active');
    case 'expiring_soon':
      return chalk.yellow('expiring soon');
    case 'expired':
      return chalk.red('expired');
    default:
      return chalk.gray('unknown');
  }
}

function ledgerStateLabel(state: DeploymentInspectionReport['contractLedgerState']): string {
  switch (state) {
    case 'found':
      return chalk.green('found');
    case 'not_found':
      return chalk.red('not found');
    case 'archived':
      return chalk.yellow('archived / expired');
    default:
      return chalk.red('error');
  }
}

function printReport(report: DeploymentInspectionReport, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(chalk.bold('\n=== Soroban Contract Deployment Inspection Report ==='));
  console.log(`${chalk.bold('Contract ID:')}          ${report.contractId}`);
  console.log(`${chalk.bold('Network:')}              ${report.network}`);
  console.log(`${chalk.bold('Current Ledger:')}       ${report.currentLedger}`);
  console.log(`${chalk.bold('Contract Ledger State:')} ${ledgerStateLabel(report.contractLedgerState)}`);

  if (report.contractLedgerState === 'not_found') {
    console.log(chalk.red(`\nDiagnostic: ${report.error}`));
    console.log(chalk.yellow('The contract ID may be incorrect, or the contract has not been deployed to this network.'));
    return;
  }

  if (report.contractLedgerState === 'archived') {
    console.log(chalk.yellow(`\nWarning: ${report.error ?? 'Contract entry appears archived or expired.'}`));
  }

  if (report.contractLedgerState === 'error' && !report.instanceXdr) {
    console.log(chalk.red(`\nError: ${report.error}`));
    return;
  }

  console.log(`${chalk.bold('\nContract Status:')}     ${stateLabel(report.contractActive)}`);

  console.log(chalk.bold('\n--- Instance Entry ---'));
  console.log(`Last Modified Ledger:  ${report.instanceLastModifiedLedger ?? chalk.gray('n/a')}`);
  console.log(`Live Until Ledger:     ${report.instanceLiveUntilLedger ?? chalk.gray('n/a')}`);
  if (report.instanceLiveUntilLedger !== null && report.currentLedger > 0) {
    const remaining = report.instanceLiveUntilLedger - report.currentLedger;
    const minutes = Math.round((remaining * 5) / 60);
    if (remaining > 0) {
      console.log(`TTL Remaining:         ${remaining} ledgers (~${minutes} min)`);
    } else {
      console.log(`TTL Remaining:         ${chalk.red('expired')}`);
    }
  }
  console.log(
    `Instance XDR:          ${report.instanceXdr ? chalk.gray(report.instanceXdr.slice(0, 60) + '…') : chalk.gray('n/a')}`,
  );

  console.log(chalk.bold('\n--- Code Reference ---'));
  if (report.codeHash) {
    console.log(`Code Hash:             ${report.codeHash}`);
    if (report.codeLastModifiedLedger !== null) {
      console.log(`Code Last Modified:    ${report.codeLastModifiedLedger}`);
      console.log(`Code Live Until:       ${report.codeLiveUntilLedger ?? chalk.gray('n/a')}`);
      console.log(
        `Code XDR:              ${report.codeXdr ? chalk.gray(report.codeXdr.slice(0, 60) + '…') : chalk.gray('n/a')}`,
      );
    } else {
      console.log(chalk.gray('  Code entry not retrieved.'));
      if (report.error) console.log(chalk.yellow(`  Note: ${report.error}`));
    }
  } else {
    console.log(chalk.gray('  Built-in executable — no separate code entry.'));
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function run(params?: {
  rpcUrl?: string;
  contractId?: string;
  json?: boolean;
}): Promise<void> {
  const rpcUrl =
    params?.rpcUrl ?? process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
  const jsonOutput = params?.json === true || process.env.JSON_OUTPUT === 'true';

  const contractId =
    params?.contractId ??
    process.env.CONTRACT_ID ??
    'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  if (!jsonOutput) {
    console.log(chalk.blue('Soroban Contract Deployment Inspection'));
    console.log(chalk.gray(`RPC: ${rpcUrl}`));
  }

  if (!isValidContractId(contractId)) {
    const msg = `Invalid contract ID: "${contractId}". Expected a 56-character Stellar C-address.`;
    if (jsonOutput) {
      console.log(JSON.stringify({ error: msg }));
    } else {
      console.error(chalk.red(msg));
    }
    return;
  }

  const server = new rpc.Server(rpcUrl);
  const report = await inspectContractDeployment(server, contractId, rpcUrl);
  printReport(report, jsonOutput);
}
