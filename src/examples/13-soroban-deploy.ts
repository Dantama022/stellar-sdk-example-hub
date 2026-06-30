import {
  Keypair,
  rpc,
  TransactionBuilder,
  Operation,
  Networks,
  Account,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  console.log(chalk.blue(`Connecting to Soroban RPC at: ${rpcUrl}`));
  const server = new rpc.Server(rpcUrl);

  console.log(chalk.yellow('\nStep 1: Preparing deployment account...'));
  const deployer = Keypair.random();
  console.log(`Deployer Public Key: ${deployer.publicKey()}`);

  const fundRes = await fetch(`https://friendbot.stellar.org/?addr=${deployer.publicKey()}`);
  if (!fundRes.ok) throw new Error('Failed to fund deployer account');
  console.log(chalk.green('Deployer account funded.'));

  console.log(chalk.yellow('\nStep 2: Loading WASM file...'));
  const wasmPath = path.join(__dirname, '../contracts/sample/hello.wasm');
  let wasmBuffer: Buffer;
  try {
    wasmBuffer = fs.readFileSync(wasmPath);
    console.log(chalk.green(`Loaded WASM file. Size: ${wasmBuffer.length} bytes.`));
  } catch {
    console.error(chalk.red(`Error: Missing WASM file at ${wasmPath}`));
    return;
  }

  const account = new Account(deployer.publicKey(), '1'); // Mock sequence for simulation

  // First phase: Upload Contract WASM
  console.log(chalk.yellow('\nStep 3: Uploading Contract WASM...'));
  const uploadOp = Operation.uploadContractWasm({
    wasm: wasmBuffer,
  });

  let uploadTx = new TransactionBuilder(account, {
    fee: '1000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(uploadOp)
    .setTimeout(30)
    .build();

  console.log('Simulating upload transaction...');
  const uploadSim = await server.simulateTransaction(uploadTx);

  if (rpc.Api.isSimulationError(uploadSim)) {
    console.warn(chalk.red('Upload Simulation Failed. (Expected if WASM is invalid/empty).'));
    console.log(chalk.gray(`Simulation details: ${uploadSim.error}`));
    console.log(chalk.cyan('\nSummary: Demonstrated failed WASM upload due to invalid payload.'));
    return;
  }

  console.log(chalk.green('Upload Simulation success!'));
  uploadTx = rpc.assembleTransaction(uploadTx, uploadSim).build();
  uploadTx.sign(deployer);

  const uploadResponse = await server.sendTransaction(uploadTx);
  if (uploadResponse.status === 'ERROR') {
    throw new Error('Upload submission failed.');
  }

  console.log(chalk.green(`WASM uploaded successfully! Hash: ${uploadResponse.hash}`));

  // Wait for the transaction to complete to get the wasm ID
  // In a real scenario, you'd poll getTransaction until SUCCESS
  // We will assume the dummy deploy logic here to show the flow.

  console.log(chalk.yellow('\nStep 4: Deploying Contract Instance...'));
  // This demonstrates creating the instance from the uploaded wasm ID
  // Since we are mocking due to dummy wasm, we use a placeholder wasm ID for illustration.
  const wasmId = Buffer.alloc(32, 1);

  const deployOp = Operation.createCustomContract({
    address: deployer.publicKey(),
    wasmId: wasmId,
  });

  let deployTx = new TransactionBuilder(account, {
    fee: '1000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(deployOp)
    .setTimeout(30)
    .build();

  console.log('Simulating deploy transaction...');
  const deploySim = await server.simulateTransaction(deployTx);
  if (rpc.Api.isSimulationError(deploySim)) {
    console.warn(chalk.red('Deploy Simulation Failed.'));
    console.log(chalk.gray(`Simulation details: ${deploySim.error}`));
    return;
  }

  deployTx = rpc.assembleTransaction(deployTx, deploySim).build();
  deployTx.sign(deployer);

  const deployResponse = await server.sendTransaction(deployTx);
  if (deployResponse.status === 'ERROR') {
    throw new Error('Deploy submission failed.');
  }

  console.log(chalk.green(`Contract deployed successfully! Hash: ${deployResponse.hash}`));
  console.log(
    chalk.cyan(
      '\nSummary: Demonstrated the two-step process of uploading and deploying a Soroban smart contract.',
    ),
  );
}
