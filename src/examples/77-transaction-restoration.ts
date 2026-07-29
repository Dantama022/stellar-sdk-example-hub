import {
  Account,
  Contract,
  Keypair,
  Networks,
  Operation,
  rpc,
  SorobanDataBuilder,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';
import { pollRawTransaction } from '../utils/raw-transaction-poll';

/**
 * Soroban Transaction Restoration Example
 *
 * Soroban charges rent for ledger state. Every contract instance, WASM blob,
 * and persistent storage entry has a `liveUntilLedgerSeq`; once the network
 * passes it, the entry is *archived*. Archived state still exists, but it is no
 * longer part of the live ledger, so any transaction whose footprint touches it
 * fails.
 *
 * The recovery path is a `RestoreFootprint` operation, and the RPC server tells
 * you when you need one. `simulateTransaction` returns a **restore preamble**
 * (`restorePreamble`) alongside the normal simulation result whenever the
 * transaction it simulated would require archived entries to be brought back:
 *
 *   sim.restorePreamble = {
 *     minResourceFee: '...',      // fee for the restore transaction
 *     transactionData: SorobanDataBuilder  // footprint to restore
 *   }
 *
 * The workflow is therefore:
 *
 *   simulate original  →  restorePreamble present?  →  submit RestoreFootprint
 *                                                   →  re-simulate original
 *                                                   →  submit original
 *
 * The original transaction must be rebuilt and re-simulated after the restore,
 * because its sequence number is consumed and its footprint/resource fee are
 * computed against the now-restored ledger state.
 *
 * This example demonstrates:
 *   1. Connecting to Soroban RPC
 *   2. Simulating a contract invocation and reading the restore preamble
 *   3. Detecting whether restoration is required
 *   4. Building, simulating, and submitting the RestoreFootprint transaction
 *   5. Waiting for the restore to confirm, then rebuilding and resubmitting the
 *      original transaction
 *   6. Reporting restoration failures clearly
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
const DEFAULT_CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const BASE_FEE = '1000000'; // 0.1 XLM — restores can be more expensive than plain invocations
const POLL_ATTEMPTS = 25;

export interface TransactionRestorationParams {
  rpcUrl?: string;
  contractId?: string;
  method?: string;
}

export interface RestorationVerdict {
  required: boolean;
  reason: string;
  minResourceFee?: string;
}

/**
 * Decides whether a simulation result calls for state restoration.
 *
 * Two signals matter. A `restorePreamble` with a non-empty `transactionData` is
 * the explicit, authoritative one. A simulation *error* mentioning archived or
 * expired entries is the fallback: some RPC versions surface the condition as a
 * plain error instead of a preamble.
 */
export function assessRestorationNeed(
  simulation: rpc.Api.SimulateTransactionResponse,
): RestorationVerdict {
  if (rpc.Api.isSimulationRestore(simulation)) {
    return {
      required: true,
      reason:
        'RPC returned a restorePreamble — the transaction footprint references archived ledger entries.',
      minResourceFee: simulation.restorePreamble.minResourceFee,
    };
  }

  if (rpc.Api.isSimulationError(simulation)) {
    const lower = simulation.error.toLowerCase();
    if (lower.includes('archiv') || lower.includes('expired') || lower.includes('evicted')) {
      return {
        required: true,
        reason: `Simulation failed on archived state: ${simulation.error}`,
      };
    }
    return {
      required: false,
      reason: `Simulation failed for an unrelated reason: ${simulation.error}`,
    };
  }

  return {
    required: false,
    reason: 'Simulation succeeded with no restore preamble — all referenced state is live.',
  };
}

/**
 * Translates a restoration failure into actionable guidance. Never throws.
 */
export function explainRestorationFailure(errorMessage: unknown): string {
  const lower = String(errorMessage ?? '').toLowerCase();

  if (
    lower.includes('insufficient') ||
    lower.includes('underfunded') ||
    lower.includes('balance')
  ) {
    return 'The fee-payer cannot cover the restore fee. Restoration is priced on entry size — fund the account and retry.';
  }
  if (lower.includes('tx_bad_seq') || lower.includes('badseq')) {
    return 'Sequence number was stale. Reload the account between the restore and the original submission — never reuse a built envelope.';
  }
  if (lower.includes('not found')) {
    return 'The transaction never landed in a ledger. Poll again, or resubmit; the restore is idempotent in effect.';
  }
  if (lower.includes('malformed') || lower.includes('footprint')) {
    return 'The restore footprint was rejected. Use the transactionData from restorePreamble verbatim rather than rebuilding the footprint by hand.';
  }
  return 'Review the raw error above. If the entry is genuinely gone rather than archived, restoration cannot recover it — redeploy instead.';
}

/**
 * Builds the RestoreFootprint transaction from a simulation's restore preamble.
 * The preamble's `transactionData` already carries the exact footprint to
 * restore, so it is reused as-is.
 */
export function buildRestoreTransaction(
  account: Account,
  preamble: rpc.Api.SimulateTransactionRestoreResponse['restorePreamble'],
): ReturnType<TransactionBuilder['build']> {
  const sorobanData = new SorobanDataBuilder(preamble.transactionData.build()).build();

  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .setSorobanData(sorobanData)
    .addOperation(Operation.restoreFootprint({}))
    .setTimeout(60)
    .build();
}

export async function run(params: TransactionRestorationParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl || process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URL;
  const contractId = params.contractId?.trim() || process.env.CONTRACT_ID || DEFAULT_CONTRACT_ID;
  const methodName = params.method?.trim() || process.env.CONTRACT_METHOD || 'decimals';

  console.log(chalk.bold('Soroban Transaction Restoration Example'));
  console.log(
    chalk.gray('Detect archived state, restore it, then resubmit the original transaction.'),
  );
  console.log(chalk.blue(`\nRPC endpoint : ${rpcUrl}`));
  console.log(chalk.blue(`Contract     : ${contractId}`));
  console.log(chalk.blue(`Method       : ${methodName}`));

  const server = new rpc.Server(rpcUrl);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Confirm connectivity
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 1: Confirming RPC connectivity...'));
  try {
    const latest = await server.getLatestLedger();
    console.log(chalk.green(`Connected. Latest ledger: ${latest.sequence}`));
  } catch (err: any) {
    console.error(chalk.red('Failed to reach Soroban RPC:'), err.message ?? String(err));
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Prepare a fee-payer
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 2: Preparing fee-payer account...'));
  const keypair = Keypair.random();
  console.log(`Fee-payer: ${keypair.publicKey()}`);

  try {
    const res = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`);
    if (!res.ok) throw new Error(`Friendbot returned HTTP ${res.status}`);
    console.log(chalk.green('Account funded via Friendbot.'));
  } catch (err: any) {
    console.warn(chalk.red('Friendbot funding failed:'), err.message ?? String(err));
    console.log(chalk.gray('  Continuing — detection still runs, but submissions will fail.'));
  }

  const loadAccount = async (): Promise<Account> => {
    try {
      return await server.getAccount(keypair.publicKey());
    } catch {
      return new Account(keypair.publicKey(), '0');
    }
  };

  const contractInstance = new Contract(contractId);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Simulate the original transaction and look for a restore preamble
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 3: Simulating the original transaction...'));

  const originalTx = new TransactionBuilder(await loadAccount(), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(contractInstance.call(methodName))
    .setTimeout(60)
    .build();

  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    simulation = await server.simulateTransaction(originalTx);
  } catch (err: any) {
    console.error(chalk.red('Simulation call failed:'), err.message ?? String(err));
    console.log(chalk.cyan(`  ${explainRestorationFailure(err.message ?? err)}`));
    return;
  }

  const verdict = assessRestorationNeed(simulation);
  console.log(chalk.yellow('\nStep 4: Restoration required?'));
  console.log(`  ${verdict.required ? chalk.red('YES') : chalk.green('NO')} — ${verdict.reason}`);
  if (verdict.minResourceFee) {
    console.log(`  Restore minimum resource fee: ${verdict.minResourceFee} stroops`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: Restore, then rebuild and resubmit the original
  // ──────────────────────────────────────────────────────────────────────────
  if (verdict.required && rpc.Api.isSimulationRestore(simulation)) {
    console.log(chalk.yellow('\nStep 5a: Restoring the archived footprint...'));
    try {
      const restoreTx = buildRestoreTransaction(await loadAccount(), simulation.restorePreamble);

      const restoreSim = await server.simulateTransaction(restoreTx);
      if (rpc.Api.isSimulationError(restoreSim)) {
        throw new Error(`Restore simulation failed: ${restoreSim.error}`);
      }

      const preparedRestore = rpc.assembleTransaction(restoreTx, restoreSim).build();
      preparedRestore.sign(keypair);

      const sent = await server.sendTransaction(preparedRestore);
      if (sent.status === 'ERROR') {
        throw new Error(`Restore submission rejected: ${sent.errorResult?.toXDR('base64')}`);
      }
      console.log(chalk.green(`  Restore submitted. Hash: ${sent.hash}`));

      // Polled over raw JSON-RPC: this example only needs the status, and a
      // protocol newer than the installed SDK would break metadata parsing.
      const settled = await pollRawTransaction(rpcUrl, sent.hash, { attempts: POLL_ATTEMPTS });
      if (settled.status !== 'SUCCESS') {
        throw new Error(`Restore finished with status ${settled.status}`);
      }
      console.log(chalk.green('  Restore confirmed — the archived entries are live again.'));

      // The original envelope is now unusable: its sequence number was
      // consumed by nothing, but its footprint and resource fee were computed
      // against the pre-restore ledger. Rebuild from scratch.
      console.log(
        chalk.yellow('\nStep 5b: Rebuilding and resubmitting the original transaction...'),
      );
      const retryTx = new TransactionBuilder(await loadAccount(), {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(contractInstance.call(methodName))
        .setTimeout(60)
        .build();

      const retrySim = await server.simulateTransaction(retryTx);
      if (rpc.Api.isSimulationError(retrySim)) {
        throw new Error(`Original still fails after restore: ${retrySim.error}`);
      }
      if (rpc.Api.isSimulationRestore(retrySim)) {
        throw new Error(
          'Original still reports a restore preamble — more entries need restoring than the first pass covered.',
        );
      }

      const preparedRetry = rpc.assembleTransaction(retryTx, retrySim).build();
      preparedRetry.sign(keypair);

      const retrySent = await server.sendTransaction(preparedRetry);
      if (retrySent.status === 'ERROR') {
        throw new Error(`Original submission rejected: ${retrySent.errorResult?.toXDR('base64')}`);
      }

      const retrySettled = await pollRawTransaction(rpcUrl, retrySent.hash, {
        attempts: POLL_ATTEMPTS,
      });
      if (retrySettled.status !== 'SUCCESS') {
        throw new Error(`Original finished with status ${retrySettled.status}`);
      }
      console.log(chalk.green(`  Original transaction succeeded. Hash: ${retrySent.hash}`));
    } catch (err: any) {
      const raw = err.message ?? String(err);
      console.warn(chalk.red('  Restoration workflow failed:'), raw);
      console.log(chalk.cyan(`  ${explainRestorationFailure(raw)}`));
    }
  } else {
    console.log(chalk.yellow('\nStep 5: Nothing to restore'));
    console.log(
      chalk.gray(
        '  Every entry this transaction touches is still live, so the restore branch is skipped.\n' +
          '  To exercise it end to end, point CONTRACT_ID at a contract whose persistent state has\n' +
          '  been left untouched past its liveUntilLedgerSeq.',
      ),
    );

    // Even with nothing archived, the *construction* of a restore is worth
    // seeing: the same footprint the contract call would touch is what a real
    // restore would name. Build and simulate it without submitting.
    console.log(chalk.gray('\n  For illustration, building a restore over the same footprint:'));
    try {
      const illustrativeFootprint = contractInstance.getFootprint();
      const sorobanData = new SorobanDataBuilder()
        .setFootprint([illustrativeFootprint], [])
        .build();

      const illustrativeRestore = new TransactionBuilder(await loadAccount(), {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .setSorobanData(sorobanData)
        .addOperation(Operation.restoreFootprint({}))
        .setTimeout(60)
        .build();

      console.log(
        `    Operation      : ${illustrativeRestore.operations[0].type} over 1 read-write entry`,
      );

      const illustrativeSim = await server.simulateTransaction(illustrativeRestore);
      if (rpc.Api.isSimulationError(illustrativeSim)) {
        console.log(chalk.gray(`    Simulation says: ${illustrativeSim.error}`));
        console.log(
          chalk.gray(
            '    Which is the expected answer — restoring entries that are already live has\n' +
              '    nothing to do. This transaction is never submitted.',
          ),
        );
      } else {
        console.log(
          chalk.gray(
            `    Simulated resource fee: ${illustrativeSim.minResourceFee} stroops (not submitted —\n` +
              '    restoring live entries is a no-op).',
          ),
        );
      }
    } catch (err: any) {
      console.log(
        chalk.gray(`    Illustrative restore could not be built: ${err.message ?? String(err)}`),
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 6: Why archived state breaks transactions
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 6: Archived state and transaction execution'));
  console.log(
    chalk.cyan(
      '  • Rent, not deletion: archived entries are removed from the live ledger but retained in\n' +
        '    history, which is why they can be restored rather than recreated.\n' +
        '  • Footprint-wide failure: a transaction declares every entry it will read or write. If\n' +
        '    any one of them is archived, the whole transaction fails — the contract never runs.\n' +
        '  • restoreFootprint vs extendFootprintTtl: restore revives *archived* entries (reactive,\n' +
        '    and the entry is unusable until it lands). extendFootprintTtl pushes back the TTL of a\n' +
        '    *live* entry (proactive, and cheaper). Extending on a schedule is nearly always better\n' +
        '    than restoring after the fact.\n' +
        '  • Always re-simulate after restoring. Footprints and resource fees are state-dependent,\n' +
        '    so a pre-restore envelope is stale by construction.',
    ),
  );

  console.log(
    chalk.cyan(
      '\nSummary: Simulated a contract invocation, inspected the restore preamble to decide whether\n' +
        'archived state was involved, submitted RestoreFootprint when it was, and rebuilt and\n' +
        'resubmitted the original transaction against the restored ledger.',
    ),
  );
}
