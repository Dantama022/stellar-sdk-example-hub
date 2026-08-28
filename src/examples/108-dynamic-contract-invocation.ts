import {
  Account,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  contract,
  rpc,
  scValToNative,
  xdr,
} from 'stellar-sdk-v16';
import chalk from 'chalk';

/**
 * ISSUE-108: Dynamic Soroban Contract Invocation
 *
 * Demonstrates how a generic Soroban client can:
 *
 * 1. Connect to Soroban RPC.
 * 2. Accept a contract ID at runtime.
 * 3. Retrieve the deployed contract WASM.
 * 4. Parse its embedded contract specification.
 * 5. Discover available functions dynamically.
 * 6. Select a function at runtime.
 * 7. Inspect the expected argument types.
 * 8. Convert JavaScript values into ScVal values from the specification.
 * 9. Build and simulate the invocation.
 * 10. Decode the returned ScVal using the same specification.
 *
 * No contract method signature is hard-coded into the invocation logic.
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

const DEFAULT_CONTRACT_ID = 'CDVSGPL3HFBGJ6ZEYQUAVE3OH3XE2ZE5ZT2GWPA3LKOYVD4UBPQJ2VHB';

const DEFAULT_FUNCTION_NAME = 'hello';

const DEFAULT_ARGUMENTS_JSON = '{"to":"Soroban"}';

export interface DynamicContractInvocationParams {
  contractId?: string;
  functionName?: string;
  argsJson?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
}

export interface DiscoveredArgument {
  name: string;
  type: string;
  optional: boolean;
}

export interface DiscoveredFunction {
  name: string;
  documentation: string;
  inputs: DiscoveredArgument[];
  outputs: string[];
}

/**
 * Parse the JavaScript argument object supplied by the caller.
 *
 * Examples:
 *
 * {"to":"Soroban"}
 * {"a":10,"b":20}
 */
export function parseArgumentJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();

  if (!trimmed) {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch (error: unknown) {
    throw new Error(`Arguments must be valid JSON: ${getErrorMessage(error)}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Arguments must be a JSON object keyed by the contract argument names.');
  }

  return parsed as Record<string, unknown>;
}

/**
 * Convert a Soroban specification type to a readable name.
 */
export function resolveTypeName(typeDef: xdr.ScSpecTypeDef): string {
  const type = typeDef.switch();

  switch (type.value) {
    case xdr.ScSpecType.scSpecTypeVoid().value:
      return 'void';

    case xdr.ScSpecType.scSpecTypeBool().value:
      return 'bool';

    case xdr.ScSpecType.scSpecTypeU32().value:
      return 'u32';

    case xdr.ScSpecType.scSpecTypeI32().value:
      return 'i32';

    case xdr.ScSpecType.scSpecTypeU64().value:
      return 'u64';

    case xdr.ScSpecType.scSpecTypeI64().value:
      return 'i64';

    case xdr.ScSpecType.scSpecTypeU128().value:
      return 'u128';

    case xdr.ScSpecType.scSpecTypeI128().value:
      return 'i128';

    case xdr.ScSpecType.scSpecTypeU256().value:
      return 'u256';

    case xdr.ScSpecType.scSpecTypeI256().value:
      return 'i256';

    case xdr.ScSpecType.scSpecTypeBytes().value:
      return 'bytes';

    case xdr.ScSpecType.scSpecTypeString().value:
      return 'string';

    case xdr.ScSpecType.scSpecTypeSymbol().value:
      return 'symbol';

    case xdr.ScSpecType.scSpecTypeAddress().value:
      return 'address';

    case xdr.ScSpecType.scSpecTypeTimepoint().value:
      return 'timepoint';

    case xdr.ScSpecType.scSpecTypeDuration().value:
      return 'duration';

    case xdr.ScSpecType.scSpecTypeVal().value:
      return 'val';

    case xdr.ScSpecType.scSpecTypeError().value:
      return 'error';

    case xdr.ScSpecType.scSpecTypeOption().value:
      return `Option<${resolveTypeName(typeDef.option().valueType())}>`;

    case xdr.ScSpecType.scSpecTypeResult().value:
      return `Result<${resolveTypeName(typeDef.result().okType())}, ${resolveTypeName(
        typeDef.result().errorType(),
      )}>`;

    case xdr.ScSpecType.scSpecTypeVec().value:
      return `Vec<${resolveTypeName(typeDef.vec().elementType())}>`;

    case xdr.ScSpecType.scSpecTypeMap().value:
      return `Map<${resolveTypeName(typeDef.map().keyType())}, ${resolveTypeName(
        typeDef.map().valueType(),
      )}>`;

    case xdr.ScSpecType.scSpecTypeTuple().value:
      return `Tuple<${typeDef.tuple().valueTypes().map(resolveTypeName).join(', ')}>`;

    case xdr.ScSpecType.scSpecTypeBytesN().value:
      return `BytesN<${typeDef.bytesN().n()}>`;

    case xdr.ScSpecType.scSpecTypeUdt().value:
      return typeDef.udt().name().toString();

    default:
      return type.name || 'unknown';
  }
}

/**
 * Discover all public functions from a runtime contract specification.
 */
export function discoverFunctions(spec: contract.Spec): DiscoveredFunction[] {
  return spec
    .funcs()
    .filter((fn) => !fn.name().toString().startsWith('__'))
    .map((fn) => ({
      name: fn.name().toString(),

      documentation: fn.doc().toString().trim(),

      inputs: fn.inputs().map((input) => ({
        name: input.name().toString(),

        type: resolveTypeName(input.type()),

        optional: input.type().switch().value === xdr.ScSpecType.scSpecTypeOption().value,
      })),

      outputs: fn.outputs().map(resolveTypeName),
    }));
}

/**
 * Select one discovered method at runtime.
 */
export function selectFunction(
  functions: DiscoveredFunction[],
  functionName: string,
): DiscoveredFunction | null {
  const requestedName = functionName.trim();

  return functions.find((fn) => fn.name === requestedName) ?? null;
}

/**
 * Convert JavaScript argument values into ScVal values using the function
 * definition obtained from the contract specification.
 */
export function encodeDynamicArguments(
  spec: contract.Spec,
  functionName: string,
  suppliedArguments: Record<string, unknown>,
): xdr.ScVal[] {
  const functionSpec = spec.getFunc(functionName);

  const inputs = functionSpec.inputs();

  const expectedNames = inputs.map((input) => input.name().toString());

  const suppliedNames = Object.keys(suppliedArguments);

  const unexpectedNames = suppliedNames.filter((name) => !expectedNames.includes(name));

  if (unexpectedNames.length > 0) {
    throw new Error(
      `Unexpected argument${unexpectedNames.length === 1 ? '' : 's'}: ${unexpectedNames.join(
        ', ',
      )}. Expected: ${expectedNames.length ? expectedNames.join(', ') : '(none)'}.`,
    );
  }

  const normalizedArguments: Record<string, unknown> = {
    ...suppliedArguments,
  };

  for (const input of inputs) {
    const name = input.name().toString();

    if (Object.prototype.hasOwnProperty.call(normalizedArguments, name)) {
      continue;
    }

    const optional = input.type().switch().value === xdr.ScSpecType.scSpecTypeOption().value;

    if (optional) {
      normalizedArguments[name] = undefined;

      continue;
    }

    throw new Error(
      `Missing required argument "${name}". Expected arguments: ${
        expectedNames.length ? expectedNames.join(', ') : '(none)'
      }.`,
    );
  }

  try {
    return spec.funcArgsToScVals(functionName, normalizedArguments);
  } catch (error: unknown) {
    throw new Error(`Could not encode arguments for "${functionName}": ${getErrorMessage(error)}`);
  }
}

/**
 * Decode the return value according to the discovered function specification.
 */
export function decodeDynamicResult(
  spec: contract.Spec,
  functionName: string,
  returnValue: xdr.ScVal,
): unknown {
  try {
    return spec.funcResToNative(functionName, returnValue);
  } catch (error: unknown) {
    throw new Error(
      `Could not decode the return value for "${functionName}": ${getErrorMessage(error)}`,
    );
  }
}

/**
 * Format a discovered function as a readable signature.
 */
export function formatFunctionSignature(fn: DiscoveredFunction): string {
  const argumentsText = fn.inputs
    .map((input) => `${input.name}${input.optional ? '?' : ''}: ${input.type}`)
    .join(', ');

  const returnText = fn.outputs.length > 0 ? fn.outputs.join(', ') : 'void';

  return `${fn.name}(${argumentsText}) -> ${returnText}`;
}

/**
 * Run ISSUE-108.
 */
export async function run(params: DynamicContractInvocationParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl?.trim() || process.env.SOROBAN_RPC_URL?.trim() || DEFAULT_RPC_URL;

  const contractId =
    params.contractId?.trim() || process.env.CONTRACT_ID?.trim() || DEFAULT_CONTRACT_ID;

  const functionName =
    params.functionName?.trim() || process.env.CONTRACT_METHOD?.trim() || DEFAULT_FUNCTION_NAME;

  const rawArguments = params.argsJson ?? process.env.CONTRACT_ARGS ?? DEFAULT_ARGUMENTS_JSON;

  const networkPassphrase =
    params.networkPassphrase?.trim() || process.env.NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;

  console.log(chalk.bold('\nDynamic Soroban Contract Invocation Example'));

  console.log(
    chalk.gray(
      'Discover a deployed contract interface at runtime and invoke it without compile-time method definitions.',
    ),
  );

  console.log(chalk.yellow('\nConfiguration'));

  console.log(`  RPC endpoint : ${rpcUrl}`);

  console.log(`  Contract ID  : ${contractId}`);

  console.log(`  Function     : ${functionName}`);

  console.log(`  Arguments    : ${rawArguments}`);

  if (!StrKey.isValidContract(contractId)) {
    console.error(
      chalk.red(
        '\nInvalid contract ID. Expected a valid Stellar contract address beginning with "C".',
      ),
    );

    return;
  }

  const server = new rpc.Server(rpcUrl);

  // -----------------------------------------------------------------------
  // Step 1: Connect
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 1: Connecting to Soroban RPC...'));

  try {
    const latestLedger = await server.getLatestLedger();

    console.log(chalk.green(`  Connected. Latest ledger sequence: ${latestLedger.sequence}`));
  } catch (error: unknown) {
    console.error(chalk.red(`  Unable to reach Soroban RPC: ${getErrorMessage(error)}`));

    console.log(chalk.gray('  Check SOROBAN_RPC_URL and your network connection.'));

    return;
  }

  // -----------------------------------------------------------------------
  // Step 2: Retrieve and parse specification
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 2: Retrieving and parsing the contract specification...'));

  let spec: contract.Spec;

  try {
    const wasm = await server.getContractWasmByContractId(contractId);

    console.log(chalk.gray(`  Retrieved ${wasm.length.toLocaleString()} WASM bytes.`));

    /*
     * fromWasm() parses the contractspecv0 section embedded in the deployed
     * WASM and exposes the resulting runtime specification as .spec.
     *
     * We only use the generated client to obtain the specification. Contract
     * invocation itself remains fully dynamic.
     */
    const dynamicClient = await contract.Client.fromWasm(wasm, {
      contractId,
      networkPassphrase,
      rpcUrl,
    });

    spec = dynamicClient.spec;

    console.log(chalk.green(`  Parsed ${spec.entries.length} specification entries.`));
  } catch (error: unknown) {
    console.error(
      chalk.red(
        `  Could not retrieve or parse the contract specification: ${getErrorMessage(error)}`,
      ),
    );

    console.log(
      chalk.gray(
        '  Verify that the contract exists on this network and is a WASM-backed Soroban contract.',
      ),
    );

    return;
  }

  // -----------------------------------------------------------------------
  // Step 3: Discover functions
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 3: Discovering available contract methods...'));

  const functions = discoverFunctions(spec);

  if (functions.length === 0) {
    console.error(chalk.red('  No public contract functions were found in the specification.'));

    return;
  }

  console.log(chalk.cyan(`  Available methods (${functions.length}):`));

  functions.forEach((fn, index) => {
    console.log(`    ${index + 1}. ${formatFunctionSignature(fn)}`);

    if (fn.documentation) {
      console.log(chalk.gray(`       ${fn.documentation}`));
    }
  });

  // -----------------------------------------------------------------------
  // Step 4: Dynamic selection
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 4: Selecting a function dynamically...'));

  const selectedFunction = selectFunction(functions, functionName);

  if (!selectedFunction) {
    console.error(
      chalk.red(`  Function "${functionName}" was not found in the contract specification.`),
    );

    console.log(chalk.gray(`  Available functions: ${functions.map((fn) => fn.name).join(', ')}`));

    return;
  }

  console.log(chalk.green(`  Selected function: ${selectedFunction.name}`));

  console.log(chalk.gray(`  Signature: ${formatFunctionSignature(selectedFunction)}`));

  // -----------------------------------------------------------------------
  // Step 5: Inspect arguments
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 5: Inspecting expected arguments...'));

  if (selectedFunction.inputs.length === 0) {
    console.log(chalk.gray('  This function expects no arguments.'));
  } else {
    selectedFunction.inputs.forEach((input, index) => {
      console.log(
        `  [${index}] ${input.name}${input.optional ? '?' : ''}: ${chalk.cyan(input.type)}`,
      );
    });
  }

  console.log(chalk.gray(`  Supplied JavaScript values: ${rawArguments}`));

  // -----------------------------------------------------------------------
  // Step 6: Encode arguments
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 6: Encoding arguments from the discovered specification...'));

  let encodedArguments: xdr.ScVal[];

  try {
    const parsedArguments = parseArgumentJson(rawArguments);

    encodedArguments = encodeDynamicArguments(spec, selectedFunction.name, parsedArguments);
  } catch (error: unknown) {
    console.error(chalk.red(`  Invalid arguments: ${getErrorMessage(error)}`));

    console.log(chalk.gray(`  Expected object shape: ${formatArgumentShape(selectedFunction)}`));

    return;
  }

  console.log(chalk.cyan(`  Encoded arguments (${encodedArguments.length}):`));

  if (encodedArguments.length === 0) {
    console.log(chalk.gray('    (none)'));
  } else {
    encodedArguments.forEach((argument, index) => {
      const expected = selectedFunction.inputs[index];

      console.log(`    [${index}] ${expected.name}`);

      console.log(chalk.gray(`        Expected type : ${expected.type}`));

      console.log(chalk.gray(`        ScVal type    : ${argument.switch().name}`));

      console.log(chalk.gray(`        XDR (base64)  : ${argument.toXDR('base64')}`));
    });
  }

  // -----------------------------------------------------------------------
  // Step 7: Build invocation
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 7: Building the dynamic invocation...'));

  const sourceKeypair = Keypair.random();

  /*
   * This example demonstrates simulation rather than submission, so it does
   * not need to sign or submit the resulting transaction.
   */
  const sourceAccount = new Account(sourceKeypair.publicKey(), '0');

  let transaction;

  try {
    const targetContract = new Contract(contractId);

    const operation = targetContract.call(selectedFunction.name, ...encodedArguments);

    transaction = new TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    console.log(chalk.green('  Contract invocation built successfully.'));

    console.log(chalk.gray(`  Source account : ${sourceKeypair.publicKey()}`));

    console.log(chalk.gray(`  Function       : ${selectedFunction.name}`));

    console.log(chalk.gray(`  Argument count : ${encodedArguments.length}`));
  } catch (error: unknown) {
    console.error(chalk.red(`  Could not build the invocation: ${getErrorMessage(error)}`));

    return;
  }

  // -----------------------------------------------------------------------
  // Step 8: Simulation
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 8: Simulating the invocation...'));

  let simulation: rpc.Api.SimulateTransactionResponse;

  try {
    simulation = await server.simulateTransaction(transaction);
  } catch (error: unknown) {
    console.error(chalk.red(`  Soroban RPC simulation request failed: ${getErrorMessage(error)}`));

    console.log(
      chalk.gray('  Check the contract ID, selected network, RPC endpoint, and argument values.'),
    );

    return;
  }

  console.log(chalk.gray(`  Simulation ledger: ${simulation.latestLedger}`));

  if (rpc.Api.isSimulationError(simulation)) {
    console.log(chalk.red('  Simulation result: FAILED'));

    console.log(chalk.red(`  Error: ${simulation.error}`));

    reportDiagnosticEvents(simulation.events);

    console.log(
      chalk.gray(
        '\n  Troubleshooting: verify the selected function, arguments, contract state, authorization requirements, and network.',
      ),
    );

    return;
  }

  if (rpc.Api.isSimulationRestore(simulation)) {
    console.log(chalk.yellow('  Simulation result: RESTORE REQUIRED'));

    console.log(
      chalk.gray(
        '  The invocation references archived ledger state that must be restored before submission.',
      ),
    );

    console.log(
      chalk.gray(
        `  Restore minimum resource fee: ${simulation.restorePreamble.minResourceFee} stroops`,
      ),
    );
  } else {
    console.log(chalk.green('  Simulation result: SUCCESS'));
  }

  console.log(chalk.gray(`  Estimated Soroban resource fee: ${simulation.minResourceFee} stroops`));

  if (!simulation.result) {
    console.log(chalk.yellow('  Simulation completed without a host-function return value.'));

    reportDiagnosticEvents(simulation.events);

    return;
  }

  // -----------------------------------------------------------------------
  // Step 9: Decode return value
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 9: Decoding the return value using the specification...'));

  const returnValue = simulation.result.retval;

  console.log(chalk.gray(`  Raw ScVal type : ${returnValue.switch().name}`));

  console.log(chalk.gray(`  Raw XDR        : ${returnValue.toXDR('base64')}`));

  try {
    const decodedValue = decodeDynamicResult(spec, selectedFunction.name, returnValue);

    console.log(chalk.green(`  Decoded return value: ${formatNativeValue(decodedValue)}`));
  } catch (error: unknown) {
    console.error(chalk.red(`  ${getErrorMessage(error)}`));

    try {
      const genericDecoded = scValToNative(returnValue);

      console.log(chalk.gray(`  Generic ScVal decode: ${formatNativeValue(genericDecoded)}`));
    } catch {
      console.log(chalk.gray('  The return value could not be decoded generically either.'));
    }

    return;
  }

  reportDiagnosticEvents(simulation.events);

  console.log(chalk.bold.green('\nDynamic contract invocation demonstration complete.'));
}

/**
 * Display the expected JSON argument structure.
 */
function formatArgumentShape(fn: DiscoveredFunction): string {
  if (fn.inputs.length === 0) {
    return '{}';
  }

  const fields = fn.inputs.map((input) => `"${input.name}": <${input.type}>`);

  return `{ ${fields.join(', ')} }`;
}

/**
 * Make SDK-native values JSON-safe.
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
    const output: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = toJsonSafe(entry);
    }

    return output;
  }

  return value;
}

/**
 * Format decoded contract values.
 */
function formatNativeValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  const safeValue = toJsonSafe(value);

  if (typeof safeValue === 'string') {
    return JSON.stringify(safeValue);
  }

  if (safeValue === null || typeof safeValue === 'number' || typeof safeValue === 'boolean') {
    return String(safeValue);
  }

  const json = JSON.stringify(safeValue, null, 2);

  return json ?? String(safeValue);
}

/**
 * Best-effort generic ScVal display.
 */
function formatScVal(value: xdr.ScVal): string {
  try {
    return formatNativeValue(scValToNative(value));
  } catch {
    return `${value.switch().name} (${value.toXDR('base64')})`;
  }
}

/**
 * Display diagnostic events when available.
 *
 * ContractEvent.contractID is an XDR Hash in the Protocol 26 SDK. We do not
 * need to manually reinterpret that XDR hash for this example, so the
 * diagnostic report focuses on status, event type, topics, and event data.
 */
function reportDiagnosticEvents(events: xdr.DiagnosticEvent[]): void {
  console.log(chalk.yellow(`\nDiagnostic events (${events.length})`));

  if (events.length === 0) {
    console.log(chalk.gray('  No diagnostic events were returned.'));

    return;
  }

  events.forEach((diagnostic, index) => {
    try {
      const event = diagnostic.event();

      const successful = diagnostic.inSuccessfulContractCall();

      const status = successful ? chalk.green('success') : chalk.red('failure');

      console.log(`  [${index}] ${status} | type=${event.type().name}`);

      const body = event.body().v0();

      const topics = body.topics();

      if (topics.length > 0) {
        console.log(chalk.gray('      Topics:'));

        topics.forEach((topic, topicIndex) => {
          console.log(chalk.gray(`        [${topicIndex}] ${formatScVal(topic)}`));
        });
      }

      console.log(chalk.gray(`      Data: ${formatScVal(body.data())}`));
    } catch (error: unknown) {
      console.log(
        chalk.gray(`  [${index}] Could not decode diagnostic event: ${getErrorMessage(error)}`),
      );
    }
  });
}

/**
 * Safely obtain an error message.
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
