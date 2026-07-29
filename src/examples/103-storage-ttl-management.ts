import {
  Asset,
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  rpc,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Soroban Contract Storage TTL Management Example
 *
 * Soroban charges rent for ledger space. Every contract data entry carries a
 * `liveUntilLedgerSeq`, and when the ledger passes it the entry stops being
 * readable:
 *
 *   Temporary entries are **deleted permanently**. The data is gone.
 *   Persistent entries are **archived**. The data survives and can be restored
 *   with `Operation.restoreFootprint`, at a cost.
 *
 * Either way a contract that assumed its state was still there starts failing,
 * and the failure surfaces as a confusing "entry not found" long after the
 * mistake was made. Long-lived applications therefore have to monitor TTL and
 * extend it *before* expiry, which is what `Operation.extendFootprintTtl` is for.
 *
 * This example demonstrates:
 *   1. Reading an entry's current TTL and translating it into remaining time
 *   2. Classifying an entry as healthy, expiring soon, or already expired
 *   3. Building an ExtendFootprintTTL transaction with the correct footprint
 *   4. Simulating the extension to learn its resource fee before committing
 *   5. Optionally submitting it and confirming the new TTL
 *   6. Explaining archival versus deletion, and when restore is the answer
 *
 * By default this example is read-only. Set EXTEND_TTL=true together with a
 * funded SECRET_KEY to actually submit the extension.
 */

/** Ledgers close roughly every 5 seconds. */
const SECONDS_PER_LEDGER = 5;

/** Warn when an entry has less than roughly a day of life left. */
const WARN_THRESHOLD_LEDGERS = (24 * 60 * 60) / SECONDS_PER_LEDGER;

export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  // Default to the native XLM Stellar Asset Contract: its address is derived
  // deterministically from the network passphrase and it is always deployed, so the
  // example runs out of the box instead of against a placeholder that does not exist.
  const contractId = process.env.CONTRACT_ID || Asset.native().contractId(Networks.TESTNET);
  const extendTo = Number(process.env.EXTEND_TO || 100_000);
  const shouldSubmit = process.env.EXTEND_TTL === 'true';

  console.log(chalk.bold('Soroban Contract Storage TTL Management Example'));
  console.log(
    chalk.gray('Inspect how long a storage entry has left, and extend it before it expires.'),
  );
  console.log(chalk.blue(`\nConnecting to Soroban RPC: ${rpcUrl}`));

  const server = new rpc.Server(rpcUrl);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Establish the current ledger
  //
  // TTL is an absolute ledger sequence, so it only means anything relative to
  // where the network is now.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 1: Reading the current ledger...'));
  let currentLedger: number;
  try {
    const latest = await server.getLatestLedger();
    currentLedger = latest.sequence;
    console.log(chalk.green(`Connected. Current ledger: ${currentLedger}`));
  } catch (err: any) {
    console.error(chalk.red('Failed to reach Soroban RPC:'), err.message);
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Read the entry and its TTL
  //
  // The contract instance entry is used because every deployed contract has one,
  // which makes this example runnable against any contract ID.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 2: Reading the contract instance entry...'));
  console.log(chalk.gray(`  Contract: ${contractId}`));

  const instanceKey = xdr.ScVal.scvLedgerKeyContractInstance();

  let entry: rpc.Api.LedgerEntryResult;
  try {
    entry = await server.getContractData(contractId, instanceKey, rpc.Durability.Persistent);
  } catch (err: any) {
    console.log(chalk.red('  Entry not found.'));
    console.log(
      chalk.gray(
        '  A contract instance is missing for two very different reasons: the contract was\n' +
          '  never deployed here, or its entry has been archived. If it is archived, the fix is\n' +
          '  Operation.restoreFootprint — see Step 6.',
      ),
    );
    console.log(chalk.gray(`  RPC said: ${err.message}`));
    return;
  }

  console.log(chalk.green('  Entry found.'));
  if (entry.lastModifiedLedgerSeq !== undefined) {
    console.log(chalk.gray(`  Last modified: ledger ${entry.lastModifiedLedgerSeq}`));
  }

  const liveUntil = entry.liveUntilLedgerSeq;
  if (liveUntil === undefined) {
    console.log(
      chalk.gray(
        '  No liveUntilLedgerSeq reported. Entries that are not rent-bearing — account and\n' +
          '  trustline entries, for instance — have no TTL to manage.',
      ),
    );
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Interpret the TTL
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 3: Interpreting the TTL'));

  const remaining = liveUntil - currentLedger;
  console.log(`  Live until ledger : ${liveUntil}`);
  console.log(`  Current ledger    : ${currentLedger}`);
  console.log(`  Remaining ledgers : ${remaining}`);

  if (remaining <= 0) {
    console.log(chalk.red(`  Status: EXPIRED (${Math.abs(remaining)} ledgers ago)`));
    console.log(
      chalk.gray(
        '  A Persistent entry in this state is archived, not deleted — restore it rather than\n' +
          '  extending it. Extending an already-expired entry does not bring it back.',
      ),
    );
  } else if (remaining < WARN_THRESHOLD_LEDGERS) {
    console.log(
      chalk.yellow(`  Status: EXPIRING SOON (~${describeDuration(remaining)} remaining)`),
    );
    console.log(chalk.gray('  Extend it now — waiting until after expiry costs more.'));
  } else {
    console.log(chalk.green(`  Status: HEALTHY (~${describeDuration(remaining)} remaining)`));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Build the extension
  //
  // ExtendFootprintTTL carries no operation-level key list. The entries to
  // extend are named by the transaction's Soroban footprint, in readOnly — a
  // detail that is easy to miss, because the operation body looks like it should
  // take the key itself.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 4: Building the ExtendFootprintTTL transaction'));
  console.log(`  Requested extendTo: ${extendTo} ledgers (~${describeDuration(extendTo)})`);
  console.log(
    chalk.gray(
      '  extendTo is measured from the current ledger, and it is a floor rather than an\n' +
        '  increment: an entry already living longer than the requested window is left alone.',
    ),
  );

  const ledgerKey = buildContractDataKey(contractId, instanceKey);
  if (!ledgerKey) {
    console.log(chalk.red('  Could not construct the ledger key for this contract.'));
    return;
  }

  const sorobanData = new SorobanDataBuilder().setFootprint([ledgerKey], []).build();

  // A throwaway account is enough to simulate; submitting needs a real one.
  const submitter = process.env.SECRET_KEY
    ? Keypair.fromSecret(process.env.SECRET_KEY)
    : Keypair.random();

  let sourceAccount: Account;
  if (shouldSubmit) {
    try {
      sourceAccount = await server.getAccount(submitter.publicKey());
    } catch {
      console.log(
        chalk.red(
          `  Cannot submit: account ${submitter.publicKey()} was not found or is unfunded.`,
        ),
      );
      console.log(chalk.gray('  Set SECRET_KEY to a funded account, or leave EXTEND_TTL unset.'));
      return;
    }
  } else {
    sourceAccount = new Account(submitter.publicKey(), '0');
  }

  const transaction = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.extendFootprintTtl({ extendTo }))
    .setSorobanData(sorobanData)
    .setTimeout(30)
    .build();

  console.log(chalk.green('  Transaction built with the entry in the read-only footprint.'));

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: Simulate to price it
  //
  // Simulating first turns "how much will this cost?" into a number before any
  // commitment, which matters when extending many entries on a schedule.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 5: Simulating the extension'));

  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    simulation = await server.simulateTransaction(transaction);
  } catch (err: any) {
    console.error(chalk.red('  Simulation request failed:'), err.message);
    return;
  }

  if (rpc.Api.isSimulationError(simulation)) {
    console.log(chalk.red('  Simulation failed:'));
    console.log(chalk.gray(`    ${simulation.error}`));
    return;
  }

  console.log(chalk.green('  Simulation succeeded.'));
  console.log(`  Minimum resource fee: ${simulation.minResourceFee} stroops`);
  console.log(
    chalk.gray(
      '  Rent scales with entry size and with how far the TTL is being pushed out. Extending\n' +
        '  a long way once is generally cheaper than extending repeatedly.',
    ),
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Step 6: Submit, if asked
  // ──────────────────────────────────────────────────────────────────────────
  if (!shouldSubmit) {
    console.log(chalk.yellow('\nStep 6: Submission skipped'));
    console.log(
      chalk.gray(
        '  This example is read-only by default. Set EXTEND_TTL=true and SECRET_KEY=<funded\n' +
          '  secret> to submit the extension and confirm the new TTL.',
      ),
    );
    explainArchival();
    return;
  }

  console.log(chalk.yellow('\nStep 6: Submitting the extension'));

  const prepared = rpc.assembleTransaction(transaction, simulation).build();
  prepared.sign(submitter);

  try {
    const sent = await server.sendTransaction(prepared);
    console.log(chalk.gray(`  Submitted. Hash: ${sent.hash}`));

    if (sent.status === 'ERROR') {
      console.log(chalk.red('  Submission rejected.'));
      console.log(chalk.gray(`  ${JSON.stringify(sent.errorResult)}`));
      return;
    }

    const confirmed = await server.pollTransaction(sent.hash, { attempts: 10 });
    if (confirmed.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      console.log(chalk.red(`  Transaction did not succeed (status: ${confirmed.status}).`));
      return;
    }

    console.log(chalk.green('  Extension confirmed.'));
  } catch (err: any) {
    console.error(chalk.red('  Submission failed:'), err.message);
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 7: Verify the new TTL
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 7: Re-reading the entry to confirm the new TTL'));
  try {
    const after = await server.getContractData(contractId, instanceKey, rpc.Durability.Persistent);
    const newLiveUntil = after.liveUntilLedgerSeq;

    if (newLiveUntil === undefined) {
      console.log(chalk.gray('  Entry no longer reports a TTL.'));
    } else {
      console.log(`  Live until ledger: ${liveUntil} → ${chalk.green(String(newLiveUntil))}`);
      console.log(chalk.gray(`  Gained ${newLiveUntil - liveUntil} ledgers.`));
    }
  } catch (err: any) {
    console.error(chalk.red('  Could not re-read the entry:'), err.message);
  }

  explainArchival();
  console.log(chalk.bold.green('\nTTL management complete.'));
}

/** The distinction that decides whether extending or restoring is the fix. */
function explainArchival(): void {
  console.log(chalk.yellow('\nArchival versus deletion'));
  console.log(
    chalk.gray(
      '  Persistent — expiry archives the entry. The data survives off the active ledger and\n' +
        '               Operation.restoreFootprint brings it back, for a fee. Extending beforehand\n' +
        '               is cheaper than restoring afterwards.\n' +
        '  Temporary  — expiry deletes the entry outright. Nothing restores it. Only put data\n' +
        '               here that can be safely recreated, such as nonces or short-lived locks.\n' +
        '  Instance   — shares the contract instance entry, so letting it lapse archives the\n' +
        '               contract itself along with its configuration.',
    ),
  );
}

/**
 * Build the LedgerKey naming a contract data entry.
 *
 * ExtendFootprintTTL identifies its targets through the footprint, so this key
 * is what actually selects the entry to extend.
 */
function buildContractDataKey(contractId: string, key: xdr.ScVal): xdr.LedgerKey | null {
  try {
    return xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(contractId).toScAddress(),
        key,
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
  } catch {
    return null;
  }
}

/** Turn a ledger count into something a reader can judge at a glance. */
function describeDuration(ledgers: number): string {
  const seconds = ledgers * SECONDS_PER_LEDGER;
  const days = seconds / 86_400;
  if (days >= 1) return `${days.toFixed(1)} days`;
  const hours = seconds / 3_600;
  if (hours >= 1) return `${hours.toFixed(1)} hours`;
  return `${Math.round(seconds / 60)} minutes`;
}
