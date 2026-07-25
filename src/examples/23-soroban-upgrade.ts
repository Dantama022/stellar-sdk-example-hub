import { createHash } from 'crypto';
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
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

const BASE_FEE = '100000';
const DEPLOY_SALT = Buffer.alloc(32, 9);

export function computeWasmHash(wasm: Buffer): Buffer {
  return createHash('sha256').update(wasm).digest();
}

export async function pollSuccessfulTransaction(
  server: rpc.Server,
  hash: string,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const response = await server.pollTransaction(hash, { attempts: 25 });

  if (response.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Transaction ${hash} finished with status ${response.status}`);
  }

  return response;
}

async function submitSorobanOperation(
  server: rpc.Server,
  signer: Keypair,
  operation: xdr.Operation,
): Promise<rpc.Api.SimulateTransactionResponse> {
  const account = await server.getAccount(signer.publicKey());
  let tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }

  tx = rpc.assembleTransaction(tx, simulation).build();
  tx.sign(signer);

  const submission = await server.sendTransaction(tx);
  if (submission.status === 'ERROR') {
    throw new Error('Soroban transaction submission failed.');
  }

  await pollSuccessfulTransaction(server, submission.hash);
  return simulation;
}

function loadWasm(relativePath: string): Buffer {
  return fs.readFileSync(path.join(__dirname, relativePath));
}

function contractIdFromSimulation(simulation: rpc.Api.SimulateTransactionResponse): string {
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result?.retval) {
    throw new Error('Deployment simulation did not return a contract address.');
  }

  return Address.fromScVal(simulation.result.retval).toString();
}

export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  const server = new rpc.Server(rpcUrl);

  console.log(chalk.bold('Soroban contract upgrade workflow'));
  console.log(
    chalk.gray(
      'Upgrade swaps contract WASM while keeping storage. Always test migrations and run explicit post-upgrade hooks when layouts change.',
    ),
  );

  const deployer = Keypair.random();
  console.log(`\nDeployer: ${deployer.publicKey()}`);

  const fundResponse = await fetch(`https://friendbot.stellar.org/?addr=${deployer.publicKey()}`);
  if (!fundResponse.ok) {
    throw new Error('Friendbot funding failed for deployer account.');
  }

  const v1Wasm = loadWasm('../contracts/sample-v1/upgradeable_v1.wasm');
  const v2Wasm = loadWasm('../contracts/sample-v2/upgradeable_v2.wasm');

  console.log(chalk.yellow('\nStep 1: Upload initial WASM (v1)...'));
  await submitSorobanOperation(server, deployer, Operation.uploadContractWasm({ wasm: v1Wasm }));
  const v1WasmHash = computeWasmHash(v1Wasm);
  console.log(`v1 WASM hash: ${v1WasmHash.toString('hex')}`);

  console.log(chalk.yellow('\nStep 2: Deploy contract instance with constructor admin...'));
  const deploySimulation = await submitSorobanOperation(
    server,
    deployer,
    Operation.createCustomContract({
      address: Address.fromString(deployer.publicKey()),
      wasmHash: v1WasmHash,
      salt: DEPLOY_SALT,
      constructorArgs: [new Address(deployer.publicKey()).toScVal()],
    }),
  );

  const contractId = contractIdFromSimulation(deploySimulation);
  const contract = new Contract(contractId);
  console.log(`Contract ID: ${contractId}`);

  const versionBefore = await invokeContractU32(server, deployer, contract, 'version');
  console.log(`Contract version before upgrade: ${versionBefore}`);

  console.log(chalk.yellow('\nStep 3: Upload upgraded WASM (v2)...'));
  await submitSorobanOperation(server, deployer, Operation.uploadContractWasm({ wasm: v2Wasm }));
  const v2WasmHash = computeWasmHash(v2Wasm);
  console.log(`v2 WASM hash: ${v2WasmHash.toString('hex')}`);

  console.log(chalk.yellow('\nStep 4: Execute upgrade...'));
  await submitSorobanOperation(
    server,
    deployer,
    contract.call('upgrade', xdr.ScVal.scvBytes(v2WasmHash)),
  );

  console.log(chalk.yellow('\nStep 5: Run post-upgrade migration and verify state...'));
  await submitSorobanOperation(server, deployer, contract.call('handle_upgrade'));

  const versionAfter = await invokeContractU32(server, deployer, contract, 'version');
  const newFunctionValue = await invokeContractU32(server, deployer, contract, 'new_v2_fn');

  console.log(chalk.green(`\nVersion after upgrade: ${versionAfter}`));
  console.log(chalk.green(`new_v2_fn() result: ${newFunctionValue}`));

  if (versionAfter !== 2) {
    throw new Error('Upgrade verification failed: expected contract version 2.');
  }

  console.log(
    chalk.cyan(
      '\nSummary: deployed v1, uploaded v2 WASM, upgraded the instance, ran handle_upgrade, and confirmed persisted admin storage plus new v2 functionality.',
    ),
  );
}

async function invokeContractU32(
  server: rpc.Server,
  signer: Keypair,
  contract: Contract,
  method: string,
): Promise<number> {
  const simulation = await submitSorobanOperation(server, signer, contract.call(method));
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result?.retval) {
    throw new Error(`Contract method ${method} returned no value.`);
  }

  return Number(scValToNative(simulation.result.retval));
}
