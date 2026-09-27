import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from 'stellar-sdk-v16';
import chalk from 'chalk';

/**
 * ISSUE-117: Soroban Authorization Tree Visualization
 *
 * Soroban authorization entries contain an invocation tree describing exactly
 * which contract calls an address has authorized.
 *
 * A single authorization entry contains:
 *
 *   credentials
 *       -> who is authorizing
 *
 *   rootInvocation
 *       -> the top-level authorized call
 *          -> subInvocation
 *             -> subInvocation
 *                -> ...
 *
 * Nested authorization becomes especially important when one contract calls
 * another contract. A user may appear to authorize one high-level action while
 * the authorization tree also covers token transfers or other nested calls.
 *
 * This example:
 *
 * 1. Builds an invocation that requires Soroban authorization.
 * 2. Simulates the transaction through Soroban RPC.
 * 3. Extracts all returned authorization entries.
 * 4. Associates each entry with its required signer.
 * 5. Visualizes root and nested invocations.
 * 6. Displays contract IDs, function names, arguments and child counts.
 * 7. Reports signature status.
 * 8. Decodes common ScVal argument types.
 * 9. Uses iterative tree traversal so deeply nested authorization trees do not
 *    depend on JavaScript recursion depth.
 * 10. Handles empty authorization results and simulation failures gracefully.
 *
 * The example performs simulation only. No transaction is signed or submitted.
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
const BASE_FEE = '100';
const DEFAULT_ALLOWANCE_AMOUNT = 0n;
const DEFAULT_ALLOWANCE_LIFETIME = 100;

export interface SorobanAuthTreeParams {
  rpcUrl?: string;
  contractId?: string;
  sourceAccountId?: string;
  spenderId?: string;
  networkPassphrase?: string;
  allowanceAmount?: string;
}

export interface AuthorizationTreeNode {
  invocation: xdr.SorobanAuthorizedInvocation;
  depth: number;
  path: string;
  kind: 'root' | 'nested';
}

export interface DecodedInvocation {
  functionType: string;
  contractId?: string;
  functionName?: string;
  arguments: string[];
  subInvocationCount: number;
}

export interface AuthorizationSignerInfo {
  credentialType: string;
  address: string;
  signatureStatus: string;
  nonce?: string;
  signatureExpirationLedger?: number;
}

/**
 * Convert an unknown thrown value into a readable message.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Render JSON without failing when a decoded Soroban value contains bigint.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Decode a Soroban address into its normal G... or C... representation.
 */
export function describeScAddress(address: xdr.ScAddress): string {
  try {
    return String(scValToNative(xdr.ScVal.scvAddress(address)));
  } catch {
    return `(undecodable address: ${address.switch().name})`;
  }
}

/**
 * Convert common ScVal argument types into readable text.
 *
 * scValToNative already handles the standard Soroban primitive and collection
 * types. Additional formatting is applied here for byte arrays, bigint values
 * and structured values.
 */
export function formatScVal(value: xdr.ScVal): string {
  const type = value.switch().name;

  try {
    const native = scValToNative(value);

    if (typeof native === 'bigint') {
      return `${type}(${native.toString()})`;
    }

    if (typeof native === 'string') {
      return `${type}("${native}")`;
    }

    if (typeof native === 'boolean' || typeof native === 'number') {
      return `${type}(${String(native)})`;
    }

    if (Buffer.isBuffer(native)) {
      return `${type}(0x${native.toString('hex')})`;
    }

    if (native instanceof Uint8Array) {
      return `${type}(0x${Buffer.from(native).toString('hex')})`;
    }

    if (native === null) {
      return `${type}(null)`;
    }

    if (native === undefined) {
      return `${type}(undefined)`;
    }

    return `${type}(${JSON.stringify(native, bigintReplacer)})`;
  } catch {
    return `${type}(raw-xdr=${value.toXDR('base64')})`;
  }
}

/**
 * Iteratively flatten an authorization invocation tree.
 *
 * Using an explicit stack instead of recursive function calls means deeply
 * nested trees are not limited by JavaScript's call-stack depth.
 */
export function flattenAuthorizationTree(
  rootInvocation: xdr.SorobanAuthorizedInvocation,
): AuthorizationTreeNode[] {
  interface PendingNode {
    invocation: xdr.SorobanAuthorizedInvocation;
    depth: number;
    path: string;
  }

  const flattened: AuthorizationTreeNode[] = [];

  const stack: PendingNode[] = [
    {
      invocation: rootInvocation,
      depth: 0,
      path: '0',
    },
  ];

  while (stack.length > 0) {
    const current = stack.pop();

    if (!current) {
      continue;
    }

    flattened.push({
      invocation: current.invocation,
      depth: current.depth,
      path: current.path,
      kind: current.depth === 0 ? 'root' : 'nested',
    });

    const children = current.invocation.subInvocations();

    /*
     * Push children in reverse order because a stack is LIFO. This preserves
     * their natural left-to-right order when we later pop them.
     */
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        invocation: children[index],
        depth: current.depth + 1,
        path: `${current.path}.${index}`,
      });
    }
  }

  return flattened;
}

/**
 * Decode the contract/function part of one authorization-tree node.
 */
export function decodeInvocation(invocation: xdr.SorobanAuthorizedInvocation): DecodedInvocation {
  const authorizedFunction = invocation.function();
  const functionType = authorizedFunction.switch().name;
  const subInvocationCount = invocation.subInvocations().length;

  /*
   * Contract calls are the most common authorization nodes and contain the
   * contract address, function name and arguments directly.
   */
  if (functionType === 'sorobanAuthorizedFunctionTypeContractFn') {
    const contractFunction = authorizedFunction.contractFn();

    return {
      functionType,
      contractId: describeScAddress(contractFunction.contractAddress()),
      functionName: contractFunction.functionName().toString(),
      arguments: contractFunction.args().map((argument) => formatScVal(argument)),
      subInvocationCount,
    };
  }

  /*
   * Contract-creation authorization variants do not have the same
   * contract/function/argument shape as normal function calls. Keep the node
   * visible instead of failing to visualize the rest of the tree.
   */
  return {
    functionType,
    arguments: [],
    subInvocationCount,
  };
}

/**
 * Inspect the credential section of one authorization entry and determine the
 * signer associated with it.
 *
 * Source-account credentials contain no explicit address in the auth entry;
 * they mean "the transaction source account authorizes this invocation".
 */
export function getAuthorizationSigner(
  credentials: xdr.SorobanCredentials,
  sourceAccountId: string,
): AuthorizationSignerInfo {
  const credentialType = credentials.switch().name;

  if (credentialType === 'sorobanCredentialsSourceAccount') {
    return {
      credentialType,
      address: sourceAccountId,
      signatureStatus: 'transaction signature required; no separate auth-entry signature is stored',
    };
  }

  if (credentialType === 'sorobanCredentialsAddress') {
    const addressCredentials = credentials.address();
    const signature = addressCredentials.signature();

    const signaturePresent = signature.switch().name !== 'scvVoid';

    return {
      credentialType,
      address: describeScAddress(addressCredentials.address()),
      nonce: addressCredentials.nonce().toString(),
      signatureExpirationLedger: addressCredentials.signatureExpirationLedger(),
      signatureStatus: signaturePresent
        ? 'signature present'
        : 'unsigned authorization entry returned by simulation',
    };
  }

  /*
   * Newer protocol versions may introduce additional credential variants.
   * Keeping the entry visible is safer than throwing during visualization.
   */
  return {
    credentialType,
    address: '(unable to decode signer for this credential variant)',
    signatureStatus: 'unknown',
  };
}

/**
 * Produce a readable summary for one invocation node.
 */
function printInvocationNode(node: AuthorizationTreeNode): void {
  const decoded = decodeInvocation(node.invocation);

  const indentation = '  '.repeat(node.depth + 2);

  const role =
    node.kind === 'root'
      ? chalk.bold.cyan(`ROOT [${node.path}]`)
      : chalk.bold.magenta(`NESTED [${node.path}]`);

  console.log(`${indentation}${role}`);

  console.log(`${indentation}  Function type   : ${decoded.functionType}`);

  if (decoded.contractId) {
    console.log(`${indentation}  Contract ID     : ${decoded.contractId}`);
  } else {
    console.log(
      chalk.gray(`${indentation}  Contract ID     : not applicable to this authorization variant`),
    );
  }

  if (decoded.functionName) {
    console.log(`${indentation}  Function        : ${decoded.functionName}`);
  } else {
    console.log(
      chalk.gray(`${indentation}  Function        : host-level contract creation operation`),
    );
  }

  if (decoded.arguments.length === 0) {
    console.log(`${indentation}  Arguments       : (none)`);
  } else {
    console.log(`${indentation}  Arguments       :`);

    decoded.arguments.forEach((argument, index) => {
      console.log(`${indentation}    [${index}] ${argument}`);
    });
  }

  console.log(`${indentation}  Sub-invocations : ${decoded.subInvocationCount}`);
}

/**
 * Visualize an entire authorization entry.
 */
export function printAuthorizationEntry(
  entry: xdr.SorobanAuthorizationEntry,
  index: number,
  sourceAccountId: string,
): void {
  console.log(chalk.bold(`\n  Authorization entry #${index + 1}`));

  const signer = getAuthorizationSigner(entry.credentials(), sourceAccountId);

  console.log(chalk.yellow('    Required signer'));
  console.log(`      Credential type : ${signer.credentialType}`);
  console.log(`      Authorized addr : ${signer.address}`);

  if (signer.nonce !== undefined) {
    console.log(`      Nonce           : ${signer.nonce}`);
  }

  if (signer.signatureExpirationLedger !== undefined) {
    console.log(`      Signature expiry: ledger ${signer.signatureExpirationLedger}`);
  }

  console.log(`      Signature status: ${signer.signatureStatus}`);

  const flattened = flattenAuthorizationTree(entry.rootInvocation());

  const nestedCount = flattened.filter((node) => node.kind === 'nested').length;
  const maximumDepth = flattened.reduce((highest, node) => Math.max(highest, node.depth), 0);

  console.log(chalk.yellow('\n    Authorization hierarchy'));
  console.log(`      Total nodes     : ${flattened.length}`);
  console.log(`      Nested nodes    : ${nestedCount}`);
  console.log(`      Maximum depth   : ${maximumDepth}`);

  flattened.forEach((node) => {
    printInvocationNode(node);
  });
}

/**
 * Build a token allowance invocation that requires authorization.
 *
 * `approve` is useful for this example because it calls require_auth() for the
 * owner/from address. Using amount 0 means the example does not need the source
 * address to hold XLM in order to demonstrate the authorization structure.
 */
export function buildAuthorizedInvocation(
  sourceAccountId: string,
  spenderId: string,
  contractId: string,
  networkPassphrase: string,
  allowanceAmount: bigint,
  expirationLedger: number,
): Transaction {
  const sourceAccount = new Account(sourceAccountId, '0');
  const tokenContract = new Contract(contractId);

  const operation = tokenContract.call(
    'approve',
    Address.fromString(sourceAccountId).toScVal(),
    Address.fromString(spenderId).toScVal(),
    nativeToScVal(allowanceAmount, { type: 'i128' }),
    nativeToScVal(expirationLedger, { type: 'u32' }),
  );

  return new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();
}

/**
 * Print useful diagnostic events when simulation fails.
 */
function printSimulationDiagnostics(events: xdr.DiagnosticEvent[]): void {
  if (events.length === 0) {
    console.log(chalk.gray('  No diagnostic events were returned.'));
    return;
  }

  console.log(chalk.gray(`  Diagnostic events: ${events.length}`));

  events.slice(0, 5).forEach((event, index) => {
    try {
      const contractEvent = event.event();
      const body = contractEvent.body().v0();

      const topics = body
        .topics()
        .map((topic) => formatScVal(topic))
        .join(', ');

      console.log(
        chalk.gray(`    [${index + 1}] successfulContractCall=${event.inSuccessfulContractCall()}`),
      );

      if (topics.length > 0) {
        console.log(chalk.gray(`        topics: ${topics}`));
      }

      console.log(chalk.gray(`        data  : ${formatScVal(body.data())}`));
    } catch (error: unknown) {
      console.log(
        chalk.gray(
          `    [${index + 1}] Could not decode diagnostic event: ${getErrorMessage(error)}`,
        ),
      );
    }
  });

  if (events.length > 5) {
    console.log(chalk.gray(`    ... ${events.length - 5} additional diagnostic event(s) omitted.`));
  }
}

/**
 * Run ISSUE-117.
 */
export async function run(params: SorobanAuthTreeParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl?.trim() || process.env.SOROBAN_RPC_URL?.trim() || DEFAULT_RPC_URL;

  const networkPassphrase =
    params.networkPassphrase?.trim() || process.env.NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;

  /*
   * The native XLM Stellar Asset Contract is always available for the network
   * and provides the standard token interface, including approve().
   */
  const defaultContractId = Asset.native().contractId(networkPassphrase);

  const contractId =
    params.contractId?.trim() ||
    process.env.AUTH_CONTRACT_ID?.trim() ||
    process.env.CONTRACT_ID?.trim() ||
    defaultContractId;

  /*
   * No secret keys are needed. Simulation records authorization requirements
   * without signing or submitting the transaction.
   */
  const sourceAccountId =
    params.sourceAccountId?.trim() ||
    process.env.AUTH_SOURCE_ACCOUNT?.trim() ||
    Keypair.random().publicKey();

  const spenderId =
    params.spenderId?.trim() ||
    process.env.AUTH_SPENDER_ACCOUNT?.trim() ||
    Keypair.random().publicKey();

  const allowanceInput =
    params.allowanceAmount?.trim() ||
    process.env.AUTH_ALLOWANCE_AMOUNT?.trim() ||
    DEFAULT_ALLOWANCE_AMOUNT.toString();

  let allowanceAmount: bigint;

  try {
    allowanceAmount = BigInt(allowanceInput);

    if (allowanceAmount < 0n) {
      throw new Error('allowance cannot be negative');
    }
  } catch {
    console.error(
      chalk.red(`Invalid AUTH_ALLOWANCE_AMOUNT "${allowanceInput}". Use a non-negative integer.`),
    );

    return;
  }

  console.log(chalk.bold('\nSoroban Authorization Tree Visualization Example'));

  console.log(
    chalk.gray(
      'Simulate an authorized contract call and turn its Soroban authorization entries into a readable invocation tree.',
    ),
  );

  console.log(chalk.yellow('\nConfiguration'));
  console.log(`  RPC endpoint       : ${rpcUrl}`);
  console.log(`  Contract           : ${contractId}`);
  console.log(`  Authorized address : ${sourceAccountId}`);
  console.log(`  Spender address    : ${spenderId}`);
  console.log(`  Allowance amount   : ${allowanceAmount.toString()}`);

  const server = new rpc.Server(rpcUrl);

  // -----------------------------------------------------------------------
  // Step 1: Connect to Soroban RPC
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 1: Connecting to Soroban RPC...'));

  let latestLedger: number;

  try {
    const ledger = await server.getLatestLedger();

    latestLedger = ledger.sequence;

    console.log(chalk.green(`  Connected. Latest ledger sequence: ${latestLedger}`));
  } catch (error: unknown) {
    console.error(chalk.red(`  Unable to reach Soroban RPC: ${getErrorMessage(error)}`));

    console.log(
      chalk.gray(
        '  Check SOROBAN_RPC_URL and confirm that the endpoint matches the selected network.',
      ),
    );

    return;
  }

  // -----------------------------------------------------------------------
  // Step 2: Build invocation that requires authorization
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow('\nStep 2: Building a Soroban invocation that requires authorization...'),
  );

  /*
   * Keep the allowance alive for a short demonstration window.
   */
  const expirationLedger = latestLedger + DEFAULT_ALLOWANCE_LIFETIME;

  let transaction: Transaction;

  try {
    transaction = buildAuthorizedInvocation(
      sourceAccountId,
      spenderId,
      contractId,
      networkPassphrase,
      allowanceAmount,
      expirationLedger,
    );
  } catch (error: unknown) {
    console.error(chalk.red(`  Could not build authorization example: ${getErrorMessage(error)}`));

    return;
  }

  console.log(chalk.green('  Transaction constructed.'));
  console.log(`  Method             : approve`);
  console.log(`  Source/authorizer  : ${sourceAccountId}`);
  console.log(`  Spender            : ${spenderId}`);
  console.log(`  Amount             : ${allowanceAmount.toString()}`);
  console.log(`  Allowance expires  : ledger ${expirationLedger}`);
  console.log(`  Transaction signed : no`);
  console.log(`  Transaction sent   : no`);

  // -----------------------------------------------------------------------
  // Step 3: Simulate and obtain authorization entries
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow('\nStep 3: Simulating transaction and recording authorization requirements...'),
  );

  let simulation: rpc.Api.SimulateTransactionResponse;

  try {
    simulation = await server.simulateTransaction(transaction);
  } catch (error: unknown) {
    console.error(chalk.red(`  Simulation request failed: ${getErrorMessage(error)}`));

    console.log(
      chalk.gray('  Confirm the RPC endpoint, contract ID, network and argument addresses.'),
    );

    return;
  }

  console.log(`  Simulation ledger: ${simulation.latestLedger}`);

  if (rpc.Api.isSimulationError(simulation)) {
    console.error(chalk.red('  Simulation failed.'));

    console.log(chalk.gray(`  RPC diagnostic: ${simulation.error}`));

    printSimulationDiagnostics(simulation.events);

    console.log(
      chalk.gray(
        '  No authorization tree can be produced because contract execution did not simulate successfully.',
      ),
    );

    return;
  }

  if (rpc.Api.isSimulationRestore(simulation)) {
    console.log(chalk.yellow('  Simulation requires archived state restoration.'));

    console.log(
      chalk.gray(
        '  Restore the required state and simulate again before relying on the authorization tree.',
      ),
    );

    return;
  }

  console.log(chalk.green('  Simulation succeeded.'));

  const authorizationEntries = simulation.result?.auth ?? [];

  // -----------------------------------------------------------------------
  // Step 4: Handle transactions with no authorization entries
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 4: Extracting authorization entries...'));

  if (authorizationEntries.length === 0) {
    console.log(chalk.yellow('  Simulation returned no authorization entries.'));

    console.log(
      chalk.gray(
        [
          '  This is valid for contract calls that do not invoke require_auth() or',
          '  require_auth_for_args(). Read-only calls commonly produce an empty result.',
          '',
          '  The default example uses the token approve() method because that method',
          '  normally requires authorization from its owner/from address.',
        ].join('\n'),
      ),
    );

    return;
  }

  console.log(
    chalk.green(
      `  Found ${authorizationEntries.length} authorization ${
        authorizationEntries.length === 1 ? 'entry' : 'entries'
      }.`,
    ),
  );

  // -----------------------------------------------------------------------
  // Step 5: Visualize every authorization tree
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 5: Authorization tree visualization'));

  authorizationEntries.forEach((entry, index) => {
    printAuthorizationEntry(entry, index, sourceAccountId);
  });

  // -----------------------------------------------------------------------
  // Step 6: Explain what the tree means
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 6: Understanding the authorization tree'));

  console.log(
    chalk.cyan(
      [
        '  • Each authorization entry belongs to one required authorizer.',
        '  • ROOT is the first invocation covered by that authorization.',
        '  • NESTED nodes are additional calls covered by the same authorization.',
        '  • Contract ID + function + arguments define exactly what is being authorized.',
        '  • A signer should inspect the entire tree, not only its root operation.',
        '  • Simulation records the required authorization structure before submission.',
        '  • Entries returned by simulation are normally unsigned and can later be',
        '    signed or satisfied by the transaction source account as appropriate.',
      ].join('\n'),
    ),
  );

  console.log(
    chalk.gray(
      '\nNested trees commonly appear when a high-level contract call invokes another contract that also requires authorization.',
    ),
  );

  console.log(chalk.bold.green('\nSoroban authorization tree visualization complete.'));

  console.log(
    chalk.gray('No transaction or authorization entry was signed or submitted by this example.'),
  );
}
