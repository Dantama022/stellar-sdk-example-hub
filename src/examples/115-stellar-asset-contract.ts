import {
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  Operation,
  rpc,
  scValToNative,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Example 115: Stellar Asset Contract (SAC) Interaction
 *
 * Classic Stellar assets are identified by:
 *
 *   asset code + issuer
 *
 * Soroban applications interact with those assets through Stellar Asset
 * Contracts (SACs). Every classic Stellar asset has a deterministic SAC
 * contract ID for a particular network.
 *
 * This example demonstrates:
 *
 *   1. Configuring and validating an issued Stellar asset.
 *   2. Deriving its deterministic SAC contract ID.
 *   3. Connecting to Soroban RPC.
 *   4. Deploying the SAC.
 *   5. Verifying the deployed contract ID.
 *   6. Inspecting the SAC contract instance.
 *   7. Reading name, symbol, decimals, admin, and balance.
 *   8. Decoding returned ScVal values.
 *   9. Simulating the standard mint(to, amount) SAC operation.
 *  10. Inspecting authorization requirements before submission.
 *  11. Demonstrating unsupported-operation handling.
 *  12. Demonstrating invalid-asset handling.
 *
 * The mint operation is SIMULATED only. It is deliberately not submitted.
 *
 * Compatibility note:
 *
 * This repository currently uses @stellar/stellar-sdk 13.x. Current Testnet
 * transaction metadata can contain newer XDR variants than that SDK knows
 * how to decode. Transaction building, simulation, assembly, signing and
 * submission still use the Stellar SDK, while confirmation polling reads
 * only raw JSON-RPC transaction status.
 */

const DEFAULT_RPC_URL =
  'https://soroban-testnet.stellar.org';

const FRIEND_BOT_URL =
  'https://friendbot.stellar.org';

const NETWORK_PASSPHRASE =
  Networks.TESTNET;

const NETWORK_NAME =
  'Testnet';

const BASE_FEE =
  '100000';

const DEFAULT_ASSET_CODE =
  'DEMO';

const DEMONSTRATION_AMOUNT =
  10_000_000n;

export interface StellarAssetContractParams {
  assetCode?: string;
  issuer?: string;
  rpcUrl?: string;
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
  status:
    | 'SUCCESS'
    | 'NOT_FOUND'
    | 'FAILED'
    | string;

  txHash?: string;
  ledger?: number;
  latestLedger?: number;
}

interface SimulatedOperation {
  transaction: Transaction;

  simulation:
    rpc.Api.SimulateTransactionSuccessResponse;
}

interface SubmittedOperation {
  transactionHash: string;

  simulation:
    rpc.Api.SimulateTransactionSuccessResponse;

  confirmation:
    RawTransactionStatus;
}

export interface SacInspection {
  contractId: string;

  executableType: string;

  isStellarAssetContract: boolean;

  lastModifiedLedgerSeq:
    | number
    | null;

  liveUntilLedgerSeq:
    | number
    | null;
}

export interface SimulatedSacCall {
  method: string;

  args:
    xdr.ScVal[];

  simulation:
    rpc.Api.SimulateTransactionSuccessResponse;

  returnValue:
    xdr.ScVal
    | null;

  decodedReturn:
    unknown;
}

/**
 * Convert errors/RPC objects into readable diagnostics.
 */
function errorMessage(
  error: unknown,
): string {
  if (
    error instanceof Error
  ) {
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
      return String(
        error,
      );
    }
  }

  return String(
    error,
  );
}

/**
 * Validate an issued Stellar asset.
 */
export function createIssuedAsset(
  assetCode: string,
  issuer: string,
): Asset {
  const code =
    assetCode
      .trim()
      .toUpperCase();

  const issuerAddress =
    issuer.trim();

  if (!code) {
    throw new Error(
      'Asset code is required.',
    );
  }

  if (
    code.length > 12
  ) {
    throw new Error(
      `Invalid asset code "${code}". Stellar issued-asset codes must contain between 1 and 12 characters.`,
    );
  }

  try {
    Keypair.fromPublicKey(
      issuerAddress,
    );
  } catch {
    throw new Error(
      `Invalid asset issuer "${issuerAddress}". Expected a valid Stellar G... account address.`,
    );
  }

  try {
    return new Asset(
      code,
      issuerAddress,
    );
  } catch (
    error: unknown
  ) {
    throw new Error(
      `Invalid Stellar asset configuration: ${errorMessage(
        error,
      )}`,
    );
  }
}

/**
 * Derive the deterministic SAC contract address.
 */
export function deriveSacContractId(
  asset: Asset,
): string {
  return asset.contractId(
    NETWORK_PASSPHRASE,
  );
}

/**
 * Fund a temporary Testnet account.
 */
async function fundAccount(
  keypair: Keypair,
  label: string,
): Promise<void> {
  console.log(
    `  ${label}: ${keypair.publicKey()}`,
  );

  const response =
    await fetch(
      `${FRIEND_BOT_URL}/?addr=${keypair.publicKey()}`,
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `Friendbot could not fund ${label}: HTTP ${response.status}.`,
    );
  }

  console.log(
    chalk.green(
      `  ${label} funded.`,
    ),
  );
}

/**
 * Raw JSON-RPC helper.
 *
 * Only transaction confirmation uses this helper.
 */
async function rawRpcCall<T>(
  rpcUrl: string,
  method: string,
  params: Record<
    string,
    unknown
  >,
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
            jsonrpc:
              '2.0',

            id: 1,

            method,

            params,
          }),
      },
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `RPC ${method} returned HTTP ${response.status}.`,
    );
  }

  const envelope =
    (await response.json()) as
      RawRpcEnvelope<T>;

  if (
    envelope.error
  ) {
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
 * Poll a submitted transaction without decoding resultMetaXdr.
 */
async function pollTransactionStatusRaw(
  rpcUrl: string,
  hash: string,
  attempts = 30,
): Promise<
  RawTransactionStatus
> {
  for (
    let attempt = 1;
    attempt <= attempts;
    attempt += 1
  ) {
    const result =
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
      result.status ===
        'SUCCESS' ||
      result.status ===
        'FAILED'
    ) {
      return result;
    }

    if (
      result.status !==
      'NOT_FOUND'
    ) {
      throw new Error(
        `Transaction ${hash} returned unexpected status "${result.status}".`,
      );
    }

    await new Promise<void>(
      (
        resolve,
      ) => {
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
 * Build and simulate one Soroban operation.
 */
async function simulateOperation(
  server: rpc.Server,
  source: Keypair,
  operation: xdr.Operation,
): Promise<
  SimulatedOperation
> {
  const account =
    await server.getAccount(
      source.publicKey(),
    );

  const transaction =
    new TransactionBuilder(
      account,
      {
        fee:
          BASE_FEE,

        networkPassphrase:
          NETWORK_PASSPHRASE,
      },
    )
      .addOperation(
        operation,
      )
      .setTimeout(
        60,
      )
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

  return {
    transaction,
    simulation,
  };
}

/**
 * Assemble, sign, submit, and confirm a previously simulated operation.
 */
async function submitSimulation(
  server: rpc.Server,
  rpcUrl: string,
  source: Keypair,
  simulated:
    SimulatedOperation,
): Promise<
  SubmittedOperation
> {
  let transaction =
    rpc
      .assembleTransaction(
        simulated.transaction,
        simulated.simulation,
      )
      .build();

  transaction.sign(
    source,
  );

  const submitted =
    await server.sendTransaction(
      transaction,
    );

  if (
    submitted.status ===
    'ERROR'
  ) {
    throw new Error(
      'Transaction was rejected during submission.',
    );
  }

  const confirmation =
    await pollTransactionStatusRaw(
      rpcUrl,
      submitted.hash,
    );

  if (
    confirmation.status !==
    'SUCCESS'
  ) {
    throw new Error(
      `Transaction ${submitted.hash} finished with status ${confirmation.status}.`,
    );
  }

  return {
    transactionHash:
      submitted.hash,

    simulation:
      simulated.simulation,

    confirmation,
  };
}

/**
 * Deploy the SAC corresponding to an asset.
 */
async function deploySac(
  server: rpc.Server,
  rpcUrl: string,
  deployer: Keypair,
  asset: Asset,
  expectedContractId: string,
): Promise<string> {
  const operation =
    Operation.createStellarAssetContract({
      asset,
    });

  console.log(
    chalk.yellow(
      '\nSimulating SAC deployment...',
    ),
  );

  const simulated =
    await simulateOperation(
      server,
      deployer,
      operation,
    );

  console.log(
    chalk.green(
      'SAC deployment simulation succeeded.',
    ),
  );

  console.log(
    `  Minimum resource fee : ${simulated.simulation.minResourceFee}`,
  );

  const returnValue =
    simulated.simulation
      .result
      ?.retval;

  let simulationContractId:
    string
    | null = null;

  if (
    returnValue
  ) {
    try {
      simulationContractId =
        Address
          .fromScVal(
            returnValue,
          )
          .toString();

      console.log(
        `  Simulation result    : ${simulationContractId}`,
      );
    } catch {
      const xdrValue =
        returnValue.toXDR(
          'base64',
        );

      console.log(
        `  Simulation result    : ${
          xdrValue.length > 100
            ? `${xdrValue.slice(
                0,
                100,
              )}...`
            : xdrValue
        }`,
      );
    }
  } else {
    console.log(
      '  Simulation result    : no return value',
    );
  }

  if (
    simulationContractId &&
    simulationContractId !==
      expectedContractId
  ) {
    throw new Error(
      `SAC identification mismatch. Asset.contractId() produced ${expectedContractId}, but deployment simulation returned ${simulationContractId}.`,
    );
  }

  console.log(
    chalk.yellow(
      '\nSubmitting simulated SAC deployment...',
    ),
  );

  const submitted =
    await submitSimulation(
      server,
      rpcUrl,
      deployer,
      simulated,
    );

  console.log(
    chalk.green(
      'SAC deployment confirmed.',
    ),
  );

  console.log(
    `  Deployment tx        : ${submitted.transactionHash}`,
  );

  console.log(
    `  Confirmed ledger     : ${
      submitted.confirmation
        .ledger ??
      submitted.confirmation
        .latestLedger ??
      'unknown'
    }`,
  );

  return (
    simulationContractId ||
    expectedContractId
  );
}

/**
 * Inspect the deployed contract instance.
 *
 * Stellar Asset Contracts use the built-in Stellar Asset executable rather
 * than normal user-supplied WASM.
 */
export async function inspectSac(
  server: rpc.Server,
  contractId: string,
): Promise<
  SacInspection
> {
  const contract =
    new Contract(
      contractId,
    );

  const response =
    await server.getLedgerEntries(
      contract.getFootprint(),
    );

  if (
    response.entries.length ===
    0
  ) {
    throw new Error(
      `No contract-instance ledger entry was found for ${contractId}.`,
    );
  }

  const ledgerEntry =
    response.entries[0];

  const contractData =
    ledgerEntry
      .val
      .contractData();

  const instanceValue =
    contractData.val();

  if (
    instanceValue
      .switch()
      .name !==
    'scvContractInstance'
  ) {
    throw new Error(
      `Ledger entry for ${contractId} is not a contract instance.`,
    );
  }

  const instance =
    instanceValue.instance();

  const executable =
    instance.executable();

  const executableType =
    executable
      .switch()
      .name;

  return {
    contractId,

    executableType,

    isStellarAssetContract:
      executableType ===
      'contractExecutableStellarAsset',

    // SDK 13.x types these fields as optional.
    lastModifiedLedgerSeq:
      ledgerEntry
        .lastModifiedLedgerSeq ??
      null,

    liveUntilLedgerSeq:
      ledgerEntry
        .liveUntilLedgerSeq ??
      null,
  };
}

/**
 * Decode a returned ScVal.
 */
export function decodeScVal(
  value: xdr.ScVal,
): unknown {
  try {
    return scValToNative(
      value,
    );
  } catch {
    return value.toXDR(
      'base64',
    );
  }
}

/**
 * Render native values safely.
 */
function displayValue(
  value: unknown,
): string {
  if (
    value ===
    undefined
  ) {
    return 'undefined';
  }

  if (
    value === null
  ) {
    return 'null';
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
    Buffer.isBuffer(
      value,
    )
  ) {
    return `Buffer<${value.toString(
      'hex',
    )}>`;
  }

  if (
    typeof value ===
    'object'
  ) {
    return JSON.stringify(
      value,
      (
        _key,
        item,
      ) =>
        typeof item ===
        'bigint'
          ? `${item.toString()}n`
          : item,
      2,
    );
  }

  return String(
    value,
  );
}

/**
 * Render contract arguments.
 */
function displayArguments(
  args: xdr.ScVal[],
): string {
  if (
    args.length ===
    0
  ) {
    return 'none';
  }

  return args
    .map(
      (
        arg,
        index,
      ) =>
        `[${index}] ${arg.switch().name}=${displayValue(
          decodeScVal(
            arg,
          ),
        )}`,
    )
    .join('; ');
}

/**
 * Simulate a SAC method and decode its return value.
 */
export async function simulateSacCall(
  server: rpc.Server,
  source: Keypair,
  contract: Contract,
  method: string,
  args:
    xdr.ScVal[] = [],
): Promise<
  SimulatedSacCall
> {
  const operation =
    contract.call(
      method,
      ...args,
    );

  const simulated =
    await simulateOperation(
      server,
      source,
      operation,
    );

  const returnValue =
    simulated.simulation
      .result
      ?.retval ??
    null;

  const decodedReturn =
    returnValue
      ? decodeScVal(
          returnValue,
        )
      : null;

  return {
    method,

    args,

    simulation:
      simulated.simulation,

    returnValue,

    decodedReturn,
  };
}

/**
 * Print one simulated SAC call.
 */
function displayCall(
  call: SimulatedSacCall,
): void {
  console.log(
    `  Contract method     : ${call.method}`,
  );

  console.log(
    `  Arguments           : ${displayArguments(
      call.args,
    )}`,
  );

  console.log(
    '  Simulation result   : SUCCESS',
  );

  console.log(
    `  Minimum resource fee: ${call.simulation.minResourceFee}`,
  );

  if (
    call.returnValue
  ) {
    console.log(
      `  Raw ScVal type      : ${call.returnValue.switch().name}`,
    );

    const raw =
      call.returnValue.toXDR(
        'base64',
      );

    console.log(
      `  Raw ScVal XDR       : ${
        raw.length > 100
          ? `${raw.slice(
              0,
              100,
            )}...`
          : raw
      }`,
    );
  } else {
    console.log(
      '  Raw ScVal           : none',
    );
  }

  console.log(
    `  Decoded return      : ${displayValue(
      call.decodedReturn,
    )}`,
  );
}

/**
 * Display authorization entries returned by simulation.
 */
function displayAuthorization(
  call:
    SimulatedSacCall,
  sourcePublicKey:
    string,
): void {
  const authEntries =
    call.simulation
      .result
      ?.auth ??
    [];

  console.log(
    `  Authorization count : ${authEntries.length}`,
  );

  if (
    authEntries.length ===
    0
  ) {
    console.log(
      chalk.gray(
        '  No explicit authorization entries were returned.',
      ),
    );

    return;
  }

  authEntries.forEach(
    (
      entry,
      index,
    ) => {
      const credentials =
        entry.credentials();

      const credentialType =
        credentials
          .switch()
          .name;

      let signer =
        '(unknown)';

      if (
        credentialType ===
        'sorobanCredentialsSourceAccount'
      ) {
        signer =
          sourcePublicKey;
      } else if (
        credentialType ===
        'sorobanCredentialsAddress'
      ) {
        signer =
          Address
            .fromScAddress(
              credentials
                .address()
                .address(),
            )
            .toString();
      }

      console.log(
        `    [${index}] ${credentialType}`,
      );

      console.log(
        `        Required signer: ${signer}`,
      );
    },
  );
}

/**
 * Demonstrate unsupported-method handling.
 */
async function demonstrateUnsupportedOperation(
  server: rpc.Server,
  source: Keypair,
  contract: Contract,
): Promise<void> {
  console.log(
    chalk.yellow(
      '\nUnsupported operation demonstration',
    ),
  );

  const unsupportedMethod =
    'total_supply';

  console.log(
    `  Requested method : ${unsupportedMethod}`,
  );

  try {
    await simulateSacCall(
      server,
      source,
      contract,
      unsupportedMethod,
    );

    console.log(
      chalk.yellow(
        '  The method unexpectedly simulated successfully.',
      ),
    );
  } catch (
    error: unknown
  ) {
    console.log(
      chalk.green(
        '  Unsupported SAC operation handled gracefully.',
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
        '  Use a method supported by the SAC interface such as name, symbol, decimals, balance, transfer, mint, or admin where applicable.',
      ),
    );
  }
}

/**
 * Run Example 115.
 */
export async function run(
  params:
    StellarAssetContractParams = {},
): Promise<void> {
  console.log(
    chalk.bold(
      'Stellar Asset Contract (SAC) Interaction Example',
    ),
  );

  console.log(
    chalk.gray(
      'Derive a classic Stellar asset\'s SAC address, deploy and inspect it, read contract state, simulate a standard SAC operation, and decode ScVal results.',
    ),
  );

  const rpcUrl =
    params.rpcUrl ||
    process.env.SOROBAN_RPC_URL ||
    DEFAULT_RPC_URL;

  // -----------------------------------------------------------------------
  // Step 1: Configure asset.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 1: Configuring Stellar asset...',
    ),
  );

  const generatedIssuer =
    params.issuer
      ? null
      : Keypair.random();

  const issuer =
    params.issuer?.trim() ||
    generatedIssuer!
      .publicKey();

  const assetCode =
    (
      params.assetCode ||
      process.env.ASSET_CODE ||
      DEFAULT_ASSET_CODE
    )
      .trim()
      .toUpperCase();

  let asset:
    Asset;

  try {
    asset =
      createIssuedAsset(
        assetCode,
        issuer,
      );
  } catch (
    error: unknown
  ) {
    console.error(
      chalk.red(
        errorMessage(
          error,
        ),
      ),
    );

    console.log(
      chalk.gray(
        'Example stopped before any network operation because the asset configuration is invalid.',
      ),
    );

    return;
  }

  const sacContractId =
    deriveSacContractId(
      asset,
    );

  console.log(
    `  Asset code     : ${asset.getCode()}`,
  );

  console.log(
    `  Asset issuer   : ${asset.getIssuer()}`,
  );

  console.log(
    `  Asset type     : ${asset.getAssetType()}`,
  );

  console.log(
    `  Network        : ${NETWORK_NAME}`,
  );

  console.log(
    `  SAC contract ID: ${sacContractId}`,
  );

  console.log(
    chalk.gray(
      '  The same asset code, issuer, and network always derive the same SAC contract ID.',
    ),
  );

  // -----------------------------------------------------------------------
  // Step 2: Connect to RPC.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 2: Connecting to Soroban RPC...',
    ),
  );

  const server =
    new rpc.Server(
      rpcUrl,
    );

  try {
    const latest =
      await server.getLatestLedger();

    console.log(
      chalk.green(
        `Connected. Latest ledger: ${latest.sequence}`,
      ),
    );
  } catch (
    error: unknown
  ) {
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
    `  Soroban RPC    : ${rpcUrl}`,
  );

  // -----------------------------------------------------------------------
  // Step 3: Prepare deployment account.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 3: Preparing SAC deployment account...',
    ),
  );

  const deployer =
    generatedIssuer ||
    Keypair.random();

  try {
    await fundAccount(
      deployer,

      generatedIssuer
        ? 'Issuer/deployer'
        : 'SAC deployer',
    );
  } catch (
    error: unknown
  ) {
    console.error(
      chalk.red(
        `Could not prepare deployment account: ${errorMessage(
          error,
        )}`,
      ),
    );

    return;
  }

  // -----------------------------------------------------------------------
  // Step 4: Deploy SAC.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 4: Deploying Stellar Asset Contract...',
    ),
  );

  let deployedContractId:
    string;

  try {
    deployedContractId =
      await deploySac(
        server,
        rpcUrl,
        deployer,
        asset,
        sacContractId,
      );
  } catch (
    error: unknown
  ) {
    console.error(
      chalk.red(
        `SAC deployment failed: ${errorMessage(
          error,
        )}`,
      ),
    );

    return;
  }

  console.log(
    `  Derived SAC ID       : ${sacContractId}`,
  );

  console.log(
    `  Deployed SAC ID      : ${deployedContractId}`,
  );

  console.log(
    `  Identification match : ${
      deployedContractId ===
      sacContractId
        ? 'YES'
        : 'NO'
    }`,
  );

  if (
    deployedContractId !==
    sacContractId
  ) {
    console.error(
      chalk.red(
        'The deployed contract does not match the deterministic SAC ID.',
      ),
    );

    return;
  }

  // -----------------------------------------------------------------------
  // Step 5: Inspect SAC.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 5: Inspecting SAC contract instance...',
    ),
  );

  let inspection:
    SacInspection;

  try {
    inspection =
      await inspectSac(
        server,
        sacContractId,
      );
  } catch (
    error: unknown
  ) {
    console.error(
      chalk.red(
        `Could not inspect SAC contract instance: ${errorMessage(
          error,
        )}`,
      ),
    );

    return;
  }

  console.log(
    `  Contract ID          : ${inspection.contractId}`,
  );

  console.log(
    `  Executable type      : ${inspection.executableType}`,
  );

  console.log(
    `  Built-in SAC         : ${
      inspection.isStellarAssetContract
        ? 'YES'
        : 'NO'
    }`,
  );

  console.log(
    `  Last modified ledger : ${
      inspection.lastModifiedLedgerSeq ??
      'not reported'
    }`,
  );

  console.log(
    `  Live until ledger    : ${
      inspection.liveUntilLedgerSeq ??
      'not reported'
    }`,
  );

  if (
    !inspection.isStellarAssetContract
  ) {
    console.error(
      chalk.red(
        'The derived contract exists but is not using the built-in Stellar Asset executable.',
      ),
    );

    return;
  }

  console.log(
    chalk.green(
      'SAC inspection verified the built-in Stellar Asset executable.',
    ),
  );

  const sacContract =
    new Contract(
      sacContractId,
    );

  // -----------------------------------------------------------------------
  // Step 6: Read metadata/state.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 6: Reading SAC metadata...',
    ),
  );

  const readMethods = [
    'name',
    'symbol',
    'decimals',
    'admin',
  ];

  for (
    const method of
      readMethods
  ) {
    console.log(
      chalk.cyan(
        `\n${method}()`,
      ),
    );

    try {
      const call =
        await simulateSacCall(
          server,
          deployer,
          sacContract,
          method,
        );

      displayCall(
        call,
      );
    } catch (
      error: unknown
    ) {
      console.log(
        chalk.yellow(
          `  ${method}() is unavailable for this SAC configuration.`,
        ),
      );

      console.log(
        chalk.gray(
          `  Diagnostic: ${errorMessage(
            error,
          )}`,
        ),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Step 7: Read balance state.
  //
  // A contract address is used so we do not need to create a classic
  // trustline merely to demonstrate a zero SAC balance.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 7: Reading asset-related contract state...',
    ),
  );

  const balanceAddress =
    Asset.native()
      .contractId(
        NETWORK_PASSPHRASE,
      );

  const balanceArgs = [
    Address
      .fromString(
        balanceAddress,
      )
      .toScVal(),
  ];

  console.log(
    `  Balance address : ${balanceAddress}`,
  );

  try {
    const balanceCall =
      await simulateSacCall(
        server,
        deployer,
        sacContract,
        'balance',
        balanceArgs,
      );

    displayCall(
      balanceCall,
    );
  } catch (
    error: unknown
  ) {
    console.error(
      chalk.red(
        `Could not read SAC balance: ${errorMessage(
          error,
        )}`,
      ),
    );

    return;
  }

  // -----------------------------------------------------------------------
  // Step 8: Simulate mint.
  //
  // This is a state-changing operation, so we deliberately stop after
  // simulation.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 8: Simulating standard SAC mint operation...',
    ),
  );

  const mintArgs = [
    Address
      .fromString(
        balanceAddress,
      )
      .toScVal(),

    nativeToScVal(
      DEMONSTRATION_AMOUNT,
      {
        type:
          'i128',
      },
    ),
  ];

  console.log(
    `  Asset code      : ${asset.getCode()}`,
  );

  console.log(
    `  Asset issuer    : ${asset.getIssuer()}`,
  );

  console.log(
    `  SAC contract ID : ${sacContractId}`,
  );

  console.log(
    `  Network         : ${NETWORK_NAME}`,
  );

  console.log(
    '  Contract method : mint',
  );

  console.log(
    `  Recipient       : ${balanceAddress}`,
  );

  console.log(
    `  Amount          : ${DEMONSTRATION_AMOUNT.toString()} base units`,
  );

  try {
    const mintCall =
      await simulateSacCall(
        server,
        deployer,
        sacContract,
        'mint',
        mintArgs,
      );

    displayCall(
      mintCall,
    );

    console.log(
      '\n  Authorization requirements:',
    );

    displayAuthorization(
      mintCall,
      deployer.publicKey(),
    );

    console.log(
      chalk.green(
        '\n  Mint invocation simulation succeeded.',
      ),
    );

    console.log(
      chalk.yellow(
        '  Mint NOT submitted. The example intentionally stops after simulation.',
      ),
    );
  } catch (
    error: unknown
  ) {
    console.log(
      chalk.yellow(
        'Mint simulation did not succeed.',
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
        'The failure was handled without submitting any state-changing transaction.',
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Step 9: Unsupported method.
  // -----------------------------------------------------------------------

  console.log(
    chalk.yellow(
      '\nStep 9: Testing unsupported operation handling...',
    ),
  );

  await demonstrateUnsupportedOperation(
    server,
    deployer,
    sacContract,
  );

  // -----------------------------------------------------------------------
  // Explanation.
  // -----------------------------------------------------------------------

  console.log(
    chalk.cyan(
      '\nClassic Stellar assets and Stellar Asset Contracts:\n' +
        '  - A classic issued Stellar asset is identified by its asset code and issuer account.\n' +
        '  - Every asset has a deterministic SAC address for each Stellar network.\n' +
        '  - Asset.contractId(networkPassphrase) derives that address without an RPC lookup.\n' +
        '  - Deploying the SAC activates Stellar\'s built-in Stellar Asset executable at that address.\n' +
        '  - The SAC is therefore different from an ordinary user-deployed WASM contract.\n' +
        '  - Classic balances and trustlines remain part of Stellar\'s asset model, while Soroban applications interact through contract methods such as balance and transfer.\n' +
        '  - Issued-asset SACs expose administrative operations such as mint, with authorization controlled by the asset administrator.\n' +
        '  - Simulation allows applications to inspect authorization, resource requirements, and return values before submitting state-changing operations.',
    ),
  );

  console.log(
    chalk.cyan(
      '\nExample summary:\n' +
        `  Asset code       : ${asset.getCode()}\n` +
        `  Asset issuer     : ${asset.getIssuer()}\n` +
        `  SAC contract ID  : ${sacContractId}\n` +
        `  Network          : ${NETWORK_NAME}\n` +
        `  Executable       : ${inspection.executableType}\n` +
        `  SAC verified     : ${
          inspection.isStellarAssetContract
            ? 'YES'
            : 'NO'
        }`,
    ),
  );

  console.log(
    chalk.green(
      '\nStellar Asset Contract example completed successfully.',
    ),
  );
}