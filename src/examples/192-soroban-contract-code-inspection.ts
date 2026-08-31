import { createHash } from 'crypto';
import fs from 'fs';

import { Contract, xdr, rpc } from '@stellar/stellar-sdk';
import chalk from 'chalk';

// ---------------------------------------------------------------------------
// Public helpers (exported for tests)
// ---------------------------------------------------------------------------

/** SHA-256 hash of a WASM buffer, returned as a hex string. */
export function hashWasm(wasm: Buffer): string {
  return createHash('sha256').update(wasm).digest('hex');
}

/** Validate a Soroban contract ID (56-character Stellar C… address). */
export function isValidContractId(id: string): boolean {
  if (typeof id !== 'string') return false;
  // Stellar contract addresses start with 'C', are 56 chars, and are base32-encoded
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

/** Build the LedgerKey for a ContractCode (WASM) entry given a hex code hash. */
export function buildContractCodeKey(codeHashHex: string): xdr.LedgerKey {
  const hashBytes = Buffer.from(codeHashHex, 'hex');
  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: hashBytes }),
  );
}

/**
 * Extract the code hash (hex string) from a ContractInstance ledger entry.
 * Returns null when the entry uses a built-in (non-WASM) executable.
 */
export function extractCodeHash(entry: rpc.Api.LedgerEntryResult): string | null {
  const dataXdr = entry.val;
  // val is a LedgerEntry; the data union is accessed via .data()
  const ledgerEntry = dataXdr as xdr.LedgerEntry;
  try {
    const contractData = ledgerEntry.data().contractData();
    const val = contractData.val();
    if (val.switch() !== xdr.ScValType.scvContractInstance()) return null;
    const instance = val.instance();
    const executable = instance.executable();
    if (executable.switch() === xdr.ContractExecutableType.contractExecutableWasm()) {
      return executable.wasmHash().toString('hex');
    }
  } catch {
    // not a contract-data ledger entry shape
  }
  return null;
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface ContractCodeReport {
  contractId: string;
  codeHash: string | null;
  currentLedger: number;
  instanceLastModifiedLedger: number | null;
  instanceLiveUntilLedger: number | null;
  codeLastModifiedLedger: number | null;
  codeLiveUntilLedger: number | null;
  instanceXdr: string | null;
  codeXdr: string | null;
  wasmHashComparison: 'match' | 'mismatch' | 'unable_to_verify' | 'not_supplied';
  error: string | null;
}

// ---------------------------------------------------------------------------
// Core inspection logic
// ---------------------------------------------------------------------------

export async function inspectContractCode(
  server: rpc.Server,
  contractId: string,
  expectedHashHex?: string,
): Promise<ContractCodeReport> {
  const report: ContractCodeReport = {
    contractId,
    codeHash: null,
    currentLedger: 0,
    instanceLastModifiedLedger: null,
    instanceLiveUntilLedger: null,
    codeLastModifiedLedger: null,
    codeLiveUntilLedger: null,
    instanceXdr: null,
    codeXdr: null,
    wasmHashComparison: expectedHashHex ? 'unable_to_verify' : 'not_supplied',
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
      report.error = `Contract instance not found: ${contractId}`;
      return report;
    }
    instanceEntry = instanceResult.entries[0];
  } catch (err: any) {
    report.error = `RPC failure fetching contract instance: ${err.message}`;
    return report;
  }

  report.instanceLastModifiedLedger = instanceEntry.lastModifiedLedgerSeq ?? null;
  report.instanceLiveUntilLedger = (instanceEntry as any).liveUntilLedgerSeq ?? null;
  report.instanceXdr = (instanceEntry.val as xdr.LedgerEntry).toXDR('base64');

  // 3. Extract code hash from the instance
  const codeHash = extractCodeHash(instanceEntry);
  report.codeHash = codeHash;

  if (codeHash === null) {
    // Likely a built-in / native contract — no separate code entry
    report.error = 'Contract uses a built-in executable; no separate code entry available.';
    return report;
  }

  // 4. Contract code ledger entry
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
    // Code entry missing is not fatal — report it but continue
    report.error = `RPC failure fetching contract code entry: ${err.message}`;
  }

  // 5. Hash comparison
  if (expectedHashHex) {
    const normalised = expectedHashHex.toLowerCase().replace(/^0x/, '');
    report.wasmHashComparison = normalised === codeHash ? 'match' : 'mismatch';
  }

  return report;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printReport(report: ContractCodeReport, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(chalk.bold('\n=== Soroban Contract Code Inspection Report ==='));
  console.log(`${chalk.bold('Contract ID:')}         ${report.contractId}`);
  console.log(`${chalk.bold('Current Ledger:')}      ${report.currentLedger}`);

  if (report.error && !report.codeHash) {
    console.log(chalk.red(`\nError: ${report.error}`));
    return;
  }

  console.log(`${chalk.bold('Code Hash:')}           ${report.codeHash ?? chalk.gray('n/a')}`);

  console.log(chalk.bold('\n--- Instance Entry ---'));
  console.log(
    `Last Modified Ledger: ${report.instanceLastModifiedLedger ?? chalk.gray('n/a')}`,
  );
  console.log(
    `Live Until Ledger:    ${report.instanceLiveUntilLedger ?? chalk.gray('n/a')}`,
  );
  console.log(
    `Instance XDR:         ${report.instanceXdr ? chalk.gray(report.instanceXdr.slice(0, 60) + '…') : chalk.gray('n/a')}`,
  );

  console.log(chalk.bold('\n--- Code Entry ---'));
  if (report.codeLastModifiedLedger !== null) {
    console.log(`Last Modified Ledger: ${report.codeLastModifiedLedger}`);
    console.log(`Live Until Ledger:    ${report.codeLiveUntilLedger ?? chalk.gray('n/a')}`);
    console.log(
      `Code XDR:             ${report.codeXdr ? chalk.gray(report.codeXdr.slice(0, 60) + '…') : chalk.gray('n/a')}`,
    );
  } else {
    console.log(chalk.gray('  Code entry not available or not retrieved.'));
    if (report.error) console.log(chalk.yellow(`  Note: ${report.error}`));
  }

  console.log(chalk.bold('\n--- Hash Verification ---'));
  switch (report.wasmHashComparison) {
    case 'match':
      console.log(chalk.green('✓ Supplied hash MATCHES deployed code identifier'));
      break;
    case 'mismatch':
      console.log(chalk.red('✗ Supplied hash DOES NOT MATCH deployed code identifier'));
      break;
    case 'unable_to_verify':
      console.log(chalk.yellow('⚠ Unable to verify — code entry could not be retrieved'));
      break;
    case 'not_supplied':
      console.log(chalk.gray('  No expected hash supplied; skipping comparison'));
      break;
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function run(params?: {
  rpcUrl?: string;
  contractId?: string;
  expectedHash?: string;
  wasmFile?: string;
  json?: boolean;
}): Promise<void> {
  const rpcUrl =
    params?.rpcUrl ?? process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
  const jsonOutput = params?.json === true || process.env.JSON_OUTPUT === 'true';

  // Resolve contract ID from param, env, or fall back to a well-known testnet contract
  const contractId =
    params?.contractId ??
    process.env.CONTRACT_ID ??
    'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';

  if (!jsonOutput) {
    console.log(chalk.blue(`Soroban Contract Code Inspection`));
    console.log(chalk.gray(`RPC: ${rpcUrl}`));
  }

  // Validate contract ID
  if (!isValidContractId(contractId)) {
    const msg = `Invalid contract ID: "${contractId}". Expected a 56-character Stellar C-address.`;
    if (jsonOutput) {
      console.log(JSON.stringify({ error: msg }));
    } else {
      console.error(chalk.red(msg));
    }
    return;
  }

  // Resolve optional expected hash — can come from a WASM file or direct hex
  let expectedHashHex: string | undefined = params?.expectedHash ?? process.env.EXPECTED_HASH;

  const wasmFile = params?.wasmFile ?? process.env.WASM_FILE;
  if (wasmFile) {
    try {
      const wasmBuf = fs.readFileSync(wasmFile);
      expectedHashHex = hashWasm(wasmBuf);
      if (!jsonOutput) {
        console.log(chalk.gray(`Computed WASM hash from file: ${expectedHashHex}`));
      }
    } catch (err: any) {
      const msg = `Invalid WASM file "${wasmFile}": ${err.message}`;
      if (jsonOutput) {
        console.log(JSON.stringify({ error: msg }));
      } else {
        console.error(chalk.red(msg));
      }
      return;
    }
  }

  const server = new rpc.Server(rpcUrl);
  const report = await inspectContractCode(server, contractId, expectedHashHex);

  printReport(report, jsonOutput);
}
