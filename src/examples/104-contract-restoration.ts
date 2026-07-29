import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  rpc,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Example 104: Soroban Contract Restoration
 *
 * Soroban ledger entries carry a Time-To-Live (TTL). When the TTL expires, entries
 * are archived and cannot be read until they are restored. Restoration is distinct
 * from TTL extension:
 *
 *   - extendFootprintTtl  — keeps a *live* entry alive longer (cheaper, proactive)
 *   - restoreFootprint    — brings an *archived* entry back to the ledger (reactive)
 *
 * This example demonstrates detecting archived contract state, building a
 * RestoreFootprint transaction, simulating it, submitting when needed, and
 * verifying the contract becomes accessible again.
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
const DEFAULT_CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const POLL_ATTEMPTS = 25;

export interface ContractRestorationParams {
  contractId?: string;
  rpcUrl?: string;
}

export type ArchiveStatus = 'accessible' | 'archived' | 'unknown';

export interface ArchiveAssessment {
  status: ArchiveStatus;
  latestLedger: number;
  liveUntilLedgerSeq?: number;
  simulationNeedsRestore: boolean;
  details: string[];
}

export interface RestorationFootprint {
  instanceKey: xdr.LedgerKey;
  wasmKey: xdr.LedgerKey;
  labels: string[];
}

export function normalizeContractId(value: string, label = 'contract ID'): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Missing ${label}. Provide a contract ID starting with "C".`);
  }
  if (!StrKey.isValidContract(trimmed)) {
    throw new Error(
      `Invalid ${label} "${trimmed}". Expected a 56-character strkey starting with "C".`,
    );
  }
  return trimmed;
}

/** Builds the ledger key for a contract's persistent instance entry. */
export function contractInstanceLedgerKey(contractId: string): xdr.LedgerKey {
  const contract = new Contract(contractId);
  if (typeof (contract as { getFootprint?: () => xdr.LedgerKey }).getFootprint === 'function') {
    return (contract as { getFootprint: () => xdr.LedgerKey }).getFootprint();
  }

  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contract.address().toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/** Derives the ContractCode ledger key from a contract instance entry. */
export function wasmLedgerKeyFromInstance(entry: rpc.Api.LedgerEntryResult): xdr.LedgerKey {
  const wasmHash = entry.val.contractData().val().instance().wasmHash();
  return xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
}

/** Resolves the instance + WASM keys required to restore a contract. */
export async function resolveRestorationFootprint(
  server: rpc.Server,
  contractId: string,
): Promise<RestorationFootprint | null> {
  const instanceKey = contractInstanceLedgerKey(contractId);

  let instanceEntry: rpc.Api.LedgerEntryResult;
  try {
    const response = await server.getLedgerEntries(instanceKey);
    if (!response.entries?.length) {
      return null;
    }
    instanceEntry = response.entries[0];
  } catch {
    return null;
  }

  const wasmKey = wasmLedgerKeyFromInstance(instanceEntry);
  return {
    instanceKey,
    wasmKey,
    labels: ['contract instance', 'contract WASM code'],
  };
}

/**
 * Determines whether a contract instance appears archived on the network.
 *
 * Uses ledger-entry TTL metadata when available and falls back to simulating a
 * lightweight invocation to detect `isSimulationRestore`.
 */
export async function assessArchiveStatus(
  server: rpc.Server,
  contractId: string,
  latestLedger: number,
  callerPublicKey: string,
): Promise<ArchiveAssessment> {
  const details: string[] = [];
  let liveUntilLedgerSeq: number | undefined;
  let simulationNeedsRestore = false;

  try {
    const instance = await server.getContractData(
      contractId,
      xdr.ScVal.scvLedgerKeyContractInstance(),
      rpc.Durability.Persistent,
    );
    liveUntilLedgerSeq = instance.liveUntilLedgerSeq;
    if (liveUntilLedgerSeq !== undefined) {
      details.push(`Instance live until ledger ${liveUntilLedgerSeq} (latest: ${latestLedger}).`);
    }
  } catch (err: any) {
    details.push(`Instance entry not readable: ${err?.message ?? String(err)}`);
  }

  const contract = new Contract(contractId);
  const probeTx = new TransactionBuilder(new Account(callerPublicKey, '0'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(contract.call('version'))
    .setTimeout(30)
    .build();

  try {
    const sim = await server.simulateTransaction(probeTx);
    simulationNeedsRestore = rpc.Api.isSimulationRestore(sim);
    if (simulationNeedsRestore) {
      details.push('Simulation reports archived entries (isSimulationRestore).');
    } else if (rpc.Api.isSimulationError(sim)) {
      details.push(`Probe simulation error (non-archive): ${sim.error.split('\n')[0]}`);
    } else {
      details.push('Probe simulation succeeded without a restore preamble.');
    }
  } catch (err: any) {
    details.push(`Probe simulation failed: ${err?.message ?? String(err)}`);
  }

  const ttlExpired =
    liveUntilLedgerSeq !== undefined && liveUntilLedgerSeq < latestLedger;

  let status: ArchiveStatus = 'unknown';
  if (simulationNeedsRestore || ttlExpired) {
    status = 'archived';
  } else if (liveUntilLedgerSeq !== undefined || !simulationNeedsRestore) {
    status = 'accessible';
  }

  return { status, latestLedger, liveUntilLedgerSeq, simulationNeedsRestore, details };
}

export function formatArchiveStatus(assessment: ArchiveAssessment): string {
  const label =
    assessment.status === 'archived'
      ? 'ARCHIVED — restoration required before reads/invokes'
      : assessment.status === 'accessible'
        ? 'ACCESSIBLE — no restoration needed'
        : 'UNKNOWN — inspect diagnostics below';

  const lines = [
    `Archive status : ${label}`,
    `Latest ledger  : ${assessment.latestLedger}`,
  ];
  if (assessment.liveUntilLedgerSeq !== undefined) {
    lines.push(`TTL expires at : ledger ${assessment.liveUntilLedgerSeq}`);
  }
  lines.push('', 'Diagnostics:');
  assessment.details.forEach((line) => lines.push(`  - ${line}`));
  return lines.join('\n');
}

export function describeTtlVsRestoration(): string {
  return [
    'TTL extension vs restoration:',
    '  extendFootprintTtl — extends the lifetime of entries that are still live.',
    '                       Use proactively before expiry to avoid archival.',
    '  restoreFootprint   — brings archived entries back onto the ledger.',
    '                       Required before a contract can be read or invoked again.',
    '                       Costs rent based on the restored footprint size and duration.',
  ].join('\n');
}

function formatFootprint(footprint: RestorationFootprint): string {
  return footprint.labels
    .map((label, index) => `  [${index + 1}] ${label}`)
    .join('\n');
}

async function pollForSuccess(server: rpc.Server, hash: string): Promise<rpc.Api.GetTransactionResponse> {
  const response = await server.pollTransaction(hash, { attempts: POLL_ATTEMPTS });
  if (response.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Restoration transaction finished with status ${response.status}`);
  }
  return response;
}

/**
 * Runs the Soroban contract restoration example.
 *
 * Inputs: runner `contractId` param, `CONTRACT_ID` env var, or CLI argv[3].
 */
export async function run(params: ContractRestorationParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl || process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URL;
  const contractInput =
    params.contractId?.trim() ||
    process.env.CONTRACT_ID?.trim() ||
    process.argv[3]?.trim() ||
    DEFAULT_CONTRACT_ID;

  console.log(chalk.bold('Soroban Contract Restoration Example'));
  console.log(chalk.blue(`Soroban RPC: ${rpcUrl}`));

  let contractId: string;
  try {
    contractId = normalizeContractId(contractInput);
  } catch (err: any) {
    console.log(chalk.red(`\n${err?.message ?? err}`));
    return;
  }

  const server = new rpc.Server(rpcUrl);

  let latestLedger: number;
  try {
    latestLedger = (await server.getLatestLedger()).sequence;
    console.log(chalk.green(`Connected. Latest ledger: ${latestLedger}`));
  } catch (err: any) {
    console.log(chalk.red(`Could not reach Soroban RPC: ${err?.message ?? err}`));
    return;
  }

  console.log(`\nContract ID: ${contractId}`);

  const feePayer = Keypair.random();
  try {
    const fundRes = await fetch(`https://friendbot.stellar.org/?addr=${feePayer.publicKey()}`);
    if (!fundRes.ok) throw new Error(`Friendbot HTTP ${fundRes.status}`);
    console.log(chalk.green(`Fee-payer funded: ${feePayer.publicKey()}`));
  } catch (err: any) {
    console.log(chalk.yellow(`Friendbot funding failed: ${err?.message ?? err}`));
    console.log(chalk.gray('Restoration submission will be skipped without a funded account.'));
  }

  const assessment = await assessArchiveStatus(
    server,
    contractId,
    latestLedger,
    feePayer.publicKey(),
  );
  console.log('\n' + formatArchiveStatus(assessment));
  console.log('\n' + describeTtlVsRestoration());

  const footprint = await resolveRestorationFootprint(server, contractId);
  if (!footprint) {
    console.log(chalk.red('\nCould not resolve a restoration footprint for this contract.'));
    console.log(chalk.gray('Verify the contract ID is deployed on this network.'));
    return;
  }

  console.log(chalk.bold('\nRestoration footprint (read-write):'));
  console.log(formatFootprint(footprint));

  let account: Account;
  try {
    account = await server.getAccount(feePayer.publicKey());
  } catch {
    console.log(chalk.yellow('\nFee-payer account unavailable — demonstrating simulation only.'));
    account = new Account(feePayer.publicKey(), '1');
  }

  const sorobanData = new SorobanDataBuilder()
    .setReadWrite([footprint.instanceKey, footprint.wasmKey])
    .build();

  let restoreTx = new TransactionBuilder(account, { fee: BASE_FEE })
    .setNetworkPassphrase(Networks.TESTNET)
    .setSorobanData(sorobanData)
    .addOperation(Operation.restoreFootprint({}))
    .setTimeout(30)
    .build();

  console.log(chalk.yellow('\nSimulating RestoreFootprint transaction...'));
  const restoreSim = await server.simulateTransaction(restoreTx);

  if (rpc.Api.isSimulationError(restoreSim)) {
    console.log(chalk.red('Restoration simulation failed.'));
    console.log(chalk.gray(restoreSim.error));
    console.log(chalk.cyan(
      '\nCommon causes: footprint keys are not archived, invalid contract ID, ' +
        'or the RPC node rejected the operation. No fees were spent.',
    ));
    return;
  }

  const restorationFee = restoreSim.minResourceFee ?? '0';
  console.log(chalk.green('Restoration simulation succeeded.'));
  console.log(`Estimated restoration resource fee: ${restorationFee} stroops`);

  if (assessment.status !== 'archived') {
    console.log(chalk.cyan(
      '\nContract is currently accessible — skipping on-chain restoration submission.',
    ));
    console.log(chalk.gray(
      'The simulation above shows the fee and footprint you would pay if the ' +
        'contract instance and WASM were archived.',
    ));
    console.log(chalk.green('\nContract restoration example completed (diagnostics only).'));
    return;
  }

  console.log(chalk.yellow('\nContract is archived — preparing and submitting restoration...'));

  try {
    restoreTx = await server.prepareTransaction(restoreTx);
  } catch (err: any) {
    console.log(chalk.red(`prepareTransaction failed: ${err?.message ?? err}`));
    return;
  }

  restoreTx.sign(feePayer);
  const sendResp = await server.sendTransaction(restoreTx);

  if (sendResp.status === 'ERROR') {
    console.log(chalk.red('Restoration submission rejected.'));
    console.log(chalk.gray(sendResp.errorResult?.toXDR('base64') ?? 'No error result available.'));
    return;
  }

  console.log(`Submitted restoration tx: ${sendResp.hash} (${sendResp.status})`);

  try {
    const final = await pollForSuccess(server, sendResp.hash);
    console.log(chalk.green(`Restoration confirmed in ledger ${final.ledger ?? '(unknown)'}.`));
  } catch (err: any) {
    console.log(chalk.red(`Restoration did not succeed: ${err?.message ?? err}`));
    return;
  }

  const postAssessment = await assessArchiveStatus(
    server,
    contractId,
    latestLedger,
    feePayer.publicKey(),
  );
  console.log('\nPost-restoration check:');
  console.log(formatArchiveStatus(postAssessment));

  if (postAssessment.status === 'accessible') {
    console.log(chalk.green('\nContract is accessible again after restoration.'));
  } else {
    console.log(chalk.yellow('\nContract may still require additional TTL extension or retries.'));
  }

  console.log(chalk.green('\nContract restoration example completed.'));
}
