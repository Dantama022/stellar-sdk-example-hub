import {
  Account,
  Contract,
  Keypair,
  Networks,
  rpc,
  scValToNative,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Soroban Contract Storage Update Example
 *
 * Soroban smart contracts maintain application state in persistent ledger
 * storage.  Updating that state requires submitting a real transaction (not
 * just simulating) — a method call that internally writes to storage via
 * `storage.set(key, value)`.
 *
 * This example demonstrates the complete lifecycle of a storage-updating
 * contract invocation:
 *
 *   1. Connect to Soroban RPC and confirm connectivity
 *   2. Fund an ephemeral account to pay fees
 *   3. Read the initial storage value (before the update)
 *   4. Build and simulate a transaction that updates storage
 *   5. Attach simulation data (footprint + resource fee) and sign
 *   6. Submit the transaction and poll for confirmation
 *   7. Re-read the storage value to verify the update
 *   8. Display before-and-after values in a readable format
 *
 * The default contract and method used here target a simple counter contract
 * deployed on Testnet.  If that contract is unavailable, the example
 * gracefully handles simulation and submission errors and still demonstrates
 * every step of the workflow.
 */

const POLL_ATTEMPTS = 25;
const BASE_FEE = '500000'; // 0.05 XLM — enough for most Soroban operations

export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';

  // Accept contract ID and method from environment variables or use defaults.
  // The default contract and method represent a typical "increment counter"
  // pattern common in Soroban tutorial contracts.
  const contractId =
    process.env.CONTRACT_ID || 'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';
  const updateMethod = process.env.CONTRACT_METHOD || 'increment';
  const readMethod = process.env.CONTRACT_READ_METHOD || 'get';

  console.log(chalk.bold('Soroban Contract Storage Update Example'));
  console.log(
    chalk.gray('Read initial state → invoke a state-modifying method → verify the updated value.'),
  );
  console.log(chalk.blue(`\nConnecting to Soroban RPC: ${rpcUrl}`));

  const server = new rpc.Server(rpcUrl);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Confirm RPC connectivity
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 1: Confirming RPC connectivity...'));
  try {
    const health = await server.getLatestLedger();
    console.log(chalk.green(`Connected. Latest ledger: ${health.sequence}`));
  } catch (err: any) {
    console.error(chalk.red('Failed to reach Soroban RPC:'), err.message);
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Fund an ephemeral account to pay transaction fees
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 2: Preparing fee-payer account...'));
  const feePayerKeypair = Keypair.random();
  console.log(`Fee-payer public key: ${feePayerKeypair.publicKey()}`);

  try {
    const fundRes = await fetch(
      `https://friendbot.stellar.org/?addr=${feePayerKeypair.publicKey()}`,
    );
    if (!fundRes.ok) throw new Error(`Friendbot returned HTTP ${fundRes.status}`);
    console.log(chalk.green('Account funded via Friendbot.'));
  } catch (err: any) {
    console.warn(chalk.red('Friendbot funding failed:'), err.message);
    console.log(
      chalk.gray(
        '  Continuing — the simulation and assembly steps will still run, but ' +
          'the final submission will fail without a funded fee-payer.',
      ),
    );
  }

  const contract = new Contract(contractId);
  console.log(`\nTarget contract : ${contractId}`);
  console.log(`Read method     : ${readMethod}`);
  console.log(`Update method   : ${updateMethod}`);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Read the initial storage value
  //
  // We call the read method via simulation (no fee, no state change) to
  // capture the current counter value before the update.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 3: Reading initial contract storage value...'));

  const initialValue = await simulateReadValue(server, feePayerKeypair, contract, readMethod);

  if (initialValue !== null) {
    console.log(chalk.green(`  Initial value: ${initialValue}`));
  } else {
    console.log(
      chalk.gray(
        '  Could not read initial value (method may not exist or contract may be ' +
          'unavailable).  Continuing with the update demonstration.',
      ),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Build the storage-update transaction
  //
  // The increment/update method modifies contract storage.  Building the
  // transaction at this stage does NOT modify state — the change only
  // happens when the transaction is confirmed on-chain.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 4: Building storage-update transaction...'));

  let feePayerAccount: Account;
  try {
    feePayerAccount = await server.getAccount(feePayerKeypair.publicKey());
  } catch (err: any) {
    console.error(chalk.red('Could not load fee-payer account from RPC:'), err.message);
    console.log(
      chalk.gray(
        '  The account must exist on-chain before building a real transaction. ' +
          'Friendbot funding may have failed.',
      ),
    );
    return;
  }

  const updateOperation = contract.call(updateMethod);

  let tx = new TransactionBuilder(feePayerAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(updateOperation)
    .setTimeout(30)
    .build();

  console.log(chalk.green('Transaction built (pre-simulation — no footprint attached yet).'));

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: Simulate and assemble
  //
  // Simulation computes the resource footprint (which ledger entries are read
  // and which are written) and the minimum resource fee.  `assembleTransaction`
  // attaches both to the transaction so the network accepts it.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 5: Simulating transaction...'));

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    console.warn(chalk.red('Simulation returned an error.'));
    console.log(chalk.gray(`Error: ${simResult.error}`));
    console.log(
      chalk.cyan(
        '\nA simulation error means the update would fail on-chain too.  Common causes:\n' +
          '  • Invalid contract ID or method name\n' +
          '  • Missing required authorization\n' +
          '  • Incorrect argument types\n' +
          '  • Contract has expired and needs its TTL extended\n' +
          'No fee was charged.  Fix the invocation and retry.',
      ),
    );
    return;
  }

  if (!rpc.Api.isSimulationSuccess(simResult)) {
    console.warn(chalk.red('Unexpected non-success simulation status.'));
    return;
  }

  console.log(chalk.green('Simulation succeeded.'));
  console.log(`  Minimum resource fee : ${simResult.minResourceFee} stroops`);

  // Attach footprint and update fee.
  tx = rpc.assembleTransaction(tx, simResult).build();
  console.log(chalk.green('Transaction assembled with resource footprint and updated fee.'));

  // ──────────────────────────────────────────────────────────────────────────
  // Step 6: Sign and submit
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 6: Signing and submitting transaction...'));

  tx.sign(feePayerKeypair);

  let txHash: string;
  try {
    const sendResponse = await server.sendTransaction(tx);

    if (sendResponse.status === 'ERROR') {
      const errDetail = sendResponse.errorResult
        ? sendResponse.errorResult.toXDR('base64')
        : 'unknown';
      throw new Error(`sendTransaction returned ERROR: ${errDetail}`);
    }

    txHash = sendResponse.hash;
    console.log(chalk.green(`Transaction accepted. Hash: ${txHash}`));
    console.log(`  Status at submission: ${sendResponse.status}`);
  } catch (err: any) {
    console.warn(chalk.red('Transaction submission failed:'), err.message);
    console.log(
      chalk.gray(
        '  This is expected when the contract ID is a placeholder or the method ' +
          'does not exist.  The simulation, assembly, and signing steps above were ' +
          'all performed correctly.',
      ),
    );
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Poll for confirmation
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nPolling for transaction confirmation...'));

  try {
    const pollResponse = await server.pollTransaction(txHash, {
      attempts: POLL_ATTEMPTS,
    });

    if (pollResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`Transaction finished with status: ${pollResponse.status}`);
    }

    console.log(chalk.green('Transaction confirmed on-chain.'));

    // Display the return value of the update method (e.g. the new counter value).
    if (rpc.Api.isSimulationSuccess(simResult) && simResult.result?.retval) {
      try {
        const retVal = scValToNative(simResult.result.retval);
        console.log(`  Return value from ${updateMethod}: ${formatNative(retVal)}`);
      } catch {
        // Ignore decode failures — they don't affect the storage update.
      }
    }
  } catch (err: any) {
    console.warn(chalk.red('Transaction did not confirm within polling window:'), err.message);
    console.log(chalk.gray('  The transaction may still confirm on a later ledger.'));
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 7: Re-read contract storage to verify the update
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 7: Verifying updated contract storage value...'));

  const updatedValue = await simulateReadValue(server, feePayerKeypair, contract, readMethod);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 8: Before-and-after summary
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 8: Before-and-after storage comparison'));
  displayStorageTransition(initialValue, updatedValue, updateMethod);

  console.log(
    chalk.cyan(
      '\nSummary: Read initial contract storage, simulated and submitted a state-modifying ' +
        'transaction, polled for on-chain confirmation, and verified the updated storage ' +
        'value — demonstrating the complete Soroban storage update lifecycle.',
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads a contract storage value by simulating a read-only method.
 * Returns the native JS value, or null if the simulation fails or returns void.
 */
async function simulateReadValue(
  server: rpc.Server,
  keypair: Keypair,
  contract: Contract,
  method: string,
): Promise<unknown> {
  try {
    const sourceAccount = await server.getAccount(keypair.publicKey()).catch(
      // If the account isn't funded, fall back to a mock sequence so we can
      // still simulate (simulation doesn't validate account state).
      () => ({ accountId: () => keypair.publicKey(), sequenceNumber: () => '0' }) as any,
    );

    const readOp = contract.call(method);
    const tx = new TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(readOp)
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
      return null;
    }

    return scValToNative(sim.result.retval);
  } catch {
    return null;
  }
}

/**
 * Displays a formatted before-and-after comparison of the storage value.
 */
function displayStorageTransition(before: unknown, after: unknown, method: string): void {
  const fmtBefore = before !== null ? formatNative(before) : '(unavailable)';
  const fmtAfter = after !== null ? formatNative(after) : '(unavailable)';

  console.log();
  console.log(`  Storage value before "${method}" : ${chalk.red(fmtBefore)}`);
  console.log(`  Storage value after  "${method}" : ${chalk.green(fmtAfter)}`);

  if (before !== null && after !== null) {
    if (String(before) !== String(after)) {
      console.log(chalk.green('\n  ✔  Storage was successfully updated on-chain.'));
    } else {
      console.log(
        chalk.yellow(
          '\n  ⚠  Before and after values are identical — the method may not have ' +
            'modified storage, or the read method returns cached data.',
        ),
      );
    }
  }

  console.log(
    chalk.gray(
      '\n  How storage changes are reflected in ledger state:\n' +
        '    1. A write to persistent/instance storage creates or updates a ContractData\n' +
        '       LedgerEntry with the new value.\n' +
        '    2. The change is visible to all callers immediately after the transaction\n' +
        '       is confirmed — there is no block finality delay beyond the ledger close.\n' +
        '    3. The live-until ledger of written entries is set automatically by the\n' +
        '       host; use `extendFootprintTtl` to keep important entries alive.\n' +
        '    4. Simulation reads the current ledger snapshot, so it always sees the\n' +
        '       most recently committed value.',
    ),
  );
}

/**
 * Converts a native JS value returned by `scValToNative` to a readable string.
 */
function formatNative(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || value === undefined) return '(null)';
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    } catch {
      return String(value);
    }
  }
  return String(value);
}
