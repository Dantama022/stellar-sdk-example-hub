import { Address, Networks, TransactionBuilder, rpc, scValToNative, xdr } from 'stellar-sdk-v16';
import chalk from 'chalk';

/**
 * ISSUE-111: Soroban Transaction Error Diagnosis
 *
 * Demonstrates how to inspect a failed Soroban transaction and turn the raw
 * RPC/XDR information into a human-readable diagnostic report.
 *
 * The example:
 *
 *   1. Accepts a transaction hash.
 *   2. Retrieves the transaction from Soroban RPC.
 *   3. Confirms whether it failed, succeeded, or is unavailable.
 *   4. Decodes TransactionResult XDR.
 *   5. Identifies failed operations.
 *   6. Inspects the Soroban invocation from the submitted envelope.
 *   7. Inspects diagnostic events.
 *   8. Extracts available Soroban resource information.
 *   9. Classifies the failure.
 *  10. Provides actionable troubleshooting guidance.
 *
 * If no transaction hash is supplied, the example attempts to locate a recent
 * failed Soroban transaction from RPC transaction history so the example
 * remains runnable through the interactive runner.
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

const DEFAULT_LOOKBACK_LEDGERS = 100;

const DEFAULT_SEARCH_PAGE_SIZE = 200;

const DEFAULT_MAX_SEARCH_PAGES = 5;

export type ErrorCategory =
  | 'RPC error'
  | 'Transaction error'
  | 'Authorization error'
  | 'Resource/Fee error'
  | 'Contract execution error'
  | 'State/Archival error'
  | 'Unknown Soroban error';

export interface SorobanErrorDiagnosisParams {
  transactionHash?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
}

export interface OperationFailure {
  index: number;
  outerCode: string;
  innerType?: string;
  innerCode?: string;
  failed: boolean;
}

export interface InvocationDetails {
  operationIndex: number;
  hostFunctionType: string;
  contractId?: string;
  functionName?: string;
  argumentCount: number;
  arguments: string[];
  authorizationEntries: number;
}

export interface SorobanResourceInfo {
  instructions: number;
  diskReadBytes: number;
  writeBytes: number;
  resourceFee: string;
  readOnlyEntries: number;
  readWriteEntries: number;
}

export interface DiagnosticEntry {
  index: number;
  successful: boolean;
  eventType: string;
  topics: string[];
  data: string;
}

export interface ErrorClassification {
  category: ErrorCategory;
  evidence: string[];
  guidance: string[];
}

/**
 * Stellar transaction hashes are 32-byte values represented as
 * 64 hexadecimal characters.
 */
export function isValidTransactionHash(hash: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(hash.trim());
}

/**
 * Normalize Stellar/XDR result codes for classification.
 */
export function normalizeCode(code: string): string {
  return code
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

/**
 * Get the top-level Stellar transaction result code.
 */
export function getTransactionResultCode(result: xdr.TransactionResult): string {
  try {
    return result.result().switch().name || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Return the fee charged by the network.
 */
export function getFeeCharged(result: xdr.TransactionResult): string {
  try {
    return result.feeCharged().toString();
  } catch {
    return 'unknown';
  }
}

/**
 * Decode operation-level results from a failed transaction.
 */
export function extractOperationFailures(result: xdr.TransactionResult): OperationFailure[] {
  const output: OperationFailure[] = [];

  try {
    const transactionResult = result.result();

    if (transactionResult.switch().name !== 'txFailed') {
      return output;
    }

    const operationResults: xdr.OperationResult[] = transactionResult.results() ?? [];

    operationResults.forEach((operationResult, index) => {
      const outerCode = operationResult.switch().name;

      let innerType: string | undefined;

      let innerCode: string | undefined;

      let failed = !isSuccessCode(outerCode);

      if (outerCode === 'opInner') {
        try {
          const inner = operationResult.tr();

          innerType = inner.switch().name;

          if (innerType === 'invokeHostFunction') {
            const invokeResult = inner.invokeHostFunctionResult();

            innerCode = invokeResult.switch().name;

            failed = !isSuccessCode(innerCode);
          } else {
            failed = !isSuccessCode(innerType);
          }
        } catch {
          failed = true;
        }
      }

      output.push({
        index,
        outerCode,
        innerType,
        innerCode,
        failed,
      });
    });
  } catch {
    return output;
  }

  return output;
}

/**
 * Inspect the submitted transaction envelope and discover Soroban
 * InvokeHostFunction operations.
 */
export function extractInvocationDetails(
  envelope: xdr.TransactionEnvelope,
  networkPassphrase: string,
): InvocationDetails[] {
  const output: InvocationDetails[] = [];

  try {
    const parsed = TransactionBuilder.fromXDR(envelope.toXDR('base64'), networkPassphrase);

    parsed.operations.forEach((operation, operationIndex) => {
      if (operation.type !== 'invokeHostFunction') {
        return;
      }

      const hostFunction = operation.func;

      const hostFunctionType = hostFunction.switch().name;

      let contractId: string | undefined;

      let functionName: string | undefined;

      let argumentsList: string[] = [];

      if (hostFunctionType === 'hostFunctionTypeInvokeContract') {
        try {
          const invocation = hostFunction.invokeContract();

          contractId = Address.fromScAddress(invocation.contractAddress()).toString();

          functionName = invocation.functionName().toString();

          argumentsList = invocation.args().map(formatScVal);
        } catch {
          /*
           * Preserve the operation even if one of the
           * invocation fields cannot be decoded.
           */
        }
      }

      output.push({
        operationIndex,
        hostFunctionType,
        contractId,
        functionName,
        argumentCount: argumentsList.length,
        arguments: argumentsList,
        authorizationEntries: operation.auth?.length ?? 0,
      });
    });
  } catch {
    return output;
  }

  return output;
}

/**
 * Extract Soroban resource limits from the transaction envelope.
 */
export function extractSorobanResourceInfo(
  envelope: xdr.TransactionEnvelope,
): SorobanResourceInfo | null {
  try {
    /*
     * Normal and fee-bump transactions have different
     * XDR envelope layouts. We isolate the dynamic union
     * access here rather than spreading `any` throughout
     * the example.
     */
    const rawEnvelope: any = envelope;

    let transaction: any = null;

    const envelopeType = envelope.switch().name;

    if (envelopeType === 'envelopeTypeTx') {
      transaction = rawEnvelope.v1().tx();
    } else if (envelopeType === 'envelopeTypeTxFeeBump') {
      transaction = rawEnvelope.feeBump().tx().innerTx().v1().tx();
    }

    if (!transaction) {
      return null;
    }

    const extension = transaction.ext();

    const sorobanData = extension.value();

    if (!sorobanData || typeof sorobanData.resources !== 'function') {
      return null;
    }

    const resources = sorobanData.resources();

    const footprint = resources.footprint();

    return {
      instructions: resources.instructions(),

      diskReadBytes: resources.diskReadBytes(),

      writeBytes: resources.writeBytes(),

      resourceFee: sorobanData.resourceFee().toBigInt().toString(),

      readOnlyEntries: footprint.readOnly().length,

      readWriteEntries: footprint.readWrite().length,
    };
  } catch {
    return null;
  }
}

/**
 * Convert raw diagnostic events into a structured representation.
 */
export function parseDiagnosticEvents(events: xdr.DiagnosticEvent[]): DiagnosticEntry[] {
  return events.map((diagnostic, index) => {
    try {
      const event = diagnostic.event();

      const body = event.body().v0();

      return {
        index,

        successful: diagnostic.inSuccessfulContractCall(),

        eventType: event.type().name,

        topics: body.topics().map(formatScVal),

        data: formatScVal(body.data()),
      };
    } catch (error: unknown) {
      return {
        index,

        successful: false,

        eventType: 'undecodable',

        topics: [],

        data: `Could not decode event: ${getErrorMessage(error)}`,
      };
    }
  });
}

/**
 * Classify a failed Soroban transaction.
 *
 * More specific Soroban categories take priority over a
 * generic transaction-level failure.
 */
export function classifyFailure(
  transactionCode: string,
  operationFailures: OperationFailure[],
  diagnostics: DiagnosticEntry[],
  invocations: InvocationDetails[],
  resources: SorobanResourceInfo | null,
): ErrorClassification {
  const evidence: string[] = [];

  const searchableParts: string[] = [transactionCode];

  operationFailures.forEach((failure) => {
    searchableParts.push(failure.outerCode);

    if (failure.innerType) {
      searchableParts.push(failure.innerType);
    }

    if (failure.innerCode) {
      searchableParts.push(failure.innerCode);
    }
  });

  diagnostics
    .filter(
      (diagnostic) =>
        !diagnostic.topics.some((topic) => topic.toLowerCase().includes('core_metrics')),
    )
    .forEach((diagnostic) => {
      searchableParts.push(diagnostic.eventType, ...diagnostic.topics, diagnostic.data);
    });

  const searchable = searchableParts.join(' ').toLowerCase();

  const normalizedTxCode = normalizeCode(transactionCode);

  // ---------------------------------------------------------------------
  // State / archival failures
  // ---------------------------------------------------------------------

  if (
    containsAny(searchable, [
      'archiv',
      'restore',
      'expired ledger',
      'expired state',
      'storage expired',
      'entry expired',
      'live_until',
      'ttl',
      'footprint not found',
      'missing ledger entry',
    ])
  ) {
    evidence.push(
      'Diagnostic or result data contains archived-state, TTL, restoration, or state-lifetime indicators.',
    );

    return {
      category: 'State/Archival error',

      evidence,

      guidance: [
        'Restore archived persistent state before retrying the invocation.',
        'Re-simulate after restoration so the ledger footprint and resource limits are recalculated.',
        'Review contract storage TTL handling and whether required temporary state has expired.',
      ],
    };
  }

  // ---------------------------------------------------------------------
  // Authorization failures
  // ---------------------------------------------------------------------

  if (
    containsAny(searchable, [
      'auth',
      'unauthor',
      'not authorized',
      'invalid signature',
      'signature',
      'credentials',
      'sorobancredentials',
      'authentication',
    ]) ||
    normalizedTxCode === 'tx_bad_auth'
  ) {
    evidence.push(
      'The transaction result or diagnostic events contain authorization or signature indicators.',
    );

    const authCount = invocations.reduce(
      (total, invocation) => total + invocation.authorizationEntries,
      0,
    );

    evidence.push(`Submitted Soroban invocation authorization entries: ${authCount}.`);

    return {
      category: 'Authorization error',

      evidence,

      guidance: [
        'Re-simulate the invocation and inspect simulation.result.auth.',
        'Ensure required SorobanAuthorizationEntry values are attached before signing.',
        'Sign address-based authorization entries using the correct account or wallet.',
        'Verify the transaction source signature and account thresholds.',
        'Do not modify the prepared transaction after signatures have been applied.',
      ],
    };
  }

  // ---------------------------------------------------------------------
  // Resource / fee failures
  // ---------------------------------------------------------------------

  if (
    containsAny(searchable, [
      'resource',
      'budget',
      'cpu',
      'instruction',
      'memory',
      'disk read',
      'write bytes',
      'read bytes',
      'insufficient fee',
      'fee too',
      'exceeded limit',
      'limit exceeded',
      'outside of the footprint',
      'footprint',
      'scestorage',
      'scecexceededlimit',
    ]) ||
    normalizedTxCode === 'tx_insufficient_fee' ||
    normalizedTxCode === 'tx_soroban_invalid'
  ) {
    evidence.push('The result or diagnostic data contains Soroban resource or fee indicators.');

    if (resources) {
      evidence.push(
        `Prepared limits: ${resources.instructions} instructions, ` +
          `${resources.diskReadBytes} disk-read bytes, ` +
          `${resources.writeBytes} write bytes, ` +
          `${resources.resourceFee} stroops resource fee.`,
      );
    }

    return {
      category: 'Resource/Fee error',

      evidence,

      guidance: [
        'Simulate the transaction immediately before signing and submission.',
        'Apply the complete successful simulation response using rpc.assembleTransaction().',
        'If resource use varies, use suitable resource leeway instead of stale hard-coded limits.',
        'Check that the transaction fee covers inclusion and Soroban resource fees.',
        'Avoid reusing old simulation results after contract state changes.',
      ],
    };
  }

  // ---------------------------------------------------------------------
  // Contract execution failures
  // ---------------------------------------------------------------------

  if (
    containsAny(searchable, [
      'invokehostfunction',
      'contract',
      'wasm',
      'trapped',
      'hosterror',
      'scecontract',
      'scewasmvm',
      'invalidinput',
      'invalid input',
      'function',
      'panic',
    ])
  ) {
    evidence.push(
      'The failed operation or diagnostic events point to Soroban host or contract execution.',
    );

    const failedInvocation = findFailedInvocation(operationFailures, invocations);

    if (failedInvocation) {
      evidence.push(
        `Failed invocation: operation ${failedInvocation.operationIndex}, ` +
          `contract=${failedInvocation.contractId ?? 'unknown'}, ` +
          `function=${failedInvocation.functionName ?? 'unknown'}.`,
      );
    }

    return {
      category: 'Contract execution error',

      evidence,

      guidance: [
        'Inspect the contract specification and confirm the function and argument types.',
        'Review failed diagnostic events for a contract-defined error code or Soroban host error.',
        'If a contract error code is present, map it against the contract specification error enum.',
        'Reproduce the invocation with simulateTransaction() before submitting another transaction.',
        'Check contract state and function preconditions.',
      ],
    };
  }

  // ---------------------------------------------------------------------
  // Generic transaction failure
  // ---------------------------------------------------------------------

  if (normalizedTxCode !== 'tx_success') {
    evidence.push(`Transaction-level result code is ${transactionCode}.`);

    return {
      category: 'Transaction error',

      evidence,

      guidance: getTransactionGuidance(normalizedTxCode),
    };
  }

  return {
    category: 'Unknown Soroban error',

    evidence: ['Available result and diagnostic information did not match a known error category.'],

    guidance: [
      'Inspect the transaction result XDR and operation result codes.',
      'Inspect diagnostic events and the submitted Soroban invocation.',
      'Confirm that the RPC endpoint and network passphrase refer to the same Stellar network.',
      'Re-simulate the invocation using the latest ledger state.',
    ],
  };
}

/**
 * Locate the Soroban invocation corresponding to the first
 * failed operation.
 */
export function findFailedInvocation(
  failures: OperationFailure[],
  invocations: InvocationDetails[],
): InvocationDetails | null {
  const firstFailed = failures.find((failure) => failure.failed);

  if (!firstFailed) {
    return null;
  }

  return invocations.find((invocation) => invocation.operationIndex === firstFailed.index) ?? null;
}

/**
 * Search recent RPC history for a failed transaction that
 * contains a Soroban InvokeHostFunction operation.
 */
export async function findRecentFailedSorobanTransaction(
  server: rpc.Server,
  networkPassphrase: string,
): Promise<string | null> {
  const latest = await server.getLatestLedger();

  const startLedger = Math.max(1, latest.sequence - DEFAULT_LOOKBACK_LEDGERS);

  let request: rpc.Api.GetTransactionsRequest = {
    startLedger,

    pagination: {
      limit: DEFAULT_SEARCH_PAGE_SIZE,
    },
  };

  for (let pageNumber = 0; pageNumber < DEFAULT_MAX_SEARCH_PAGES; pageNumber += 1) {
    const page = await server.getTransactions(request);

    const reversed = [...page.transactions].reverse();

    for (const transaction of reversed) {
      if (transaction.status !== rpc.Api.GetTransactionStatus.FAILED) {
        continue;
      }

      const invocations = extractInvocationDetails(transaction.envelopeXdr, networkPassphrase);

      if (invocations.length > 0) {
        return transaction.txHash;
      }
    }

    if (!page.cursor) {
      break;
    }

    request = {
      pagination: {
        cursor: page.cursor,

        limit: DEFAULT_SEARCH_PAGE_SIZE,
      },
    };
  }

  return null;
}

/**
 * Run ISSUE-111.
 */
export async function run(params: SorobanErrorDiagnosisParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl?.trim() || process.env.SOROBAN_RPC_URL?.trim() || DEFAULT_RPC_URL;

  const networkPassphrase =
    params.networkPassphrase?.trim() || process.env.NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;

  /*
   * Explicit string | undefined is intentional.
   *
   * A hash can come from user input, an environment variable,
   * a positional argument, or the automatic failed-transaction
   * search below. That search may legitimately return null.
   */
  let transactionHash: string | undefined =
    params.transactionHash?.trim() ||
    process.env.TRANSACTION_HASH?.trim() ||
    process.argv[3]?.trim();

  console.log(chalk.bold('\nSoroban Transaction Error Diagnosis Example'));

  console.log(
    chalk.gray(
      'Retrieve a failed Soroban transaction and turn its RPC/XDR data into a readable diagnostic report.',
    ),
  );

  console.log(chalk.yellow('\nConfiguration'));

  console.log(`  RPC endpoint     : ${rpcUrl}`);

  console.log(`  Transaction hash : ${transactionHash || '(not supplied)'}`);

  const server = new rpc.Server(rpcUrl);

  // -----------------------------------------------------------------------
  // Step 1: Connect
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 1: Connecting to Soroban RPC...'));

  try {
    const latestLedger = await server.getLatestLedger();

    console.log(chalk.green(`  Connected. Latest ledger sequence: ${latestLedger.sequence}`));

    console.log(chalk.gray(`  Network protocol version: ${latestLedger.protocolVersion}`));
  } catch (error: unknown) {
    printRpcFailure(error, rpcUrl);

    return;
  }

  // -----------------------------------------------------------------------
  // Step 2: Resolve transaction hash
  // -----------------------------------------------------------------------

  if (!transactionHash) {
    console.log(chalk.yellow('\nStep 2: No transaction hash supplied.'));

    console.log(
      chalk.gray(
        `  Searching the last ${DEFAULT_LOOKBACK_LEDGERS} ledgers for a recent failed Soroban invocation...`,
      ),
    );

    try {
      const discoveredHash = await findRecentFailedSorobanTransaction(server, networkPassphrase);

      transactionHash = discoveredHash ?? undefined;
    } catch (error: unknown) {
      console.error(
        chalk.yellow(`  Could not search recent transaction history: ${getErrorMessage(error)}`),
      );
    }

    if (!transactionHash) {
      console.log(chalk.yellow('  No recent failed Soroban transaction was found automatically.'));

      console.log(
        chalk.gray(
          '  Supply a failed transaction hash through the interactive runner or TRANSACTION_HASH.',
        ),
      );

      console.log(
        chalk.gray(
          '  Example: TRANSACTION_HASH=<64-character-hash> npm run run-example 111-soroban-transaction-error-diagnosis',
        ),
      );

      return;
    }

    console.log(chalk.green(`  Found recent failed Soroban transaction: ${transactionHash}`));
  } else {
    console.log(chalk.yellow('\nStep 2: Validating the supplied transaction hash...'));

    if (!isValidTransactionHash(transactionHash)) {
      console.error(chalk.red('  Invalid transaction hash.'));

      console.log(chalk.gray('  Expected exactly 64 hexadecimal characters.'));

      return;
    }

    console.log(chalk.green('  Transaction hash format is valid.'));
  }

  // -----------------------------------------------------------------------
  // Step 3: Retrieve transaction result
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 3: Retrieving transaction result from Soroban RPC...'));

  let response: rpc.Api.GetTransactionResponse;

  try {
    response = await server.getTransaction(transactionHash);
  } catch (error: unknown) {
    printRpcFailure(error, rpcUrl);

    return;
  }

  console.log(`  Transaction hash : ${transactionHash}`);

  console.log(`  RPC status       : ${response.status}`);

  console.log(`  Latest RPC ledger: ${response.latestLedger}`);

  console.log(`  Oldest RPC ledger: ${response.oldestLedger}`);

  // -----------------------------------------------------------------------
  // NOT_FOUND / unavailable
  // -----------------------------------------------------------------------

  if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    console.log(chalk.yellow('\nDiagnostic report'));

    console.log(`  Failure status : ${chalk.yellow('NOT FOUND')}`);

    console.log(`  Error category : ${chalk.yellow('State/Archival error')}`);

    console.log(
      '  Error details  : The RPC node does not currently have a terminal transaction record for this hash.',
    );

    console.log(chalk.gray('\n  Possible reasons:'));

    console.log(chalk.gray('    - the transaction hash was never submitted on this network;'));

    console.log(chalk.gray('    - the transaction is still too recent to have a terminal result;'));

    console.log(
      chalk.gray("    - the transaction is older than this RPC node's retention window;"),
    );

    console.log(chalk.gray('    - the hash belongs to another Stellar network.'));

    console.log(chalk.gray('\n  Troubleshooting:'));

    console.log(chalk.gray('    - verify the transaction hash and network;'));

    console.log(
      chalk.gray(
        `    - this RPC currently retains ledgers ${response.oldestLedger} through ${response.latestLedger};`,
      ),
    );

    console.log(chalk.gray('    - use an archival RPC/data source for older transactions.'));

    return;
  }

  // -----------------------------------------------------------------------
  // Successful transaction supplied
  // -----------------------------------------------------------------------

  if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    console.log(chalk.yellow('\nDiagnostic report'));

    console.log(`  Failure status : ${chalk.green('SUCCESS')}`);

    console.log(`  Ledger sequence: ${response.ledger}`);

    console.log(`  Result code    : ${getTransactionResultCode(response.resultXdr)}`);

    console.log(
      chalk.gray('\n  This transaction did not fail, so there is no failure diagnosis to produce.'),
    );

    console.log(
      chalk.gray('  Supply the hash of a transaction whose getTransaction status is FAILED.'),
    );

    return;
  }

  /*
   * TypeScript now narrows response to
   * GetFailedTransactionResponse.
   */
  const failedResponse = response;

  // -----------------------------------------------------------------------
  // Step 4: Decode transaction result
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 4: Decoding failed transaction XDR...'));

  const transactionCode = getTransactionResultCode(failedResponse.resultXdr);

  const feeCharged = getFeeCharged(failedResponse.resultXdr);

  const operationFailures = extractOperationFailures(failedResponse.resultXdr);

  console.log(`  Failure status          : ${chalk.red('FAILED')}`);

  console.log(`  Ledger sequence         : ${failedResponse.ledger}`);

  console.log(`  Transaction result code : ${transactionCode}`);

  console.log(`  Fee charged             : ${feeCharged} stroops`);

  console.log(`  Fee-bump transaction    : ${failedResponse.feeBump ? 'yes' : 'no'}`);

  console.log(`  Operation results       : ${operationFailures.length}`);

  // -----------------------------------------------------------------------
  // Step 5: Inspect failed operations
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 5: Inspecting failed operations...'));

  if (operationFailures.length === 0) {
    console.log(chalk.gray('  No operation-level results were available.'));

    console.log(
      chalk.gray(
        '  The failure may have occurred during transaction-level validation before operation execution.',
      ),
    );
  } else {
    operationFailures.forEach((operation) => {
      const status = operation.failed ? chalk.red('FAILED') : chalk.green('SUCCESS');

      console.log(`  Operation [${operation.index}] ${status}`);

      console.log(`    Outer result  : ${operation.outerCode}`);

      if (operation.innerType) {
        console.log(`    Operation type: ${operation.innerType}`);
      }

      if (operation.innerCode) {
        console.log(`    Inner result  : ${operation.innerCode}`);
      }
    });
  }

  // -----------------------------------------------------------------------
  // Step 6: Inspect submitted Soroban invocation
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 6: Inspecting the submitted Soroban invocation...'));

  const invocations = extractInvocationDetails(failedResponse.envelopeXdr, networkPassphrase);

  if (invocations.length === 0) {
    console.log(
      chalk.gray('  No InvokeHostFunction operation could be decoded from the submitted envelope.'),
    );
  } else {
    invocations.forEach((invocation) => {
      console.log(`  Operation [${invocation.operationIndex}]`);

      console.log(`    Host function        : ${invocation.hostFunctionType}`);

      if (invocation.contractId) {
        console.log(`    Contract ID          : ${invocation.contractId}`);
      }

      if (invocation.functionName) {
        console.log(`    Contract function    : ${invocation.functionName}`);
      }

      console.log(`    Arguments            : ${invocation.argumentCount}`);

      invocation.arguments.forEach((argument, index) => {
        console.log(`      [${index}] ${argument}`);
      });

      console.log(`    Authorization entries: ${invocation.authorizationEntries}`);
    });
  }

  const failedInvocation = findFailedInvocation(operationFailures, invocations);

  if (failedInvocation) {
    console.log(chalk.red('\n  Failed invocation identified:'));

    console.log(`    Operation index : ${failedInvocation.operationIndex}`);

    console.log(`    Contract        : ${failedInvocation.contractId ?? 'unknown'}`);

    console.log(`    Function        : ${failedInvocation.functionName ?? 'unknown'}`);
  }

  // -----------------------------------------------------------------------
  // Step 7: Resource information
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 7: Inspecting relevant Soroban resource information...'));

  const resources = extractSorobanResourceInfo(failedResponse.envelopeXdr);

  if (!resources) {
    console.log(
      chalk.gray('  No SorobanTransactionData could be decoded from the submitted envelope.'),
    );
  } else {
    console.log(`  CPU instruction limit : ${resources.instructions.toLocaleString()}`);

    console.log(`  Disk read-byte limit  : ${resources.diskReadBytes.toLocaleString()}`);

    console.log(`  Write-byte limit      : ${resources.writeBytes.toLocaleString()}`);

    console.log(`  Resource fee          : ${resources.resourceFee} stroops`);

    console.log(`  Read-only footprint   : ${resources.readOnlyEntries}`);

    console.log(`  Read-write footprint  : ${resources.readWriteEntries}`);

    console.log(`  Final fee charged     : ${feeCharged} stroops`);
  }

  // -----------------------------------------------------------------------
  // Step 8: Diagnostic events
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 8: Parsing diagnostic events...'));

  const rawDiagnostics = failedResponse.diagnosticEventsXdr ?? [];

  const diagnostics = parseDiagnosticEvents(rawDiagnostics);

  console.log(`  Diagnostic events: ${diagnostics.length}`);

  if (diagnostics.length === 0) {
    console.log(chalk.gray('  No diagnostic information was returned by this RPC node.'));

    console.log(
      chalk.gray(
        '  Classification will rely on transaction XDR, operation results, envelope data, and resource information.',
      ),
    );
  } else {
    diagnostics.forEach((diagnostic) => {
      const status = diagnostic.successful ? chalk.green('success') : chalk.red('failure');

      console.log(`\n  [${diagnostic.index}] ${status} | type=${diagnostic.eventType}`);

      if (diagnostic.topics.length > 0) {
        console.log('    Topics:');

        diagnostic.topics.forEach((topic, topicIndex) => {
          console.log(`      [${topicIndex}] ${topic}`);
        });
      }

      console.log(`    Data: ${diagnostic.data}`);
    });
  }

  // -----------------------------------------------------------------------
  // Step 9: Classify failure
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 9: Classifying the failure...'));

  const classification = classifyFailure(
    transactionCode,
    operationFailures,
    diagnostics,
    invocations,
    resources,
  );

  console.log(`  Error category: ${chalk.red(classification.category)}`);

  console.log('\n  Evidence:');

  classification.evidence.forEach((item) => {
    console.log(`    - ${item}`);
  });

  // -----------------------------------------------------------------------
  // Step 10: Final readable diagnostic report
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 10: Diagnostic report...'));

  console.log(chalk.bold('\n========== SOROBAN FAILURE REPORT =========='));

  console.log(`Transaction hash : ${transactionHash}`);

  console.log('Failure status   : FAILED');

  console.log(`Ledger sequence  : ${failedResponse.ledger}`);

  console.log(`Error category   : ${classification.category}`);

  console.log(`Transaction code : ${transactionCode}`);

  console.log(`Fee charged      : ${feeCharged} stroops`);

  if (failedInvocation) {
    console.log(`Failed operation : ${failedInvocation.operationIndex}`);

    console.log(`Contract         : ${failedInvocation.contractId ?? 'unknown'}`);

    console.log(`Function         : ${failedInvocation.functionName ?? 'unknown'}`);
  } else {
    const firstFailure = operationFailures.find((operation) => operation.failed);

    console.log(`Failed operation : ${firstFailure ? firstFailure.index : 'not available'}`);
  }

  console.log(`Diagnostic events: ${diagnostics.length}`);

  console.log(`Result XDR       : ${failedResponse.resultXdr.toXDR('base64')}`);

  console.log('\nTroubleshooting guidance:');

  classification.guidance.forEach((guidance, index) => {
    console.log(`  ${index + 1}. ${guidance}`);
  });

  console.log(chalk.bold('============================================'));

  console.log(chalk.bold.green('\nSoroban transaction error diagnosis complete.'));
}

/**
 * Decide whether a Stellar result code is a success code.
 */
function isSuccessCode(code: string): boolean {
  const normalized = normalizeCode(code);

  return normalized.includes('success') || normalized === 'op_inner';
}

/**
 * Search a diagnostic corpus for any of the supplied patterns.
 */
function containsAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern.toLowerCase()));
}

/**
 * Transaction-level troubleshooting advice.
 */
function getTransactionGuidance(normalizedCode: string): string[] {
  switch (normalizedCode) {
    case 'tx_bad_seq':
      return [
        'Reload the source account immediately before building the transaction.',
        'Rebuild using the current account sequence number.',
        'Do not reuse a sequence number from an earlier submitted transaction.',
      ];

    case 'tx_bad_auth':
      return [
        'Verify the transaction signature and source-account signer thresholds.',
        'Confirm that every required signer signed the final prepared transaction.',
      ];

    case 'tx_insufficient_fee':
      return [
        'Fetch current network fee information and increase the inclusion fee.',
        'Re-simulate Soroban operations so the resource fee is current.',
      ];

    case 'tx_insufficient_balance':
      return ['Ensure the source account can cover the transaction fee and required reserves.'];

    case 'tx_too_early':
      return [
        'Inspect transaction time/ledger bounds and retry after the minimum bound is reached.',
      ];

    case 'tx_too_late':
      return ['Rebuild the transaction with fresh time bounds and re-simulate before signing.'];

    case 'tx_soroban_invalid':
      return [
        'Re-simulate the Soroban transaction and rebuild it from the latest simulation response.',
        'Check Soroban transaction data, resource limits, footprint, and authorization entries.',
      ];

    default:
      return [
        `Inspect the Stellar transaction result code (${normalizedCode}) and any operation-level results.`,
        'Confirm the source account sequence, signatures, fees, time bounds, and network.',
        'For Soroban operations, re-simulate and prepare a fresh transaction before retrying.',
      ];
  }
}

/**
 * Render a Soroban ScError with useful information.
 */
function formatScError(error: xdr.ScError): string {
  try {
    const type = error.switch().name;

    if (type === 'sceContract') {
      return `ContractError(type=${type}, ` + `code=${error.contractCode()})`;
    }

    return `ScError(type=${type}, ` + `code=${error.code().name})`;
  } catch {
    return 'ScError(undecodable)';
  }
}

/**
 * Best-effort ScVal rendering.
 */
function formatScVal(value: xdr.ScVal): string {
  try {
    if (value.switch().value === xdr.ScValType.scvError().value) {
      return formatScError(value.error());
    }

    return formatNativeValue(scValToNative(value));
  } catch {
    try {
      return `${value.switch().name} ` + `(XDR=${value.toXDR('base64')})`;
    } catch {
      return '(undecodable ScVal)';
    }
  }
}

/**
 * Convert SDK-native values to JSON-safe values.
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
    return Array.from(value.entries()).map(([key, item]) => [toJsonSafe(key), toJsonSafe(item)]);
  }

  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = toJsonSafe(item);
    }

    return output;
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

  const json = JSON.stringify(safe, null, 2);

  return json ?? String(safe);
}

/**
 * Display an RPC/network problem as an RPC error rather than
 * incorrectly treating it as a failed contract execution.
 */
function printRpcFailure(error: unknown, rpcUrl: string): void {
  console.error(chalk.red('\nRPC request failed.'));

  console.log(`  Error category : ${chalk.red('RPC error')}`);

  console.log(`  RPC endpoint   : ${rpcUrl}`);

  console.log(`  Error details  : ${getErrorMessage(error)}`);

  console.log(chalk.gray('\n  Troubleshooting:'));

  console.log(chalk.gray('    - verify the RPC URL and network connectivity;'));

  console.log(chalk.gray('    - confirm that the RPC service is healthy;'));

  console.log(chalk.gray('    - retry transient transport/JSON-RPC failures with backoff;'));

  console.log(
    chalk.gray('    - do not classify an RPC transport failure as a contract execution failure.'),
  );
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
