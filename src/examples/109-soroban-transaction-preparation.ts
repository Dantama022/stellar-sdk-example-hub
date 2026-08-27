import {
  Account,
  Contract,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from 'stellar-sdk-v16';
import chalk from 'chalk';

/**
 * ISSUE-109: Soroban Transaction Preparation
 *
 * Soroban transactions must normally be simulated before signing because the
 * initial transaction does not yet contain the final:
 *
 * - resource limits,
 * - ledger footprint,
 * - Soroban resource fee,
 * - authorization entries.
 *
 * This example demonstrates:
 *
 *   build -> simulate -> inspect -> prepare
 *
 * It intentionally stops BEFORE signing or submission.
 *
 * ISSUE-110 continues the lifecycle by signing, submitting, and waiting for
 * confirmation.
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

const DEFAULT_CONTRACT_ID = 'CDVSGPL3HFBGJ6ZEYQUAVE3OH3XE2ZE5ZT2GWPA3LKOYVD4UBPQJ2VHB';

const DEFAULT_FUNCTION_NAME = 'hello';

const DEFAULT_ARGUMENT = 'Soroban';

const BASE_FEE = '100';

export interface SorobanPreparationParams {
  rpcUrl?: string;
  contractId?: string;
  functionName?: string;
  argument?: string;
  networkPassphrase?: string;
}

export interface ResourceSummary {
  instructions: number;
  diskReadBytes: number;
  writeBytes: number;
  readOnlyEntries: number;
  readWriteEntries: number;
  resourceFee: string;
}

/**
 * Extract the resource limits and footprint counts from Soroban transaction
 * data returned by simulation or attached to a prepared transaction.
 *
 * Protocol 26 calls the read-byte field `diskReadBytes`.
 */
export function extractResourceSummary(
  transactionData: xdr.SorobanTransactionData,
): ResourceSummary {
  const resources = transactionData.resources();

  const footprint = resources.footprint();

  return {
    instructions: resources.instructions(),

    diskReadBytes: resources.diskReadBytes(),

    writeBytes: resources.writeBytes(),

    readOnlyEntries: footprint.readOnly().length,

    readWriteEntries: footprint.readWrite().length,

    resourceFee: transactionData.resourceFee().toBigInt().toString(),
  };
}

/**
 * Obtain the SorobanTransactionData actually embedded in a prepared
 * transaction.
 *
 * rpc.assembleTransaction() attaches this transaction extension using the
 * simulation response.
 */
export function getPreparedSorobanData(transaction: Transaction): xdr.SorobanTransactionData {
  const envelope = transaction.toEnvelope();

  const sorobanData = envelope.v1().tx().ext().value();

  if (!sorobanData) {
    throw new Error('Prepared transaction does not contain Soroban transaction data.');
  }

  return sorobanData;
}

/**
 * Count authorization entries actually present on the prepared invocation.
 */
export function getPreparedAuthorizationCount(transaction: Transaction): number {
  const operation = transaction.operations[0];

  if (operation?.type !== 'invokeHostFunction') {
    return 0;
  }

  return operation.auth?.length ?? 0;
}

/**
 * Explain the five stages of a normal Soroban transaction lifecycle.
 */
export function explainTransactionLifecycle(): string {
  return [
    'Soroban transaction lifecycle:',
    '',
    '  1. BUILD',
    '     Create the transaction and contract invocation.',
    '     Resource limits, final Soroban fee, footprint, and generated',
    '     authorization entries are not known yet.',
    '',
    '  2. SIMULATE',
    '     Send the unsigned transaction to Soroban RPC.',
    '     RPC executes it without committing ledger changes and estimates',
    '     resources, fees, footprint, authorization, and the return value.',
    '',
    '  3. PREPARE',
    '     Apply the successful simulation result to the original transaction.',
    '     The prepared transaction now contains the Soroban transaction data,',
    '     adjusted fee, footprint, resource limits, and generated auth entries.',
    '',
    '  4. SIGN',
    '     Sign the fully prepared transaction and any required authorization',
    '     entries. Signing before preparation would sign the wrong transaction.',
    '',
    '  5. SUBMIT',
    '     Send the signed prepared transaction to Soroban RPC and wait for',
    '     the network to reach a terminal transaction result.',
  ].join('\n');
}

/**
 * Run the Soroban transaction preparation example.
 */
export async function run(params: SorobanPreparationParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl?.trim() || process.env.SOROBAN_RPC_URL?.trim() || DEFAULT_RPC_URL;

  const contractId =
    params.contractId?.trim() || process.env.CONTRACT_ID?.trim() || DEFAULT_CONTRACT_ID;

  const functionName =
    params.functionName?.trim() || process.env.CONTRACT_METHOD?.trim() || DEFAULT_FUNCTION_NAME;

  const argument = params.argument ?? process.env.CONTRACT_ARGUMENT ?? DEFAULT_ARGUMENT;

  const networkPassphrase =
    params.networkPassphrase?.trim() || process.env.NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;

  console.log(chalk.bold('\nSoroban Transaction Preparation Example'));

  console.log(
    chalk.gray('Build, simulate, apply resource data, and inspect a transaction before signing.'),
  );

  console.log(chalk.yellow('\nConfiguration'));

  console.log(`  RPC endpoint : ${rpcUrl}`);

  console.log(`  Contract ID  : ${contractId}`);

  console.log(`  Function     : ${functionName}`);

  console.log(`  Argument     : ${argument}`);

  const server = new rpc.Server(rpcUrl);

  // -----------------------------------------------------------------------
  // Step 1: Connect to RPC
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 1: Connecting to Soroban RPC...'));

  try {
    const latestLedger = await server.getLatestLedger();

    console.log(chalk.green(`  Connected. Latest ledger sequence: ${latestLedger.sequence}`));
  } catch (error: unknown) {
    console.error(chalk.red(`  Unable to connect to Soroban RPC: ${getErrorMessage(error)}`));

    return;
  }

  // -----------------------------------------------------------------------
  // Step 2: Build raw invocation
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 2: Building the initial Soroban transaction...'));

  /*
   * ISSUE-109 demonstrates preparation only, not submission.
   *
   * Simulation therefore does not require a funded account. A temporary
   * source account is enough for this preparation demonstration.
   */
  const sourceKeypair = Keypair.random();

  const sourceAccount = new Account(sourceKeypair.publicKey(), '0');

  let rawTransaction: Transaction;

  try {
    const targetContract = new Contract(contractId);

    /*
     * The fixture contract's hello function expects a Soroban String.
     *
     * ISSUE-108 demonstrates dynamically discovering this type. ISSUE-109
     * focuses on transaction preparation, so the invocation itself is kept
     * deliberately simple.
     */
    const invocation = targetContract.call(functionName, xdr.ScVal.scvString(argument));

    rawTransaction = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(invocation)
      .setTimeout(30)
      .build();
  } catch (error: unknown) {
    console.error(chalk.red(`  Failed to build transaction: ${getErrorMessage(error)}`));

    return;
  }

  console.log(chalk.green('  Initial transaction built.'));

  console.log(`  Transaction source account : ${sourceKeypair.publicKey()}`);

  console.log(`  Initial transaction fee     : ${rawTransaction.fee} stroops`);

  console.log(`  Operation count             : ${rawTransaction.operations.length}`);

  console.log(chalk.gray('  Soroban footprint           : not attached yet'));

  console.log(chalk.gray('  Final resource fee          : not known yet'));

  // -----------------------------------------------------------------------
  // Step 3: Simulate
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 3: Simulating the transaction...'));

  let simulation: rpc.Api.SimulateTransactionResponse;

  try {
    simulation = await server.simulateTransaction(rawTransaction);
  } catch (error: unknown) {
    console.error(chalk.red(`  RPC simulation request failed: ${getErrorMessage(error)}`));

    console.log(
      chalk.gray('  Verify the RPC endpoint, contract ID, network, function, and argument.'),
    );

    return;
  }

  console.log(`  Simulation ledger : ${simulation.latestLedger}`);

  if (rpc.Api.isSimulationError(simulation)) {
    console.error(chalk.red('  Simulation result : FAILED'));

    console.error(chalk.red(`  Error             : ${simulation.error}`));

    displayDiagnosticEvents(simulation.events);

    console.log(
      chalk.gray(
        '\n  Preparation cannot continue because a failed simulation does not provide a valid transaction preparation result.',
      ),
    );

    return;
  }

  if (rpc.Api.isSimulationRestore(simulation)) {
    console.log(chalk.yellow('  Simulation result : RESTORE REQUIRED'));

    console.log(`  Restore fee       : ${simulation.restorePreamble.minResourceFee} stroops`);

    console.log(
      chalk.gray(
        '  Archived ledger entries must be restored and the invocation simulated again before the final transaction can be prepared safely.',
      ),
    );

    return;
  }

  if (!rpc.Api.isSimulationSuccess(simulation)) {
    console.error(chalk.red('  Simulation returned an unexpected response type.'));

    return;
  }

  console.log(chalk.green('  Simulation result : SUCCESS'));

  // -----------------------------------------------------------------------
  // Step 4: Extract resource information
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 4: Extracting simulation resource requirements...'));

  const simulatedData = simulation.transactionData.build();

  const simulatedResources = extractResourceSummary(simulatedData);

  console.log(chalk.cyan('\n  Resource limits'));

  console.log(`    CPU instructions : ${simulatedResources.instructions.toLocaleString()}`);

  console.log(`    Disk read bytes  : ${simulatedResources.diskReadBytes.toLocaleString()}`);

  console.log(`    Write bytes      : ${simulatedResources.writeBytes.toLocaleString()}`);

  console.log(`    Resource fee     : ${simulatedResources.resourceFee} stroops`);

  console.log(`    RPC minimum fee  : ${simulation.minResourceFee} stroops`);

  const footprint = simulatedData.resources().footprint();

  const readOnly = footprint.readOnly();

  const readWrite = footprint.readWrite();

  console.log(chalk.cyan('\n  Footprint information'));

  console.log(`    Read-only entries  : ${readOnly.length}`);

  readOnly.forEach((key, index) => {
    console.log(`      [${index}] ${describeLedgerKey(key)}`);
  });

  console.log(`    Read-write entries : ${readWrite.length}`);

  readWrite.forEach((key, index) => {
    console.log(`      [${index}] ${describeLedgerKey(key)}`);
  });

  // -----------------------------------------------------------------------
  // Step 5: Inspect authorization requirements
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 5: Inspecting authorization entries...'));

  const simulationAuth = simulation.result?.auth ?? [];

  if (simulationAuth.length === 0) {
    console.log(chalk.gray('  No Soroban authorization entries are required by this invocation.'));
  } else {
    console.log(`  Authorization entries required: ${simulationAuth.length}`);

    simulationAuth.forEach((entry, index) => {
      console.log(`    [${index}] ${entry.credentials().switch().name}`);

      console.log(chalk.gray(`        XDR: ${entry.toXDR('base64')}`));
    });
  }

  // -----------------------------------------------------------------------
  // Step 6: Apply simulation result / prepare transaction
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow('\nStep 6: Applying the simulation result and preparing the transaction...'),
  );

  let preparedTransaction: Transaction;

  try {
    /*
     * assembleTransaction() clones the original transaction and applies:
     *
     * - SorobanTransactionData,
     * - resource limits,
     * - ledger footprint,
     * - resource fee,
     * - generated authorization entries.
     *
     * The resulting transaction is ready for signing, but remains unsigned.
     */
    preparedTransaction = rpc.assembleTransaction(rawTransaction, simulation).build();
  } catch (error: unknown) {
    console.error(chalk.red(`  Transaction preparation failed: ${getErrorMessage(error)}`));

    return;
  }

  console.log(chalk.green('  Simulation results applied successfully.'));

  // -----------------------------------------------------------------------
  // Step 7: Inspect the prepared transaction
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 7: Inspecting the prepared transaction...'));

  let preparedSorobanData: xdr.SorobanTransactionData;

  try {
    preparedSorobanData = getPreparedSorobanData(preparedTransaction);
  } catch (error: unknown) {
    console.error(
      chalk.red(`  Could not inspect prepared Soroban data: ${getErrorMessage(error)}`),
    );

    return;
  }

  const preparedResources = extractResourceSummary(preparedSorobanData);

  const preparedAuthCount = getPreparedAuthorizationCount(preparedTransaction);

  console.log(chalk.cyan('\n  Prepared transaction summary'));

  console.log(`    Source account       : ${preparedTransaction.source}`);

  console.log(`    Sequence number      : ${preparedTransaction.sequence}`);

  console.log(`    Operation count      : ${preparedTransaction.operations.length}`);

  console.log(`    Total transaction fee: ${preparedTransaction.fee} stroops`);

  console.log(`    Soroban resource fee : ${preparedResources.resourceFee} stroops`);

  console.log(`    CPU instructions     : ${preparedResources.instructions.toLocaleString()}`);

  console.log(`    Disk read bytes      : ${preparedResources.diskReadBytes.toLocaleString()}`);

  console.log(`    Write bytes          : ${preparedResources.writeBytes.toLocaleString()}`);

  console.log(`    Read-only footprint  : ${preparedResources.readOnlyEntries}`);

  console.log(`    Read-write footprint : ${preparedResources.readWriteEntries}`);

  console.log(`    Authorization entries: ${preparedAuthCount}`);

  /*
   * This is an important verification step: compare the simulation resources
   * with the resources embedded in the actual transaction we are about to sign.
   */
  const resourcesMatch = resourceSummariesMatch(simulatedResources, preparedResources);

  console.log(
    `    Simulation data applied correctly: ${
      resourcesMatch ? chalk.green('YES') : chalk.red('NO')
    }`,
  );

  if (!resourcesMatch) {
    console.error(
      chalk.red('  Prepared transaction resources do not match the simulation result.'),
    );

    return;
  }

  // -----------------------------------------------------------------------
  // Step 8: Prepared XDR
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 8: Prepared transaction XDR...'));

  const preparedXdr = preparedTransaction.toEnvelope().toXDR('base64');

  console.log(chalk.cyan('\nPrepared transaction XDR:'));

  console.log(preparedXdr);

  console.log(chalk.gray(`\n  XDR length: ${preparedXdr.length.toLocaleString()} characters`));

  console.log(chalk.green('\n  The transaction is now prepared for signing.'));

  console.log(chalk.yellow('  This example intentionally does NOT sign or submit it.'));

  // -----------------------------------------------------------------------
  // Step 9: Explain lifecycle
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 9: Understanding the Soroban transaction lifecycle...'));

  console.log(chalk.cyan(`\n${explainTransactionLifecycle()}`));

  console.log(chalk.bold.green('\nSoroban transaction preparation demonstration complete.'));

  console.log(
    chalk.gray(
      'ISSUE-110 continues from this point with signing, submission, polling, and final confirmation.',
    ),
  );
}

/**
 * Compare simulation-derived resources against the resources embedded in the
 * prepared transaction.
 */
export function resourceSummariesMatch(
  simulated: ResourceSummary,
  prepared: ResourceSummary,
): boolean {
  return (
    simulated.instructions === prepared.instructions &&
    simulated.diskReadBytes === prepared.diskReadBytes &&
    simulated.writeBytes === prepared.writeBytes &&
    simulated.readOnlyEntries === prepared.readOnlyEntries &&
    simulated.readWriteEntries === prepared.readWriteEntries &&
    simulated.resourceFee === prepared.resourceFee
  );
}

/**
 * Render a ledger footprint key without assuming the internal structure of
 * every possible LedgerKey union variant.
 */
function describeLedgerKey(key: xdr.LedgerKey): string {
  try {
    return `${key.switch().name} | XDR=${key.toXDR('base64')}`;
  } catch {
    return '(unable to decode ledger key)';
  }
}

/**
 * Diagnostic events help explain simulation failure.
 */
function displayDiagnosticEvents(events: xdr.DiagnosticEvent[]): void {
  console.log(chalk.yellow(`\n  Diagnostic events (${events.length})`));

  if (events.length === 0) {
    console.log(chalk.gray('    No diagnostic events were returned.'));

    return;
  }

  events.forEach((diagnostic, index) => {
    try {
      const event = diagnostic.event();

      const status = diagnostic.inSuccessfulContractCall() ? 'success' : 'failure';

      console.log(`    [${index}] ${status} | ${event.type().name}`);

      const body = event.body().v0();

      console.log(`        Topics: ${body.topics().length}`);

      console.log(`        Data XDR: ${body.data().toXDR('base64')}`);
    } catch (error: unknown) {
      console.log(chalk.gray(`    [${index}] Could not decode event: ${getErrorMessage(error)}`));
    }
  });
}

/**
 * Safely extract an error message.
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error !== null && typeof error === 'object' && 'message' in error) {
    return String(
      (
        error as {
          message: unknown;
        }
      ).message,
    );
  }

  return String(error);
}
