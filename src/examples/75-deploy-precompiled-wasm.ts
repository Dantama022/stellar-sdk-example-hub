import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  Address,
  Keypair,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base fee in stroops used for every transaction in this example.
 * Soroban transactions carry an additional resource fee computed at simulation
 * time; this base covers the inclusion fee portion.
 */
const BASE_FEE = '100000';

/**
 * Salt used to derive a deterministic contract address for the deploy step.
 * Using a fixed salt means re-running the example after the WASM has already
 * been installed will still produce the same contract ID.  In production you
 * would normally use a random salt or one derived from your deployment pipeline.
 */
const DEPLOY_SALT = Buffer.alloc(32, 0x75); // 0x75 = ASCII 'u' — unique per example

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes the SHA-256 hash of the WASM buffer.
 *
 * This hash is the on-chain key for the ContractCode ledger entry.  After a
 * successful uploadContractWasm transaction the network stores the binary under
 * this hash.  The same hash is then passed to createCustomContract to point
 * the new contract instance at the correct code.
 */
function computeWasmHash(wasm: Buffer): Buffer {
  return createHash('sha256').update(wasm).digest();
}

/**
 * Simulates, assembles, signs, submits, and polls a single Soroban operation.
 *
 * Returns the simulation result, which carries:
 *   - result.retval  — the return value of an InvokeHostFunction operation
 *   - transactionData — the assembled Soroban resource footprint
 *
 * Throws on simulation error, submission error, or if the transaction does not
 * reach SUCCESS status within the polling window.
 */
async function submitAndPoll(
  server: rpc.Server,
  signer: Keypair,
  operation: xdr.Operation,
  networkPassphrase: string,
): Promise<rpc.Api.SimulateTransactionResponse> {
  // Use server.getAccount() to fetch the real account sequence number.
  // Using a mock sequence ('1') would cause txBAD_SEQ on the actual submission.
  const account = await server.getAccount(signer.publicKey());

  let tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  // Step 1: Simulate to compute the Soroban resource footprint and min fee.
  const simulation = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }

  // Step 2: Assemble — merges the SorobanTransactionData and auth entries that
  // the simulation computed into the transaction envelope.
  tx = rpc.assembleTransaction(tx, simulation).build();
  tx.sign(signer);

  // Step 3: Submit.
  const sendResp = await server.sendTransaction(tx);
  if (sendResp.status === 'ERROR') {
    const code = sendResp.errorResult?.result().switch().name ?? 'unknown';
    throw new Error(`Transaction submission failed: ${code}`);
  }

  // Step 4: Poll until the transaction is included in a ledger.
  // pollTransaction retries getTransaction until status is no longer NOT_FOUND.
  const finalResp = await server.pollTransaction(sendResp.hash, { attempts: 30 });

  if (finalResp.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Transaction ${sendResp.hash} finished with status: ${finalResp.status}`);
  }

  return simulation;
}

/**
 * Loads, validates, and returns a WASM buffer from the given file path.
 *
 * Validation checks:
 *   1. The file must exist and be readable.
 *   2. The file must not be empty.
 *   3. The first four bytes must be the WebAssembly magic number (0x00 0x61 0x73 0x6D).
 *
 * Returns null and logs a human-readable error if any check fails, so the
 * caller can exit gracefully without throwing.
 */
function loadAndValidateWasm(filePath: string): Buffer | null {
  // Check existence
  if (!fs.existsSync(filePath)) {
    console.error(chalk.red(`  Error: WASM file not found at: ${filePath}`));
    console.error(
      chalk.gray(
        '  Place a compiled .wasm artifact at the path above, or pass a custom\n' +
          '  path via the WASM_PATH environment variable.',
      ),
    );
    return null;
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err: any) {
    console.error(chalk.red(`  Error reading WASM file: ${err.message}`));
    return null;
  }

  // Check non-empty
  if (buf.length === 0) {
    console.error(chalk.red('  Error: WASM file is empty.'));
    return null;
  }

  // Validate WebAssembly magic number: \0asm
  const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
  if (buf.length < 4 || !buf.slice(0, 4).equals(WASM_MAGIC)) {
    console.error(
      chalk.red(
        `  Error: File does not start with the WebAssembly magic number (\\0asm).\n` +
          `  Got: 0x${buf.slice(0, 4).toString('hex').toUpperCase()}\n` +
          `  Expected: 0x${WASM_MAGIC.toString('hex').toUpperCase()}\n` +
          `  The file may be corrupted, truncated, or not a compiled WASM binary.`,
      ),
    );
    return null;
  }

  return buf;
}

/**
 * Verifies that a contract instance exists on-chain after deployment by calling
 * getLedgerEntries with the contract's instance key.
 *
 * This is a lightweight read — it only checks the ContractData (instance) entry,
 * not the ContractCode (WASM) entry.  A successful response confirms the network
 * has recorded the contract and it is live.
 */
async function verifyDeployment(server: rpc.Server, contractId: string): Promise<void> {
  console.log(chalk.yellow('\nStep 5: Verifying deployed contract on-chain…'));

  // Build the LedgerKey for the contract instance (ContractData entry)
  const instanceKey = new xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

  const resp = await server.getLedgerEntries(instanceKey);

  if (!resp.entries || resp.entries.length === 0) {
    console.warn(
      chalk.yellow(
        '  Warning: getLedgerEntries returned no entries for the deployed contract.\n' +
          '  The contract may have been archived or the ledger state has not yet propagated.',
      ),
    );
    return;
  }

  const entry = resp.entries[0];
  const lastMod = entry.lastModifiedLedgerSeq ?? 'unknown';
  const liveUntil = entry.liveUntilLedgerSeq ?? 'unknown';

  console.log(chalk.green('  ✓ Contract instance confirmed on-chain.'));
  console.log(`    Last modified ledger:  ${lastMod}`);
  console.log(`    Live until ledger:     ${liveUntil}`);
  console.log(`    Latest ledger (RPC):   ${resp.latestLedger}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the Deploy Precompiled WASM example.
 *
 * Demonstrates the complete two-phase deployment workflow for a precompiled
 * Soroban contract artifact:
 *
 *   Phase 1 — Upload (installContractCode)
 *     The WASM binary is submitted to the network via an
 *     uploadContractWasm operation.  The network stores the binary in a
 *     ContractCode ledger entry, keyed by its SHA-256 hash.  The hash is
 *     returned as the operation's return value.  Multiple contracts can share
 *     the same code by pointing at the same hash — uploading an already-known
 *     hash is idempotent.
 *
 *   Phase 2 — Deploy (createCustomContract)
 *     A createCustomContract operation is submitted with the WASM hash and a
 *     salt.  The network derives a deterministic contract address
 *     (ContractID = hash(deployer + salt + wasmHash)) and creates a
 *     ContractData (instance) ledger entry pointing at the code.  The contract
 *     address is returned as the operation's return value.
 *
 * After deployment, a getLedgerEntries call confirms the instance is live and
 * shows the ledger at which it will expire (TTL).
 *
 * Accepted parameters (all optional):
 *   wasmPath — file system path to the .wasm artifact.
 *              Defaults to WASM_PATH env var, then src/contracts/sample/hello.wasm.
 */
export async function run(params?: { wasmPath?: string }): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  const networkPassphrase = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;

  console.log(chalk.blue(`Deploy Precompiled WASM — RPC: ${rpcUrl}`));

  // ── Step 1: Resolve and validate the WASM file ────────────────────────────
  console.log(chalk.yellow('\nStep 1: Loading WASM artifact…'));

  const rawPath =
    (params?.wasmPath ?? '').trim() ||
    process.env.WASM_PATH ||
    path.join(__dirname, '../contracts/sample/hello.wasm');

  // Resolve to an absolute path so error messages are unambiguous
  const wasmPath = path.resolve(rawPath);

  console.log(`  Source path: ${wasmPath}`);

  const wasmBuffer = loadAndValidateWasm(wasmPath);
  if (!wasmBuffer) {
    // loadAndValidateWasm already printed the error — exit cleanly
    return;
  }

  const wasmSize = wasmBuffer.length;
  const localHash = computeWasmHash(wasmBuffer);

  console.log(chalk.green(`  ✓ WASM loaded.`));
  console.log(`    File size:    ${wasmSize.toLocaleString()} bytes`);
  console.log(`    SHA-256 hash: ${localHash.toString('hex')}`);
  console.log(
    chalk.gray(
      '\n  The SHA-256 hash is the on-chain key for the ContractCode ledger entry.\n' +
        '  The network stores the binary exactly once under this key regardless of\n' +
        '  how many contracts reference it.',
    ),
  );

  // ── Step 2: Fund a deployer account ──────────────────────────────────────
  console.log(chalk.yellow('\nStep 2: Funding deployer account via Friendbot…'));

  const deployer = Keypair.random();
  console.log(`  Deployer public key: ${deployer.publicKey()}`);

  const fundRes = await fetch(`https://friendbot.stellar.org/?addr=${deployer.publicKey()}`);
  if (!fundRes.ok) {
    console.error(
      chalk.red(
        `  Friendbot returned HTTP ${fundRes.status}.\n` +
          '  The Testnet faucet may be rate-limited. Wait a moment and retry.',
      ),
    );
    return;
  }
  console.log(chalk.green('  ✓ Deployer funded with XLM.'));

  const server = new rpc.Server(rpcUrl);

  // ── Step 3: Upload the WASM binary ───────────────────────────────────────
  //
  // uploadContractWasm stores the WASM on-chain under its SHA-256 hash.
  // The operation's return value contains the installed hash as scvBytes.
  // We cross-check it against the locally computed hash to confirm the
  // network received the binary we intended.
  //
  // If the same WASM was uploaded by a previous run (or another deployer),
  // the operation is idempotent — the network simply acknowledges the existing
  // entry.  The simulation will still succeed and the same hash will be
  // returned.
  console.log(chalk.yellow('\nStep 3: Uploading WASM to the network…'));
  console.log(
    chalk.gray(
      '  This creates a ContractCode ledger entry keyed by the WASM hash.\n' +
        '  Multiple contracts can share code by referencing the same hash.',
    ),
  );

  let uploadSim: rpc.Api.SimulateTransactionResponse;
  try {
    uploadSim = await submitAndPoll(
      server,
      deployer,
      Operation.uploadContractWasm({ wasm: wasmBuffer }),
      networkPassphrase,
    );
  } catch (err: any) {
    console.error(chalk.red(`\n  Upload failed: ${err.message}`));
    if (err.message?.includes('ExceededLimit') || err.message?.includes('too large')) {
      console.error(
        chalk.gray(
          '  The WASM binary exceeds the network size limit.\n' +
            '  Try a smaller contract or split the code across multiple uploads.',
        ),
      );
    }
    return;
  }

  // Extract and display the installed WASM hash from the simulation return value.
  // uploadContractWasm returns the hash as scvBytes.
  let installedHash = localHash; // fall back to local computation
  if (rpc.Api.isSimulationSuccess(uploadSim) && uploadSim.result?.retval) {
    const retval = uploadSim.result.retval;
    if (retval.switch().name === 'scvBytes') {
      installedHash = Buffer.from(retval.bytes());
    }
  }

  console.log(chalk.green('  ✓ WASM uploaded successfully.'));
  console.log(`    Installed WASM hash: ${chalk.cyan(installedHash.toString('hex'))}`);

  const hashMatch = localHash.equals(installedHash);
  if (hashMatch) {
    console.log(chalk.green('    Hash matches local SHA-256 computation ✓'));
  } else {
    console.warn(
      chalk.yellow(
        `    Warning: installed hash (${installedHash.toString('hex')}) ` +
          `differs from local hash (${localHash.toString('hex')}).`,
      ),
    );
  }

  // ── Step 4: Deploy a contract instance ───────────────────────────────────
  //
  // createCustomContract derives a deterministic contract address from:
  //   hash(network_passphrase + deployer_address + salt + wasm_hash)
  //
  // The operation returns the new contract address as an scvAddress.
  // We extract it via Address.fromScVal(simulation.result.retval).toString().
  //
  // Using a fixed DEPLOY_SALT means repeated runs produce the same contract ID.
  // The deploy will still succeed (no error) even if the contract already exists
  // because the simulation would detect the collision and the submission would
  // be idempotent for the same deployer+salt+wasmHash combination.
  console.log(chalk.yellow('\nStep 4: Deploying contract instance…'));
  console.log(
    chalk.gray(
      '  This creates a ContractData (instance) ledger entry that points\n' +
        '  at the uploaded WASM hash.\n' +
        '  ContractID = hash(networkPassphrase + deployerAddress + salt + wasmHash)',
    ),
  );

  let deploySim: rpc.Api.SimulateTransactionResponse;
  try {
    deploySim = await submitAndPoll(
      server,
      deployer,
      Operation.createCustomContract({
        address: Address.fromString(deployer.publicKey()),
        wasmHash: installedHash,
        salt: DEPLOY_SALT,
      }),
      networkPassphrase,
    );
  } catch (err: any) {
    console.error(chalk.red(`\n  Deploy failed: ${err.message}`));
    if (err.message?.includes('already exists') || err.message?.includes('EXISTING')) {
      console.error(
        chalk.gray(
          '  A contract with this deployer+salt combination already exists.\n' +
            '  Change DEPLOY_SALT or use a different deployer keypair to deploy a new instance.',
        ),
      );
    }
    return;
  }

  // Extract the contract ID from the simulation return value.
  if (!rpc.Api.isSimulationSuccess(deploySim) || !deploySim.result?.retval) {
    console.error(chalk.red('  Deploy transaction succeeded but returned no contract address.'));
    return;
  }

  let contractId: string;
  try {
    contractId = Address.fromScVal(deploySim.result.retval).toString();
  } catch (err: any) {
    console.error(
      chalk.red(`  Could not decode contract address from return value: ${err.message}`),
    );
    return;
  }

  console.log(chalk.green('  ✓ Contract deployed successfully.'));
  console.log(`    Contract ID: ${chalk.cyan(contractId)}`);
  console.log(
    chalk.gray(
      '\n  How to use this contract ID:\n' +
        '    const contract = new Contract(contractId);\n' +
        '    const callOp   = contract.call("methodName", ...args);\n' +
        '    // Simulate, assemble, sign, submit — see example 05-soroban-invoke.',
    ),
  );

  // ── Step 5: Verify the deployment by reading the ledger entry ─────────────
  try {
    await verifyDeployment(server, contractId);
  } catch (err: any) {
    // Verification failure is non-fatal — the deploy itself succeeded
    console.warn(chalk.yellow(`  Verification skipped: ${err.message}`));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(chalk.bold.green('\n━━━ Deployment Complete ━━━'));
  console.log(`  WASM file:     ${wasmPath}`);
  console.log(`  WASM size:     ${wasmSize.toLocaleString()} bytes`);
  console.log(`  WASM hash:     ${chalk.cyan(installedHash.toString('hex'))}`);
  console.log(`  Contract ID:   ${chalk.cyan(contractId)}`);
  console.log(`  Network:       ${networkPassphrase}`);
  console.log(`  Deployer:      ${deployer.publicKey()}`);
  console.log(
    chalk.cyan(
      '\nDeployment workflow recap:\n' +
        '  1. Load the .wasm artifact from disk and validate the magic number.\n' +
        '  2. Compute SHA-256 hash locally for cross-checking.\n' +
        '  3. Submit Operation.uploadContractWasm({ wasm }) — creates the ContractCode entry.\n' +
        '  4. Submit Operation.createCustomContract({ address, wasmHash, salt }) —\n' +
        '     creates the ContractData (instance) entry; returns the contract address.\n' +
        '  5. Call getLedgerEntries(instanceKey) to confirm the instance is live.\n' +
        '\n' +
        'Multiple deployments:\n' +
        '  - The same WASM binary only needs to be uploaded once across all contracts\n' +
        '    that share the code — uploadContractWasm is idempotent for the same hash.\n' +
        '  - To deploy additional instances of the same WASM, change the salt or the\n' +
        '    deployer address; the wasmHash remains the same.',
    ),
  );
}
