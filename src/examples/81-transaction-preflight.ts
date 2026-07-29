import {
  Account,
  Contract,
  Keypair,
  Networks,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Soroban Transaction Preflight Example
 *
 * "Preflight" is the full workflow a Soroban transaction goes through before it
 * can be safely signed and submitted:
 *
 *   1. Build an unsigned invocation transaction (no footprint, no real fee yet)
 *   2. Submit it to `simulateTransaction` so the RPC node can execute the
 *      contract call inside a sandboxed host environment and report back the
 *      ledger footprint, authorization requirements, and resource costs
 *   3. Assemble the final transaction using that simulation data (footprint +
 *      adjusted fee)
 *   4. Sign and submit the assembled transaction, then poll until it confirms
 *
 * This is different from an *ordinary simulation* (as shown in
 * `68-soroban-contract-simulation`), which is a pure dry-run used to read
 * contract state or preview a call — it is never meant to be signed or
 * submitted. Preflight simulation looks identical on the wire (it is the same
 * `simulateTransaction` RPC call), but its purpose is to prepare a transaction
 * that *will* be submitted, and it always precedes signing and broadcasting.
 *
 * This example demonstrates the complete preflight lifecycle end-to-end,
 * including signing, submission, polling for confirmation, and graceful
 * handling of preflight failures at every stage.
 */

const POLL_ATTEMPTS = 25;
const BASE_FEE = '100000'; // 0.01 XLM base fee before the resource fee is added

export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';

  // Accept a contract ID and method name from environment variables or use
  // defaults. The default contract ID is the same well-known "Hello World"
  // contract used by the simulation example.
  const contractId =
    process.env.CONTRACT_ID || 'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';
  const methodName = process.env.CONTRACT_METHOD || 'hello';

  console.log(chalk.bold('Soroban Transaction Preflight Example'));
  console.log(
    chalk.gray('Simulate → assemble → sign → submit → confirm: the full preflight workflow.'),
  );
  console.log(chalk.blue(`\nConnecting to Soroban RPC: ${rpcUrl}`));

  const server = new rpc.Server(rpcUrl);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Confirm RPC connectivity
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 1: Confirming RPC connectivity...'));
  try {
    const health = await server.getLatestLedger();
    console.log(chalk.green(`Connected. Latest ledger sequence: ${health.sequence}`));
  } catch (err: any) {
    console.error(chalk.red('Failed to reach Soroban RPC:'), err.message);
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Fund an ephemeral fee-payer account
  //
  // Preflight always ends with signing and submission, so — unlike a pure
  // simulation-only example — we need a funded account able to pay the real
  // network + resource fee.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 2: Preparing fee-payer account...'));
  const feePayerKeypair = Keypair.random();
  console.log(`Fee-payer public key: ${feePayerKeypair.publicKey()}`);

  let funded = false;
  try {
    const fundRes = await fetch(
      `https://friendbot.stellar.org/?addr=${feePayerKeypair.publicKey()}`,
    );
    if (!fundRes.ok) throw new Error(`Friendbot returned HTTP ${fundRes.status}`);
    console.log(chalk.green('Account funded via Friendbot.'));
    funded = true;
  } catch (err: any) {
    console.warn(chalk.red('Friendbot funding failed:'), err.message);
    console.log(
      chalk.gray(
        '  Continuing — the preflight simulation and assembly steps will still run, ' +
          'but signing/submission will fail without a funded fee-payer.',
      ),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Build the contract invocation transaction
  //
  // We do NOT yet know the resource footprint or the minimum resource fee —
  // that is exactly what preflight simulation discovers next.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 3: Building contract invocation transaction...'));
  console.log(`Contract ID : ${contractId}`);
  console.log(`Method      : ${methodName}`);

  let sourceAccount: Account;
  if (funded) {
    try {
      sourceAccount = await server.getAccount(feePayerKeypair.publicKey());
    } catch (err: any) {
      console.warn(
        chalk.red('Could not load funded account from RPC, falling back to a mock account:'),
        err.message,
      );
      sourceAccount = new Account(feePayerKeypair.publicKey(), '0');
    }
  } else {
    // Simulation still works against a mock account with an arbitrary
    // sequence number — only the later sign/submit steps require funding.
    sourceAccount = new Account(feePayerKeypair.publicKey(), '0');
  }

  const contract = new Contract(contractId);
  const callArg = xdr.ScVal.scvSymbol('Stellar');
  const callOperation = contract.call(methodName, callArg);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(callOperation)
    .setTimeout(30)
    .build();

  console.log(chalk.green('Transaction built (pre-preflight, no footprint attached yet).'));

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Run preflight simulation
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 4: Submitting transaction for preflight simulation...'));

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    const failure = describePreflightFailure(simResult.error);
    console.warn(chalk.red('Preflight simulation failed.'));
    console.log(chalk.gray(`Error details: ${failure.message}`));
    console.log(chalk.cyan(`Guidance: ${failure.guidance}`));
    return;
  }

  if (!rpc.Api.isSimulationSuccess(simResult)) {
    console.warn(chalk.red('Preflight simulation returned an unexpected non-success status.'));
    return;
  }

  console.log(chalk.green('Preflight simulation succeeded.'));

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: Extract and display footprint, authorization, and resource fee
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 5: Extracting preflight data...'));

  if (simResult.transactionData) {
    try {
      const transactionData = simResult.transactionData.build();
      const footprintSummary = extractFootprintSummary(transactionData);

      console.log(chalk.bold('\n  Ledger footprint:'));
      console.log(`    Instructions (CPU)   : ${footprintSummary.instructions}`);
      console.log(`    Read bytes           : ${footprintSummary.readBytes}`);
      console.log(`    Write bytes          : ${footprintSummary.writeBytes}`);
      console.log(`    Read-only entries    : ${footprintSummary.readOnlyEntryCount}`);
      console.log(`    Read-write entries   : ${footprintSummary.readWriteEntryCount}`);
    } catch {
      console.log(chalk.gray('    (Could not decode detailed footprint breakdown.)'));
    }
  }

  const authSummary = summarizeAuthEntries(simResult.result?.auth);
  console.log(chalk.bold('\n  Authorization entries:'));
  if (authSummary.count === 0) {
    console.log(chalk.gray('    (No authorization entries required for this invocation.)'));
  } else {
    authSummary.entries.forEach((entry) => console.log(`    ${entry}`));
    console.log(
      chalk.gray('    These entries must be signed (or pre-authorized) before submission.'),
    );
  }

  console.log(chalk.bold('\n  Resource fee estimate:'));
  console.log(`    ${formatResourceFee(simResult.minResourceFee)}`);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 6: Assemble the final transaction using preflight data
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 6: Assembling final transaction with preflight data...'));

  const assembledTx = rpc.assembleTransaction(tx, simResult).build();

  console.log(
    chalk.green('Transaction assembled with the simulated footprint and an adjusted resource fee.'),
  );

  console.log(chalk.cyan(`\n${explainPreflightVsSimulation()}`));

  // ──────────────────────────────────────────────────────────────────────────
  // Step 7: Sign and submit the preflighted transaction
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 7: Signing and submitting the preflighted transaction...'));

  assembledTx.sign(feePayerKeypair);

  let txHash: string;
  try {
    const sendResponse = await server.sendTransaction(assembledTx);

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
        '  This is expected when the fee-payer account is unfunded or the contract ' +
          'ID/method is a placeholder. All preflight steps above (simulate, extract, ' +
          'assemble, sign) completed correctly.',
      ),
    );
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 8: Poll for confirmation and display the final result
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 8: Polling for transaction confirmation...'));

  try {
    const pollResponse = await server.pollTransaction(txHash, { attempts: POLL_ATTEMPTS });

    if (pollResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`Transaction finished with status: ${pollResponse.status}`);
    }

    console.log(chalk.green('Transaction confirmed on-chain.'));
    console.log(`  Transaction hash: ${txHash}`);

    if (simResult.result?.retval) {
      try {
        const nativeValue = scValToNative(simResult.result.retval);
        console.log(`  Execution result : ${JSON.stringify(nativeValue)}`);
      } catch {
        console.log(chalk.gray('  (Return value could not be decoded to a native JS type.)'));
      }
    } else {
      console.log(chalk.gray('  (Contract method returned no value — void return type.)'));
    }
  } catch (err: any) {
    console.warn(chalk.red('Transaction did not confirm within the polling window:'), err.message);
    console.log(chalk.gray('  The transaction may still confirm on a later ledger.'));
    return;
  }

  console.log(
    chalk.cyan(
      '\nSummary: Ran a full Soroban preflight — simulated the invocation, extracted the ' +
        'ledger footprint and resource fee, assembled the transaction, signed it, submitted ' +
        'it, and polled until on-chain confirmation.',
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (pure / network-free, exported for testing)
// ─────────────────────────────────────────────────────────────────────────────

export interface FootprintSummary {
  instructions: number;
  readBytes: number;
  writeBytes: number;
  readOnlyEntryCount: number;
  readWriteEntryCount: number;
}

/**
 * Decodes the resource usage and ledger footprint contained in a
 * `SorobanTransactionData` XDR structure returned by preflight simulation.
 */
export function extractFootprintSummary(
  transactionData: xdr.SorobanTransactionData,
): FootprintSummary {
  const resources = transactionData.resources();
  const footprint = resources.footprint();

  return {
    instructions: resources.instructions(),
    readBytes: resources.readBytes(),
    writeBytes: resources.writeBytes(),
    readOnlyEntryCount: footprint.readOnly().length,
    readWriteEntryCount: footprint.readWrite().length,
  };
}

/**
 * Summarizes the authorization entries returned by a preflight simulation.
 * Returns a zeroed summary for an empty or missing list rather than throwing.
 */
export function summarizeAuthEntries(authEntries: unknown[] | undefined): {
  count: number;
  entries: string[];
} {
  if (!authEntries || authEntries.length === 0) {
    return { count: 0, entries: [] };
  }

  return {
    count: authEntries.length,
    entries: authEntries.map((_entry, idx) => `[${idx}] SorobanAuthorizationEntry`),
  };
}

/**
 * Formats a minimum resource fee (as returned by simulation) into a readable
 * "N stroops" string.
 */
export function formatResourceFee(minResourceFee: string | number): string {
  return `${minResourceFee} stroops`;
}

/**
 * Given the raw error message from a failed preflight simulation, returns the
 * original message alongside actionable guidance. Never throws — this is the
 * graceful-failure-handling surface for the example.
 */
export function describePreflightFailure(errorMessage: string): {
  message: string;
  guidance: string;
} {
  const message = errorMessage ?? '(no error message provided)';
  const lower = message.toLowerCase();

  let guidance: string;
  if (
    lower.includes('missing value for key') ||
    lower.includes('no contract') ||
    lower.includes('invalid contract')
  ) {
    guidance =
      'The contract ID may be invalid or the contract may not be deployed on this network. ' +
      'Double-check the CONTRACT_ID environment variable.';
  } else if (
    lower.includes('unknown method') ||
    lower.includes('function not found') ||
    lower.includes('missingvalue')
  ) {
    guidance =
      'The method name does not exist on this contract. Verify CONTRACT_METHOD matches a ' +
      'function exported by the deployed contract.';
  } else if (
    lower.includes('argument') ||
    lower.includes('type mismatch') ||
    lower.includes('unexpectedtype')
  ) {
    guidance =
      'One or more arguments passed to the contract call have an incorrect type or count. ' +
      "Check the method's expected parameter types.";
  } else if (
    lower.includes('auth') &&
    (lower.includes('missing') || lower.includes('required') || lower.includes('invalid'))
  ) {
    guidance =
      'The invocation requires authorization that was not provided. Sign the required ' +
      'authorization entries before re-simulating and submitting.';
  } else if (lower.includes('expired') || lower.includes('ttl') || lower.includes('archived')) {
    guidance =
      'The contract or one of its ledger entries has expired. Extend its TTL with ' +
      'extendFootprintTtl (or restoreFootprint) before invoking it again.';
  } else {
    guidance =
      'Review the raw simulation error above for details. Common causes include an invalid ' +
      'contract ID, wrong method name, incorrect argument types, missing authorization, or ' +
      'an expired contract TTL. No fee is charged for a failed simulation.';
  }

  return { message, guidance };
}

/**
 * Explains the conceptual difference between "preflight" and an ordinary
 * read-only simulation. Used both in console output and asserted on in tests.
 */
export function explainPreflightVsSimulation(): string {
  return (
    'Preflight vs. ordinary simulation:\n' +
    '  Preflight is the full simulate -> assemble -> sign -> submit pipeline that always\n' +
    '  precedes a real, state-changing invocation. It uses simulateTransaction to discover\n' +
    '  the ledger footprint, authorization requirements, and resource fee, then feeds that\n' +
    '  data into the transaction that is actually signed and broadcast to the network.\n' +
    '  An ordinary simulation (a dry run, e.g. calling a read-only/view method) uses the\n' +
    '  exact same simulateTransaction RPC call, but the result is only inspected locally —\n' +
    '  it is never assembled, signed, or submitted. In short: every submitted Soroban\n' +
    '  transaction goes through preflight, but not every simulation is a preflight.'
  );
}
