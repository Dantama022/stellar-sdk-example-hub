import {
  Account,
  Contract,
  Keypair,
  Networks,
  Operation,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Multi-Contract Transaction Composition Example
 *
 * A frequent misconception is that "a transaction with multiple contract
 * invocations" means adding several top-level `contract.call(...)` operations
 * to one `TransactionBuilder`. That is NOT how Soroban works: the protocol
 * allows **at most one host-function (contract invocation) operation per
 * transaction**. `.addOperation()`-ing two separate `contract.call(...)`
 * results into one transaction is rejected outright (or never simulates
 * successfully), because the Soroban host only ever executes a single
 * invocation entry point per transaction.
 *
 * The way applications genuinely compose multi-contract behaviour into one
 * atomic transaction is by invoking a single "orchestrator" (a.k.a. "router")
 * contract, whose method internally makes cross-contract calls to one or
 * more downstream contracts during its own execution. From the *transaction's*
 * point of view there is still only one operation — but the *ledger effects*,
 * *resource footprint*, and *authorization requirements* span every contract
 * that the orchestrator touches while it runs. That is the sense in which
 * this example builds "a transaction containing multiple contract
 * invocations": one operation, one host-function call, and multiple
 * contracts participating atomically underneath it.
 *
 * This differs from `24-cross-contract-invoke.ts`, which focuses on the
 * caller -> proxy call mechanics for a single downstream dependency. This
 * example focuses on:
 *   - Passing several downstream contract IDs into one orchestrator call
 *   - Displaying the *combined* resource usage and authorization data that
 *     simulation reports for the whole call tree
 *   - Explaining atomicity (all-or-nothing rollback) and execution order
 *     (determined by the orchestrator's own code, not argument order)
 *   - Handling failures from the orchestrator or any downstream contract
 *     gracefully, without crashing the process
 *
 * This example demonstrates:
 *   1. Connecting to Soroban RPC and confirming connectivity
 *   2. Configuring one orchestrator contract ID and two downstream contract
 *      IDs
 *   3. Funding an ephemeral caller account via Friendbot
 *   4. Building a single orchestrator invocation operation that receives
 *      both downstream contract addresses as arguments
 *   5. Simulating the complete transaction and displaying combined resource
 *      usage and authorization data
 *   6. Assembling, signing, and submitting the transaction
 *   7. Displaying execution results, explaining that per-call results are
 *      inferred from the overall transaction outcome
 *   8. Explaining atomicity and deterministic execution order
 */

export interface InvocationResult {
  contractId: string;
  success: boolean;
  value?: unknown;
  error?: string;
}

export interface InvocationSummary {
  total: number;
  succeeded: number;
  failed: number;
}

/**
 * Builds the single top-level operation that invokes the orchestrator
 * contract. The orchestrator receives every downstream contract ID as an
 * `Address` argument — it is the orchestrator's own WASM code that decides
 * whether, and in what order, to call into each of those contracts while
 * this single host-function invocation executes.
 *
 * This function is pure and network-free: it only builds an XDR operation
 * from inputs and never touches the network.
 */
export function buildOrchestratorOperation(
  orchestratorContractId: string,
  downstreamContractIds: string[],
  methodName: string,
): xdr.Operation<Operation.InvokeHostFunction> {
  const orchestrator = new Contract(orchestratorContractId);
  const downstreamArgs = downstreamContractIds.map((id) => new Contract(id).address().toScVal());

  return orchestrator.call(methodName, ...downstreamArgs);
}

/**
 * Aggregates per-contract invocation outcomes into totals. Pure function,
 * no network or SDK dependency — easy to unit test with plain objects.
 */
export function summarizeInvocationResults(results: InvocationResult[]): InvocationSummary {
  return results.reduce<InvocationSummary>(
    (summary, result) => ({
      total: summary.total + 1,
      succeeded: summary.succeeded + (result.success ? 1 : 0),
      failed: summary.failed + (result.success ? 0 : 1),
    }),
    { total: 0, succeeded: 0, failed: 0 },
  );
}

/**
 * Static explanation of atomicity and execution order for multi-contract
 * composition through a single orchestrator invocation. Returned as a string
 * so it can be both unit tested and printed to the console.
 */
export function explainAtomicity(): string {
  return [
    'Atomicity: the orchestrator invocation, and every cross-contract call it makes while',
    'it executes, run inside a single Soroban host-function invocation. If ANY part of that',
    'call tree reverts for any reason -- the orchestrator itself, or a failure deep inside a',
    'downstream cross-contract call -- the ENTIRE transaction is rolled back atomically.',
    'None of its effects (storage writes, balance changes, events) are committed to the',
    'ledger. There is no partial execution: either every contract touched by the invocation',
    'succeeds together, or none of their state changes apply.',
    '',
    'Execution order: the order in which downstream contracts are actually called is',
    "deterministic, but it is decided by the orchestrator contract's own code path -- the",
    'sequence of calls it makes internally -- NOT by the order the downstream contract IDs',
    'are listed as arguments to this transaction. Passing [contractA, contractB] does not',
    "guarantee contractA is invoked before contractB; only the orchestrator's logic does.",
  ].join('\n');
}

/**
 * Produces a human-readable, ordered list of steps describing how execution
 * flows from the transaction into the orchestrator and out to its downstream
 * contracts. This is a display helper only -- it does not claim to observe
 * real host execution order (see `explainAtomicity`), it just illustrates the
 * conceptual call chain implied by the arguments supplied to this example.
 */
export function describeExecutionOrder(downstreamContractIds: string[]): string[] {
  const steps: string[] = ['1. Orchestrator invoked (the single top-level transaction operation)'];

  downstreamContractIds.forEach((id, index) => {
    steps.push(
      `${index + 2}. Cross-call into ${id} (order decided by orchestrator code, not this list)`,
    );
  });

  steps.push(`${downstreamContractIds.length + 2}. Orchestrator invocation completes and returns`);

  return steps;
}

/**
 * Maps a raw simulation/submission error message to friendly guidance.
 * Mirrors the error-branch style used in 24/68/71, but generalized to cover
 * failures that can originate from the orchestrator OR from any downstream
 * contract it calls -- since Soroban surfaces both as a single invocation
 * failure. Never throws, and always returns non-empty guidance.
 */
export function explainInvocationFailure(errorMessage: string): {
  message: string;
  guidance: string;
} {
  const message = errorMessage || 'Unknown error';
  const lower = message.toLowerCase();

  if (lower.includes('invalid contract id') || lower.includes('invalid contract')) {
    return {
      message,
      guidance:
        'One of the configured contract IDs (orchestrator or a downstream contract) is not a ' +
        'valid or deployed contract strkey. Verify CONTRACT_ID, CONTRACT_ID_A, and CONTRACT_ID_B ' +
        'and confirm each contract is actually deployed on the target network.',
    };
  }

  if (
    (lower.includes('missing') && lower.includes('function')) ||
    lower.includes('unknown method') ||
    lower.includes('no such method') ||
    lower.includes('function not found')
  ) {
    return {
      message,
      guidance:
        'The orchestrator contract does not expose the method name that was invoked. Confirm ' +
        'the method name and that the deployed WASM matches the interface this example expects.',
    };
  }

  if (lower.includes('auth') || lower.includes('unauthorized') || lower.includes('signature')) {
    return {
      message,
      guidance:
        'An authorization requirement was not satisfied. Either the orchestrator or one of the ' +
        'downstream contracts it calls requires a signed SorobanAuthorizationEntry that was not ' +
        'provided. Because authorization failures inside a cross-contract call still fail the ' +
        'whole invocation, check auth entries for every contract in the call tree, not just the ' +
        'orchestrator.',
    };
  }

  if (
    lower.includes('trap') ||
    lower.includes('revert') ||
    lower.includes('panic') ||
    lower.includes('host invocation failed') ||
    lower.includes('contract error')
  ) {
    return {
      message,
      guidance:
        'The orchestrator invocation reverted, either from its own logic or because a downstream ' +
        'cross-contract call it made failed. Per Soroban atomicity, this rolls back the entire ' +
        'transaction: none of the contracts touched -- orchestrator or downstream -- had their ' +
        'state changes committed. Inspect diagnostic events to find which contract in the call ' +
        'tree raised the error.',
    };
  }

  if (lower.includes('expired') || lower.includes('ttl') || lower.includes('archived')) {
    return {
      message,
      guidance:
        'A contract instance or storage entry involved in the call tree has expired (its ' +
        "live-until ledger has passed). Extend the entry's TTL with `extendFootprintTtl` before " +
        'retrying the invocation.',
    };
  }

  return {
    message,
    guidance:
      'The invocation failed for a reason this example does not recognize. Because the ' +
      'orchestrator and its downstream calls execute inside one atomic invocation, no partial ' +
      'effects were committed -- it is safe to inspect the raw error above and retry.',
  };
}

export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';

  // In production this "orchestrator" would be a purpose-built router contract
  // whose method fans out to whatever downstream contracts a workflow needs.
  // No such contract is deployed for this repo's examples, so -- consistent
  // with `68-soroban-contract-simulation.ts` -- we reuse its well-known
  // "Hello World" Testnet contract ID as a stand-in default. Override with a
  // real orchestrator's contract ID via CONTRACT_ID when one is available.
  const orchestratorContractId =
    process.env.CONTRACT_ID || 'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';
  const methodName = process.env.CONTRACT_METHOD || 'orchestrate';

  // Two sample downstream contract IDs the orchestrator is told about. These
  // are syntactically valid contract strkeys (so building the operation
  // succeeds) but are not contracts deployed for this example -- simulation
  // is expected to fail unless real, deployed contract IDs are supplied.
  const downstreamContractIdA =
    process.env.CONTRACT_ID_A || 'CAZSKFP35JH65M3ORDPHKDH3SPYBZIYU2N2ZEY63E24NFIZCG4XNLVQD';
  const downstreamContractIdB =
    process.env.CONTRACT_ID_B || 'CD3VK47OKVWW3QPWAICPJ6CGBTRIXKDWE4QWAR6LQ7UW667F3Q7KOTQL';
  const downstreamContractIds = [downstreamContractIdA, downstreamContractIdB];

  console.log(chalk.bold('Multi-Contract Transaction Composition Example'));
  console.log(
    chalk.gray(
      'Compose one orchestrator invocation that reaches multiple downstream contracts atomically.',
    ),
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
  // Step 2: Configure contract IDs
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 2: Configuring orchestrator and downstream contracts...'));
  console.log(`Orchestrator contract   : ${orchestratorContractId}`);
  console.log(`Orchestrator method     : ${methodName}`);
  console.log(`Downstream contract A   : ${downstreamContractIdA}`);
  console.log(`Downstream contract B   : ${downstreamContractIdB}`);
  console.log(
    chalk.gray(
      '\n  IMPORTANT: Soroban permits only one host-function (contract invocation) operation ' +
        'per transaction. "Multiple contract invocations" here means the orchestrator receives ' +
        'both downstream contract addresses as arguments and calls into them internally during ' +
        'its own execution -- NOT two separate top-level contract.call() operations added to ' +
        'the same TransactionBuilder.',
    ),
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Fund an ephemeral caller account
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 3: Preparing caller account...'));
  const caller = Keypair.random();
  console.log(`Caller public key: ${caller.publicKey()}`);

  try {
    const fundRes = await fetch(`https://friendbot.stellar.org/?addr=${caller.publicKey()}`);
    if (!fundRes.ok) throw new Error(`Friendbot returned HTTP ${fundRes.status}`);
    console.log(chalk.green('Caller account funded via Friendbot.'));
  } catch (err: any) {
    console.warn(chalk.red('Friendbot funding failed:'), err.message);
    console.log(
      chalk.gray(
        '  Continuing -- simulation can still run against a mock account, but final ' +
          'submission will fail without a funded caller.',
      ),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Build the single orchestrator invocation operation
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 4: Building the orchestrator invocation operation...'));

  console.log(chalk.bold('\n  Planned execution order (illustrative):'));
  describeExecutionOrder(downstreamContractIds).forEach((step) => console.log(`    ${step}`));

  let sourceAccount: Account;
  try {
    sourceAccount = await server.getAccount(caller.publicKey());
  } catch {
    // Friendbot funding may have failed; fall back to a mock account so the
    // remaining build/simulation steps can still be demonstrated.
    sourceAccount = new Account(caller.publicKey(), '0');
  }

  let operation: xdr.Operation<Operation.InvokeHostFunction>;
  try {
    operation = buildOrchestratorOperation(
      orchestratorContractId,
      downstreamContractIds,
      methodName,
    );
  } catch (err: any) {
    const { guidance } = explainInvocationFailure(err.message || String(err));
    console.warn(chalk.red('\nFailed to build the orchestrator operation:'), err.message);
    console.log(chalk.cyan(`  Guidance: ${guidance}`));
    console.log(
      chalk.cyan(
        '\nSummary: Demonstrated multi-contract transaction composition through a single ' +
          'orchestrator invocation, and handled an operation-build failure gracefully without ' +
          'submitting anything to the network.',
      ),
    );
    return;
  }

  let tx = new TransactionBuilder(sourceAccount, {
    fee: '1000000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  console.log(chalk.green(`Transaction built with ${tx.operations.length} operation(s).`));
  console.log(
    chalk.gray(
      '  Exactly one operation is present -- the orchestrator invocation -- even though it ' +
        'reaches two downstream contracts once executed.',
    ),
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: Simulate the complete transaction
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 5: Simulating the complete transaction...'));

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    const { guidance } = explainInvocationFailure(simResult.error);
    console.warn(chalk.red('Simulation failed.'));
    console.log(chalk.gray(`  Error details: ${simResult.error}`));
    console.log(chalk.cyan(`  Guidance: ${guidance}`));
    console.log(chalk.bold('\nAtomicity and execution order:'));
    console.log(explainAtomicity());
    console.log(
      chalk.cyan(
        '\nSummary: Built a single orchestrator invocation referencing two downstream ' +
          'contracts, simulated it, and handled the simulation failure gracefully -- no fee ' +
          'was charged and nothing was submitted.',
      ),
    );
    return;
  }

  if (!rpc.Api.isSimulationSuccess(simResult)) {
    console.warn(chalk.red('Simulation returned an unexpected non-success status.'));
    return;
  }

  console.log(chalk.green('Simulation succeeded.'));
  displayCombinedResourceUsage(simResult);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 6: Assemble, sign, and submit
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 6: Assembling, signing, and submitting the transaction...'));

  tx = rpc.assembleTransaction(tx, simResult).build();
  tx.sign(caller);

  let txHash: string | undefined;
  let submissionError: string | undefined;

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
  } catch (err: any) {
    submissionError = (err.message || String(err)) as string;
    const { guidance } = explainInvocationFailure(submissionError);
    console.warn(chalk.red('Transaction submission failed:'), submissionError);
    console.log(chalk.cyan(`  Guidance: ${guidance}`));
  }

  let confirmed = false;
  if (txHash && !submissionError) {
    console.log(chalk.yellow('\nPolling for transaction confirmation...'));
    try {
      const pollResponse = await server.pollTransaction(txHash, { attempts: 25 });
      if (pollResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Transaction finished with status: ${pollResponse.status}`);
      }
      confirmed = true;
      console.log(chalk.green('Transaction confirmed on-chain.'));
    } catch (err: any) {
      submissionError = err.message || String(err);
      console.warn(chalk.red('Transaction did not confirm:'), submissionError);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 7: Display execution results per configured downstream contract
  //
  // Soroban's JS SDK does not return a separate result object per nested
  // cross-contract call -- only the overall invocation's return value and
  // emitted events. We are honest about that here: each entry below is
  // inferred from the single, atomic transaction outcome, not observed
  // independently per downstream contract.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(
    chalk.yellow('\nStep 7: Execution results (inferred from overall transaction outcome)...'),
  );
  console.log(
    chalk.gray(
      '  Soroban executes nested cross-contract calls within one atomic host invocation, so ' +
        'the JS SDK does not expose a separate result per downstream call -- these results are ' +
        'inferred from whether the single transaction succeeded as a whole.',
    ),
  );

  const overallSuccess = confirmed && !submissionError;
  const results: InvocationResult[] = [
    {
      contractId: orchestratorContractId,
      success: overallSuccess,
      value:
        overallSuccess && simResult.result?.retval
          ? safeDecode(simResult.result.retval)
          : undefined,
      error: overallSuccess ? undefined : submissionError,
    },
    ...downstreamContractIds.map((contractId) => ({
      contractId,
      success: overallSuccess,
      error: overallSuccess ? undefined : submissionError,
    })),
  ];

  results.forEach((result) => {
    const label = result.success ? chalk.green('SUCCESS') : chalk.red('FAILED');
    console.log(`  [${label}] ${result.contractId}`);
    if (result.value !== undefined)
      console.log(`    Return value: ${JSON.stringify(result.value)}`);
    if (result.error) console.log(`    Error: ${result.error}`);
  });

  const summary = summarizeInvocationResults(results);
  console.log(
    chalk.bold(
      `\n  Summary: ${summary.succeeded}/${summary.total} contract entries reported success, ` +
        `${summary.failed} failed.`,
    ),
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Step 8: Atomicity and execution order
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 8: Atomicity and execution order'));
  console.log(explainAtomicity());

  console.log(
    chalk.cyan(
      '\nSummary: Built and submitted one orchestrator invocation touching two downstream ' +
        'contracts, displayed the combined resource footprint and authorization data from ' +
        'simulation, reported inferred per-contract results, and explained why the whole call ' +
        'tree succeeds or fails together.',
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Displays resource usage and authorization data from a successful simulation,
 * following the same decode pattern used in `68-soroban-contract-simulation.ts`.
 * Because the simulated operation is a single orchestrator invocation, these
 * numbers represent the *combined* footprint and auth across every contract
 * the orchestrator touches while executing -- not just the orchestrator's own
 * storage.
 */
function displayCombinedResourceUsage(sim: rpc.Api.SimulateTransactionSuccessResponse): void {
  console.log(chalk.bold('\n  Combined resource estimates (orchestrator + downstream calls):'));
  console.log(`    Minimum resource fee : ${sim.minResourceFee} stroops`);

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
      console.log(
        chalk.gray(
          '    (These footprint entries can belong to the orchestrator, either downstream ' +
            'contract, or all three -- simulation reports the union across the whole call tree.)',
        ),
      );
    } catch {
      console.log(chalk.gray('    (Could not decode detailed resource breakdown.)'));
    }
  }

  if (sim.result?.auth && sim.result.auth.length > 0) {
    console.log(chalk.bold('\n  Authorization entries required (across all contracts called):'));
    sim.result.auth.forEach((_entry, idx) => {
      console.log(`    [${idx}] SorobanAuthorizationEntry`);
    });
    console.log(chalk.gray('    Each entry must be signed (or pre-authorized) before submission.'));
  } else {
    console.log(chalk.gray('\n  (No authorization entries required for this invocation.)'));
  }

  if (sim.result?.retval) {
    try {
      const decoded = scValToNative(sim.result.retval);
      console.log(chalk.bold('\n  Orchestrator return value:'));
      console.log(
        `    ${JSON.stringify(decoded, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
      );
    } catch {
      console.log(chalk.gray('    (Return value could not be decoded to a native JS type.)'));
    }
  }
}

function safeDecode(retval: Parameters<typeof scValToNative>[0]): unknown {
  try {
    return scValToNative(retval);
  } catch {
    return undefined;
  }
}
