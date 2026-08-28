import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  rpc,
  scValToNative,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Example 114: Soroban Contract Upgrade
 *
 * Soroban allows a contract to replace the WASM executable associated with
 * its existing contract address. Upgradeability is NOT automatically safe:
 * the contract itself must expose an upgrade function and implement whatever
 * authorization policy the application requires.
 *
 * The bundled sample contracts use an administrator stored by v1's
 * constructor. upgrade(new_wasm_hash) calls require_auth() for that
 * administrator before replacing the current contract WASM.
 *
 * This example demonstrates:
 *
 *   1. Connecting to Soroban RPC.
 *   2. Loading v1 and v2 WASM implementations.
 *   3. Installing and deploying v1.
 *   4. Identifying the current implementation before upgrade.
 *   5. Uploading the new v2 implementation.
 *   6. Demonstrating rejection of an unauthorized upgrade attempt.
 *   7. Demonstrating graceful handling of a failed upgrade.
 *   8. Building and simulating the authorized upgrade transaction.
 *   9. Displaying its authorization requirements.
 *  10. Signing and submitting the upgrade.
 *  11. Running the contract's post-upgrade hook.
 *  12. Retrieving the implementation again after confirmation.
 *  13. Verifying the WASM hash, version(), and new v2 functionality.
 *
 * Compatibility note:
 *
 * This repository currently uses @stellar/stellar-sdk 13.x. Current Testnet
 * transaction metadata can contain newer XDR variants than that SDK knows how
 * to decode. Transaction construction, simulation, assembly, signing and
 * submission still use the SDK, but confirmation polling reads only the raw
 * JSON-RPC getTransaction status and deliberately avoids decoding
 * resultMetaXdr.
 */

const RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';

const FRIEND_BOT_URL = 'https://friendbot.stellar.org';

const NETWORK_PASSPHRASE = Networks.TESTNET;

const BASE_FEE = '100000';

const V1_WASM_PATH = path.join(__dirname, '../contracts/sample-v1/upgradeable_v1.wasm');

const V2_WASM_PATH = path.join(__dirname, '../contracts/sample-v2/upgradeable_v2.wasm');

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
  ledger?: number;
  latestLedger?: number;
  resultXdr?: string;
  diagnosticEventsXdr?: string[];
}

interface SimulatedOperation {
  transaction: Transaction;
  simulation: rpc.Api.SimulateTransactionSuccessResponse;
}

interface SubmittedOperation {
  simulation: rpc.Api.SimulateTransactionSuccessResponse;

  transactionHash: string;

  confirmation: RawTransactionStatus;
}

export interface UpgradeVerification {
  expectedWasmHash: string;
  actualWasmHash: string;
  wasmMatches: boolean;
  version: number;
  newFunctionValue: number;
  verified: boolean;
}

/**
 * Convert unknown errors and RPC objects to readable output.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error !== null && typeof error === 'object') {
    try {
      return JSON.stringify(error, null, 2);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

/**
 * SHA-256 hash of Soroban WASM.
 */
export function computeWasmHash(wasm: Buffer): Buffer {
  return createHash('sha256').update(wasm).digest();
}

/**
 * Load one of the repository's bundled contract implementations.
 */
function loadWasm(wasmPath: string): Buffer {
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`Contract WASM was not found at ${wasmPath}`);
  }

  const wasm = fs.readFileSync(wasmPath);

  if (wasm.length <= 8) {
    throw new Error(`Contract WASM at ${wasmPath} is not a usable Soroban binary.`);
  }

  return wasm;
}

/**
 * Fund a temporary Testnet account.
 */
async function fundAccount(keypair: Keypair, label: string): Promise<void> {
  console.log(`  ${label}: ${keypair.publicKey()}`);

  const response = await fetch(`${FRIEND_BOT_URL}/?addr=${keypair.publicKey()}`);

  if (!response.ok) {
    throw new Error(`Friendbot could not fund ${label}: HTTP ${response.status}`);
  }

  console.log(chalk.green(`  ${label} funded.`));
}

/**
 * Raw JSON-RPC call.
 *
 * Only transaction-status polling uses this helper.
 */
async function rawRpcCall<T>(
  rpcUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',

    headers: {
      'Content-Type': 'application/json',
    },

    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC ${method} returned HTTP ${response.status}.`);
  }

  const envelope = (await response.json()) as RawRpcEnvelope<T>;

  if (envelope.error) {
    throw new Error(`RPC ${method} failed (${envelope.error.code}): ${envelope.error.message}`);
  }

  if (envelope.result === undefined) {
    throw new Error(`RPC ${method} returned no result.`);
  }

  return envelope.result;
}

/**
 * Poll a submitted transaction without decoding its TransactionMeta XDR.
 */
async function pollTransactionStatusRaw(
  rpcUrl: string,
  hash: string,
  attempts = 30,
): Promise<RawTransactionStatus> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await rawRpcCall<RawTransactionStatus>(rpcUrl, 'getTransaction', {
      hash,
    });

    if (result.status === 'SUCCESS' || result.status === 'FAILED') {
      return result;
    }

    if (result.status !== 'NOT_FOUND') {
      throw new Error(`Transaction ${hash} returned unexpected status "${result.status}".`);
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1000);
    });
  }

  throw new Error(`Transaction ${hash} was not confirmed after ${attempts} polling attempts.`);
}

/**
 * Build and simulate one Soroban operation without submitting it.
 */
async function simulateOperation(
  server: rpc.Server,
  signer: Keypair,
  operation: xdr.Operation,
): Promise<SimulatedOperation> {
  const account = await server.getAccount(signer.publicKey());

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,

    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  const simulation = await server.simulateTransaction(transaction);

  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }

  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error('Soroban RPC returned an unexpected simulation response.');
  }

  return {
    transaction,
    simulation,
  };
}

/**
 * Submit a previously simulated operation.
 */
async function submitSimulation(
  server: rpc.Server,
  rpcUrl: string,
  signer: Keypair,
  simulated: SimulatedOperation,
): Promise<SubmittedOperation> {
  const transaction = rpc.assembleTransaction(simulated.transaction, simulated.simulation).build();

  transaction.sign(signer);

  const submission = await server.sendTransaction(transaction);

  if (submission.status === 'ERROR') {
    throw new Error('Soroban transaction was rejected during submission.');
  }

  const confirmation = await pollTransactionStatusRaw(rpcUrl, submission.hash);

  if (confirmation.status !== 'SUCCESS') {
    throw new Error(`Transaction ${submission.hash} finished with status ${confirmation.status}.`);
  }

  return {
    simulation: simulated.simulation,

    transactionHash: submission.hash,

    confirmation,
  };
}

/**
 * Complete build -> simulate -> sign -> submit -> confirm workflow.
 */
async function submitOperation(
  server: rpc.Server,
  rpcUrl: string,
  signer: Keypair,
  operation: xdr.Operation,
): Promise<SubmittedOperation> {
  const simulated = await simulateOperation(server, signer, operation);

  return submitSimulation(server, rpcUrl, signer, simulated);
}

/**
 * Read the contract address returned by createCustomContract simulation.
 */
function contractIdFromSimulation(simulation: rpc.Api.SimulateTransactionSuccessResponse): string {
  const retval = simulation.result?.retval;

  if (!retval) {
    throw new Error('Contract deployment simulation returned no contract address.');
  }

  return Address.fromScVal(retval).toString();
}

/**
 * Return the required signer represented by an authorization entry.
 */
export function getAuthorizationSigner(
  entry: xdr.SorobanAuthorizationEntry,
  transactionSource: string,
): string {
  const credentials = entry.credentials();

  const type = credentials.switch().name;

  if (type === 'sorobanCredentialsSourceAccount') {
    return transactionSource;
  }

  if (type === 'sorobanCredentialsAddress') {
    return Address.fromScAddress(credentials.address().address()).toString();
  }

  return `(unsupported: ${type})`;
}

/**
 * Display authorization returned by simulation.
 */
function displayAuthorization(
  simulation: rpc.Api.SimulateTransactionSuccessResponse,
  transactionSource: string,
): string {
  const entries = simulation.result?.auth ?? [];

  if (entries.length === 0) {
    console.log('  Authorization entries : 0');

    console.log(chalk.green('  Authorization status  : AUTHORIZED BY TRANSACTION SOURCE'));

    console.log(
      chalk.gray(
        '  The administrator is the transaction source, so no separate address authorization entry is required.',
      ),
    );

    return 'authorized by transaction source';
  }

  console.log(`  Authorization entries : ${entries.length}`);

  entries.forEach((entry, index) => {
    const signer = getAuthorizationSigner(entry, transactionSource);

    console.log(`    [${index}] required signer: ${signer}`);

    console.log(`        credential type: ${entry.credentials().switch().name}`);
  });

  return entries.map((entry) => getAuthorizationSigner(entry, transactionSource)).join(', ');
}

/**
 * Retrieve the contract's actual current executable WASM and identify it by
 * SHA-256 hash.
 */
export async function identifyCurrentImplementation(
  server: rpc.Server,
  contractId: string,
): Promise<{
  wasm: Buffer;
  wasmHash: Buffer;
}> {
  const wasm = await server.getContractWasmByContractId(contractId);

  return {
    wasm,
    wasmHash: computeWasmHash(wasm),
  };
}

/**
 * Simulate a u32-returning contract method.
 */
async function invokeContractU32(
  server: rpc.Server,
  source: Keypair,
  contract: Contract,
  method: string,
): Promise<number> {
  const account = await server.getAccount(source.publicKey());

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,

    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method))
    .setTimeout(60)
    .build();

  const simulation = await server.simulateTransaction(transaction);

  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`${method} simulation failed: ${simulation.error}`);
  }

  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result?.retval) {
    throw new Error(`Contract method ${method} returned no value.`);
  }

  return Number(scValToNative(simulation.result.retval));
}

/**
 * Attempt to upgrade with an account that is NOT the configured admin.
 *
 * Simulation normally discovers an explicit authorization entry for the real
 * administrator. We intentionally do not sign that Soroban authorization
 * entry. The attacker signs only the transaction envelope, which must not be
 * enough to perform the upgrade.
 */
async function demonstrateUnauthorizedUpgrade(
  server: rpc.Server,
  rpcUrl: string,
  attacker: Keypair,
  admin: Keypair,
  contract: Contract,
  newWasmHash: Buffer,
): Promise<void> {
  console.log(chalk.yellow('\nUnauthorized upgrade demonstration'));

  console.log(`  Attacker          : ${attacker.publicKey()}`);

  console.log(`  Contract admin    : ${admin.publicKey()}`);

  const account = await server.getAccount(attacker.publicKey());

  const operation = contract.call('upgrade', xdr.ScVal.scvBytes(newWasmHash));

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,

    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  const simulation = await server.simulateTransaction(transaction);

  if (rpc.Api.isSimulationError(simulation)) {
    console.log(chalk.green('  Unauthorized attempt rejected during simulation.'));

    console.log(chalk.gray(`  Diagnostic: ${simulation.error}`));

    return;
  }

  if (!rpc.Api.isSimulationSuccess(simulation)) {
    console.log(chalk.green('  Unauthorized attempt produced no successful simulation.'));

    return;
  }

  const authEntries = simulation.result?.auth ?? [];

  console.log(`  Simulation auth entries : ${authEntries.length}`);

  authEntries.forEach((entry, index) => {
    const requiredSigner = getAuthorizationSigner(entry, attacker.publicKey());

    console.log(`    [${index}] required signer: ${requiredSigner}`);
  });

  const requiresAdmin = authEntries.some(
    (entry) => getAuthorizationSigner(entry, attacker.publicKey()) === admin.publicKey(),
  );

  if (requiresAdmin) {
    console.log(
      chalk.green(
        '  Authorization check: simulation correctly requires the configured administrator.',
      ),
    );
  }

  console.log(
    chalk.gray("  Submitting without the administrator's Soroban authorization signature..."),
  );

  const assembled = rpc.assembleTransaction(transaction, simulation).build();

  // Deliberately sign only the transaction envelope with the attacker.
  assembled.sign(attacker);

  const submission = await server.sendTransaction(assembled);

  if (submission.status === 'ERROR') {
    console.log(chalk.green('  Unauthorized upgrade rejected at submission.'));

    return;
  }

  const confirmation = await pollTransactionStatusRaw(rpcUrl, submission.hash);

  if (confirmation.status === 'FAILED') {
    console.log(
      chalk.green(`  Unauthorized upgrade rejected on-chain. Transaction: ${submission.hash}`),
    );

    return;
  }

  if (confirmation.status === 'SUCCESS') {
    throw new Error(
      'SECURITY CHECK FAILED: an unauthorized account unexpectedly completed the upgrade.',
    );
  }

  throw new Error(
    `Unauthorized test produced unexpected transaction status "${confirmation.status}".`,
  );
}

/**
 * Demonstrate a failed upgrade using a random WASM hash which was never
 * installed.
 *
 * We simulate only. A failing state-changing transaction is not submitted.
 */
async function demonstrateFailedUpgrade(
  server: rpc.Server,
  admin: Keypair,
  contract: Contract,
): Promise<void> {
  console.log(chalk.yellow('\nFailed upgrade demonstration'));

  const invalidWasmHash = randomBytes(32);

  console.log(`  Non-existent WASM hash: ${invalidWasmHash.toString('hex')}`);

  const account = await server.getAccount(admin.publicKey());

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,

    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call('upgrade', xdr.ScVal.scvBytes(invalidWasmHash)))
    .setTimeout(60)
    .build();

  try {
    const simulation = await server.simulateTransaction(transaction);

    if (rpc.Api.isSimulationError(simulation)) {
      console.log(chalk.green('  Invalid implementation rejected during simulation.'));

      console.log(chalk.gray(`  Diagnostic: ${simulation.error}`));

      return;
    }

    if (rpc.Api.isSimulationSuccess(simulation)) {
      console.log(chalk.yellow('  Simulation did not reject the unknown hash immediately.'));

      console.log(
        chalk.gray(
          '  The operation is intentionally not submitted. Production applications should stop whenever the target implementation cannot be independently verified.',
        ),
      );

      return;
    }

    console.log(chalk.green('  Invalid upgrade was not accepted.'));
  } catch (error: unknown) {
    console.log(chalk.green('  Invalid upgrade handled gracefully.'));

    console.log(chalk.gray(`  Diagnostic: ${errorMessage(error)}`));
  }
}

/**
 * Verify the current executable and v2 behavior after upgrade.
 */
async function verifyUpgrade(
  server: rpc.Server,
  source: Keypair,
  contract: Contract,
  contractId: string,
  expectedHash: Buffer,
): Promise<UpgradeVerification> {
  const current = await identifyCurrentImplementation(server, contractId);

  const version = await invokeContractU32(server, source, contract, 'version');

  const newFunctionValue = await invokeContractU32(server, source, contract, 'new_v2_fn');

  const expectedWasmHash = expectedHash.toString('hex');

  const actualWasmHash = current.wasmHash.toString('hex');

  const wasmMatches = actualWasmHash === expectedWasmHash;

  const verified = wasmMatches && version === 2;

  return {
    expectedWasmHash,
    actualWasmHash,
    wasmMatches,
    version,
    newFunctionValue,
    verified,
  };
}

/**
 * Run Example 114.
 */
export async function run(): Promise<void> {
  console.log(chalk.bold('Soroban Contract Upgrade Example'));

  console.log(
    chalk.gray(
      'Deploy v1, inspect its implementation, reject unauthorized/invalid upgrades, simulate and submit an authorized v2 upgrade, then verify the new implementation.',
    ),
  );

  const server = new rpc.Server(RPC_URL);

  // -----------------------------------------------------------------------
  // Step 1: Connect.
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 1: Connecting to Soroban RPC...'));

  try {
    const latest = await server.getLatestLedger();

    console.log(chalk.green(`Connected. Latest ledger: ${latest.sequence}`));
  } catch (error: unknown) {
    console.error(chalk.red(`RPC connection failed: ${errorMessage(error)}`));

    return;
  }

  console.log('  Network     : Testnet');

  console.log(`  Soroban RPC : ${RPC_URL}`);

  // -----------------------------------------------------------------------
  // Step 2: Load v1 and v2.
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 2: Preparing contract implementations...'));

  let v1Wasm: Buffer;

  let v2Wasm: Buffer;

  try {
    v1Wasm = loadWasm(V1_WASM_PATH);

    v2Wasm = loadWasm(V2_WASM_PATH);
  } catch (error: unknown) {
    console.error(chalk.red(errorMessage(error)));

    return;
  }

  const v1WasmHash = computeWasmHash(v1Wasm);

  const v2WasmHash = computeWasmHash(v2Wasm);

  console.log(`  v1 WASM path : ${V1_WASM_PATH}`);

  console.log(`  v1 WASM size : ${v1Wasm.length.toLocaleString()} bytes`);

  console.log(`  v1 WASM hash : ${v1WasmHash.toString('hex')}`);

  console.log(`  v2 WASM path : ${V2_WASM_PATH}`);

  console.log(`  v2 WASM size : ${v2Wasm.length.toLocaleString()} bytes`);

  console.log(`  v2 WASM hash : ${v2WasmHash.toString('hex')}`);

  if (v1WasmHash.equals(v2WasmHash)) {
    console.error(
      chalk.red(
        'v1 and v2 have the same WASM hash; there is no implementation change to demonstrate.',
      ),
    );

    return;
  }

  // -----------------------------------------------------------------------
  // Step 3: Create admin + attacker.
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 3: Creating Testnet participants...'));

  const admin = Keypair.random();

  const attacker = Keypair.random();

  try {
    await fundAccount(admin, 'Administrator');

    await fundAccount(attacker, 'Unauthorized account');
  } catch (error: unknown) {
    console.error(chalk.red(`Could not prepare Testnet accounts: ${errorMessage(error)}`));

    return;
  }

  // -----------------------------------------------------------------------
  // Step 4: Install v1.
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 4: Installing v1 WASM...'));

  try {
    const installed = await submitOperation(
      server,
      RPC_URL,
      admin,

      Operation.uploadContractWasm({
        wasm: v1Wasm,
      }),
    );

    console.log(chalk.green('v1 WASM installed.'));

    console.log(`  Transaction hash : ${installed.transactionHash}`);
  } catch (error: unknown) {
    console.error(chalk.red(`Could not install v1: ${errorMessage(error)}`));

    return;
  }

  // -----------------------------------------------------------------------
  // Step 5: Deploy v1 with admin constructor.
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 5: Deploying upgradeable v1 contract...'));

  let contractId: string;

  try {
    const deployment = await submitOperation(
      server,
      RPC_URL,
      admin,

      Operation.createCustomContract({
        address: Address.fromString(admin.publicKey()),

        wasmHash: v1WasmHash,

        salt: randomBytes(32),

        constructorArgs: [Address.fromString(admin.publicKey()).toScVal()],
      }),
    );

    contractId = contractIdFromSimulation(deployment.simulation);

    console.log(chalk.green('v1 contract deployed.'));

    console.log(`  Contract ID      : ${contractId}`);

    console.log(`  Deployment tx    : ${deployment.transactionHash}`);
  } catch (error: unknown) {
    console.error(chalk.red(`Contract deployment failed: ${errorMessage(error)}`));

    return;
  }

  const deployedContract = new Contract(contractId);

  // -----------------------------------------------------------------------
  // Step 6: Identify current implementation before upgrade.
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 6: Identifying current implementation...'));

  let previousImplementationHash: Buffer;

  try {
    const current = await identifyCurrentImplementation(server, contractId);

    previousImplementationHash = current.wasmHash;

    const versionBefore = await invokeContractU32(server, admin, deployedContract, 'version');

    console.log(`  Contract ID       : ${contractId}`);

    console.log(`  Previous WASM hash: ${previousImplementationHash.toString('hex')}`);

    console.log(`  Version before    : ${versionBefore}`);

    if (!previousImplementationHash.equals(v1WasmHash)) {
      throw new Error('Current contract implementation does not match the expected v1 WASM hash.');
    }

    console.log(chalk.green('Current implementation verified as v1.'));
  } catch (error: unknown) {
    console.error(chalk.red(`Could not identify current implementation: ${errorMessage(error)}`));

    return;
  }

  // -----------------------------------------------------------------------
  // Step 7: Install v2.
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 7: Installing new v2 WASM...'));

  try {
    const upload = await submitOperation(
      server,
      RPC_URL,
      admin,

      Operation.uploadContractWasm({
        wasm: v2Wasm,
      }),
    );

    console.log(chalk.green('v2 WASM installed.'));

    console.log(`  New WASM hash     : ${v2WasmHash.toString('hex')}`);

    console.log(`  Upload transaction: ${upload.transactionHash}`);
  } catch (error: unknown) {
    console.error(chalk.red(`Could not install v2: ${errorMessage(error)}`));

    return;
  }

  // -----------------------------------------------------------------------
  // Step 8: Unauthorized-upgrade rejection.
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 8: Testing upgrade authorization...'));

  try {
    await demonstrateUnauthorizedUpgrade(
      server,
      RPC_URL,
      attacker,
      admin,
      deployedContract,
      v2WasmHash,
    );
  } catch (error: unknown) {
    console.error(chalk.red(`Authorization test failed unexpectedly: ${errorMessage(error)}`));

    return;
  }

  // Confirm attacker did not alter the contract.
  try {
    const afterUnauthorized = await identifyCurrentImplementation(server, contractId);

    if (!afterUnauthorized.wasmHash.equals(v1WasmHash)) {
      throw new Error('Unauthorized test unexpectedly changed the contract implementation.');
    }

    console.log(chalk.green('  Contract remains on v1 after unauthorized attempt.'));
  } catch (error: unknown) {
    console.error(chalk.red(errorMessage(error)));

    return;
  }

  // -----------------------------------------------------------------------
  // Step 9: Failed-upgrade handling.
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 9: Demonstrating failed-upgrade handling...'));

  await demonstrateFailedUpgrade(server, admin, deployedContract);

  // -----------------------------------------------------------------------
  // Step 10: Build and SIMULATE authorized upgrade.
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 10: Building and simulating authorized upgrade...'));

  let upgradeSimulation: SimulatedOperation;

  try {
    upgradeSimulation = await simulateOperation(
      server,
      admin,

      deployedContract.call('upgrade', xdr.ScVal.scvBytes(v2WasmHash)),
    );

    console.log(chalk.green('Upgrade simulation succeeded.'));

    console.log(`  Contract ID        : ${contractId}`);

    console.log(`  Previous WASM hash : ${previousImplementationHash.toString('hex')}`);

    console.log(`  New WASM hash      : ${v2WasmHash.toString('hex')}`);

    console.log(`  Contract method    : upgrade`);

    console.log(`  Argument            : ${v2WasmHash.toString('hex')}`);

    console.log(`  Minimum resource fee: ${upgradeSimulation.simulation.minResourceFee}`);

    console.log('\n  Upgrade authorization:');

    displayAuthorization(upgradeSimulation.simulation, admin.publicKey());
  } catch (error: unknown) {
    console.error(chalk.red(`Authorized upgrade simulation failed: ${errorMessage(error)}`));

    return;
  }

  // -----------------------------------------------------------------------
  // Step 11: Sign and submit the SAME simulated upgrade.
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 11: Signing and submitting upgrade...'));

  let upgradeTransactionHash: string;

  try {
    const upgrade = await submitSimulation(server, RPC_URL, admin, upgradeSimulation);

    upgradeTransactionHash = upgrade.transactionHash;

    console.log(chalk.green('Upgrade transaction confirmed.'));

    console.log(`  Upgrade transaction hash: ${upgradeTransactionHash}`);

    console.log(`  Upgrade authorization    : AUTHORIZED`);

    console.log(
      `  Confirmed ledger         : ${
        upgrade.confirmation.ledger ?? upgrade.confirmation.latestLedger ?? 'unknown'
      }`,
    );
  } catch (error: unknown) {
    console.error(chalk.red(`Upgrade submission failed: ${errorMessage(error)}`));

    return;
  }

  // -----------------------------------------------------------------------
  // Step 12: Post-upgrade hook.
  //
  // The bundled v2 contract contains handle_upgrade(). Upgrade/migration
  // design belongs to the application contract, not the Stellar network.
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 12: Running post-upgrade hook...'));

  try {
    const hook = await submitOperation(
      server,
      RPC_URL,
      admin,

      deployedContract.call('handle_upgrade'),
    );

    console.log(chalk.green('Post-upgrade hook completed.'));

    console.log(`  Hook transaction: ${hook.transactionHash}`);
  } catch (error: unknown) {
    console.error(chalk.red(`Post-upgrade hook failed: ${errorMessage(error)}`));

    return;
  }

  // -----------------------------------------------------------------------
  // Step 13: Verify implementation and contract behavior.
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 13: Verifying upgraded implementation...'));

  let verification: UpgradeVerification;

  try {
    verification = await verifyUpgrade(server, admin, deployedContract, contractId, v2WasmHash);
  } catch (error: unknown) {
    console.error(chalk.red(`Post-upgrade verification failed: ${errorMessage(error)}`));

    return;
  }

  console.log(`  Contract ID         : ${contractId}`);

  console.log(`  Previous WASM hash  : ${previousImplementationHash.toString('hex')}`);

  console.log(`  Expected new hash   : ${verification.expectedWasmHash}`);

  console.log(`  Current WASM hash   : ${verification.actualWasmHash}`);

  console.log(`  WASM hash matches   : ${verification.wasmMatches ? 'YES' : 'NO'}`);

  console.log(`  Contract version    : ${verification.version}`);

  console.log(`  new_v2_fn() result  : ${verification.newFunctionValue}`);

  console.log(`  Verification result : ${verification.verified ? 'SUCCESS' : 'FAILED'}`);

  if (!verification.verified) {
    console.error(chalk.red('Upgrade verification did not satisfy the expected v2 state.'));

    return;
  }

  console.log(chalk.green('\nContract upgrade verified successfully.'));

  console.log(
    chalk.cyan(
      '\nHow Soroban upgrade authorization works:\n' +
        "  - Soroban lets a contract replace its current WASM, but the network does not define the application's upgrade policy.\n" +
        '  - The contract itself decides who may call its upgrade function.\n' +
        '  - This bundled contract stores an administrator and calls require_auth() before updating the current contract WASM.\n' +
        '  - When the administrator is also the transaction source, its transaction signature can satisfy source-account authorization.\n' +
        "  - An unrelated transaction source cannot authorize the administrator's contract action merely by signing the transaction envelope.\n" +
        '  - Production contracts should carefully design administrator keys, multisig/governance, migrations, rollback plans, and implementation verification.',
    ),
  );

  console.log(
    chalk.cyan(
      '\nUpgrade summary:\n' +
        `  Contract ID            : ${contractId}\n` +
        `  Previous WASM hash     : ${previousImplementationHash.toString('hex')}\n` +
        `  New WASM hash          : ${v2WasmHash.toString('hex')}\n` +
        `  Upgrade transaction    : ${upgradeTransactionHash}\n` +
        '  Upgrade authorization  : AUTHORIZED\n' +
        `  Verification result    : ${verification.verified ? 'SUCCESS' : 'FAILED'}`,
    ),
  );
}
