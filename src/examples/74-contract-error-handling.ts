import {
  Keypair,
  rpc,
  Contract,
  xdr,
  nativeToScVal,
  Networks,
  TransactionBuilder,
  Account,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

// ─────────────────────────────────────────────────────────────────────────────
// Error taxonomy
// ─────────────────────────────────────────────────────────────────────────────
//
// When working with Soroban contracts, failures can occur at six distinct
// layers.  This example covers all of them:
//
//  A. Pre-flight (SDK-side)       — synchronous throws before any network call
//  B. Simulation failure          — rpc.Api.isSimulationError() / isSimulationRestore()
//  C. Transaction submission error— SendTransactionResponse.status === 'ERROR'
//  D. Transaction execution failure — GetTransactionStatus.FAILED + resultXdr
//  E. Contract application error  — scvError return value (ScErrorCode / ScErrorType)
//  F. Network / JSON-RPC error    — thrown exceptions from the transport layer
//
// Understanding which layer an error comes from determines the correct
// remediation.  The sections below demonstrate each category in isolation.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a minimal transaction that calls a Soroban contract method.
 * Uses a mock sequence number (1) because simulation does not consume sequences.
 */
function buildInvokeTx(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  sourcePublicKey: string,
  networkPassphrase: string = Networks.TESTNET,
): ReturnType<TransactionBuilder['build']> {
  const c = new Contract(contractId);
  const op = c.call(method, ...args);
  const account = new Account(sourcePublicKey, '1');
  return new TransactionBuilder(account, { fee: '1000', networkPassphrase })
    .addOperation(op)
    .setTimeout(30)
    .build();
}

/**
 * Decodes a ScError value into a human-readable string.
 *
 * Soroban contracts signal application-level errors by returning an scvError
 * ScVal.  The error is a union with two fields:
 *   - type  (ScErrorType)  — whether the error originated in the contract,
 *                            host, WASM, auth layer, etc.
 *   - code  (ScErrorCode)  — the specific error within that type.
 *
 * The most important case for application developers is ScErrorType.contract,
 * which carries the user-defined contract error code — an integer that maps to
 * a variant in the contract's #[contracterror] enum.
 */
function decodeScError(err: xdr.ScError): string {
  const typeName: string = err.switch().name; // e.g. 'sceContract', 'sceWasmVm'

  // Contract-defined errors carry a u32 code that maps to the contract's
  // own error enum.  The code is in err.contractCode() for ScErrorType.sceContract.
  if (typeName === 'sceContract') {
    const code: number = err.contractCode();
    return `Contract error  type=${typeName}  code=${code}`;
  }

  // All other error types (host, wasm, value, auth, context, etc.) carry an
  // ScErrorCode instead.  The code name is self-describing.
  const codeName: string = err.code().name; // e.g. 'scecArithDomain', 'scecInvalidInput'
  return `Host error  type=${typeName}  code=${codeName}`;
}

/**
 * Polls getTransaction until the transaction is no longer NOT_FOUND,
 * with a simple exponential back-off.  Returns the final response.
 *
 * Soroban transactions are first accepted into the mempool (PENDING) and then
 * included in a ledger (SUCCESS or FAILED) within a few seconds.  Polling
 * getTransaction is the recommended pattern for waiting on transaction finality.
 */
async function waitForTransaction(
  server: rpc.Server,
  hash: string,
  maxAttempts = 12,
  delayMs = 2000,
): Promise<rpc.Api.GetTransactionResponse> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await server.getTransaction(hash);
    if (resp.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return resp;
    }
    console.log(chalk.gray(`    Polling (${attempt}/${maxAttempts})…`));
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Transaction ${hash} not found after ${maxAttempts} attempts`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Category A — Pre-flight / SDK-side validation errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-flight errors are thrown synchronously by the SDK before any network
 * call is made.  They indicate a bug in the calling code — wrong types,
 * out-of-range values, or malformed addresses.
 *
 * Catching these early means faster feedback and no wasted RPC round-trips.
 * They are always instances of TypeError or RangeError and always include a
 * descriptive message.
 */
function demonstratePreflightErrors(): void {
  console.log(chalk.bold('\n━━━ Category A: Pre-flight / SDK Validation Errors ━━━'));
  console.log(
    chalk.gray(
      '  These are thrown synchronously — no network involved.\n' +
        '  Cause: passing the wrong JS type or an out-of-range value to nativeToScVal.\n',
    ),
  );

  // A-1: String passed where a number is required
  try {
    nativeToScVal('oops' as unknown as number, { type: 'u32' });
  } catch (err: any) {
    console.log(chalk.green(`  ✓ A-1 Wrong JS type  → ${err.constructor.name}: ${err.message}`));
  }

  // A-2: Integer beyond u32 maximum (4 294 967 295)
  try {
    nativeToScVal(5_000_000_000, { type: 'u32' });
  } catch (err: any) {
    console.log(chalk.green(`  ✓ A-2 Out-of-range u32 → ${err.constructor.name}: ${err.message}`));
  }

  // A-3: Invalid Stellar address
  try {
    nativeToScVal('GBADADDRESS', { type: 'address' });
  } catch (err: any) {
    console.log(
      chalk.green(`  ✓ A-3 Invalid address → ${err.constructor.name}: ${err.message.slice(0, 72)}`),
    );
  }

  // A-4: null for a non-optional field
  try {
    nativeToScVal(null as unknown as number, { type: 'u32' });
  } catch (err: any) {
    console.log(
      chalk.green(`  ✓ A-4 null for non-optional → ${err.constructor.name}: ${err.message}`),
    );
  }

  console.log(
    chalk.gray(
      '\n  Remedy: validate types and ranges in your application code before calling\n' +
        '  nativeToScVal(). These errors never surface as RPC errors.',
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Category B — Simulation failures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * simulateTransaction runs the contract in a sandboxed host environment
 * without committing any state.  It can fail for several reasons:
 *
 *  B-1. Contract not found — the contract ID is not deployed on this network
 *  B-2. Method not found  — the function name does not exist in the contract
 *  B-3. Wrong argument    — the argument type or count is wrong
 *  B-4. Restore needed    — a ledger entry the contract reads has expired
 *
 * All simulation failures set `SimulateTransactionResponse.error` (a string).
 * The SDK type-guard rpc.Api.isSimulationError() narrows to the error variant.
 * rpc.Api.isSimulationRestore() identifies the restore-needed sub-case.
 *
 * Diagnostic events inside the response often carry additional context such as
 * the contract backtrace or the specific host function that failed.
 */
async function demonstrateSimulationErrors(
  server: rpc.Server,
  callerPublicKey: string,
): Promise<void> {
  console.log(chalk.bold('\n━━━ Category B: Simulation Failures ━━━'));
  console.log(
    chalk.gray(
      '  simulateTransaction returns an error response — no exception thrown.\n' +
        '  Detect with: rpc.Api.isSimulationError(simResult)\n',
    ),
  );

  // ── B-1: Non-existent contract ────────────────────────────────────────────
  console.log(chalk.yellow('  B-1: Calling a contract that is not deployed…'));
  {
    // This is a valid-format contract ID but refers to nothing on Testnet.
    const ghostId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    const tx = buildInvokeTx(ghostId, 'hello', [xdr.ScVal.scvSymbol('World')], callerPublicKey);

    const sim = await server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(sim)) {
      // The error string typically contains "does not exist" or "HostError"
      const brief = sim.error.split('\n')[0].slice(0, 120);
      console.log(chalk.red(`    ✗ Simulation error: ${brief}`));
      console.log(chalk.gray(`    Diagnostic events: ${sim.events.length} event(s)`));
      console.log(chalk.cyan('    Remedy: verify the contract ID is deployed on this network.'));
    } else {
      console.log(chalk.gray('    (Simulation unexpectedly succeeded — contract may now exist)'));
    }
  }

  // ── B-2: Method not found ─────────────────────────────────────────────────
  console.log(chalk.yellow('\n  B-2: Calling a method that does not exist on the native SAC…'));
  {
    // The native SAC does not have a "nonexistent_method" function.
    const sacId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    const tx = buildInvokeTx(sacId, 'nonexistent_method', [], callerPublicKey);

    const sim = await server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(sim)) {
      const brief = sim.error.split('\n')[0].slice(0, 120);
      console.log(chalk.red(`    ✗ Simulation error: ${brief}`));
      console.log(chalk.cyan('    Remedy: check the method name against the contract ScSpec.'));
    } else {
      console.log(chalk.gray('    (Simulation unexpectedly succeeded)'));
    }
  }

  // ── B-3: Wrong argument type ──────────────────────────────────────────────
  console.log(chalk.yellow('\n  B-3: Passing a Symbol where balance() expects an Address…'));
  {
    const sacId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    // balance(id: Address) — but we pass scvSymbol("bad_arg") instead
    const tx = buildInvokeTx(sacId, 'balance', [xdr.ScVal.scvSymbol('bad_arg')], callerPublicKey);

    const sim = await server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(sim)) {
      const brief = sim.error.split('\n')[0].slice(0, 120);
      console.log(chalk.red(`    ✗ Simulation error: ${brief}`));
      console.log(
        chalk.cyan(
          '    Remedy: use nativeToScVal(addr, { type: "address" }) for Address arguments.',
        ),
      );
    } else {
      console.log(chalk.gray('    (Simulation unexpectedly succeeded)'));
    }
  }

  // ── B-4: isSimulationRestore (conceptual) ─────────────────────────────────
  // A SimulateTransactionRestoreResponse has both success fields AND a
  // restorePreamble.  It means the simulation ran successfully but requires
  // a preceding RestoreFootprint transaction before submission.
  console.log(
    chalk.gray(
      '\n  B-4 (conceptual): When rpc.Api.isSimulationRestore(sim) is true,\n' +
        '  a ledger entry the contract needs has expired.  You must submit a\n' +
        '  RestoreFootprint transaction first, then retry the original call.\n' +
        '  The sim.restorePreamble.transactionData field contains the footprint\n' +
        '  to restore.  Use rpc.assembleTransaction() with that data to build it.',
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Category C — Transaction submission errors (sendTransaction)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * sendTransaction submits a signed transaction envelope to the RPC node.
 * It returns synchronously with a status — it does NOT wait for ledger inclusion.
 *
 * Possible statuses:
 *   "PENDING"          — accepted into the mempool; poll getTransaction for finality
 *   "DUPLICATE"        — already seen; safe to poll the same hash
 *   "TRY_AGAIN_LATER"  — node is busy; retry after a short delay
 *   "ERROR"            — rejected outright; never call getTransaction for this hash
 *
 * The "ERROR" case sets response.errorResult (an xdr.TransactionResult) which
 * encodes the transaction-level result code that caused the rejection.
 * Common codes: txBAD_SEQ, txINSUFFICIENT_FEE, txNO_ACCOUNT, txBAD_AUTH.
 *
 * This category is distinct from Category D: submission errors happen before
 * the transaction reaches a ledger, while Category D failures happen during
 * ledger application after the transaction was accepted.
 */
async function demonstrateSubmissionError(server: rpc.Server, keypair: Keypair): Promise<void> {
  console.log(chalk.bold('\n━━━ Category C: Transaction Submission Error ━━━'));
  console.log(
    chalk.gray(
      '  sendTransaction returns status="ERROR" when the RPC node rejects the envelope.\n' +
        '  Detect with: response.status === "ERROR"\n',
    ),
  );

  // Build a transaction that is not simulation-assembled (no resource footprint).
  // Submitting a Soroban invoke without assembling it will fail with a bad auth
  // or resource error, giving us a clean "ERROR" status to demonstrate.
  const sacId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
  const idArg = nativeToScVal(keypair.publicKey(), { type: 'address' });
  const tx = buildInvokeTx(sacId, 'balance', [idArg], keypair.publicKey());

  // Intentionally skip simulation/assembly and sign with wrong fee/resources.
  // This will be rejected at the submission gate.
  tx.sign(keypair);

  console.log(
    chalk.yellow('  Submitting a transaction without assembling (no Soroban resource data)…'),
  );
  const sendResp = await server.sendTransaction(tx);

  if (sendResp.status === 'ERROR') {
    console.log(chalk.red(`  ✗ Submission status: ${sendResp.status}`));

    // errorResult is a parsed xdr.TransactionResult
    if (sendResp.errorResult) {
      const resultCode = sendResp.errorResult.result().switch().name;
      const feeCharged = sendResp.errorResult.feeCharged().toString();
      console.log(`    Transaction result code: ${chalk.yellow(resultCode)}`);
      console.log(`    Fee charged:             ${feeCharged} stroops`);
    }

    // diagnosticEvents may carry host-level detail on what went wrong
    if (sendResp.diagnosticEvents && sendResp.diagnosticEvents.length > 0) {
      console.log(`    Diagnostic events: ${sendResp.diagnosticEvents.length} event(s) attached`);
    }

    console.log(
      chalk.cyan(
        '    Remedy: always simulate first with server.simulateTransaction() and\n' +
          '    assemble with rpc.assembleTransaction() before signing and submitting.',
      ),
    );
  } else if (sendResp.status === 'PENDING' || sendResp.status === 'DUPLICATE') {
    // The node accepted it even without assembly — report and move on
    console.log(
      chalk.gray(
        `  Submission status: ${sendResp.status} (accepted; skipping submission error demo)`,
      ),
    );
  } else if (sendResp.status === 'TRY_AGAIN_LATER') {
    console.log(
      chalk.yellow('  Node is busy (TRY_AGAIN_LATER). Retry the send after a short delay.'),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Category D — Transaction execution failure (getTransaction FAILED)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Even when sendTransaction returns PENDING (accepted into the mempool), the
 * transaction may fail during ledger application.  This is visible by polling
 * getTransaction until status is SUCCESS or FAILED.
 *
 * A FAILED response contains:
 *   - resultXdr  (xdr.TransactionResult)  — the top-level transaction result
 *   - diagnosticEventsXdr                 — optional host diagnostic trace
 *
 * The resultXdr decodes to a TransactionResultCode (e.g. txFailed) and, for
 * txFailed, an array of per-operation InvokeHostFunctionResult codes.
 *
 * This example simulates the scenario correctly (full assembly + signing) and
 * then demonstrates the decoding path by inspecting the FAILED result structure
 * using a transaction that we know will fail due to authorization: calling
 * transfer() on the native SAC without the required signature authorisation.
 */
async function demonstrateExecutionFailure(server: rpc.Server, keypair: Keypair): Promise<void> {
  console.log(chalk.bold('\n━━━ Category D: Transaction Execution Failure ━━━'));
  console.log(
    chalk.gray(
      '  sendTransaction → PENDING, then getTransaction → FAILED.\n' +
        '  Detect with: resp.status === GetTransactionStatus.FAILED\n',
    ),
  );

  const sacId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
  const dest = Keypair.random().publicKey();

  // Transfer requires the "from" account to have authorised the invocation via
  // a SorobanAuthorizationEntry.  We intentionally omit that authorisation so
  // the on-chain execution fails with an auth error.
  const args = [
    nativeToScVal(keypair.publicKey(), { type: 'address' }), // from
    nativeToScVal(dest, { type: 'address' }), // to
    nativeToScVal(BigInt('1'), { type: 'i128' }), // amount
  ];

  let tx = buildInvokeTx(sacId, 'transfer', args, keypair.publicKey());

  console.log(chalk.yellow('  Simulating transfer() (auth will be missing)…'));
  const sim = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(sim)) {
    // Auth errors on transfers often surface at simulation time as well.
    const brief = sim.error.split('\n')[0].slice(0, 120);
    console.log(chalk.red(`  ✗ Simulation-level auth error (Category B/D overlap): ${brief}`));
    console.log(
      chalk.gray(
        '  This contract enforces authorisation at simulation time.\n' +
          '  The pattern below still applies when the error reaches execution.',
      ),
    );

    // Show how you would decode a FAILED getTransaction response.
    console.log(
      chalk.gray(
        '\n  Decoding a GetFailedTransactionResponse:\n' +
          '  ─────────────────────────────────────────\n' +
          '  const result = resp.resultXdr;  // xdr.TransactionResult\n' +
          '  const txCode = result.result().switch().name;  // e.g. "txFailed"\n' +
          '\n' +
          '  if (txCode === "txFailed") {\n' +
          '    const opResults = result.result().results() ?? [];\n' +
          '    opResults.forEach((op, i) => {\n' +
          '      // For InvokeHostFunction: op.tr().invokeHostFunctionResult()\n' +
          '      const opCode = op.switch().name;  // "opInner" when op ran\n' +
          '      console.log(`Op[${i}]: ${opCode}`);\n' +
          '    });\n' +
          '  }',
      ),
    );
    return;
  }

  // Assemble and sign (but we deliberately skip adding contract auth entries)
  tx = rpc.assembleTransaction(tx, sim).build();
  tx.sign(keypair);

  console.log(chalk.yellow('  Submitting transfer without auth entries…'));
  const sendResp = await server.sendTransaction(tx);

  if (sendResp.status === 'ERROR') {
    // Rejected at submission gate (also a valid outcome for missing auth)
    const code = sendResp.errorResult?.result().switch().name ?? 'unknown';
    console.log(chalk.red(`  ✗ Submission error: ${code}`));
    console.log(
      chalk.cyan('    Remedy: include SorobanAuthorizationEntry signed by the "from" account.'),
    );
    return;
  }

  if (sendResp.status !== 'PENDING') {
    console.log(chalk.yellow(`  Unexpected status: ${sendResp.status}`));
    return;
  }

  console.log(chalk.gray(`  Accepted (PENDING). Hash: ${sendResp.hash}`));
  console.log(chalk.yellow('  Polling for finality…'));

  let finalResp: rpc.Api.GetTransactionResponse;
  try {
    finalResp = await waitForTransaction(server, sendResp.hash);
  } catch (err: any) {
    console.log(chalk.yellow(`  ${err.message} — skipping execution failure decode.`));
    return;
  }

  if (finalResp.status === rpc.Api.GetTransactionStatus.FAILED) {
    console.log(chalk.red('  ✗ Transaction FAILED on-ledger.'));

    const result = finalResp.resultXdr;
    const txCode = result.result().switch().name;
    console.log(`    Transaction result code: ${chalk.yellow(txCode)}`);

    // For txFailed, traverse per-operation results.
    if (txCode === 'txFailed') {
      const opResults = result.result().results() ?? [];
      opResults.forEach((op, i) => {
        // op.switch().name is 'opInner' when the operation ran but failed,
        // or 'opBAD_AUTH', 'opNO_ACCOUNT', etc. for protocol-level rejections.
        const opSwitch = op.switch().name;
        console.log(`    Op[${i}] outer code: ${chalk.yellow(opSwitch)}`);

        if (opSwitch === 'opInner') {
          // Drill into the InvokeHostFunction result
          try {
            const innerResult = op.tr().invokeHostFunctionResult();
            const innerCode = innerResult.switch().name; // e.g. 'invokeHostFunctionTrapped'
            console.log(`    Op[${i}] inner code: ${chalk.yellow(innerCode)}`);
          } catch {
            // Other operation types have different inner result accessors
          }
        }
      });
    }

    // Diagnostic events may contain a Soroban host backtrace
    if (finalResp.diagnosticEventsXdr && finalResp.diagnosticEventsXdr.length > 0) {
      console.log(`    Diagnostic events: ${finalResp.diagnosticEventsXdr.length} event(s)`);
    }

    console.log(
      chalk.cyan('    Remedy: include the required SorobanAuthorizationEntry for transfer().'),
    );
  } else if (finalResp.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    console.log(chalk.green('  Transaction succeeded (auth was not required in this context).'));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Category E — Contract application error (scvError return value)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A contract can signal a domain error by returning or panicking with an
 * ScError value rather than crashing the host.  This produces a simulation
 * result that is technically "successful" at the RPC layer but contains an
 * scvError in the retval field.
 *
 * The most important sub-case is ScErrorType.sceContract, which carries the
 * numeric code of the contract's own #[contracterror] enum variant.  SDK
 * consumers map these codes to human-readable messages by consulting the
 * contract's ScSpec error enum entries.
 *
 * This section demonstrates:
 *  E-1. What an scvError return value looks like on the wire
 *  E-2. How to detect it in simulation and getTransaction responses
 *  E-3. How to decode the error type, code, and map to a message
 */
function demonstrateContractApplicationError(): void {
  console.log(chalk.bold('\n━━━ Category E: Contract Application Error (scvError) ━━━'));
  console.log(
    chalk.gray(
      '  A contract may return scvError to signal a domain-level failure.\n' +
        '  This is different from a simulation failure — the RPC call "succeeded"\n' +
        '  but the contract itself signals an error via its return value.\n',
    ),
  );

  // ── E-1: Construct example scvError values to show the wire format ─────────
  // ScError is a struct with two fields:
  //   - type: ScErrorType  (sceContract | sceWasmVm | sceHost | ...)
  //   - code: ScErrorCode  (scecArithDomain | scecInvalidInput | ...)
  //
  // For contract-defined errors, type = sceContract and contractCode() holds
  // the user-defined discriminant.

  // Simulate what a contract might return for "InvalidAmount" (code = 1)
  const contractErr = xdr.ScError.sceContract(1);
  const errScVal = xdr.ScVal.scvError(contractErr);

  console.log('  Simulated scvError return value:');
  console.log(`    ScVal type:   ${chalk.cyan(errScVal.switch().name)}`);
  console.log(`    ScError type: ${chalk.yellow(errScVal.error().switch().name)}`);
  console.log(`    Contract code: ${chalk.yellow(String(errScVal.error().contractCode()))}`);

  // ── E-2: Detection pattern in a simulation result ─────────────────────────
  console.log(
    chalk.gray(
      '\n  Detection pattern in simulation results:\n' +
        '  ──────────────────────────────────────────\n' +
        '  if (!rpc.Api.isSimulationError(sim) && sim.result?.retval) {\n' +
        '    const retval = sim.result.retval;\n' +
        '    if (retval.switch().value === xdr.ScValType.scvError().value) {\n' +
        '      const scErr = retval.error();\n' +
        '      console.log(decodeScError(scErr));\n' +
        '    }\n' +
        '  }',
    ),
  );

  // ── E-3: Decode and map codes to human-readable messages ──────────────────
  console.log('\n  Decoding contract error codes:');

  // A typical application-level error registry built from ScSpec error enums.
  // In a real app you'd populate this from contract.Spec.errorCases().
  const CONTRACT_ERRORS: Record<number, string> = {
    1: 'InvalidAmount — the amount provided is zero or negative',
    2: 'InsufficientBalance — caller balance is too low',
    3: 'NotAuthorized — caller does not hold the required role',
    4: 'AlreadyInitialized — contract state has already been set up',
    5: 'Overflow — arithmetic result exceeds u128 range',
  };

  [1, 2, 3, 5, 99].forEach((code) => {
    const fakeErr = xdr.ScError.sceContract(code);
    const decoded = decodeScError(fakeErr);
    const message = CONTRACT_ERRORS[code] ?? `Unknown contract error code ${code}`;
    console.log(`    code=${code}  decoded="${decoded}"`);
    console.log(chalk.gray(`           message: ${message}`));
  });

  // Host errors use an ScErrorCode name rather than a user-defined integer
  const hostErr = xdr.ScError.sceValue(xdr.ScErrorCode.scecArithDomain());
  console.log(`\n  Host value error: ${chalk.yellow(decodeScError(hostErr))}`);
  console.log(chalk.gray('  (Arithmetic domain errors occur e.g. on division by zero)'));

  console.log(
    chalk.cyan(
      '\n  Recommended pattern:\n' +
        '  1. Fetch the contract ScSpec (see example 72).\n' +
        '  2. Build a map from error code number → name/doc using spec.errorCases().\n' +
        '  3. After simulation or getTransaction, check retval.switch() === scvError,\n' +
        '     extract retval.error().contractCode(), and look up the message.',
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Category F — Network / JSON-RPC errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Network errors and JSON-RPC protocol errors are thrown as exceptions by the
 * SDK's underlying HTTP transport.  They are entirely separate from contract or
 * transaction failures.
 *
 * Common scenarios:
 *  F-1. The RPC node is unreachable (ECONNREFUSED / fetch failure)
 *  F-2. The node returns a JSON-RPC error object (non-2xx or error field)
 *  F-3. Timeout — the request takes longer than the configured limit
 *
 * These are always caught via try/catch around any awaited RPC call.  The
 * SDK does not provide a typed error class for them, so discriminating is done
 * by inspecting the thrown value's message or code property.
 */
async function demonstrateNetworkError(): Promise<void> {
  console.log(chalk.bold('\n━━━ Category F: Network / JSON-RPC Errors ━━━'));
  console.log(chalk.gray('  These are thrown exceptions — not SDK return values.\n'));

  // F-1: Unreachable endpoint
  console.log(chalk.yellow('  F-1: Connecting to an unreachable RPC endpoint…'));
  try {
    const deadServer = new rpc.Server('https://rpc.unreachable-host-example.invalid');
    await deadServer.getNetwork();
    console.log(chalk.red('  [UNEXPECTED] Request should have failed'));
  } catch (err: any) {
    // The error could be a fetch TypeError, ENOTFOUND, or similar depending on
    // the runtime and environment.
    const isNetworkErr =
      err?.message?.includes('fetch') ||
      err?.message?.includes('ECONNREFUSED') ||
      err?.message?.includes('ENOTFOUND') ||
      err?.message?.includes('network') ||
      err?.code === 'ENOTFOUND' ||
      err?.code === 'ECONNREFUSED';

    if (isNetworkErr) {
      console.log(
        chalk.green(
          `  ✓ F-1 Network error caught → ${err.constructor.name}: ${err.message.slice(0, 80)}`,
        ),
      );
    } else {
      // Some environments throw a different error type; still caught
      console.log(
        chalk.green(
          `  ✓ F-1 Error caught → ${err.constructor.name}: ${err.message?.slice(0, 80) ?? String(err)}`,
        ),
      );
    }
  }

  console.log(
    chalk.gray(
      '\n  Recommended handling pattern:\n' +
        '  try {\n' +
        '    const result = await server.simulateTransaction(tx);\n' +
        '    // … handle result\n' +
        '  } catch (err) {\n' +
        '    if (err?.message?.includes("fetch") || err?.code === "ECONNREFUSED") {\n' +
        '      // Network unreachable — retry with back-off\n' +
        '    } else if (err?.response?.status === 429) {\n' +
        '      // Rate limited — wait and retry\n' +
        '    } else {\n' +
        '      // Unknown — log and surface to the user\n' +
        '    }\n' +
        '  }',
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bonus: successful simulation for contrast
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shows a successful contract invocation for contrast with all error cases.
 * Calls balance() on the native SAC — the simplest read-only call that always
 * succeeds as long as the network is reachable.
 */
async function demonstrateSuccess(server: rpc.Server, callerPublicKey: string): Promise<void> {
  console.log(chalk.bold('\n━━━ Successful Invocation (for contrast) ━━━'));

  const sacId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
  const idArg = nativeToScVal(callerPublicKey, { type: 'address' });
  const tx = buildInvokeTx(sacId, 'balance', [idArg], callerPublicKey);

  const sim = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(sim)) {
    console.log(chalk.yellow(`  Simulation failed: ${sim.error.split('\n')[0].slice(0, 80)}`));
    return;
  }

  const retval = sim.result?.retval;
  const retvalType = retval?.switch().name ?? 'void';
  console.log(chalk.green(`  ✓ Simulation success — retval type: ${retvalType}`));
  console.log(
    chalk.gray(
      '  A SUCCESS path has:\n' +
        '    rpc.Api.isSimulationError(sim)   → false\n' +
        '    rpc.Api.isSimulationSuccess(sim) → true\n' +
        '    sim.result.retval.switch().name  → (not scvError)',
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the Soroban Contract Error Handling example.
 *
 * Covers the complete error taxonomy for Soroban contract interactions:
 *
 *  A. Pre-flight errors     — SDK throws synchronously (TypeError / RangeError)
 *  B. Simulation failures   — rpc.Api.isSimulationError() / isSimulationRestore()
 *  C. Submission errors     — SendTransactionResponse.status === "ERROR"
 *  D. Execution failures    — GetTransactionStatus.FAILED + resultXdr decoding
 *  E. Contract app errors   — scvError retval with ScErrorType + ScErrorCode
 *  F. Network errors        — thrown exceptions from the transport layer
 *
 * Sections A, E, and F are demonstrated offline or with minimal network usage.
 * Sections B, C, and D require a live Soroban RPC connection.
 *
 * Design rationale
 * ─────────────────
 * Categories A–F map to completely different remediation strategies:
 *   A → fix the calling code  (type/value mismatch)
 *   B → fix the invocation    (contract ID, method name, argument types)
 *       or restore expired entries (isSimulationRestore)
 *   C → fix the transaction envelope (assemble, sign, resource data)
 *   D → fix authorisation or application logic
 *   E → handle business-domain error (check balance, retry, surface to user)
 *   F → retry with back-off or surface connectivity issue to the user
 *
 * Mixing these up leads to confusing error messages and fragile retry logic.
 * The checks demonstrated here give a clear decision tree for each failure mode.
 */
export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  console.log(chalk.blue(`Soroban Contract Error Handling — RPC: ${rpcUrl}`));

  // ── Categories A and E are fully offline ──────────────────────────────────
  console.log(chalk.bold.yellow('\n═══ Offline Sections (no network required) ═══'));

  demonstratePreflightErrors();
  demonstrateContractApplicationError();

  // ── Categories B, C, D, F require a network connection ───────────────────
  console.log(chalk.bold.yellow('\n═══ Network Sections ═══'));

  // Category F is demonstrated first because it doesn't need a funded account
  await demonstrateNetworkError();

  // Fund a fresh keypair for the live sections
  console.log(chalk.yellow('\nFunding a fresh account via Friendbot for live tests…'));
  const keypair = Keypair.random();
  let funded = false;
  try {
    const fundRes = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`);
    funded = fundRes.ok;
    if (funded) {
      console.log(chalk.green(`Funded: ${keypair.publicKey()}`));
    } else {
      console.log(
        chalk.yellow(
          `Friendbot returned ${fundRes.status} — live tests will proceed with best-effort.`,
        ),
      );
    }
  } catch (err: any) {
    console.log(chalk.yellow(`Friendbot unreachable (${err.message?.slice(0, 60)}). Continuing…`));
  }

  const server = new rpc.Server(rpcUrl);

  // ── Category B: simulation errors ────────────────────────────────────────
  try {
    await demonstrateSimulationErrors(server, keypair.publicKey());
  } catch (err: any) {
    console.log(chalk.red(`\nCategory B aborted: ${err.message?.slice(0, 80) ?? String(err)}`));
    console.log(chalk.gray('Check SOROBAN_RPC_URL and network connectivity.'));
  }

  // ── Category C: submission error ─────────────────────────────────────────
  try {
    await demonstrateSubmissionError(server, keypair);
  } catch (err: any) {
    console.log(chalk.red(`\nCategory C aborted: ${err.message?.slice(0, 80) ?? String(err)}`));
  }

  // ── Category D: execution failure ────────────────────────────────────────
  if (funded) {
    try {
      await demonstrateExecutionFailure(server, keypair);
    } catch (err: any) {
      console.log(chalk.red(`\nCategory D aborted: ${err.message?.slice(0, 80) ?? String(err)}`));
    }
  } else {
    console.log(chalk.gray('\nCategory D skipped — account not funded.'));
  }

  // ── Successful invocation for contrast ───────────────────────────────────
  try {
    await demonstrateSuccess(server, keypair.publicKey());
  } catch (err: any) {
    console.log(chalk.yellow(`Success demo skipped: ${err.message?.slice(0, 60)}`));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(chalk.bold.green('\n━━━ Error Handling Decision Tree ━━━'));
  console.log(
    chalk.cyan(
      '  Before any network call:\n' +
        '    try { nativeToScVal(...) } catch (e) { /* Category A */ }\n' +
        '\n' +
        '  After simulateTransaction(tx):\n' +
        '    if (rpc.Api.isSimulationRestore(sim))  → Category B-4: restore first\n' +
        '    if (rpc.Api.isSimulationError(sim))    → Category B:   fix invocation\n' +
        '    if (sim.result.retval.switch() === scvError) → Category E: app error\n' +
        '\n' +
        '  After sendTransaction(tx):\n' +
        '    if (status === "ERROR")          → Category C: fix envelope\n' +
        '    if (status === "TRY_AGAIN_LATER")→ retry with back-off\n' +
        '    if (status === "PENDING")        → poll getTransaction(hash)\n' +
        '\n' +
        '  After getTransaction(hash):\n' +
        '    if (status === FAILED)           → Category D: decode resultXdr\n' +
        '    if (status === SUCCESS && retval.switch() === scvError) → Category E\n' +
        '\n' +
        '  Caught exception from any RPC call → Category F: network/transport',
    ),
  );
}
