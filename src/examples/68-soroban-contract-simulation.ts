import {
  Contract,
  Keypair,
  Networks,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
  Account,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Soroban Contract Simulation Example
 *
 * Before submitting a Soroban transaction, developers typically simulate the contract
 * invocation to:
 *   - Estimate resource usage (CPU, memory, ledger I/O, transaction size)
 *   - Obtain required authorization entries
 *   - Validate that the invocation will succeed without spending fees
 *
 * Simulation does NOT modify ledger state — it is a dry-run that returns a detailed
 * response including the minimum resource fee and the transaction footprint. The
 * footprint must be attached to the real transaction before signing and submission.
 *
 * This example demonstrates:
 *   1. Building a Soroban contract invocation transaction
 *   2. Submitting it for simulation via Soroban RPC
 *   3. Parsing and displaying estimated resource usage and returned values
 *   4. Explaining how simulation results feed into the final transaction
 */

export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';

  // Accept a contract ID and method name from environment variables or use defaults.
  // The default contract ID is a well-known "Hello World" contract deployed on Testnet.
  const contractId =
    process.env.CONTRACT_ID || 'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';
  const methodName = process.env.CONTRACT_METHOD || 'hello';

  console.log(chalk.bold('Soroban Contract Simulation Example'));
  console.log(chalk.gray('Dry-run a contract invocation to inspect resources before submitting.'));
  console.log(chalk.blue(`\nConnecting to Soroban RPC: ${rpcUrl}`));

  const server = new rpc.Server(rpcUrl);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Confirm RPC connectivity
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 1: Confirming RPC connectivity...'));
  let latestLedger: number;
  try {
    const health = await server.getLatestLedger();
    latestLedger = health.sequence;
    console.log(chalk.green(`Connected. Latest ledger sequence: ${latestLedger}`));
  } catch (err: any) {
    console.error(chalk.red('Failed to reach Soroban RPC:'), err.message);
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Build the contract invocation transaction
  //
  // At this stage we do NOT know the resource footprint or the minimum fee.
  // We use a placeholder fee and a mock sequence number because simulation
  // accepts unsigned, unsubmitted transactions.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 2: Building contract invocation transaction...'));
  console.log(`Contract ID : ${contractId}`);
  console.log(`Method      : ${methodName}`);

  const ephemeralKeypair = Keypair.random();

  // Use a mock source account — simulation does not require the account to exist
  // on-chain.  The sequence number is arbitrary for simulation purposes.
  const sourceAccount = new Account(ephemeralKeypair.publicKey(), '0');

  const contract = new Contract(contractId);

  // Build a simple invocation with a single string argument.
  // Real contracts may require different argument types (Address, i64, map, etc.).
  const callArg = xdr.ScVal.scvSymbol('Stellar');
  const callOperation = contract.call(methodName, callArg);

  let tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(callOperation)
    .setTimeout(30)
    .build();

  console.log(chalk.green('Transaction built (pre-simulation, no footprint attached yet).'));

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Simulate the transaction
  //
  // `simulateTransaction` sends the transaction XDR to the Soroban RPC node
  // which executes it inside a simulated host environment.  No state changes
  // are committed.  The response contains:
  //   - `minResourceFee`: the minimum fee in stroops to cover resource usage
  //   - `transactionData`: a SorobanTransactionData XDR that must be attached
  //   - `result.retval`: the ScVal returned by the contract method (if any)
  //   - `error`: a human-readable message when simulation fails
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 3: Submitting transaction for simulation...'));

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    console.warn(chalk.red('Simulation returned an error.'));
    console.log(chalk.gray(`Error details: ${simResult.error}`));
    console.log(
      chalk.cyan(
        '\nA simulation error means the contract invocation would fail on-chain too. ' +
          'Common causes: invalid contract ID, wrong method name, incorrect argument types, ' +
          'or missing authorization. No fee is charged for a failed simulation.',
      ),
    );
    return;
  }

  if (!rpc.Api.isSimulationSuccess(simResult)) {
    console.warn(chalk.red('Simulation returned an unexpected non-success status.'));
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Display simulation results
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 4: Parsing simulation results...'));
  displaySimulationResults(simResult);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: Show how simulation data feeds into the final transaction
  //
  // `rpc.assembleTransaction` attaches the SorobanTransactionData XDR and
  // sets the fee to at least `base_fee + minResourceFee`.  The assembled
  // transaction is then ready to be signed and submitted.
  //
  // We do NOT submit here — this example focuses on simulation only.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 5: Demonstrating transaction assembly (without submitting)...'));

  const assembled = rpc.assembleTransaction(tx, simResult).build();

  console.log(
    chalk.green(
      'Transaction assembled with simulation footprint and updated resource fee.',
    ),
  );
  console.log(
    chalk.gray(
      '  The assembled transaction now contains the SorobanTransactionData extension ' +
        '(footprint + resource limits) and an adjusted fee covering both the base network ' +
        'fee and the Soroban resource fee.  Sign and submit this assembled transaction ' +
        'to execute the contract on-chain.',
    ),
  );
  console.log(`  XDR length (assembled): ${assembled.toEnvelope().toXDR('base64').length} chars`);

  console.log(
    chalk.cyan(
      '\nSummary: Built a Soroban contract invocation, simulated it via RPC, inspected ' +
        'estimated resources and returned values, and assembled the footprint-bearing ' +
        'transaction — all without broadcasting anything to the network.',
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses and pretty-prints the resource usage contained in a successful
 * simulation response.
 */
function displaySimulationResults(sim: rpc.Api.SimulateTransactionSuccessResponse): void {
  console.log(chalk.green('Simulation succeeded.'));
  console.log(
    chalk.bold('\n  Resource estimates:'),
  );
  console.log(`    Minimum resource fee : ${sim.minResourceFee} stroops`);

  // The SorobanTransactionData contains detailed resource limits set by the node.
  // Decode it to expose CPU, memory, and ledger-entry footprint counts.
  if (sim.transactionData) {
    try {
      const txData = sim.transactionData.build();
      const resources = txData.resources();
      console.log(`    Instructions (CPU)   : ${resources.instructions()}`);
      console.log(`    Read bytes           : ${resources.readBytes()}`);
      console.log(`    Write bytes          : ${resources.writeBytes()}`);

      const footprint = resources.footprint();
      const readOnly = footprint.readOnly();
      const readWrite = footprint.readWrite();
      console.log(`    Read-only entries    : ${readOnly.length}`);
      console.log(`    Read-write entries   : ${readWrite.length}`);
    } catch {
      console.log(chalk.gray('    (Could not decode detailed resource breakdown.)'));
    }
  }

  // Display the return value when the contract method returns one.
  if (sim.result?.retval) {
    console.log(chalk.bold('\n  Returned value from contract:'));
    try {
      const nativeValue = scValToNative(sim.result.retval);
      console.log(`    Native JS value: ${JSON.stringify(nativeValue)}`);
      console.log(`    XDR type       : ${sim.result.retval.switch().name}`);
    } catch {
      console.log(chalk.gray('    (Return value could not be decoded to a native JS type.)'));
    }
  } else {
    console.log(chalk.gray('\n  (Contract method returned no value — void return type.)'));
  }

  // Report authorization entries if the contract requires them.
  if (sim.result?.auth && sim.result.auth.length > 0) {
    console.log(chalk.bold('\n  Authorization entries required:'));
    sim.result.auth.forEach((_entry, idx) => {
      console.log(`    [${idx}] SorobanAuthorizationEntry`);
    });
    console.log(
      chalk.gray(
        '    These entries must be signed (or pre-authorized) before submission.',
      ),
    );
  } else {
    console.log(chalk.gray('\n  (No authorization entries required for this invocation.)'));
  }
}
