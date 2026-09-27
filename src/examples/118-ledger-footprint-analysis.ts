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
  rpc,
  scValToNative,
  xdr,
} from 'stellar-sdk-v16';
import chalk from 'chalk';

/**
 * ISSUE-118: Soroban Ledger Footprint Analysis
 *
 * Soroban transactions declare the ledger entries they need to read and write
 * through a ledger footprint.
 *
 * Simulation is normally used to discover that footprint before a transaction
 * is prepared, signed, and submitted.
 *
 * This example demonstrates how to:
 *
 * 1. Connect to Soroban RPC.
 * 2. Build two Soroban contract invocations.
 * 3. Simulate both invocations.
 * 4. Extract their ledger footprints.
 * 5. Separate read-only and read-write entries.
 * 6. Decode common ledger-key types.
 * 7. Identify contract-data durability.
 * 8. Identify contract-instance entries.
 * 9. Display raw XDR for detailed inspection.
 * 10. Compare the footprints from two invocations.
 * 11. Explain why footprints are required by Soroban.
 * 12. Handle empty footprints and simulation failures gracefully.
 *
 * The example performs simulation only. Nothing is signed or submitted.
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
const BASE_FEE = '100';
const DEFAULT_METHOD_A = 'decimals';
const DEFAULT_METHOD_B = 'name';

export interface LedgerFootprintParams {
  rpcUrl?: string;
  networkPassphrase?: string;
  contractId?: string;
  methodA?: string;
  methodB?: string;
  balanceAddress?: string;
}

export type FootprintAccess = 'read-only' | 'read-write';

export type ContractStorageType =
  | 'persistent'
  | 'temporary'
  | 'instance'
  | 'contract-code'
  | 'not-contract-storage';

export interface FootprintEntryInfo {
  access: FootprintAccess;
  ledgerType: string;
  description: string;
  rawXdr: string;
  isContractEntry: boolean;
  storageType: ContractStorageType;
}

export interface FootprintSummary {
  readOnlyCount: number;
  readWriteCount: number;
  totalCount: number;
  contractEntryCount: number;
  persistentEntryCount: number;
  temporaryEntryCount: number;
  instanceEntryCount: number;
  contractCodeCount: number;
  entries: FootprintEntryInfo[];
}

export interface FootprintComparison {
  firstTotal: number;
  secondTotal: number;
  totalDelta: number;
  firstReadOnly: number;
  secondReadOnly: number;
  readOnlyDelta: number;
  firstReadWrite: number;
  secondReadWrite: number;
  readWriteDelta: number;
  commonEntries: number;
  onlyInFirst: number;
  onlyInSecond: number;
}

export interface SimulatedFootprint {
  label: string;
  method: string;
  success: boolean;
  restoreRequired: boolean;
  error?: string;
  latestLedger?: number;
  summary?: FootprintSummary;
}

/**
 * Return a readable error message without assuming that the thrown value is an
 * Error instance.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Decode an ScVal for display while preserving a raw fallback for unusual
 * values.
 */
export function formatScVal(value: xdr.ScVal): string {
  if (value.switch() === xdr.ScValType.scvLedgerKeyContractInstance()) {
    return '<contract instance>';
  }

  if (value.switch() === xdr.ScValType.scvLedgerKeyNonce()) {
    try {
      return `<nonce ${value.nonceKey().nonce().toString()}>`;
    } catch {
      return '<nonce>';
    }
  }

  try {
    const native = scValToNative(value);

    if (typeof native === 'bigint') {
      return native.toString();
    }

    if (native instanceof Uint8Array) {
      return `0x${Buffer.from(native).toString('hex')}`;
    }

    if (native === undefined) {
      return '(undefined)';
    }

    if (native === null) {
      return '(null)';
    }

    if (typeof native === 'object') {
      return JSON.stringify(native, bigintReplacer);
    }

    return String(native);
  } catch {
    return `${value.switch().name}(raw-xdr=${value.toXDR('base64')})`;
  }
}

/**
 * JSON.stringify cannot serialize bigint directly.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString('hex')}`;
  }

  return value;
}

/**
 * Convert a contract ScAddress into its normal C... form when possible.
 */
export function describeScAddress(address: xdr.ScAddress): string {
  try {
    return String(scValToNative(xdr.ScVal.scvAddress(address)));
  } catch {
    return `(undecodable ${address.switch().name})`;
  }
}

/**
 * Determine the Soroban storage category represented by a ledger key.
 *
 * Contract instance entries are contract-data entries with persistent
 * durability and the special ledger-key-contract-instance ScVal. They are
 * reported separately because they have a distinct role even though their
 * durability is persistent.
 */
export function identifyStorageType(key: xdr.LedgerKey): ContractStorageType {
  try {
    if (key.switch() === xdr.LedgerEntryType.contractCode()) {
      return 'contract-code';
    }

    if (key.switch() !== xdr.LedgerEntryType.contractData()) {
      return 'not-contract-storage';
    }

    const contractData = key.contractData();

    if (contractData.key().switch() === xdr.ScValType.scvLedgerKeyContractInstance()) {
      return 'instance';
    }

    const durability = contractData.durability().name.toLowerCase();

    if (durability.includes('temporary')) {
      return 'temporary';
    }

    return 'persistent';
  } catch {
    return 'not-contract-storage';
  }
}

/**
 * Decode a ledger key into readable information.
 *
 * Complex/uncommon keys still retain their raw XDR, so the example never loses
 * the exact ledger-key representation returned by simulation.
 */
export function describeLedgerKey(key: xdr.LedgerKey): string {
  try {
    switch (key.switch()) {
      case xdr.LedgerEntryType.contractData(): {
        const data = key.contractData();

        const contractId = describeScAddress(data.contract());

        const storageType = identifyStorageType(key);

        const durability = data.durability().name;

        return [
          'contractData',
          `contract=${contractId}`,
          `storage=${storageType}`,
          `durability=${durability}`,
          `key=${formatScVal(data.key())}`,
        ].join('  ');
      }

      case xdr.LedgerEntryType.contractCode(): {
        const hash = key.contractCode().hash().toString('hex');

        return `contractCode  wasmHash=${hash}`;
      }

      case xdr.LedgerEntryType.account(): {
        try {
          const publicKey = StrKey.encodeEd25519PublicKey(key.account().accountId().ed25519());

          return `account  address=${publicKey}`;
        } catch {
          return 'account';
        }
      }

      case xdr.LedgerEntryType.trustline():
        return 'trustline';

      case xdr.LedgerEntryType.offer():
        return 'offer';

      case xdr.LedgerEntryType.data():
        return 'classic-account-data';

      case xdr.LedgerEntryType.claimableBalance():
        return 'claimableBalance';

      case xdr.LedgerEntryType.liquidityPool():
        return 'liquidityPool';

      case xdr.LedgerEntryType.configSetting():
        return 'configSetting';

      case xdr.LedgerEntryType.ttl(): {
        const keyHash = key.ttl().keyHash().toString('hex');

        return `ttl  keyHash=${keyHash}`;
      }

      default:
        return key.switch().name;
    }
  } catch (error: unknown) {
    return `(could not decode ledger key: ${getErrorMessage(error)})`;
  }
}

/**
 * Turn one raw ledger key into the normalized representation used by the
 * report and comparison helpers.
 */
export function inspectFootprintEntry(
  key: xdr.LedgerKey,
  access: FootprintAccess,
): FootprintEntryInfo {
  const storageType = identifyStorageType(key);

  const isContractEntry =
    key.switch() === xdr.LedgerEntryType.contractData() ||
    key.switch() === xdr.LedgerEntryType.contractCode();

  return {
    access,
    ledgerType: key.switch().name,
    description: describeLedgerKey(key),
    rawXdr: key.toXDR('base64'),
    isContractEntry,
    storageType,
  };
}

/**
 * Extract and classify all entries in a Soroban footprint.
 */
export function analyzeFootprint(footprint: xdr.LedgerFootprint): FootprintSummary {
  const readOnly = footprint.readOnly();
  const readWrite = footprint.readWrite();

  const entries: FootprintEntryInfo[] = [
    ...readOnly.map((key) => inspectFootprintEntry(key, 'read-only')),
    ...readWrite.map((key) => inspectFootprintEntry(key, 'read-write')),
  ];

  /*
   * Instance entries have persistent durability underneath, but the report
   * exposes them as their own category. For the persistent total, count both
   * ordinary persistent contract data and contract instances.
   */
  const persistentEntryCount = entries.filter(
    (entry) => entry.storageType === 'persistent' || entry.storageType === 'instance',
  ).length;

  return {
    readOnlyCount: readOnly.length,
    readWriteCount: readWrite.length,
    totalCount: entries.length,

    contractEntryCount: entries.filter((entry) => entry.isContractEntry).length,

    persistentEntryCount,

    temporaryEntryCount: entries.filter((entry) => entry.storageType === 'temporary').length,

    instanceEntryCount: entries.filter((entry) => entry.storageType === 'instance').length,

    contractCodeCount: entries.filter((entry) => entry.storageType === 'contract-code').length,

    entries,
  };
}

/**
 * Compare two analyzed footprints by raw ledger-key identity.
 *
 * Access mode is deliberately not included in the identity. The same ledger
 * key appearing read-only in one invocation and read-write in another should
 * still be recognized as the same underlying ledger entry.
 */
export function compareFootprints(
  first: FootprintSummary,
  second: FootprintSummary,
): FootprintComparison {
  const firstKeys = new Set(first.entries.map((entry) => entry.rawXdr));
  const secondKeys = new Set(second.entries.map((entry) => entry.rawXdr));

  let commonEntries = 0;

  firstKeys.forEach((key) => {
    if (secondKeys.has(key)) {
      commonEntries += 1;
    }
  });

  return {
    firstTotal: first.totalCount,
    secondTotal: second.totalCount,
    totalDelta: second.totalCount - first.totalCount,

    firstReadOnly: first.readOnlyCount,
    secondReadOnly: second.readOnlyCount,
    readOnlyDelta: second.readOnlyCount - first.readOnlyCount,

    firstReadWrite: first.readWriteCount,
    secondReadWrite: second.readWriteCount,
    readWriteDelta: second.readWriteCount - first.readWriteCount,

    commonEntries,
    onlyInFirst: firstKeys.size - commonEntries,
    onlyInSecond: secondKeys.size - commonEntries,
  };
}

/**
 * Build one Soroban invocation.
 */
export function buildInvocation(
  sourceAccountId: string,
  networkPassphrase: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Transaction {
  const sourceAccount = new Account(sourceAccountId, '0');

  const contract = new Contract(contractId);

  return new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
}

/**
 * Determine arguments for the built-in demonstration methods.
 *
 * `decimals` takes no arguments.
 * `balance` takes one address.
 *
 * Custom methods can still be selected through environment variables. They
 * are invoked with no arguments so any mismatch is reported cleanly by
 * simulation rather than crashing the example.
 */
export function buildMethodArguments(method: string, balanceAddress: string): xdr.ScVal[] {
  if (method === 'balance') {
    return [Address.fromString(balanceAddress).toScVal()];
  }

  return [];
}

/**
 * Simulate an invocation and extract its footprint.
 */
async function simulateFootprint(
  server: rpc.Server,
  label: string,
  method: string,
  sourceAccountId: string,
  networkPassphrase: string,
  contractId: string,
  args: xdr.ScVal[],
): Promise<SimulatedFootprint> {
  let transaction: Transaction;

  try {
    transaction = buildInvocation(sourceAccountId, networkPassphrase, contractId, method, args);
  } catch (error: unknown) {
    return {
      label,
      method,
      success: false,
      restoreRequired: false,
      error: `Could not build invocation: ${getErrorMessage(error)}`,
    };
  }

  let simulation: rpc.Api.SimulateTransactionResponse;

  try {
    simulation = await server.simulateTransaction(transaction);
  } catch (error: unknown) {
    return {
      label,
      method,
      success: false,
      restoreRequired: false,
      error: `RPC simulation request failed: ${getErrorMessage(error)}`,
    };
  }

  if (rpc.Api.isSimulationError(simulation)) {
    return {
      label,
      method,
      success: false,
      restoreRequired: false,
      latestLedger: simulation.latestLedger,
      error: simulation.error,
    };
  }

  if (rpc.Api.isSimulationRestore(simulation)) {
    return {
      label,
      method,
      success: false,
      restoreRequired: true,
      latestLedger: simulation.latestLedger,
      error:
        'Simulation detected archived ledger state that must be restored before this invocation can be analyzed safely.',
    };
  }

  try {
    const transactionData = simulation.transactionData.build();

    const footprint = transactionData.resources().footprint();

    return {
      label,
      method,
      success: true,
      restoreRequired: false,
      latestLedger: simulation.latestLedger,
      summary: analyzeFootprint(footprint),
    };
  } catch (error: unknown) {
    return {
      label,
      method,
      success: false,
      restoreRequired: false,
      latestLedger: simulation.latestLedger,
      error: `Simulation succeeded but its footprint could not be decoded: ${getErrorMessage(
        error,
      )}`,
    };
  }
}

/**
 * Print one footprint category.
 */
function printEntryGroup(title: string, entries: FootprintEntryInfo[]): void {
  console.log(chalk.cyan(`\n  ${title} (${entries.length})`));

  if (entries.length === 0) {
    console.log(chalk.gray('    (none)'));
    return;
  }

  entries.forEach((entry, index) => {
    console.log(`    [${index + 1}] ${entry.description}`);

    /*
     * Raw XDR makes every complex ledger key inspectable even when its
     * high-level representation is unfamiliar to this example.
     */
    console.log(chalk.gray(`        Type    : ${entry.ledgerType}`));

    console.log(chalk.gray(`        Storage : ${entry.storageType}`));

    console.log(chalk.gray(`        Raw XDR : ${entry.rawXdr}`));
  });
}

/**
 * Display one complete footprint report.
 */
function printFootprintReport(result: SimulatedFootprint): void {
  console.log(chalk.bold(`\n${result.label}: ${result.method}()`));

  if (!result.success || !result.summary) {
    if (result.restoreRequired) {
      console.log(chalk.yellow('  Result : RESTORE REQUIRED'));
    } else {
      console.log(chalk.red('  Result : SIMULATION FAILED'));
    }

    if (result.latestLedger !== undefined) {
      console.log(`  Ledger : ${result.latestLedger}`);
    }

    console.log(chalk.gray(`  Detail : ${result.error ?? 'No diagnostic information returned.'}`));

    return;
  }

  const summary = result.summary;

  console.log(chalk.green('  Result : SUCCESS'));

  if (result.latestLedger !== undefined) {
    console.log(`  Ledger : ${result.latestLedger}`);
  }

  console.log(chalk.yellow('\n  Footprint summary'));

  console.log(`    Total entries       : ${summary.totalCount}`);
  console.log(`    Read-only entries   : ${summary.readOnlyCount}`);
  console.log(`    Read-write entries  : ${summary.readWriteCount}`);
  console.log(`    Contract entries    : ${summary.contractEntryCount}`);
  console.log(`    Persistent entries  : ${summary.persistentEntryCount}`);
  console.log(`    Temporary entries   : ${summary.temporaryEntryCount}`);
  console.log(`    Instance entries    : ${summary.instanceEntryCount}`);
  console.log(`    Contract-code keys  : ${summary.contractCodeCount}`);

  if (summary.totalCount === 0) {
    console.log(chalk.yellow('\n  The simulation returned an empty ledger footprint.'));

    console.log(
      chalk.gray('  This can be valid when the invocation does not access ledger-backed state.'),
    );

    return;
  }

  const readOnly = summary.entries.filter((entry) => entry.access === 'read-only');

  const readWrite = summary.entries.filter((entry) => entry.access === 'read-write');

  printEntryGroup('READ-ONLY', readOnly);

  printEntryGroup('READ-WRITE', readWrite);
}

/**
 * Display comparison information for two successful footprint simulations.
 */
function printComparison(first: SimulatedFootprint, second: SimulatedFootprint): void {
  console.log(chalk.yellow('\nFootprint comparison'));

  if (!first.success || !first.summary) {
    console.log(
      chalk.gray(
        `  Cannot compare because ${first.label} (${first.method}) did not produce a usable footprint.`,
      ),
    );

    return;
  }

  if (!second.success || !second.summary) {
    console.log(
      chalk.gray(
        `  Cannot compare because ${second.label} (${second.method}) did not produce a usable footprint.`,
      ),
    );

    return;
  }

  const comparison = compareFootprints(first.summary, second.summary);

  console.log(`  ${first.label.padEnd(15)}: ${first.method}()`);

  console.log(`  ${second.label.padEnd(15)}: ${second.method}()`);

  console.log('');

  console.log(
    `  Total entries       : ${comparison.firstTotal} -> ${comparison.secondTotal} (${formatDelta(
      comparison.totalDelta,
    )})`,
  );

  console.log(
    `  Read-only entries   : ${comparison.firstReadOnly} -> ${
      comparison.secondReadOnly
    } (${formatDelta(comparison.readOnlyDelta)})`,
  );

  console.log(
    `  Read-write entries  : ${comparison.firstReadWrite} -> ${
      comparison.secondReadWrite
    } (${formatDelta(comparison.readWriteDelta)})`,
  );

  console.log(`  Common ledger keys  : ${comparison.commonEntries}`);
  console.log(`  Only in first call  : ${comparison.onlyInFirst}`);
  console.log(`  Only in second call : ${comparison.onlyInSecond}`);

  if (comparison.totalDelta > 0) {
    console.log(
      chalk.cyan(
        `\n  ${second.method}() touches ${comparison.totalDelta} more ledger ${
          comparison.totalDelta === 1 ? 'entry' : 'entries'
        } than ${first.method}().`,
      ),
    );
  } else if (comparison.totalDelta < 0) {
    console.log(
      chalk.cyan(
        `\n  ${second.method}() touches ${Math.abs(comparison.totalDelta)} fewer ledger ${
          Math.abs(comparison.totalDelta) === 1 ? 'entry' : 'entries'
        } than ${first.method}().`,
      ),
    );
  } else {
    console.log(
      chalk.cyan(
        '\n  Both invocations touch the same number of ledger entries, though the actual keys may differ.',
      ),
    );
  }

  if (comparison.firstReadWrite === 0 && comparison.secondReadWrite === 0) {
    console.log(
      chalk.gray(
        '  Both default invocations are read-only and therefore produce no read-write footprint entries.',
      ),
    );
  }
}

/**
 * Render signed deltas consistently.
 */
export function formatDelta(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }

  return value.toString();
}

/**
 * Run ISSUE-118.
 */
export async function run(params: LedgerFootprintParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl?.trim() || process.env.SOROBAN_RPC_URL?.trim() || DEFAULT_RPC_URL;

  const networkPassphrase =
    params.networkPassphrase?.trim() || process.env.NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;

  const defaultContractId = Asset.native().contractId(networkPassphrase);

  const contractId =
    params.contractId?.trim() ||
    process.env.FOOTPRINT_CONTRACT_ID?.trim() ||
    process.env.CONTRACT_ID?.trim() ||
    defaultContractId;

  const methodA =
    params.methodA?.trim() || process.env.FOOTPRINT_METHOD_A?.trim() || DEFAULT_METHOD_A;

  const methodB =
    params.methodB?.trim() || process.env.FOOTPRINT_METHOD_B?.trim() || DEFAULT_METHOD_B;

  const balanceAddress =
    params.balanceAddress?.trim() ||
    process.env.FOOTPRINT_BALANCE_ADDRESS?.trim() ||
    Keypair.random().publicKey();

  console.log(chalk.bold('\nSoroban Ledger Footprint Analysis Example'));

  console.log(
    chalk.gray(
      'Simulate two contract invocations, decode the ledger entries they access, and compare their footprints.',
    ),
  );

  console.log(chalk.yellow('\nConfiguration'));

  console.log(`  RPC endpoint    : ${rpcUrl}`);
  console.log(`  Contract        : ${contractId}`);
  console.log(`  Invocation A    : ${methodA}()`);
  console.log(`  Invocation B    : ${methodB}()`);
  console.log(`  Balance address : ${balanceAddress}`);

  // -----------------------------------------------------------------------
  // Step 1: Validate inputs
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 1: Validating inputs...'));

  if (!StrKey.isValidContract(contractId)) {
    console.error(
      chalk.red(`  Invalid contract ID "${contractId}". Expected a valid C... contract address.`),
    );

    return;
  }

  if (!StrKey.isValidEd25519PublicKey(balanceAddress) && !StrKey.isValidContract(balanceAddress)) {
    console.error(
      chalk.red(`  Invalid balance address "${balanceAddress}". Expected a G... or C... address.`),
    );

    return;
  }

  console.log(chalk.green('  Input validation passed.'));

  // -----------------------------------------------------------------------
  // Step 2: Connect to Soroban RPC
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 2: Connecting to Soroban RPC...'));

  const server = new rpc.Server(rpcUrl);

  try {
    const latestLedger = await server.getLatestLedger();

    console.log(chalk.green(`  Connected. Latest ledger sequence: ${latestLedger.sequence}`));
  } catch (error: unknown) {
    console.error(chalk.red(`  Unable to reach Soroban RPC: ${getErrorMessage(error)}`));

    console.log(
      chalk.gray('  Check SOROBAN_RPC_URL and ensure the endpoint matches the selected network.'),
    );

    return;
  }

  // -----------------------------------------------------------------------
  // Step 3: Build invocation arguments
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 3: Building two contract invocations...'));

  let argsA: xdr.ScVal[];
  let argsB: xdr.ScVal[];

  try {
    argsA = buildMethodArguments(methodA, balanceAddress);

    argsB = buildMethodArguments(methodB, balanceAddress);
  } catch (error: unknown) {
    console.error(chalk.red(`  Could not encode invocation arguments: ${getErrorMessage(error)}`));

    return;
  }

  console.log(`  Invocation A : ${methodA}(${describeArguments(argsA)})`);

  console.log(`  Invocation B : ${methodB}(${describeArguments(argsB)})`);

  /*
   * No funded account or secret key is necessary because this example only
   * simulates transactions.
   */
  const simulationSource = Keypair.random().publicKey();

  // -----------------------------------------------------------------------
  // Step 4: Simulate first invocation
  // -----------------------------------------------------------------------

  console.log(chalk.yellow(`\nStep 4: Simulating ${methodA}()...`));

  const first = await simulateFootprint(
    server,
    'Invocation A',
    methodA,
    simulationSource,
    networkPassphrase,
    contractId,
    argsA,
  );

  if (first.success) {
    console.log(chalk.green('  First simulation succeeded.'));
  } else {
    console.log(
      chalk.yellow(
        `  First simulation did not produce a usable footprint: ${first.error ?? 'unknown reason'}`,
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Step 5: Simulate second invocation
  // -----------------------------------------------------------------------

  console.log(chalk.yellow(`\nStep 5: Simulating ${methodB}()...`));

  const second = await simulateFootprint(
    server,
    'Invocation B',
    methodB,
    simulationSource,
    networkPassphrase,
    contractId,
    argsB,
  );

  if (second.success) {
    console.log(chalk.green('  Second simulation succeeded.'));
  } else {
    console.log(
      chalk.yellow(
        `  Second simulation did not produce a usable footprint: ${
          second.error ?? 'unknown reason'
        }`,
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Step 6: Print detailed footprint reports
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 6: Detailed ledger footprint reports'));

  printFootprintReport(first);

  printFootprintReport(second);

  // -----------------------------------------------------------------------
  // Step 7: Compare footprints
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 7: Comparing the two invocations...'));

  printComparison(first, second);

  // -----------------------------------------------------------------------
  // Step 8: Explain Soroban footprints
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 8: Why Soroban transactions need footprints'));

  console.log(
    chalk.cyan(
      [
        '  • A Soroban footprint declares the exact ledger keys a transaction may access.',
        '  • Read-only entries can be read but are not expected to be modified.',
        '  • Read-write entries may be read, created, changed, or deleted.',
        '  • Contract-data entries can use persistent or temporary durability.',
        '  • A contract instance is represented by a special persistent contract-data key.',
        '  • Contract code is stored under a separate contract-code ledger key.',
        '  • Simulation discovers the transitive footprint, including state touched by',
        '    contracts called indirectly by the original contract.',
      ].join('\n'),
    ),
  );

  console.log(
    chalk.gray(
      '\n  Without an accurate footprint, the network cannot safely execute the Soroban transaction against the declared ledger state.',
    ),
  );

  // -----------------------------------------------------------------------
  // Step 9: Explain simulation and transaction preparation
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 9: Simulation and transaction preparation'));

  console.log(
    chalk.cyan(
      [
        '  1. Build the initial contract invocation.',
        '  2. Simulate it through Soroban RPC.',
        '  3. RPC executes against a temporary ledger snapshot and records the entries',
        '     that the invocation reads and writes.',
        '  4. The returned Soroban transaction data contains the recommended footprint.',
        '  5. Transaction preparation applies that data to the transaction before signing.',
        '  6. If ledger state changes enough before submission, the footprint may become',
        '     stale and the transaction should be simulated again.',
      ].join('\n'),
    ),
  );

  console.log(chalk.bold.green('\nSoroban ledger footprint analysis complete.'));

  console.log(
    chalk.gray('No transaction was signed or submitted. Both invocations were simulation-only.'),
  );
}

/**
 * Display invocation arguments compactly.
 */
function describeArguments(args: xdr.ScVal[]): string {
  if (args.length === 0) {
    return '';
  }

  return args.map((argument) => formatScVal(argument)).join(', ');
}
