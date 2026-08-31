import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
  contract,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from 'stellar-sdk-v16';
import chalk from 'chalk';

/**
 * ISSUE-116: Soroban Token Contract Interaction
 *
 * Soroban token contracts expose a standard interface for fungible assets.
 * This example demonstrates how applications can inspect token metadata,
 * balances and allowances, construct a transfer, and simulate that transfer
 * before any transaction is signed or submitted.
 *
 * The example intentionally performs simulation only. It never broadcasts a
 * transfer and therefore never moves real assets.
 *
 * It demonstrates:
 *
 * 1. Connecting to Soroban RPC.
 * 2. Accepting and validating a token contract ID.
 * 3. Inspecting available contract methods where runtime specification
 *    metadata is available.
 * 4. Reading token name, symbol and decimals.
 * 5. Reading an address balance.
 * 6. Reading an allowance where supported.
 * 7. Reading total_supply where supported.
 * 8. Building a token transfer with correctly encoded ScVal arguments.
 * 9. Simulating the transfer before submission.
 * 10. Decoding returned ScVal values.
 * 11. Recognising insufficient-balance failures.
 * 12. Explaining the relationship between Soroban token contracts and
 *     classic Stellar assets represented by the Stellar Asset Contract.
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
const BASE_FEE = '100';

const STANDARD_TOKEN_METHODS = [
  'name',
  'symbol',
  'decimals',
  'balance',
  'allowance',
  'approve',
  'transfer',
  'transfer_from',
  'burn',
  'burn_from',
];

export interface SorobanTokenContractParams {
  tokenContractId?: string;
  accountId?: string;
  spenderId?: string;
  recipientId?: string;
  transferAmount?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
}

export interface SimulationValueResult {
  ok: boolean;
  restoreRequired: boolean;
  rawValue?: xdr.ScVal;
  decodedValue?: unknown;
  error?: string;
}

export interface TokenMetadata {
  name?: string;
  symbol?: string;
  decimals?: number;
}

export interface TokenTransferSummary {
  from: string;
  to: string;
  amount: bigint;
  transaction: Transaction;
}

/**
 * Return a readable error message without assuming that caught values are
 * always Error objects.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Validate a Soroban contract address.
 */
export function isValidTokenContractId(contractId: string): boolean {
  return StrKey.isValidContract(contractId.trim());
}

/**
 * Token balance and authorization arguments may use either account addresses
 * or contract addresses.
 */
export function isValidSorobanAddress(address: string): boolean {
  const value = address.trim();

  return StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);
}

/**
 * Safely convert a decoded Soroban integer to bigint.
 */
export function toBigIntValue(value: unknown): bigint | null {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
    return BigInt(value);
  }

  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }

  return null;
}

/**
 * Render a raw token amount using its declared decimal precision.
 *
 * Example:
 *
 *   formatTokenAmount(12345678n, 7) -> "1.2345678"
 */
export function formatTokenAmount(amount: bigint, decimals: number): string {
  if (decimals <= 0) {
    return amount.toString();
  }

  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;

  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '');

  const rendered = fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();

  return negative ? `-${rendered}` : rendered;
}

/**
 * Decode an ScVal while retaining a predictable fallback for values the SDK
 * cannot convert to a native JavaScript representation.
 */
export function decodeScVal(value: xdr.ScVal): unknown {
  try {
    return scValToNative(value);
  } catch {
    return {
      type: value.switch().name,
      xdr: value.toXDR('base64'),
    };
  }
}

/**
 * Determine whether a simulation error appears to represent a balance-related
 * failure.
 *
 * Stellar Asset Contract failures may expose human-readable text, contract
 * error names, or numeric error information depending on the RPC version.
 */
export function isInsufficientBalanceError(message: string): boolean {
  const normalized = message.toLowerCase();

  return (
    normalized.includes('insufficient') ||
    normalized.includes('balanceerror') ||
    normalized.includes('balance error') ||
    normalized.includes('balance is not sufficient') ||
    normalized.includes('accountmissing') ||
    normalized.includes('account missing')
  );
}

/**
 * Build a single-operation Soroban contract invocation.
 *
 * The source account only needs an address and sequence for simulation. No
 * signing occurs in this example.
 */
export function buildContractInvocation(
  sourceAccountId: string,
  networkPassphrase: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Transaction {
  const sourceAccount = new Account(sourceAccountId, '0');
  const tokenContract = new Contract(contractId);

  return new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(tokenContract.call(method, ...args))
    .setTimeout(30)
    .build();
}

/**
 * Build the transfer invocation separately so it can be tested independently
 * from RPC communication.
 */
export function buildTokenTransfer(
  sourceAccountId: string,
  networkPassphrase: string,
  contractId: string,
  from: string,
  to: string,
  amount: bigint,
): TokenTransferSummary {
  if (amount < 0n) {
    throw new Error('Transfer amount cannot be negative.');
  }

  if (!isValidSorobanAddress(from)) {
    throw new Error(`Invalid transfer source address "${from}".`);
  }

  if (!isValidSorobanAddress(to)) {
    throw new Error(`Invalid transfer destination address "${to}".`);
  }

  const args = [
    Address.fromString(from).toScVal(),
    Address.fromString(to).toScVal(),
    nativeToScVal(amount, { type: 'i128' }),
  ];

  return {
    from,
    to,
    amount,
    transaction: buildContractInvocation(
      sourceAccountId,
      networkPassphrase,
      contractId,
      'transfer',
      args,
    ),
  };
}

/**
 * Simulate a token method and decode its return value.
 */
async function simulateMethod(
  server: rpc.Server,
  sourceAccountId: string,
  networkPassphrase: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<SimulationValueResult> {
  let simulation: rpc.Api.SimulateTransactionResponse;

  try {
    const transaction = buildContractInvocation(
      sourceAccountId,
      networkPassphrase,
      contractId,
      method,
      args,
    );

    simulation = await server.simulateTransaction(transaction);
  } catch (error: unknown) {
    return {
      ok: false,
      restoreRequired: false,
      error: `RPC request failed: ${getErrorMessage(error)}`,
    };
  }

  if (rpc.Api.isSimulationError(simulation)) {
    return {
      ok: false,
      restoreRequired: false,
      error: simulation.error,
    };
  }

  const restoreRequired = rpc.Api.isSimulationRestore(simulation);

  if (!simulation.result) {
    return {
      ok: true,
      restoreRequired,
    };
  }

  return {
    ok: true,
    restoreRequired,
    rawValue: simulation.result.retval,
    decodedValue: decodeScVal(simulation.result.retval),
  };
}

/**
 * Try to inspect the deployed WASM contract specification.
 *
 * Stellar Asset Contracts are native/built-in contracts rather than ordinary
 * user-deployed WASM contracts, so an RPC node may not expose WASM
 * specification metadata for them. In that case the example falls back to the
 * standard token interface and probes those methods directly.
 */
async function inspectTokenMethods(
  server: rpc.Server,
  rpcUrl: string,
  networkPassphrase: string,
  contractId: string,
): Promise<string[] | null> {
  try {
    const wasm = await server.getContractWasmByContractId(contractId);

    const client = await contract.Client.fromWasm(wasm, {
      contractId,
      networkPassphrase,
      rpcUrl,
    });

    const methods = client.spec
      .funcs()
      .map((fn) => fn.name().toString())
      .filter((name) => !name.startsWith('__'))
      .sort();

    return methods;
  } catch {
    return null;
  }
}

/**
 * Print a result returned by a token getter.
 */
function printGetterResult(label: string, result: SimulationValueResult): void {
  if (!result.ok) {
    console.log(chalk.yellow(`  ${label.padEnd(12)}: unavailable`));
    console.log(chalk.gray(`                  ${result.error ?? 'No value returned.'}`));
    return;
  }

  if (result.rawValue) {
    console.log(`  ${label.padEnd(12)}: ${formatNativeValue(result.decodedValue)}`);
    console.log(chalk.gray(`                  ScVal: ${result.rawValue.switch().name}`));
  } else {
    console.log(chalk.yellow(`  ${label.padEnd(12)}: no return value`));
  }

  if (result.restoreRequired) {
    console.log(
      chalk.yellow('                  Archived state must be restored before submission.'),
    );
  }
}

/**
 * Render common native values without losing bigint precision.
 */
export function formatNativeValue(value: unknown): string {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value === undefined) {
    return '(undefined)';
  }

  if (value === null) {
    return '(null)';
  }

  try {
    return JSON.stringify(
      value,
      (_key, nestedValue) =>
        typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue,
      2,
    );
  } catch {
    return String(value);
  }
}

/**
 * Display a compact subset of diagnostic events when simulation fails.
 */
function printDiagnosticEvents(events: xdr.DiagnosticEvent[]): void {
  if (events.length === 0) {
    console.log(chalk.gray('  No diagnostic events were returned by the RPC node.'));
    return;
  }

  console.log(chalk.gray(`  Diagnostic events returned: ${events.length}`));

  events.slice(0, 5).forEach((event, index) => {
    try {
      const contractEvent = event.event();
      const body = contractEvent.body().v0();
      const topics = body.topics().map((topic) => formatNativeValue(decodeScVal(topic)));

      console.log(chalk.gray(`    [${index + 1}] successful=${event.inSuccessfulContractCall()}`));

      if (topics.length > 0) {
        console.log(chalk.gray(`        topics: ${topics.join(', ')}`));
      }

      console.log(chalk.gray(`        data  : ${formatNativeValue(decodeScVal(body.data()))}`));
    } catch (error: unknown) {
      console.log(
        chalk.gray(
          `    [${index + 1}] Could not decode diagnostic event: ${getErrorMessage(error)}`,
        ),
      );
    }
  });

  if (events.length > 5) {
    console.log(chalk.gray(`    ... ${events.length - 5} additional event(s) omitted.`));
  }
}

/**
 * Run ISSUE-116.
 */
export async function run(params: SorobanTokenContractParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl?.trim() || process.env.SOROBAN_RPC_URL?.trim() || DEFAULT_RPC_URL;

  const networkPassphrase =
    params.networkPassphrase?.trim() || process.env.NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;

  /*
   * The native asset's Stellar Asset Contract ID is deterministic for a
   * network, making it a reliable default token contract.
   */
  const defaultTokenContractId = Asset.native().contractId(networkPassphrase);

  const contractId =
    params.tokenContractId?.trim() ||
    process.env.TOKEN_CONTRACT_ID?.trim() ||
    process.env.CONTRACT_ID?.trim() ||
    defaultTokenContractId;

  /*
   * No secret key is needed because this example only simulates. A random
   * account address therefore makes a safe default address for balance,
   * allowance and transfer demonstrations.
   */
  const generatedAccount = Keypair.random().publicKey();
  const generatedSpender = Keypair.random().publicKey();
  const generatedRecipient = Keypair.random().publicKey();

  const accountId =
    params.accountId?.trim() || process.env.TOKEN_ACCOUNT_ID?.trim() || generatedAccount;

  const spenderId =
    params.spenderId?.trim() || process.env.TOKEN_SPENDER_ID?.trim() || generatedSpender;

  const recipientId =
    params.recipientId?.trim() || process.env.TOKEN_RECIPIENT_ID?.trim() || generatedRecipient;

  const transferAmountInput =
    params.transferAmount?.trim() || process.env.TOKEN_TRANSFER_AMOUNT?.trim() || '1';

  console.log(chalk.bold('\nSoroban Token Contract Interaction Example'));

  console.log(
    chalk.gray(
      'Inspect token metadata and balances, then construct and simulate a token transfer without broadcasting it.',
    ),
  );

  console.log(chalk.yellow('\nConfiguration'));
  console.log(`  RPC endpoint      : ${rpcUrl}`);
  console.log(`  Network           : ${networkPassphrase}`);
  console.log(`  Token contract    : ${contractId}`);
  console.log(`  Balance address   : ${accountId}`);
  console.log(`  Allowance spender : ${spenderId}`);
  console.log(`  Transfer recipient: ${recipientId}`);
  console.log(`  Transfer amount   : ${transferAmountInput} base unit(s)`);

  // -----------------------------------------------------------------------
  // Step 1: Validate input
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 1: Validating input...'));

  if (!isValidTokenContractId(contractId)) {
    console.error(
      chalk.red(
        `  Invalid token contract ID "${contractId}". Expected a valid Stellar contract address beginning with "C".`,
      ),
    );

    return;
  }

  if (!isValidSorobanAddress(accountId)) {
    console.error(chalk.red(`  Invalid balance/source address "${accountId}".`));
    console.log(
      chalk.gray('  Expected a valid Stellar account (G...) or contract (C...) address.'),
    );
    return;
  }

  if (!isValidSorobanAddress(spenderId)) {
    console.error(chalk.red(`  Invalid spender address "${spenderId}".`));
    return;
  }

  if (!isValidSorobanAddress(recipientId)) {
    console.error(chalk.red(`  Invalid recipient address "${recipientId}".`));
    return;
  }

  let transferAmount: bigint;

  try {
    transferAmount = BigInt(transferAmountInput);

    if (transferAmount < 0n) {
      throw new Error('amount cannot be negative');
    }
  } catch {
    console.error(
      chalk.red(
        `  Invalid transfer amount "${transferAmountInput}". Use a non-negative integer in token base units.`,
      ),
    );

    return;
  }

  console.log(chalk.green('  Input validation passed.'));

  const server = new rpc.Server(rpcUrl);

  // -----------------------------------------------------------------------
  // Step 2: Connect to Soroban RPC
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 2: Connecting to Soroban RPC...'));

  try {
    const latestLedger = await server.getLatestLedger();

    console.log(chalk.green(`  Connected. Latest ledger sequence: ${latestLedger.sequence}`));
  } catch (error: unknown) {
    console.error(chalk.red(`  Unable to reach Soroban RPC: ${getErrorMessage(error)}`));
    console.log(chalk.gray('  Check SOROBAN_RPC_URL and your network connection.'));
    return;
  }

  // -----------------------------------------------------------------------
  // Step 3: Inspect available token methods
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 3: Inspecting token contract methods...'));

  const discoveredMethods = await inspectTokenMethods(
    server,
    rpcUrl,
    networkPassphrase,
    contractId,
  );

  if (discoveredMethods && discoveredMethods.length > 0) {
    console.log(
      chalk.green(`  Runtime specification exposes ${discoveredMethods.length} public method(s):`),
    );

    discoveredMethods.forEach((method) => {
      const standard = STANDARD_TOKEN_METHODS.includes(method) ? ' [token interface]' : '';
      console.log(`    - ${method}${standard}`);
    });
  } else {
    console.log(
      chalk.gray(
        '  Runtime WASM specification is unavailable. This is normal for native Stellar Asset Contracts.',
      ),
    );

    console.log(chalk.cyan('  Standard token methods that this example can probe:'));

    STANDARD_TOKEN_METHODS.forEach((method) => {
      console.log(`    - ${method}`);
    });
  }

  // -----------------------------------------------------------------------
  // Step 4: Read token metadata
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 4: Reading token metadata...'));

  /*
   * Read-only simulations do not need an existing funded transaction source.
   * If accountId itself is a G-address, use it as the simulated transaction
   * source. Otherwise use a throwaway G-address because TransactionBuilder
   * requires an account source rather than a contract address.
   */
  const simulationSource = StrKey.isValidEd25519PublicKey(accountId)
    ? accountId
    : Keypair.random().publicKey();

  const nameResult = await simulateMethod(
    server,
    simulationSource,
    networkPassphrase,
    contractId,
    'name',
  );

  const symbolResult = await simulateMethod(
    server,
    simulationSource,
    networkPassphrase,
    contractId,
    'symbol',
  );

  const decimalsResult = await simulateMethod(
    server,
    simulationSource,
    networkPassphrase,
    contractId,
    'decimals',
  );

  printGetterResult('Name', nameResult);
  printGetterResult('Symbol', symbolResult);
  printGetterResult('Decimals', decimalsResult);

  const metadata: TokenMetadata = {};

  if (nameResult.ok && typeof nameResult.decodedValue === 'string') {
    metadata.name = nameResult.decodedValue;
  }

  if (symbolResult.ok && typeof symbolResult.decodedValue === 'string') {
    metadata.symbol = symbolResult.decodedValue;
  }

  const decodedDecimals = toBigIntValue(decimalsResult.decodedValue);

  if (
    decodedDecimals !== null &&
    decodedDecimals >= 0n &&
    decodedDecimals <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    metadata.decimals = Number(decodedDecimals);
  }

  // -----------------------------------------------------------------------
  // Step 5: Read token balance
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 5: Reading account balance...'));

  const balanceResult = await simulateMethod(
    server,
    simulationSource,
    networkPassphrase,
    contractId,
    'balance',
    [Address.fromString(accountId).toScVal()],
  );

  let balance: bigint | null = null;

  if (!balanceResult.ok) {
    console.log(chalk.yellow('  Balance is unavailable.'));
    console.log(chalk.gray(`  ${balanceResult.error ?? 'No balance value returned.'}`));
  } else {
    balance = toBigIntValue(balanceResult.decodedValue);

    if (balance === null) {
      console.log(
        chalk.yellow(
          `  Balance returned an unexpected value: ${formatNativeValue(balanceResult.decodedValue)}`,
        ),
      );
    } else {
      console.log(`  Address       : ${accountId}`);
      console.log(`  Raw balance   : ${balance.toString()} base unit(s)`);

      if (metadata.decimals !== undefined) {
        console.log(
          `  Display amount: ${formatTokenAmount(balance, metadata.decimals)} ${
            metadata.symbol ?? ''
          }`.trimEnd(),
        );
      }
    }

    if (balanceResult.rawValue) {
      console.log(chalk.gray(`  Return ScVal  : ${balanceResult.rawValue.switch().name}`));
      console.log(chalk.gray(`  Return XDR    : ${balanceResult.rawValue.toXDR('base64')}`));
    }
  }

  // -----------------------------------------------------------------------
  // Step 6: Inspect allowance
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 6: Inspecting allowance...'));

  const allowanceResult = await simulateMethod(
    server,
    simulationSource,
    networkPassphrase,
    contractId,
    'allowance',
    [Address.fromString(accountId).toScVal(), Address.fromString(spenderId).toScVal()],
  );

  if (!allowanceResult.ok) {
    console.log(chalk.yellow('  Allowance could not be read.'));
    console.log(
      chalk.gray(
        `  ${allowanceResult.error ?? 'The contract may not implement the standard allowance method.'}`,
      ),
    );
  } else {
    const allowance = toBigIntValue(allowanceResult.decodedValue);

    console.log(`  Owner   : ${accountId}`);
    console.log(`  Spender : ${spenderId}`);

    if (allowance !== null) {
      console.log(`  Allowance: ${allowance.toString()} base unit(s)`);

      if (metadata.decimals !== undefined) {
        console.log(
          `  Display  : ${formatTokenAmount(allowance, metadata.decimals)} ${
            metadata.symbol ?? ''
          }`.trimEnd(),
        );
      }
    } else {
      console.log(`  Allowance: ${formatNativeValue(allowanceResult.decodedValue)}`);
    }
  }

  // -----------------------------------------------------------------------
  // Step 7: Probe total supply
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 7: Checking total supply where supported...'));

  /*
   * total_supply is useful but is not guaranteed by the common token
   * interface. We deliberately probe it instead of assuming it exists.
   */
  const totalSupplyResult = await simulateMethod(
    server,
    simulationSource,
    networkPassphrase,
    contractId,
    'total_supply',
  );

  if (!totalSupplyResult.ok) {
    console.log(
      chalk.gray(
        '  total_supply is not available on this contract, or the contract rejected the call.',
      ),
    );

    console.log(
      chalk.gray(
        '  This is expected for token implementations that expose only the standard token interface.',
      ),
    );
  } else {
    const totalSupply = toBigIntValue(totalSupplyResult.decodedValue);

    if (totalSupply !== null) {
      console.log(`  Raw total supply: ${totalSupply.toString()} base unit(s)`);

      if (metadata.decimals !== undefined) {
        console.log(
          `  Display amount   : ${formatTokenAmount(totalSupply, metadata.decimals)} ${
            metadata.symbol ?? ''
          }`.trimEnd(),
        );
      }
    } else {
      console.log(`  Total supply: ${formatNativeValue(totalSupplyResult.decodedValue)}`);
    }
  }

  // -----------------------------------------------------------------------
  // Step 8: Construct token transfer
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 8: Constructing token transfer...'));

  let transfer: TokenTransferSummary;

  try {
    transfer = buildTokenTransfer(
      simulationSource,
      networkPassphrase,
      contractId,
      accountId,
      recipientId,
      transferAmount,
    );
  } catch (error: unknown) {
    console.error(chalk.red(`  Could not construct transfer: ${getErrorMessage(error)}`));
    return;
  }

  console.log(chalk.green('  Transfer invocation constructed successfully.'));
  console.log(`  From       : ${transfer.from}`);
  console.log(`  To         : ${transfer.to}`);
  console.log(`  Raw amount : ${transfer.amount.toString()} base unit(s)`);

  if (metadata.decimals !== undefined) {
    console.log(
      `  Display    : ${formatTokenAmount(transfer.amount, metadata.decimals)} ${
        metadata.symbol ?? ''
      }`.trimEnd(),
    );
  }

  const transferOperation = transfer.transaction.operations[0];

  if (transferOperation?.type === 'invokeHostFunction') {
    console.log(chalk.gray(`  Operation  : ${transferOperation.type}`));
    console.log(
      chalk.gray(`  Auth entries before simulation: ${transferOperation.auth?.length ?? 0}`),
    );
  }

  // -----------------------------------------------------------------------
  // Step 9: Pre-check for insufficient balance
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 9: Checking balance before simulation...'));

  if (balance !== null && transferAmount > balance) {
    console.log(
      chalk.yellow(
        `  Requested amount ${transferAmount.toString()} exceeds the available balance ${balance.toString()}.`,
      ),
    );

    console.log(
      chalk.gray(
        '  An application can stop here before asking a wallet to sign. This example continues to simulation so the RPC diagnostic can also be inspected.',
      ),
    );
  } else if (balance !== null) {
    console.log(chalk.green('  The inspected balance is sufficient for the requested amount.'));
  } else {
    console.log(
      chalk.gray(
        '  Balance could not be determined, so the transfer will rely on simulation for validation.',
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Step 10: Simulate the transfer
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 10: Simulating token transfer...'));

  console.log(
    chalk.gray(
      '  Simulation executes the invocation without committing ledger changes or broadcasting the transaction.',
    ),
  );

  let transferSimulation: rpc.Api.SimulateTransactionResponse;

  try {
    transferSimulation = await server.simulateTransaction(transfer.transaction);
  } catch (error: unknown) {
    console.error(chalk.red(`  Simulation request failed: ${getErrorMessage(error)}`));
    console.log(
      chalk.gray('  Verify the RPC endpoint, network, token contract ID and supplied addresses.'),
    );
    return;
  }

  console.log(chalk.gray(`  Simulation ledger: ${transferSimulation.latestLedger}`));

  if (rpc.Api.isSimulationError(transferSimulation)) {
    console.log(chalk.yellow('  Transfer simulation: FAILED'));

    const message = transferSimulation.error;

    console.log(chalk.gray(`  RPC diagnostic: ${message}`));

    if ((balance !== null && transferAmount > balance) || isInsufficientBalanceError(message)) {
      console.log(
        chalk.yellow(
          '  Diagnosis: insufficient balance or an unavailable source balance prevented the transfer.',
        ),
      );

      console.log(
        chalk.gray(
          '  This is an expected application-level condition. Reduce the amount, fund the source address, or select another holder.',
        ),
      );
    } else {
      console.log(
        chalk.gray(
          '  The contract rejected the transfer for another reason. Check authorization, address validity, token state and diagnostic events.',
        ),
      );
    }

    printDiagnosticEvents(transferSimulation.events);
  } else {
    if (rpc.Api.isSimulationRestore(transferSimulation)) {
      console.log(chalk.yellow('  Transfer simulation: RESTORE REQUIRED'));

      console.log(
        chalk.gray(
          '  Archived ledger state must be restored before this transfer can be submitted.',
        ),
      );

      console.log(
        chalk.gray(
          `  Restore minimum resource fee: ${transferSimulation.restorePreamble.minResourceFee} stroops`,
        ),
      );
    } else {
      console.log(chalk.green('  Transfer simulation: SUCCESS'));
    }

    console.log(`  Estimated Soroban resource fee: ${transferSimulation.minResourceFee} stroops`);

    if (transferSimulation.result) {
      console.log(chalk.gray(`  Return ScVal: ${transferSimulation.result.retval.switch().name}`));

      console.log(
        chalk.gray(
          `  Decoded return value: ${formatNativeValue(
            decodeScVal(transferSimulation.result.retval),
          )}`,
        ),
      );
    }

    const authorizationEntries = transferSimulation.result?.auth ?? [];

    console.log(`  Authorization entries required: ${authorizationEntries.length}`);

    console.log(
      chalk.gray(
        '  A real application would now prepare/assemble the transaction from this simulation result, collect any required authorization, sign it, and only then submit it.',
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Step 11: Explain Stellar asset/token relationship
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 11: Stellar assets and Soroban token contracts'));

  console.log(
    chalk.cyan(
      [
        '  • Soroban token contracts expose fungible-token operations such as metadata, balances,',
        '    allowances and transfers.',
        '  • Classic Stellar assets can be used by smart contracts through their deterministic',
        '    Stellar Asset Contract (SAC).',
        '  • The SAC acts as the smart-contract representation of a classic Stellar asset, keeping',
        '    contract-side balances and operations consistent with the underlying Stellar asset.',
        '  • A user-deployed Soroban token contract can also implement the standard token interface',
        '    without representing a classic Stellar-issued asset.',
        '  • Optional methods must be detected rather than assumed; total_supply is an example.',
      ].join('\n'),
    ),
  );

  console.log(chalk.bold.green('\nSoroban token contract inspection complete.'));

  console.log(
    chalk.gray(
      'No transaction was signed or submitted. The transfer demonstration was simulation-only.',
    ),
  );
}
