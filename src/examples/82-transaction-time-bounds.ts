import {
  Account,
  Contract,
  Keypair,
  Networks,
  rpc,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Soroban Transaction Time Bounds Example
 *
 * Every Stellar transaction can carry a "time bounds" precondition — a pair of
 * Unix timestamps, `minTime` and `maxTime`, that define the wall-clock window
 * during which the transaction is considered valid. The network compares the
 * *ledger close time* (not the submitter's clock) against this window:
 *
 *   • If the ledger close time is before `minTime`  → rejected as `txTooEarly`.
 *   • If the ledger close time is after `maxTime`   → rejected as `txTooLate`.
 *   • `maxTime === 0` is a special case meaning "no upper bound" — the
 *     transaction never expires on time grounds. This is convenient for
 *     testing but dangerous in production (see best practices below).
 *
 * For Soroban contract invocations, time bounds are enforced by core BEFORE
 * the host runs the contract. An expired or not-yet-valid transaction never
 * reaches the contract's execution — the entire invocation is rejected at
 * the transaction-validation stage, regardless of how the contract itself
 * would have behaved.
 *
 * This example demonstrates:
 *   1. Connecting to Soroban RPC and confirming connectivity
 *   2. Funding an ephemeral fee-payer account
 *   3. Computing and validating a valid time-bounds window, then building,
 *      simulating, signing, and submitting a contract invocation within it
 *   4. Deliberately constructing an *already-expired* window (rather than
 *      waiting in real time) to demonstrate how an expired transaction is
 *      rejected, and translating the raw error into friendly guidance
 *   5. Demonstrating graceful handling of an invalid time-bounds configuration
 *   6. Explaining best practices for choosing time bounds for Soroban apps
 */

const BASE_FEE = '500000'; // 0.05 XLM — enough for most Soroban operations
const POLL_ATTEMPTS = 25;

// ─────────────────────────────────────────────────────────────────────────────
// Pure, network-free helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes a `{ minTime, maxTime }` time-bounds window relative to `nowSeconds`.
 *
 * `minOffsetSeconds` may be negative to build a window that already opened in
 * the past (used by the expired-transaction demonstration below).
 */
export function computeTimeBounds(
  nowSeconds: number,
  minOffsetSeconds: number,
  validitySeconds: number,
): { minTime: number; maxTime: number } {
  const minTime = nowSeconds + minOffsetSeconds;
  const maxTime = minTime + validitySeconds;
  return { minTime, maxTime };
}

/**
 * Validates a time-bounds configuration, throwing a descriptive `Error` for
 * anything that would be a nonsensical or misconfigured window: negative
 * timestamps, non-integer/NaN values, or a `maxTime` that does not come after
 * `minTime`. This is the "handle invalid time-bound configurations
 * gracefully" requirement — callers are expected to catch these errors and
 * report them clearly rather than let a cryptic network rejection surface.
 */
export function validateTimeBounds(minTime: number, maxTime: number): void {
  if (!Number.isInteger(minTime)) {
    throw new Error(
      `minTime must be an integer number of seconds since the Unix epoch; received ${minTime}`,
    );
  }
  if (!Number.isInteger(maxTime)) {
    throw new Error(
      `maxTime must be an integer number of seconds since the Unix epoch; received ${maxTime}`,
    );
  }
  if (minTime < 0) {
    throw new Error(`minTime must not be negative; received ${minTime}`);
  }
  if (maxTime < 0) {
    throw new Error(`maxTime must not be negative; received ${maxTime}`);
  }
  if (maxTime <= minTime) {
    throw new Error(`maxTime (${maxTime}) must be greater than minTime (${minTime})`);
  }
}

/**
 * Returns whether `nowSeconds` is past `maxTime`.
 *
 * Per Stellar convention, `maxTime === 0` means "no upper bound", so such a
 * window is never considered expired.
 */
export function isExpired(maxTime: number, nowSeconds: number): boolean {
  if (maxTime === 0) return false;
  return nowSeconds > maxTime;
}

/**
 * Returns whether `nowSeconds` is still before `minTime`.
 */
export function isNotYetValid(minTime: number, nowSeconds: number): boolean {
  return nowSeconds < minTime;
}

/**
 * Produces a short, human-readable description of a time-bounds window's
 * current status relative to `nowSeconds`.
 */
export function describeValidityWindow(
  minTime: number,
  maxTime: number,
  nowSeconds: number,
): string {
  if (isNotYetValid(minTime, nowSeconds)) {
    const opensIn = minTime - nowSeconds;
    return `Not yet valid — opens in ${opensIn}s`;
  }

  if (isExpired(maxTime, nowSeconds)) {
    const agoSeconds = nowSeconds - maxTime;
    return `Expired ${agoSeconds}s ago (maxTime was ${maxTime})`;
  }

  if (maxTime === 0) {
    return 'Valid now — no upper bound configured (window never closes)';
  }

  const closesIn = maxTime - nowSeconds;
  return `Valid now — window closes in ${closesIn}s`;
}

/**
 * Maps a raw simulation/submission error message to friendly guidance.
 *
 * Recognizes the classic time-bounds rejection codes (`txTooLate`,
 * `txTooEarly`) as well as common Soroban RPC timeout/expiry wording, and
 * falls back to sensible generic guidance for anything else. Never throws —
 * this function is meant to be called from a `catch` block.
 */
export function explainTimeBoundsFailure(errorMessage: string): {
  message: string;
  guidance: string;
} {
  const message = typeof errorMessage === 'string' ? errorMessage : String(errorMessage ?? '');
  const lower = message.toLowerCase();

  if (lower.includes('tx_too_late') || lower.includes('txtoolate')) {
    return {
      message,
      guidance:
        'The transaction was submitted after its maxTime — the ledger close time is past the configured ' +
        'upper bound, so the network rejected it before the contract could execute. Recompute a fresh ' +
        'time-bounds window with computeTimeBounds() and resubmit; never reuse an expired, already-signed ' +
        'transaction.',
    };
  }

  if (lower.includes('tx_too_early') || lower.includes('txtooearly')) {
    return {
      message,
      guidance:
        'The transaction was submitted before its minTime — the ledger close time has not yet reached the ' +
        'configured lower bound. Either wait until minTime is reached, or lower the minOffsetSeconds used ' +
        'when computing the window.',
    };
  }

  if (
    lower.includes('timeout') ||
    lower.includes('try_again_later') ||
    lower.includes('expired') ||
    lower.includes('not found')
  ) {
    return {
      message,
      guidance:
        'The Soroban RPC node did not return a definitive result before the poll gave up. This can happen ' +
        'when the network is busy or the transaction has not yet landed in a ledger. Poll again, or ' +
        'resubmit with a freshly computed time-bounds window in case the original one has since expired.',
    };
  }

  return {
    message,
    guidance:
      'Unrecognized error. Review the raw message above, verify the contract ID and method name, and ' +
      'confirm the time-bounds window is still valid before retrying.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal (network-touching) helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads the fee-payer account from RPC, falling back to a mock account with
 * sequence "0" if the account cannot be loaded (e.g. Friendbot funding
 * failed). The fallback still allows building and simulating a transaction so
 * the rest of the example can proceed and demonstrate its time-bounds logic.
 */
async function loadAccountOrFallback(server: rpc.Server, keypair: Keypair): Promise<Account> {
  try {
    return await server.getAccount(keypair.publicKey());
  } catch {
    return new Account(keypair.publicKey(), '0');
  }
}

/**
 * Extracts a readable message from a `sendTransaction` response whose status
 * is `ERROR`, preferring the decoded transaction result code when available.
 */
function describeSendError(sendResponse: rpc.Api.SendTransactionResponse): string {
  if (!sendResponse.errorResult) {
    return `sendTransaction returned status ${sendResponse.status}`;
  }
  try {
    const resultCode = sendResponse.errorResult.result().switch().name;
    return `sendTransaction rejected with ${resultCode}`;
  } catch {
    return `sendTransaction returned ERROR: ${sendResponse.errorResult.toXDR('base64')}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';

  // Default contract/method mirror the well-known "Hello World" contract used
  // by the other Soroban examples (68, 71) — override with your own via env.
  const contractId =
    process.env.CONTRACT_ID || 'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';
  const methodName = process.env.CONTRACT_METHOD || 'hello';

  console.log(chalk.bold('Soroban Transaction Time Bounds Example'));
  console.log(
    chalk.gray(
      'Construct, simulate, sign, and submit a Soroban contract invocation with custom time bounds.',
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
  // Step 2: Fund an ephemeral fee-payer account
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 2: Preparing fee-payer account...'));
  const keypair = Keypair.random();
  console.log(`Fee-payer public key: ${keypair.publicKey()}`);

  try {
    const fundRes = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`);
    if (!fundRes.ok) throw new Error(`Friendbot returned HTTP ${fundRes.status}`);
    console.log(chalk.green('Account funded via Friendbot.'));
  } catch (err: any) {
    console.warn(chalk.red('Friendbot funding failed:'), err.message);
    console.log(
      chalk.gray(
        '  Continuing — simulation and time-bounds logic will still run, but the final submission ' +
          'will fail without a funded fee-payer.',
      ),
    );
  }

  const contract = new Contract(contractId);
  console.log(`\nTarget contract : ${contractId}`);
  console.log(`Method          : ${methodName}`);

  const nowSeconds = Math.floor(Date.now() / 1000);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Build, simulate, sign, and submit within a VALID time-bounds window
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 3: Building a transaction with a valid time-bounds window...'));

  const validWindow = computeTimeBounds(nowSeconds, 0, 60);
  validateTimeBounds(validWindow.minTime, validWindow.maxTime);

  console.log(
    `  minTime : ${validWindow.minTime} (${new Date(validWindow.minTime * 1000).toISOString()})`,
  );
  console.log(
    `  maxTime : ${validWindow.maxTime} (${new Date(validWindow.maxTime * 1000).toISOString()})`,
  );
  console.log(`  ${describeValidityWindow(validWindow.minTime, validWindow.maxTime, nowSeconds)}`);

  const validAccount = await loadAccountOrFallback(server, keypair);

  const validTx = new TransactionBuilder(validAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(contract.call(methodName))
    .setTimeout(0)
    .setTimebounds(validWindow.minTime, validWindow.maxTime)
    .build();

  console.log(chalk.green('Transaction built with valid time bounds (pre-simulation).'));

  console.log(
    chalk.yellow('\nStep 4: Simulating, signing, and submitting within the valid window...'),
  );
  try {
    const simResult = await server.simulateTransaction(validTx);

    if (rpc.Api.isSimulationError(simResult)) {
      const { guidance } = explainTimeBoundsFailure(simResult.error);
      console.warn(chalk.red('Simulation returned an error.'));
      console.log(chalk.gray(`  Error: ${simResult.error}`));
      console.log(chalk.cyan(`  ${guidance}`));
    } else if (!rpc.Api.isSimulationSuccess(simResult)) {
      console.warn(chalk.red('Simulation returned an unexpected non-success status.'));
    } else {
      console.log(chalk.green('Simulation succeeded.'));
      console.log(`  Minimum resource fee : ${simResult.minResourceFee} stroops`);

      const assembledTx = rpc.assembleTransaction(validTx, simResult).build();
      assembledTx.sign(keypair);
      console.log(chalk.green('Transaction assembled with the simulated footprint and signed.'));

      const sendResponse = await server.sendTransaction(assembledTx);
      if (sendResponse.status === 'ERROR') {
        throw new Error(describeSendError(sendResponse));
      }
      console.log(chalk.green(`Transaction accepted. Hash: ${sendResponse.hash}`));

      const pollResponse = await server.pollTransaction(sendResponse.hash, {
        attempts: POLL_ATTEMPTS,
      });
      if (pollResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Transaction finished with status: ${pollResponse.status}`);
      }
      console.log(
        chalk.green('Transaction confirmed on-chain, within its configured validity window.'),
      );
    }
  } catch (err: any) {
    const rawMessage = err.message ?? String(err);
    const { guidance } = explainTimeBoundsFailure(rawMessage);
    console.warn(chalk.red('Valid-window submission did not complete successfully:'), rawMessage);
    console.log(chalk.cyan(`  ${guidance}`));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: Demonstrate an already-EXPIRED time-bounds window
  //
  // Rather than waiting for a real transaction to expire (which would make
  // this example slow and non-deterministic), we deliberately construct a
  // window that opened an hour ago and closed thirty minutes ago.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 5: Demonstrating an already-expired time-bounds window...'));

  const expiredWindow = computeTimeBounds(nowSeconds, -3600, 1800);
  // Structurally this is still a valid configuration (maxTime > minTime) —
  // it is simply in the past relative to "now".
  validateTimeBounds(expiredWindow.minTime, expiredWindow.maxTime);

  console.log(
    `  minTime : ${expiredWindow.minTime} (${new Date(expiredWindow.minTime * 1000).toISOString()})`,
  );
  console.log(
    `  maxTime : ${expiredWindow.maxTime} (${new Date(expiredWindow.maxTime * 1000).toISOString()})`,
  );
  console.log(
    `  ${describeValidityWindow(expiredWindow.minTime, expiredWindow.maxTime, nowSeconds)}`,
  );

  try {
    const expiredAccount = await loadAccountOrFallback(server, keypair);

    const expiredTx = new TransactionBuilder(expiredAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(contract.call(methodName))
      .setTimeout(0)
      .setTimebounds(expiredWindow.minTime, expiredWindow.maxTime)
      .build();

    expiredTx.sign(keypair);

    const sendResponse = await server.sendTransaction(expiredTx);
    if (sendResponse.status === 'ERROR') {
      throw new Error(describeSendError(sendResponse));
    }

    const pollResponse = await server.pollTransaction(sendResponse.hash, {
      attempts: POLL_ATTEMPTS,
    });
    if (pollResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`Transaction finished with status: ${pollResponse.status}`);
    }

    console.log(
      chalk.yellow(
        '  Unexpected: the expired transaction was reported successful. The network should have ' +
          'rejected it on time-bounds grounds.',
      ),
    );
  } catch (err: any) {
    const rawMessage = err.message ?? String(err);
    const { guidance } = explainTimeBoundsFailure(rawMessage);
    console.log(
      chalk.green('  Expired transaction was correctly rejected — no contract execution occurred.'),
    );
    console.log(chalk.gray(`  Raw error: ${rawMessage}`));
    console.log(chalk.cyan(`  ${guidance}`));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 6: Demonstrate graceful handling of an INVALID time-bounds configuration
  // ──────────────────────────────────────────────────────────────────────────
  console.log(
    chalk.yellow('\nStep 6: Demonstrating graceful handling of an invalid configuration...'),
  );

  const brokenMinTime = nowSeconds + 100;
  const brokenMaxTime = nowSeconds; // maxTime before minTime — intentionally invalid

  try {
    validateTimeBounds(brokenMinTime, brokenMaxTime);
    console.log(chalk.red('  Unexpected: the invalid configuration was not rejected.'));
  } catch (err: any) {
    console.log(chalk.green('  Invalid configuration correctly rejected before any network call.'));
    console.log(chalk.gray(`  ${err.message}`));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 7: Best practices and how time bounds affect Soroban execution
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 7: Best practices for choosing time bounds'));
  console.log(
    chalk.cyan(
      '  • Prefer short validity windows (seconds to a few minutes). A narrow window shrinks the\n' +
        '    replay-attack surface — a signed transaction that leaks cannot be resubmitted long after\n' +
        '    it was created.\n' +
        '  • Always set an explicit, finite maxTime in production. maxTime = 0 means "no expiry" and\n' +
        '    should be reserved for local testing, never for user-facing or high-value transactions.\n' +
        '  • Account for clock skew between your client and the network by giving minTime a small\n' +
        '    buffer (a few seconds) rather than setting it to exactly "now".\n' +
        '  • For Soroban contract invocations specifically, remember that time bounds are enforced\n' +
        '    by core BEFORE the host runs the contract: the ledger close time must fall within\n' +
        '    [minTime, maxTime] or the entire transaction — including the contract invocation — is\n' +
        "    rejected up front. A well-chosen window is therefore part of your contract's security\n" +
        '    model, not just an transport-layer detail.',
    ),
  );

  console.log(
    chalk.cyan(
      '\nSummary: Built and submitted a Soroban contract invocation within a valid time-bounds window, ' +
        'demonstrated the rejection of an already-expired window without a real-time wait, and showed ' +
        'graceful validation of a malformed time-bounds configuration.',
    ),
  );
}
