import {
  Account,
  Contract,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from 'stellar-sdk-v16';
import chalk from 'chalk';

/**
 * ISSUE-110: Soroban Transaction Submission and Confirmation
 *
 * Demonstrates the complete Soroban transaction lifecycle:
 *
 *   build
 *     -> simulate
 *     -> prepare
 *     -> sign
 *     -> submit
 *     -> poll
 *     -> inspect terminal result
 *
 * Unlike ISSUE-109, this example submits a real transaction to Testnet.
 *
 * By default, a temporary account is created and funded through the network's
 * Friendbot service. A caller may instead provide SOURCE_SECRET to use an
 * existing Testnet account.
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

const DEFAULT_CONTRACT_ID = 'CDVSGPL3HFBGJ6ZEYQUAVE3OH3XE2ZE5ZT2GWPA3LKOYVD4UBPQJ2VHB';

const DEFAULT_FUNCTION_NAME = 'hello';

const DEFAULT_ARGUMENT = 'Soroban';

const DEFAULT_BASE_FEE = '100';

const DEFAULT_POLL_INTERVAL_MS = 1000;

const DEFAULT_POLL_TIMEOUT_MS = 30000;

export interface SorobanSubmissionParams {
  rpcUrl?: string;
  contractId?: string;
  functionName?: string;
  argument?: string;
  sourceSecret?: string;
  networkPassphrase?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
}

export type PollOutcome =
  | {
      kind: 'SUCCESS';
      attempts: number;
      response: rpc.Api.GetSuccessfulTransactionResponse;
    }
  | {
      kind: 'FAILED';
      attempts: number;
      response: rpc.Api.GetFailedTransactionResponse;
    }
  | {
      kind: 'UNAVAILABLE';
      attempts: number;
      response: rpc.Api.GetMissingTransactionResponse;
      reason: string;
    }
  | {
      kind: 'TIMEOUT';
      attempts: number;
      response: rpc.Api.GetMissingTransactionResponse | null;
    };

export interface ResourceLimits {
  instructions: number;
  diskReadBytes: number;
  writeBytes: number;
  readOnlyEntries: number;
  readWriteEntries: number;
  resourceFee: string;
}

/**
 * Extract Soroban resource limits embedded in a prepared transaction.
 *
 * These are the resource limits determined during simulation and committed
 * into the transaction before it is signed.
 */
export function extractPreparedResourceLimits(transaction: Transaction): ResourceLimits {
  const envelope = transaction.toEnvelope();

  const sorobanData = envelope.v1().tx().ext().value();

  if (!sorobanData) {
    throw new Error('Transaction does not contain Soroban transaction data.');
  }

  const resources = sorobanData.resources();

  const footprint = resources.footprint();

  return {
    instructions: resources.instructions(),

    diskReadBytes: resources.diskReadBytes(),

    writeBytes: resources.writeBytes(),

    readOnlyEntries: footprint.readOnly().length,

    readWriteEntries: footprint.readWrite().length,

    resourceFee: sorobanData.resourceFee().toBigInt().toString(),
  };
}

/**
 * Validate polling configuration.
 */
export function normalizePositiveInteger(
  value: number | string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

/**
 * Poll getTransaction manually so the example visibly demonstrates the state
 * transitions rather than hiding them behind rpc.Server.pollTransaction().
 */
export async function pollForTerminalResult(
  server: rpc.Server,
  hash: string,
  submissionLedger: number,
  options: PollOptions,
): Promise<PollOutcome> {
  const startedAt = Date.now();

  let attempts = 0;

  let latestMissing: rpc.Api.GetMissingTransactionResponse | null = null;

  for (;;) {
    attempts += 1;

    let response: rpc.Api.GetTransactionResponse;

    try {
      response = await server.getTransaction(hash);
    } catch (error: unknown) {
      throw new Error(`RPC error while checking transaction status: ${getErrorMessage(error)}`);
    }

    if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        kind: 'SUCCESS',
        attempts,
        response,
      };
    }

    if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
      return {
        kind: 'FAILED',
        attempts,
        response,
      };
    }

    latestMissing = response;

    /*
     * If the ledger at which we submitted the transaction is already older
     * than the RPC node's retention window and the transaction still cannot
     * be found, this RPC node can no longer provide a definitive record.
     */
    if (submissionLedger < response.oldestLedger) {
      return {
        kind: 'UNAVAILABLE',
        attempts,
        response,
        reason:
          `The submission ledger (${submissionLedger}) is older than ` +
          `this RPC node's oldest retained ledger (${response.oldestLedger}).`,
      };
    }

    console.log(
      chalk.yellow(`  Poll ${attempts}: transaction not yet found; treating as pending.`),
    );

    console.log(
      chalk.gray(`    RPC ledger range: ${response.oldestLedger} - ${response.latestLedger}`),
    );

    const elapsed = Date.now() - startedAt;

    if (elapsed >= options.timeoutMs) {
      return {
        kind: 'TIMEOUT',
        attempts,
        response: latestMissing,
      };
    }

    const remaining = options.timeoutMs - elapsed;

    await sleep(Math.min(options.intervalMs, remaining));
  }
}

/**
 * Run ISSUE-110.
 */
export async function run(params: SorobanSubmissionParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl?.trim() || process.env.SOROBAN_RPC_URL?.trim() || DEFAULT_RPC_URL;

  const contractId =
    params.contractId?.trim() || process.env.CONTRACT_ID?.trim() || DEFAULT_CONTRACT_ID;

  const functionName =
    params.functionName?.trim() || process.env.CONTRACT_METHOD?.trim() || DEFAULT_FUNCTION_NAME;

  const argument = params.argument ?? process.env.CONTRACT_ARGUMENT ?? DEFAULT_ARGUMENT;

  const suppliedSecret = params.sourceSecret?.trim() || process.env.SOURCE_SECRET?.trim();

  const networkPassphrase =
    params.networkPassphrase?.trim() || process.env.NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;

  const pollIntervalMs = normalizePositiveInteger(
    params.pollIntervalMs ?? process.env.POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
  );

  const pollTimeoutMs = normalizePositiveInteger(
    params.pollTimeoutMs ?? process.env.POLL_TIMEOUT_MS,
    DEFAULT_POLL_TIMEOUT_MS,
  );

  console.log(chalk.bold('\nSoroban Transaction Submission and Confirmation Example'));

  console.log(
    chalk.gray('Build, simulate, prepare, sign, submit, poll, and inspect a Soroban transaction.'),
  );

  console.log(chalk.yellow('\nConfiguration'));

  console.log(`  RPC endpoint      : ${rpcUrl}`);

  console.log(`  Contract ID       : ${contractId}`);

  console.log(`  Function          : ${functionName}`);

  console.log(`  Argument          : ${argument}`);

  console.log(`  Poll interval     : ${pollIntervalMs} ms`);

  console.log(`  Poll timeout      : ${pollTimeoutMs} ms`);

  console.log(
    `  Source account    : ${
      suppliedSecret ? 'provided through SOURCE_SECRET' : 'temporary Testnet account'
    }`,
  );

  const server = new rpc.Server(rpcUrl);

  // -----------------------------------------------------------------------
  // Step 1: Connect
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 1: Connecting to Soroban RPC...'));

  try {
    const network = await server.getNetwork();

    const latestLedger = await server.getLatestLedger();

    console.log(chalk.green(`  Connected. Latest ledger sequence: ${latestLedger.sequence}`));

    console.log(chalk.gray(`  Network protocol version: ${network.protocolVersion}`));

    if (network.passphrase !== networkPassphrase) {
      console.warn(
        chalk.yellow(
          '  Warning: configured network passphrase differs from the RPC network passphrase.',
        ),
      );
    }
  } catch (error: unknown) {
    console.error(chalk.red(`  Unable to connect to Soroban RPC: ${getErrorMessage(error)}`));

    return;
  }

  // -----------------------------------------------------------------------
  // Step 2: Obtain funded signing account
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 2: Preparing the signing account...'));

  let signer: Keypair;
  let sourceAccount: Account;

  try {
    if (suppliedSecret) {
      signer = Keypair.fromSecret(suppliedSecret);

      console.log(chalk.gray('  Using the account supplied through SOURCE_SECRET.'));

      sourceAccount = await server.getAccount(signer.publicKey());
    } else {
      signer = Keypair.random();

      console.log(`  Generated public key: ${signer.publicKey()}`);

      console.log(chalk.gray('  Funding temporary account through the RPC network Friendbot...'));

      await server.fundAddress(signer.publicKey());

      sourceAccount = await server.getAccount(signer.publicKey());

      console.log(chalk.green('  Temporary Testnet account funded successfully.'));
    }
  } catch (error: unknown) {
    console.error(chalk.red(`  Could not prepare the signing account: ${getErrorMessage(error)}`));

    console.log(
      chalk.gray(
        '  Friendbot is intended for Testnet/Futurenet. For another network, provide a funded SOURCE_SECRET.',
      ),
    );

    return;
  }

  console.log(`  Source public key : ${signer.publicKey()}`);

  console.log(`  Current sequence  : ${sourceAccount.sequenceNumber()}`);

  /*
   * Never print signer.secret(). Private signing material should not appear
   * in example output or application logs.
   */

  // -----------------------------------------------------------------------
  // Step 3: Build
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 3: Building the Soroban invocation...'));

  let rawTransaction: Transaction;

  try {
    const targetContract = new Contract(contractId);

    const invocation = targetContract.call(functionName, xdr.ScVal.scvString(argument));

    rawTransaction = new TransactionBuilder(sourceAccount, {
      fee: DEFAULT_BASE_FEE,
      networkPassphrase,
    })
      .addOperation(invocation)
      .setTimeout(60)
      .build();
  } catch (error: unknown) {
    console.error(chalk.red(`  Failed to build transaction: ${getErrorMessage(error)}`));

    return;
  }

  console.log(chalk.green('  Initial transaction built.'));

  console.log(`  Source     : ${rawTransaction.source}`);

  console.log(`  Sequence   : ${rawTransaction.sequence}`);

  console.log(`  Base fee   : ${rawTransaction.fee} stroops`);

  // -----------------------------------------------------------------------
  // Step 4: Simulate
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 4: Simulating the transaction...'));

  let simulation: rpc.Api.SimulateTransactionResponse;

  try {
    simulation = await server.simulateTransaction(rawTransaction);
  } catch (error: unknown) {
    console.error(chalk.red(`  Simulation RPC request failed: ${getErrorMessage(error)}`));

    return;
  }

  if (rpc.Api.isSimulationError(simulation)) {
    console.error(chalk.red('  Simulation result: FAILED'));

    console.error(chalk.red(`  ${simulation.error}`));

    displayDiagnosticEvents(simulation.events);

    return;
  }

  if (rpc.Api.isSimulationRestore(simulation)) {
    console.warn(
      chalk.yellow('  Simulation indicates archived ledger state requires restoration.'),
    );

    console.log(
      chalk.gray(
        '  This example stops rather than submitting a transaction whose required state is not ready.',
      ),
    );

    return;
  }

  if (!rpc.Api.isSimulationSuccess(simulation)) {
    console.error(chalk.red('  Simulation returned an unexpected response.'));

    return;
  }

  console.log(chalk.green('  Simulation result: SUCCESS'));

  console.log(`  Simulation ledger       : ${simulation.latestLedger}`);

  console.log(`  Minimum Soroban fee     : ${simulation.minResourceFee} stroops`);

  // -----------------------------------------------------------------------
  // Step 5: Prepare
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 5: Preparing the transaction from simulation results...'));

  let preparedTransaction: Transaction;

  try {
    preparedTransaction = rpc.assembleTransaction(rawTransaction, simulation).build();
  } catch (error: unknown) {
    console.error(chalk.red(`  Transaction preparation failed: ${getErrorMessage(error)}`));

    return;
  }

  console.log(chalk.green('  Transaction prepared successfully.'));

  let resourceLimits: ResourceLimits;

  try {
    resourceLimits = extractPreparedResourceLimits(preparedTransaction);

    console.log(chalk.cyan('\n  Prepared resource allocation'));

    console.log(`    CPU instructions : ${resourceLimits.instructions.toLocaleString()}`);

    console.log(`    Disk read bytes  : ${resourceLimits.diskReadBytes.toLocaleString()}`);

    console.log(`    Write bytes      : ${resourceLimits.writeBytes.toLocaleString()}`);

    console.log(`    Read-only entries: ${resourceLimits.readOnlyEntries}`);

    console.log(`    Read-write entries: ${resourceLimits.readWriteEntries}`);

    console.log(`    Soroban fee      : ${resourceLimits.resourceFee} stroops`);
  } catch (error: unknown) {
    console.error(chalk.red(`  Could not inspect prepared resources: ${getErrorMessage(error)}`));

    return;
  }

  // -----------------------------------------------------------------------
  // Step 6: Sign
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 6: Signing the prepared transaction...'));

  try {
    preparedTransaction.sign(signer);
  } catch (error: unknown) {
    console.error(chalk.red(`  Signing failed: ${getErrorMessage(error)}`));

    return;
  }

  console.log(chalk.green('  Prepared transaction signed successfully.'));

  /*
   * Signing occurs only AFTER simulation data has been applied.
   * Any change to the transaction after signing would invalidate the signature.
   */

  // -----------------------------------------------------------------------
  // Step 7: Submit
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 7: Submitting the signed transaction...'));

  let submission: rpc.Api.SendTransactionResponse;

  try {
    submission = await server.sendTransaction(preparedTransaction);
  } catch (error: unknown) {
    console.error(chalk.red(`  RPC submission request failed: ${getErrorMessage(error)}`));

    return;
  }

  console.log(`  Transaction hash  : ${submission.hash}`);

  console.log(`  Submission status : ${submission.status}`);

  console.log(`  RPC latest ledger : ${submission.latestLedger}`);

  if (submission.status === 'ERROR') {
    console.error(
      chalk.red('  The RPC node rejected the transaction before it entered the pending pool.'),
    );

    if (submission.errorResult) {
      console.log(`  Error result XDR : ${submission.errorResult.toXDR('base64')}`);

      console.log(`  Result code      : ${getTransactionResultCode(submission.errorResult)}`);
    }

    if (submission.diagnosticEvents && submission.diagnosticEvents.length > 0) {
      displayDiagnosticEvents(submission.diagnosticEvents);
    }

    return;
  }

  if (submission.status === 'TRY_AGAIN_LATER') {
    console.warn(chalk.yellow('  RPC returned TRY_AGAIN_LATER.'));

    console.log(
      chalk.gray(
        '  The transaction was not accepted for processing. Retry submission after the RPC node recovers.',
      ),
    );

    return;
  }

  if (submission.status === 'DUPLICATE') {
    console.log(
      chalk.yellow(
        '  This transaction was already known to the RPC node. Continuing to confirmation polling.',
      ),
    );
  }

  if (submission.status === 'PENDING') {
    console.log(chalk.green('  Transaction accepted and is pending network confirmation.'));
  }

  // -----------------------------------------------------------------------
  // Step 8: Poll
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 8: Polling transaction status...'));

  console.log(chalk.gray(`  Polling every ${pollIntervalMs} ms for up to ${pollTimeoutMs} ms.`));

  let outcome: PollOutcome;

  try {
    outcome = await pollForTerminalResult(server, submission.hash, submission.latestLedger, {
      intervalMs: pollIntervalMs,

      timeoutMs: pollTimeoutMs,
    });
  } catch (error: unknown) {
    console.error(chalk.red(`  Polling failed because of an RPC error: ${getErrorMessage(error)}`));

    return;
  }

  if (outcome.kind === 'TIMEOUT') {
    console.warn(chalk.yellow('\nPolling timeout reached.'));

    console.log(`  Transaction hash : ${submission.hash}`);

    console.log(`  Poll attempts    : ${outcome.attempts}`);

    console.log(
      chalk.gray(
        '  The transaction did not reach a terminal result within the configured timeout.',
      ),
    );

    console.log(
      chalk.gray('  It may still confirm later. Increase POLL_TIMEOUT_MS or query the hash again.'),
    );

    return;
  }

  if (outcome.kind === 'UNAVAILABLE') {
    console.warn(chalk.yellow('\nTransaction is unavailable from this RPC node.'));

    console.log(`  Transaction hash : ${submission.hash}`);

    console.log(`  Reason           : ${outcome.reason}`);

    console.log(
      chalk.gray(
        '  Query another archival data source or RPC service if historical confirmation is still required.',
      ),
    );

    return;
  }

  // -----------------------------------------------------------------------
  // Step 9: Terminal result
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 9: Interpreting the terminal transaction result...'));

  if (outcome.kind === 'FAILED') {
    const response = outcome.response;

    const resultCode = getTransactionResultCode(response.resultXdr);

    console.error(chalk.red('  Final status       : FAILED'));

    console.log(`  Transaction hash   : ${response.txHash}`);

    console.log(`  Ledger sequence    : ${response.ledger}`);

    console.log(`  Poll attempts      : ${outcome.attempts}`);

    console.log(`  Execution result   : ${resultCode}`);

    console.log(`  Fee charged        : ${getFeeCharged(response.resultXdr)} stroops`);

    if (isLikelyExpirationResult(resultCode)) {
      console.log(
        chalk.yellow('  Failure appears related to transaction validity/expiration bounds.'),
      );
    }

    displayFinalEvents(response.events);

    if (response.diagnosticEventsXdr && response.diagnosticEventsXdr.length > 0) {
      displayDiagnosticEvents(response.diagnosticEventsXdr);
    }

    console.log(
      chalk.gray('\n  ISSUE-111 demonstrates deeper diagnosis of failed Soroban transactions.'),
    );

    return;
  }

  const finalResponse = outcome.response;

  console.log(chalk.green('  Final status       : SUCCESS'));

  console.log(`  Transaction hash   : ${finalResponse.txHash}`);

  console.log(`  Ledger sequence    : ${finalResponse.ledger}`);

  console.log(`  Poll attempts      : ${outcome.attempts}`);

  console.log(`  Execution result   : ${getTransactionResultCode(finalResponse.resultXdr)}`);

  console.log(`  Fee charged        : ${getFeeCharged(finalResponse.resultXdr)} stroops`);

  // -----------------------------------------------------------------------
  // Step 10: Decode return value
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 10: Decoding the final return value...'));

  if (finalResponse.returnValue) {
    console.log(`  Return ScVal type : ${finalResponse.returnValue.switch().name}`);

    try {
      const decoded = scValToNative(finalResponse.returnValue);

      console.log(`  Return value      : ${formatNativeValue(decoded)}`);
    } catch (error: unknown) {
      console.log(chalk.yellow(`  Could not decode return value: ${getErrorMessage(error)}`));

      console.log(`  Return XDR        : ${finalResponse.returnValue.toXDR('base64')}`);
    }
  } else {
    console.log(chalk.gray('  No Soroban return value was present.'));
  }

  // -----------------------------------------------------------------------
  // Step 11: Resource usage / allocation
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 11: Resource usage and fees...'));

  console.log(
    chalk.gray(
      '  The prepared transaction contains the maximum resource allocation established by simulation.',
    ),
  );

  console.log(`  CPU instructions limit : ${resourceLimits.instructions.toLocaleString()}`);

  console.log(`  Disk read bytes limit  : ${resourceLimits.diskReadBytes.toLocaleString()}`);

  console.log(`  Write bytes limit      : ${resourceLimits.writeBytes.toLocaleString()}`);

  console.log(`  Read-only footprint    : ${resourceLimits.readOnlyEntries}`);

  console.log(`  Read-write footprint   : ${resourceLimits.readWriteEntries}`);

  console.log(`  Prepared resource fee  : ${resourceLimits.resourceFee} stroops`);

  console.log(`  Final total fee charged: ${getFeeCharged(finalResponse.resultXdr)} stroops`);

  // -----------------------------------------------------------------------
  // Step 12: Events
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 12: Displaying final transaction events...'));

  displayFinalEvents(finalResponse.events);

  if (finalResponse.diagnosticEventsXdr && finalResponse.diagnosticEventsXdr.length > 0) {
    displayDiagnosticEvents(finalResponse.diagnosticEventsXdr);
  }

  console.log(chalk.bold.green('\nSoroban transaction submission lifecycle complete.'));
}

/**
 * Return the top-level Stellar transaction result code.
 */
export function getTransactionResultCode(result: xdr.TransactionResult): string {
  try {
    return result.result().switch().name || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Return the fee actually charged by the network.
 */
export function getFeeCharged(result: xdr.TransactionResult): string {
  try {
    return result.feeCharged().toString();
  } catch {
    return 'unknown';
  }
}

/**
 * Identify result codes commonly related to a transaction that is no longer
 * valid for the ledger/time range in which it was submitted.
 */
export function isLikelyExpirationResult(resultCode: string): boolean {
  const normalized = resultCode.replace(/[_\-\s]/g, '').toLowerCase();

  return (
    normalized.includes('toolate') ||
    normalized.includes('tooearly') ||
    normalized.includes('badminseqage') ||
    normalized.includes('badminseqledgergap')
  );
}

/**
 * Display final transaction-level and contract-level events.
 */
function displayFinalEvents(events: rpc.Api.TransactionEvents): void {
  const transactionEvents = events.transactionEventsXdr ?? [];

  const contractEventGroups = events.contractEventsXdr ?? [];

  const contractEvents = contractEventGroups.flat();

  console.log(chalk.cyan(`\n  Transaction events (${transactionEvents.length})`));

  if (transactionEvents.length === 0) {
    console.log(chalk.gray('    (none)'));
  } else {
    transactionEvents.forEach((event, index) => {
      console.log(`    [${index}] XDR=${event.toXDR('base64')}`);
    });
  }

  console.log(chalk.cyan(`\n  Contract events (${contractEvents.length})`));

  if (contractEvents.length === 0) {
    console.log(chalk.gray('    (none)'));

    return;
  }

  contractEvents.forEach((event, index) => {
    try {
      const body = event.body().v0();

      console.log(`    [${index}] type=${event.type().name}`);

      const topics = body.topics();

      if (topics.length > 0) {
        console.log('        Topics:');

        topics.forEach((topic, topicIndex) => {
          console.log(`          [${topicIndex}] ${formatScVal(topic)}`);
        });
      }

      console.log(`        Data: ${formatScVal(body.data())}`);
    } catch (error: unknown) {
      console.log(`    [${index}] Could not decode event: ${getErrorMessage(error)}`);

      console.log(`        XDR: ${event.toXDR('base64')}`);
    }
  });
}

/**
 * Display Soroban diagnostic events returned by simulation/submission/final
 * transaction lookup.
 */
function displayDiagnosticEvents(events: xdr.DiagnosticEvent[]): void {
  console.log(chalk.cyan(`\n  Diagnostic events (${events.length})`));

  if (events.length === 0) {
    console.log(chalk.gray('    (none)'));

    return;
  }

  events.forEach((diagnostic, index) => {
    try {
      const event = diagnostic.event();

      const successful = diagnostic.inSuccessfulContractCall();

      console.log(
        `    [${index}] ${successful ? 'success' : 'failure'} | type=${event.type().name}`,
      );

      const body = event.body().v0();

      if (body.topics().length > 0) {
        console.log('        Topics:');

        body.topics().forEach((topic, topicIndex) => {
          console.log(`          [${topicIndex}] ${formatScVal(topic)}`);
        });
      }

      console.log(`        Data: ${formatScVal(body.data())}`);
    } catch (error: unknown) {
      console.log(`    [${index}] Could not decode diagnostic event: ${getErrorMessage(error)}`);
    }
  });
}

/**
 * Best-effort ScVal decoding.
 */
function formatScVal(value: xdr.ScVal): string {
  try {
    return formatNativeValue(scValToNative(value));
  } catch {
    return `${value.switch().name} (${value.toXDR('base64')})`;
  }
}

/**
 * Convert native values to JSON-safe data.
 */
function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString('hex')}`;
  }

  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }

  if (value instanceof Map) {
    return Array.from(value.entries()).map(([key, entry]) => [toJsonSafe(key), toJsonSafe(entry)]);
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = toJsonSafe(entry);
    }

    return result;
  }

  return value;
}

/**
 * Human-readable native-value formatting.
 */
function formatNativeValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  const safe = toJsonSafe(value);

  if (typeof safe === 'string') {
    return JSON.stringify(safe);
  }

  if (safe === null || typeof safe === 'number' || typeof safe === 'boolean') {
    return String(safe);
  }

  const result = JSON.stringify(safe, null, 2);

  return result ?? String(safe);
}

/**
 * Poll delay.
 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Safely render an unknown thrown value.
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
