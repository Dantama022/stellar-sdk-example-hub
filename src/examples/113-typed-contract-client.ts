import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  Address,
  contract,
  Keypair,
  Networks,
  Operation,
  rpc,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Example 113: Soroban Typed Contract Client Generation
 *
 * Soroban contracts can embed an ScSpec contract specification in their WASM.
 * The specification describes exported functions, argument types, return
 * types, structs, enums, unions, and contract errors.
 *
 * The Stellar JavaScript SDK can consume that specification and construct a
 * contract.Client whose methods correspond to the contract's exported
 * functions.
 *
 * This example demonstrates:
 *
 *   1. Connecting to Soroban RPC.
 *   2. Accepting an optional deployed contract ID.
 *   3. Deploying a bundled example contract when no ID is supplied.
 *   4. Retrieving the deployed contract WASM through Soroban RPC.
 *   5. Retrieving and parsing its embedded contract specification.
 *   6. Displaying functions, argument types, return types, and custom types.
 *   7. Constructing a TypeScript-style typed client interface.
 *   8. Demonstrating typed JavaScript argument -> ScVal conversion.
 *   9. Demonstrating a generated SDK contract method.
 *  10. Demonstrating developer-friendly decoded return values.
 *  11. Handling invalid IDs and unusable specifications gracefully.
 *
 * The repository's own upgradeable_v1.wasm is used as the default fixture so
 * the example does not depend on a third-party Testnet deployment remaining
 * alive indefinitely.
 *
 * Compatibility note:
 *
 * This repository currently uses @stellar/stellar-sdk 13.x. Current Testnet
 * transaction metadata is newer than the TransactionMeta schema bundled with
 * that SDK. Therefore submitted transactions are polled through raw JSON-RPC
 * for status only. We deliberately do not decode resultMetaXdr because this
 * example does not need transaction metadata.
 */

const DEFAULT_RPC_URL =
  'https://soroban-testnet.stellar.org';

const FRIEND_BOT_URL =
  'https://friendbot.stellar.org';

const NETWORK_PASSPHRASE =
  Networks.TESTNET;

const BASE_FEE =
  '100000';

const BUNDLED_WASM_PATH =
  path.join(
    __dirname,
    '../contracts/sample-v1/upgradeable_v1.wasm',
  );

export interface TypedContractClientParams {
  contractId?: string;
  rpcUrl?: string;
}

export interface ParsedArgument {
  name: string;
  type: string;
}

export interface ParsedFunction {
  name: string;
  documentation: string;
  inputs: ParsedArgument[];
  outputs: string[];
}

export interface ParsedCustomType {
  kind: string;
  name: string;
}

interface RawRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface RawRpcEnvelope<T> {
  jsonrpc?: string;
  id?: number | string;
  result?: T;
  error?: RawRpcError;
}

interface RawTransactionStatus {
  status: 'SUCCESS' | 'NOT_FOUND' | 'FAILED' | string;
  txHash?: string;
  latestLedger?: number;
  ledger?: number;
  resultXdr?: string;
  diagnosticEventsXdr?: string[];
}

/**
 * Produce a readable error from either Error instances or RPC response
 * objects.
 */
function errorMessage(
  error: unknown,
): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    error !== null &&
    typeof error === 'object'
  ) {
    try {
      return JSON.stringify(
        error,
        null,
        2,
      );
    } catch {
      return String(error);
    }
  }

  return String(error);
}

/**
 * Validate a Soroban contract StrKey.
 */
export function normalizeContractId(
  value: string,
): string {
  const trimmed =
    value.trim();

  if (!trimmed) {
    throw new Error(
      'Missing contract ID.',
    );
  }

  if (
    !StrKey.isValidContract(
      trimmed,
    )
  ) {
    throw new Error(
      `Invalid Soroban contract ID "${trimmed}".`,
    );
  }

  return trimmed;
}

/**
 * Compute the hash used when installing/deploying contract WASM.
 */
export function computeWasmHash(
  wasm: Buffer,
): Buffer {
  return createHash('sha256')
    .update(wasm)
    .digest();
}

/**
 * Load the repository's bundled example contract.
 */
function loadBundledWasm(): Buffer {
  if (
    !fs.existsSync(
      BUNDLED_WASM_PATH,
    )
  ) {
    throw new Error(
      `Bundled contract WASM was not found at ${BUNDLED_WASM_PATH}`,
    );
  }

  const wasm =
    fs.readFileSync(
      BUNDLED_WASM_PATH,
    );

  if (
    wasm.length <= 8
  ) {
    throw new Error(
      'Bundled WASM is too small to be a usable Soroban contract.',
    );
  }

  return wasm;
}

/**
 * Fund a temporary Testnet account through Friendbot.
 */
async function fundAccount(
  keypair: Keypair,
): Promise<void> {
  const response =
    await fetch(
      `${FRIEND_BOT_URL}/?addr=${keypair.publicKey()}`,
    );

  if (!response.ok) {
    throw new Error(
      `Friendbot funding failed with HTTP ${response.status}.`,
    );
  }
}

/**
 * Make a raw JSON-RPC request.
 *
 * This is used only for getTransaction status polling. Transaction creation,
 * simulation, assembly and submission continue to use the Stellar SDK.
 */
async function rawRpcCall<T>(
  rpcUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const response =
    await fetch(
      rpcUrl,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',
        },

        body:
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            params,
          }),
      },
    );

  if (!response.ok) {
    throw new Error(
      `RPC ${method} returned HTTP ${response.status}.`,
    );
  }

  const envelope =
    (await response.json()) as
      RawRpcEnvelope<T>;

  if (envelope.error) {
    throw new Error(
      `RPC ${method} failed (${envelope.error.code}): ${envelope.error.message}`,
    );
  }

  if (
    envelope.result ===
    undefined
  ) {
    throw new Error(
      `RPC ${method} returned no result.`,
    );
  }

  return envelope.result;
}

/**
 * Poll getTransaction using raw JSON-RPC.
 *
 * SDK 13.x attempts to deserialize resultMetaXdr when a transaction is found.
 * Current Testnet can return a newer TransactionMeta union variant that this
 * repository's installed XDR schema does not understand.
 *
 * We need only SUCCESS/FAILED status here, so reading the raw RPC response
 * avoids decoding transaction metadata unnecessarily.
 */
async function pollTransactionStatusRaw(
  rpcUrl: string,
  hash: string,
  attempts = 30,
): Promise<RawTransactionStatus> {
  for (
    let attempt = 1;
    attempt <= attempts;
    attempt += 1
  ) {
    const transaction =
      await rawRpcCall<
        RawTransactionStatus
      >(
        rpcUrl,
        'getTransaction',
        {
          hash,
        },
      );

    if (
      transaction.status ===
      'SUCCESS'
    ) {
      return transaction;
    }

    if (
      transaction.status ===
      'FAILED'
    ) {
      throw new Error(
        `Transaction ${hash} failed on ledger ${
          transaction.ledger ??
          'unknown'
        }.`,
      );
    }

    if (
      transaction.status !==
      'NOT_FOUND'
    ) {
      throw new Error(
        `Transaction ${hash} returned unexpected status "${transaction.status}".`,
      );
    }

    await new Promise<void>(
      (resolve) => {
        setTimeout(
          resolve,
          1000,
        );
      },
    );
  }

  throw new Error(
    `Transaction ${hash} was not confirmed after ${attempts} polling attempts.`,
  );
}

/**
 * Build, simulate, assemble, sign, submit and confirm one Soroban operation.
 */
async function submitSorobanOperation(
  server: rpc.Server,
  rpcUrl: string,
  signer: Keypair,
  operation: xdr.Operation,
): Promise<
  rpc.Api.SimulateTransactionSuccessResponse
> {
  const account =
    await server.getAccount(
      signer.publicKey(),
    );

  let transaction =
    new TransactionBuilder(
      account,
      {
        fee: BASE_FEE,

        networkPassphrase:
          NETWORK_PASSPHRASE,
      },
    )
      .addOperation(
        operation,
      )
      .setTimeout(60)
      .build();

  const simulation =
    await server.simulateTransaction(
      transaction,
    );

  if (
    rpc.Api.isSimulationError(
      simulation,
    )
  ) {
    throw new Error(
      `Simulation failed: ${simulation.error}`,
    );
  }

  if (
    !rpc.Api.isSimulationSuccess(
      simulation,
    )
  ) {
    throw new Error(
      'Soroban RPC returned an unexpected simulation response.',
    );
  }

  transaction =
    rpc
      .assembleTransaction(
        transaction,
        simulation,
      )
      .build();

  transaction.sign(
    signer,
  );

  const submission =
    await server.sendTransaction(
      transaction,
    );

  if (
    submission.status ===
    'ERROR'
  ) {
    throw new Error(
      'Soroban transaction submission failed.',
    );
  }

  console.log(
    chalk.gray(
      `  Submitted transaction: ${submission.hash}`,
    ),
  );

  const confirmation =
    await pollTransactionStatusRaw(
      rpcUrl,
      submission.hash,
    );

  console.log(
    chalk.gray(
      `  Confirmed on ledger: ${
        confirmation.ledger ??
        confirmation.latestLedger ??
        'unknown'
      }`,
    ),
  );

  return simulation;
}

/**
 * Extract a deployed contract address from createCustomContract simulation.
 */
function contractIdFromSimulation(
  simulation:
    rpc.Api.SimulateTransactionSuccessResponse,
): string {
  const returnValue =
    simulation.result?.retval;

  if (!returnValue) {
    throw new Error(
      'Contract deployment simulation did not return a contract address.',
    );
  }

  return Address
    .fromScVal(
      returnValue,
    )
    .toString();
}

/**
 * Deploy the bundled example contract.
 */
async function deployBundledContract(
  server: rpc.Server,
  rpcUrl: string,
): Promise<{
  contractId: string;
  deployer: Keypair;
}> {
  console.log(
    chalk.yellow(
      '\nNo contract ID supplied.',
    ),
  );

  console.log(
    chalk.gray(
      'Deploying the repository\'s bundled upgradeable_v1.wasm so this example does not depend on an expiring external Testnet contract.',
    ),
  );

  const deployer =
    Keypair.random();

  console.log(
    `  Deployer     : ${deployer.publicKey()}`,
  );

  console.log(
    '  Funding temporary Testnet account...',
  );

  await fundAccount(
    deployer,
  );

  console.log(
    chalk.green(
      '  Temporary deployer funded.',
    ),
  );

  const wasm =
    loadBundledWasm();

  const wasmHash =
    computeWasmHash(
      wasm,
    );

  console.log(
    `  Bundled WASM : ${BUNDLED_WASM_PATH}`,
  );

  console.log(
    `  WASM size    : ${wasm.length.toLocaleString()} bytes`,
  );

  console.log(
    `  WASM hash    : ${wasmHash.toString('hex')}`,
  );

  // -----------------------------------------------------------------------
  // Install WASM.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nInstalling bundled WASM...',
    ),
  );

  await submitSorobanOperation(
    server,
    rpcUrl,
    deployer,
    Operation.uploadContractWasm({
      wasm,
    }),
  );

  console.log(
    chalk.green(
      'WASM installation confirmed.',
    ),
  );

  // -----------------------------------------------------------------------
  // Deploy a contract instance.
  //
  // The bundled v1 contract constructor receives its administrator address.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nDeploying fresh contract instance...',
    ),
  );

  const deploymentSimulation =
    await submitSorobanOperation(
      server,
      rpcUrl,
      deployer,

      Operation.createCustomContract({
        address:
          Address.fromString(
            deployer.publicKey(),
          ),

        wasmHash,

        salt:
          randomBytes(32),

        constructorArgs: [
          Address
            .fromString(
              deployer.publicKey(),
            )
            .toScVal(),
        ],
      }),
    );

  const contractId =
    contractIdFromSimulation(
      deploymentSimulation,
    );

  console.log(
    chalk.green(
      'Contract deployment confirmed.',
    ),
  );

  console.log(
    `  Contract ID  : ${contractId}`,
  );

  return {
    contractId,
    deployer,
  };
}

/**
 * Convert an ScSpec type definition into readable Soroban notation.
 */
export function resolveTypeName(
  typeDef: xdr.ScSpecTypeDef,
): string {
  const value =
    typeDef.switch().value;

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeVal()
      .value
  ) {
    return 'val';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeBool()
      .value
  ) {
    return 'bool';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeVoid()
      .value
  ) {
    return 'void';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeError()
      .value
  ) {
    return 'error';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeU32()
      .value
  ) {
    return 'u32';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeI32()
      .value
  ) {
    return 'i32';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeU64()
      .value
  ) {
    return 'u64';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeI64()
      .value
  ) {
    return 'i64';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeTimepoint()
      .value
  ) {
    return 'timepoint';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeDuration()
      .value
  ) {
    return 'duration';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeU128()
      .value
  ) {
    return 'u128';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeI128()
      .value
  ) {
    return 'i128';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeU256()
      .value
  ) {
    return 'u256';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeI256()
      .value
  ) {
    return 'i256';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeBytes()
      .value
  ) {
    return 'bytes';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeString()
      .value
  ) {
    return 'string';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeSymbol()
      .value
  ) {
    return 'symbol';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeAddress()
      .value
  ) {
    return 'address';
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeOption()
      .value
  ) {
    return `Option<${resolveTypeName(
      typeDef
        .option()
        .valueType(),
    )}>`;
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeResult()
      .value
  ) {
    return `Result<${resolveTypeName(
      typeDef
        .result()
        .okType(),
    )}, ${resolveTypeName(
      typeDef
        .result()
        .errorType(),
    )}>`;
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeVec()
      .value
  ) {
    return `Vec<${resolveTypeName(
      typeDef
        .vec()
        .elementType(),
    )}>`;
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeMap()
      .value
  ) {
    return `Map<${resolveTypeName(
      typeDef
        .map()
        .keyType(),
    )}, ${resolveTypeName(
      typeDef
        .map()
        .valueType(),
    )}>`;
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeTuple()
      .value
  ) {
    return `Tuple<${typeDef
      .tuple()
      .valueTypes()
      .map(
        resolveTypeName,
      )
      .join(', ')}>`;
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeBytesN()
      .value
  ) {
    return `BytesN<${
      typeDef
        .bytesN()
        .n()
    }>`;
  }

  if (
    value ===
    xdr.ScSpecType
      .scSpecTypeUdt()
      .value
  ) {
    return typeDef
      .udt()
      .name()
      .toString();
  }

  return 'unknown';
}

/**
 * Parse one function from the contract specification.
 */
export function parseFunction(
  fn: xdr.ScSpecFunctionV0,
): ParsedFunction {
  return {
    name:
      fn.name().toString(),

    documentation:
      fn.doc().toString().trim(),

    inputs:
      fn.inputs().map(
        (input) => ({
          name:
            input
              .name()
              .toString(),

          type:
            resolveTypeName(
              input.type(),
            ),
        }),
      ),

    outputs:
      fn.outputs().map(
        resolveTypeName,
      ),
  };
}

/**
 * Parse custom struct/enum/union/error type names.
 */
export function parseCustomTypes(
  spec: contract.Spec,
): ParsedCustomType[] {
  const customTypes:
    ParsedCustomType[] = [];

  for (
    const entry of
      spec.entries
  ) {
    const kind =
      entry.switch().value;

    if (
      kind ===
      xdr.ScSpecEntryKind
        .scSpecEntryUdtStructV0()
        .value
    ) {
      customTypes.push({
        kind: 'struct',

        name:
          entry
            .udtStructV0()
            .name()
            .toString(),
      });

      continue;
    }

    if (
      kind ===
      xdr.ScSpecEntryKind
        .scSpecEntryUdtEnumV0()
        .value
    ) {
      customTypes.push({
        kind: 'enum',

        name:
          entry
            .udtEnumV0()
            .name()
            .toString(),
      });

      continue;
    }

    if (
      kind ===
      xdr.ScSpecEntryKind
        .scSpecEntryUdtUnionV0()
        .value
    ) {
      customTypes.push({
        kind: 'union',

        name:
          entry
            .udtUnionV0()
            .name()
            .toString(),
      });

      continue;
    }

    if (
      kind ===
      xdr.ScSpecEntryKind
        .scSpecEntryUdtErrorEnumV0()
        .value
    ) {
      customTypes.push({
        kind:
          'contract-error enum',

        name:
          entry
            .udtErrorEnumV0()
            .name()
            .toString(),
      });
    }
  }

  return customTypes;
}

/**
 * Render a method signature.
 */
export function formatMethodSignature(
  fn: ParsedFunction,
): string {
  const args =
    fn.inputs
      .map(
        (input) =>
          `${input.name}: ${input.type}`,
      )
      .join(', ');

  const output =
    fn.outputs.length > 0
      ? fn.outputs.join(', ')
      : 'void';

  return `${fn.name}(${args}) -> ${output}`;
}

/**
 * Convert common Soroban types into TypeScript-style types.
 */
export function toTypeScriptType(
  type: string,
): string {
  const primitives:
    Record<string, string> = {
      val: 'unknown',
      bool: 'boolean',
      void: 'void',
      error: 'unknown',

      u32: 'number',
      i32: 'number',

      u64: 'bigint',
      i64: 'bigint',

      u128: 'bigint',
      i128: 'bigint',

      u256: 'bigint',
      i256: 'bigint',

      timepoint: 'bigint',
      duration: 'bigint',

      bytes: 'Buffer',

      string: 'string',
      symbol: 'string',
      address: 'string',
    };

  if (
    primitives[type]
  ) {
    return primitives[type];
  }

  if (
    type.startsWith('Vec<') &&
    type.endsWith('>')
  ) {
    return `Array<${toTypeScriptType(
      type.slice(
        4,
        -1,
      ),
    )}>`;
  }

  if (
    type.startsWith(
      'Option<',
    ) &&
    type.endsWith('>')
  ) {
    return `${toTypeScriptType(
      type.slice(
        7,
        -1,
      ),
    )} | undefined`;
  }

  if (
    type.startsWith(
      'BytesN<',
    )
  ) {
    return 'Buffer';
  }

  if (
    type.startsWith(
      'Tuple<',
    )
  ) {
    return 'unknown[]';
  }

  if (
    type.startsWith(
      'Map<',
    )
  ) {
    return 'Map<unknown, unknown>';
  }

  if (
    type.startsWith(
      'Result<',
    )
  ) {
    return 'unknown';
  }

  // User-defined type.
  return type;
}

/**
 * Build a readable TypeScript-style client definition from the spec.
 */
export function buildTypedInterface(
  functions:
    ParsedFunction[],
): string {
  const lines: string[] = [
    'interface GeneratedContractClient extends contract.Client {',
  ];

  for (
    const fn of
      functions
  ) {
    if (
      fn.name ===
      '__constructor'
    ) {
      continue;
    }

    let resultType =
      'void';

    if (
      fn.outputs.length === 1
    ) {
      resultType =
        toTypeScriptType(
          fn.outputs[0],
        );
    } else if (
      fn.outputs.length > 1
    ) {
      resultType =
        `[${fn.outputs
          .map(
            toTypeScriptType,
          )
          .join(', ')}]`;
    }

    if (
      fn.inputs.length === 0
    ) {
      lines.push(
        `  ${fn.name}(options?: contract.MethodOptions): Promise<contract.AssembledTransaction<${resultType}>>;`,
      );

      continue;
    }

    lines.push(
      `  ${fn.name}(`,
    );

    lines.push(
      '    args: {',
    );

    for (
      const input of
        fn.inputs
    ) {
      lines.push(
        `      ${input.name}: ${toTypeScriptType(
          input.type,
        )};`,
      );
    }

    lines.push(
      '    },',
    );

    lines.push(
      '    options?: contract.MethodOptions,',
    );

    lines.push(
      `  ): Promise<contract.AssembledTransaction<${resultType}>>;`,
    );
  }

  lines.push('}');

  return lines.join('\n');
}

/**
 * Produce a safe example JavaScript value for selected ScSpec primitive types.
 *
 * It is used for argument encoding only. We do not submit the state-changing
 * operation chosen for this demonstration.
 */
function sampleValueForType(
  typeDef: xdr.ScSpecTypeDef,
  address: string,
): unknown {
  const type =
    typeDef.switch().value;

  if (
    type ===
    xdr.ScSpecType
      .scSpecTypeAddress()
      .value
  ) {
    return address;
  }

  if (
    type ===
    xdr.ScSpecType
      .scSpecTypeString()
      .value
  ) {
    return 'typed-client';
  }

  if (
    type ===
    xdr.ScSpecType
      .scSpecTypeSymbol()
      .value
  ) {
    return 'typed_demo';
  }

  if (
    type ===
    xdr.ScSpecType
      .scSpecTypeU32()
      .value
  ) {
    return 7;
  }

  if (
    type ===
    xdr.ScSpecType
      .scSpecTypeI32()
      .value
  ) {
    return -7;
  }

  if (
    type ===
      xdr.ScSpecType
        .scSpecTypeU64()
        .value ||
    type ===
      xdr.ScSpecType
        .scSpecTypeU128()
        .value ||
    type ===
      xdr.ScSpecType
        .scSpecTypeU256()
        .value
  ) {
    return 7n;
  }

  if (
    type ===
      xdr.ScSpecType
        .scSpecTypeI64()
        .value ||
    type ===
      xdr.ScSpecType
        .scSpecTypeI128()
        .value ||
    type ===
      xdr.ScSpecType
        .scSpecTypeI256()
        .value
  ) {
    return -7n;
  }

  if (
    type ===
    xdr.ScSpecType
      .scSpecTypeBytes()
      .value
  ) {
    return Buffer.from(
      'typed-client',
      'utf8',
    );
  }

  if (
    type ===
    xdr.ScSpecType
      .scSpecTypeBytesN()
      .value
  ) {
    return Buffer.alloc(
      typeDef
        .bytesN()
        .n(),
      0xab,
    );
  }

  throw new Error(
    `No generic demonstration value is configured for ${resolveTypeName(
      typeDef,
    )}.`,
  );
}

/**
 * Choose a simple function for demonstrating typed argument conversion.
 *
 * upgrade(BytesN<32>) is preferred for the bundled contract. It is not
 * submitted here because Issue 114 owns the contract-upgrade workflow.
 */
function findTypedArgumentFunction(
  spec: contract.Spec,
): xdr.ScSpecFunctionV0 | null {
  const functions =
    spec.funcs();

  const upgrade =
    functions.find(
      (fn) =>
        fn.name().toString() ===
          'upgrade' &&
        fn.inputs().length === 1,
    );

  if (upgrade) {
    return upgrade;
  }

  return (
    functions.find(
      (fn) =>
        fn.name().toString() !==
          '__constructor' &&
        fn.inputs().length === 1,
    ) ?? null
  );
}

/**
 * Render native JS values safely.
 */
function displayValue(
  value: unknown,
): string {
  if (
    Buffer.isBuffer(value)
  ) {
    return `Buffer<${value.toString(
      'hex',
    )}>`;
  }

  if (
    typeof value ===
    'bigint'
  ) {
    return `${value.toString()}n`;
  }

  if (
    typeof value ===
    'string'
  ) {
    return JSON.stringify(
      value,
    );
  }

  if (
    value !== null &&
    typeof value ===
      'object'
  ) {
    return JSON.stringify(
      value,
      (
        _key,
        item,
      ) => {
        if (
          typeof item ===
          'bigint'
        ) {
          return `${item.toString()}n`;
        }

        return item;
      },
      2,
    );
  }

  return String(value);
}

/**
 * Call a dynamically generated zero-argument method.
 *
 * The bundled contract exposes version() -> u32.
 */
async function demonstrateGeneratedMethod(
  client: contract.Client,
  functions:
    ParsedFunction[],
): Promise<void> {
  const selected =
    functions.find(
      (fn) =>
        fn.name ===
          'version' &&
        fn.inputs.length === 0,
    ) ||
    functions.find(
      (fn) =>
        fn.name !==
          '__constructor' &&
        fn.inputs.length === 0,
    );

  if (!selected) {
    console.log(
      chalk.yellow(
        'No zero-argument method is available for a safe generic invocation demonstration.',
      ),
    );

    return;
  }

  const dynamicClient =
    client as unknown as Record<
      string,
      (
        options?:
          contract.MethodOptions,
      ) => Promise<
        contract.AssembledTransaction<unknown>
      >
    >;

  const method =
    dynamicClient[
      selected.name
    ];

  if (
    typeof method !==
    'function'
  ) {
    throw new Error(
      `Generated client method "${selected.name}" was not found.`,
    );
  }

  const assembled =
    await method.call(
      client,
    );

  console.log(
    `  Contract method : ${selected.name}`,
  );

  console.log(
    '  Arguments       : none',
  );

  console.log(
    `  Return type     : ${
      selected.outputs.length > 0
        ? selected.outputs.join(
            ', ',
          )
        : 'void'
    }`,
  );

  console.log(
    `  Decoded return  : ${displayValue(
      assembled.result,
    )}`,
  );

  console.log(
    `  JavaScript type : ${
      Array.isArray(
        assembled.result,
      )
        ? 'array'
        : typeof assembled.result
    }`,
  );

  console.log(
    chalk.green(
      '  Generated client invocation simulated successfully.',
    ),
  );
}

/**
 * Run Example 113.
 */
export async function run(
  params:
    TypedContractClientParams = {},
): Promise<void> {
  console.log(
    chalk.bold(
      'Soroban Typed Contract Client Generation Example',
    ),
  );

  console.log(
    chalk.gray(
      'Discover a deployed contract specification, construct a client from it, encode typed arguments, and decode typed return values.',
    ),
  );

  const rpcUrl =
    params.rpcUrl ||
    process.env.SOROBAN_RPC_URL ||
    DEFAULT_RPC_URL;

  const suppliedContractId =
    params.contractId?.trim() ||
    process.env.CONTRACT_ID?.trim() ||
    process.argv[3]?.trim();

  const server =
    new rpc.Server(
      rpcUrl,
    );

  // -----------------------------------------------------------------------
  // Step 1: Connect to Soroban RPC.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 1: Connecting to Soroban RPC...',
    ),
  );

  try {
    const latest =
      await server.getLatestLedger();

    console.log(
      chalk.green(
        `Connected. Latest ledger: ${latest.sequence}`,
      ),
    );
  } catch (error: unknown) {
    console.error(
      chalk.red(
        `RPC connection failed: ${errorMessage(
          error,
        )}`,
      ),
    );

    return;
  }

  console.log(
    '  Network     : Testnet',
  );

  console.log(
    `  Soroban RPC : ${rpcUrl}`,
  );

  // -----------------------------------------------------------------------
  // Step 2: Identify or deploy the contract.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 2: Resolving contract...',
    ),
  );

  let contractId:
    string;

  let demonstrationAddress =
    Keypair.random()
      .publicKey();

  if (
    suppliedContractId
  ) {
    try {
      contractId =
        normalizeContractId(
          suppliedContractId,
        );
    } catch (error: unknown) {
      console.error(
        chalk.red(
          errorMessage(error),
        ),
      );

      console.log(
        chalk.gray(
          'Use a valid StrKey-encoded Soroban contract ID beginning with "C".',
        ),
      );

      return;
    }

    console.log(
      `  Contract ID : ${contractId}`,
    );

    console.log(
      '  Source      : user supplied',
    );
  } else {
    try {
      const deployment =
        await deployBundledContract(
          server,
          rpcUrl,
        );

      contractId =
        deployment.contractId;

      demonstrationAddress =
        deployment.deployer
          .publicKey();
    } catch (error: unknown) {
      console.error(
        chalk.red(
          `Could not create self-contained demonstration contract: ${errorMessage(
            error,
          )}`,
        ),
      );

      return;
    }
  }

  // -----------------------------------------------------------------------
  // Step 3: Retrieve the deployed contract WASM from RPC.
  //
  // Even for our newly deployed fixture we fetch it from the network again.
  // This demonstrates the requested deployed-contract -> specification flow.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 3: Retrieving deployed contract WASM...',
    ),
  );

  let deployedWasm:
    Buffer;

  try {
    deployedWasm =
      await server
        .getContractWasmByContractId(
          contractId,
        );

    console.log(
      chalk.green(
        `WASM retrieved from Soroban RPC (${deployedWasm.length.toLocaleString()} bytes).`,
      ),
    );
  } catch (error: unknown) {
    console.error(
      chalk.red(
        'Could not retrieve deployed contract WASM.',
      ),
    );

    console.log(
      chalk.gray(
        `  Diagnostic: ${errorMessage(
          error,
        )}`,
      ),
    );

    console.log(
      chalk.gray(
        'The contract may not exist, may have expired, or may not be a WASM-backed Soroban contract.',
      ),
    );

    return;
  }

  // -----------------------------------------------------------------------
  // Step 4: Construct SDK client from the retrieved specification.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 4: Retrieving contract specification and constructing client...',
    ),
  );

  let client:
    contract.Client;

  try {
    client =
      await contract.Client.fromWasm(
        deployedWasm,
        {
          contractId,

          networkPassphrase:
            NETWORK_PASSPHRASE,

          rpcUrl,
        },
      );
  } catch (error: unknown) {
    console.error(
      chalk.yellow(
        'The contract does not contain a usable Soroban specification.',
      ),
    );

    console.log(
      chalk.gray(
        `  Diagnostic: ${errorMessage(
          error,
        )}`,
      ),
    );

    console.log(
      chalk.gray(
        'Without ScSpec metadata, tooling cannot automatically derive method names, arguments, return types, or generated bindings.',
      ),
    );

    return;
  }

  const spec =
    client.spec;

  if (
    !spec ||
    spec.entries.length === 0
  ) {
    console.log(
      chalk.yellow(
        'Contract specification is empty.',
      ),
    );

    return;
  }

  console.log(
    chalk.green(
      `Contract specification loaded (${spec.entries.length} entries).`,
    ),
  );

  // -----------------------------------------------------------------------
  // Step 5: Parse and display methods.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 5: Parsing contract methods...',
    ),
  );

  const functions =
    spec
      .funcs()
      .map(
        parseFunction,
      );

  console.log(
    `  Contract ID       : ${contractId}`,
  );

  console.log(
    `  Available methods : ${functions.length}`,
  );

  if (
    functions.length === 0
  ) {
    console.log(
      chalk.yellow(
        'No callable functions were found in the contract specification.',
      ),
    );

    return;
  }

  for (
    const fn of
      functions
  ) {
    console.log(
      `\n  ${chalk.cyan(
        formatMethodSignature(
          fn,
        ),
      )}`,
    );

    if (
      fn.inputs.length === 0
    ) {
      console.log(
        chalk.gray(
          '    Argument types : none',
        ),
      );
    } else {
      console.log(
        chalk.gray(
          '    Argument types :',
        ),
      );

      for (
        const input of
          fn.inputs
      ) {
        console.log(
          chalk.gray(
            `      - ${input.name}: ${input.type}`,
          ),
        );
      }
    }

    console.log(
      chalk.gray(
        `    Return type${
          fn.outputs.length === 1
            ? ''
            : 's'
        }   : ${
          fn.outputs.length > 0
            ? fn.outputs.join(
                ', ',
              )
            : 'void'
        }`,
      ),
    );

    if (
      fn.documentation
    ) {
      console.log(
        chalk.gray(
          `    Documentation : ${fn.documentation}`,
        ),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Step 6: Parse custom types.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 6: Parsing custom contract types...',
    ),
  );

  const customTypes =
    parseCustomTypes(
      spec,
    );

  if (
    customTypes.length === 0
  ) {
    console.log(
      chalk.gray(
        '  No custom structs, enums, unions, or contract-error enums are declared.',
      ),
    );
  } else {
    for (
      const item of
        customTypes
    ) {
      console.log(
        `  ${item.kind}: ${item.name}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Step 7: Construct a TypeScript-style typed interface.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 7: Constructing typed client interface...',
    ),
  );

  console.log();

  console.log(
    buildTypedInterface(
      functions,
    ),
  );

  console.log(
    chalk.green(
      '\nTyped interface constructed from the deployed contract specification.',
    ),
  );

  // -----------------------------------------------------------------------
  // Step 8: Verify dynamically generated SDK client methods.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 8: Verifying generated SDK client methods...',
    ),
  );

  const generatedMethods =
    functions
      .filter(
        (fn) =>
          fn.name !==
          '__constructor',
      )
      .filter(
        (fn) =>
          typeof (
            client as unknown as Record<
              string,
              unknown
            >
          )[fn.name] ===
          'function',
      )
      .map(
        (fn) =>
          fn.name,
      );

  console.log(
    `  Generated methods: ${
      generatedMethods.length > 0
        ? generatedMethods.join(
            ', ',
          )
        : '(none)'
    }`,
  );

  if (
    generatedMethods.length === 0
  ) {
    console.log(
      chalk.yellow(
        'No generated client methods were available.',
      ),
    );

    return;
  }

  // -----------------------------------------------------------------------
  // Step 9: Typed argument handling.
  //
  // For the bundled contract this normally selects upgrade(BytesN<32>).
  // The resulting ScVal is displayed but the state-changing operation is not
  // submitted because Issue 114 owns the upgrade workflow.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 9: Demonstrating typed argument handling...',
    ),
  );

  const typedFunction =
    findTypedArgumentFunction(
      spec,
    );

  if (!typedFunction) {
    console.log(
      chalk.gray(
        'No suitable single-argument function was available for this generic typed-argument demonstration.',
      ),
    );
  } else {
    const functionName =
      typedFunction
        .name()
        .toString();

    const input =
      typedFunction
        .inputs()[0];

    const argumentName =
      input
        .name()
        .toString();

    const argumentType =
      resolveTypeName(
        input.type(),
      );

    try {
      const nativeValue =
        sampleValueForType(
          input.type(),
          demonstrationAddress,
        );

      const typedArguments:
        Record<string, unknown> = {
          [argumentName]:
            nativeValue,
        };

      const encoded =
        spec.funcArgsToScVals(
          functionName,
          typedArguments,
        );

      console.log(
        `  Contract method : ${functionName}`,
      );

      console.log(
        `  Argument        : ${argumentName}`,
      );

      console.log(
        `  Argument type   : ${argumentType}`,
      );

      console.log(
        `  Native JS value : ${displayValue(
          nativeValue,
        )}`,
      );

      console.log(
        `  Encoded ScVals  : ${encoded.length}`,
      );

      encoded.forEach(
        (
          scVal,
          index,
        ) => {
          console.log(
            `    [${index}] ${scVal.switch().name}`,
          );
        },
      );

      console.log(
        chalk.green(
          '  Typed JavaScript argument encoded successfully using the contract specification.',
        ),
      );

      console.log(
        chalk.gray(
          '  The state-changing operation is not submitted here; Example 114 demonstrates the complete upgrade workflow.',
        ),
      );
    } catch (error: unknown) {
      console.log(
        chalk.yellow(
          `Typed argument demonstration skipped: ${errorMessage(
            error,
          )}`,
        ),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Step 10: Invoke a generated method and decode its return value.
  //
  // The bundled contract exposes version() -> u32.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 10: Calling generated contract method...',
    ),
  );

  try {
    await demonstrateGeneratedMethod(
      client,
      functions,
    );
  } catch (error: unknown) {
    console.error(
      chalk.red(
        `Generated method simulation failed: ${errorMessage(
          error,
        )}`,
      ),
    );

    return;
  }

  // -----------------------------------------------------------------------
  // Explanation.
  // -----------------------------------------------------------------------

  console.log(
    chalk.cyan(
      '\nContract specifications and typed clients:\n' +
        '  - Soroban WASM can embed ScSpec metadata describing the public contract interface.\n' +
        '  - That specification identifies available methods, arguments, return values, and custom types.\n' +
        '  - contract.Client reads the specification and creates matching JavaScript methods dynamically.\n' +
        '  - contract.Spec.funcArgsToScVals converts developer-friendly JavaScript arguments into the exact ScVal values expected by the contract.\n' +
        '  - contract.Spec.funcResToNative converts returned ScVal values back into developer-friendly JavaScript values.\n' +
        '  - Generated TypeScript bindings use the same specification to provide compile-time method names, autocomplete, argument checking, and return types.\n' +
        '  - This reduces the errors and boilerplate associated with constructing and decoding raw XDR manually.',
    ),
  );

  console.log(
    chalk.green(
      '\nTyped contract client example completed successfully.',
    ),
  );
}