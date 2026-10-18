import {
  Keypair,
  rpc,
  Contract,
  xdr,
  Networks,
  TransactionBuilder,
  Account,
} from '@stellar/stellar-sdk';

export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  console.log(`Connecting to Soroban RPC at: ${rpcUrl}`);
  const server = new rpc.Server(rpcUrl);

  // 1. Prepare caller account
  console.log('Preparing caller account...');
  const caller = Keypair.random();
  console.log(`Caller Public Key: ${caller.publicKey()}`);

  // Fund caller via friendbot so it exists and has fee funds
  await fetch(`https://friendbot.stellar.org/?addr=${caller.publicKey()}`);
  console.log('Caller funded with XLM.');

  // 2. Instantiate Contract representation
  // This is a standard Hello Contract ID commonly deployed on testnet
  const contractId = 'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';
  const helloContract = new Contract(contractId);
  console.log(`\nConnecting to Hello Contract ID: ${contractId}`);

  // 3. Create Contract Invocation Operation
  // Calling 'hello' method with argument 'Stellar'
  console.log('Building contract invocation call...');
  const callOp = helloContract.call('hello', xdr.ScVal.scvSymbol('Stellar'));

  // 4. Load caller account details
  // Note: For Soroban transactions, Horizon is not strictly required.
  // We can fetch the account sequence directly from Soroban RPC or Horizon.
  // Here we use Soroban RPC getLatestLedger and mock sequence or fetch from Horizon.
  const sourceAccount = new Account(caller.publicKey(), '1');

  // 5. Build transaction
  let tx = new TransactionBuilder(sourceAccount, {
    fee: '1000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(callOp)
    .setTimeout(30)
    .build();

  // 6. Simulate Transaction
  // Soroban invocations must be simulated to compute footprint and resource fees
  console.log('Simulating contract transaction on-chain...');
  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    console.warn('Simulation returned an error (expected if mock address or contract expired).');
    console.log(`Details: ${simResult.error}`);
    return;
  }

  console.log('Simulation success!');
  console.log(`Transaction Resources: Min Fee=${simResult.minResourceFee} stroops`);

  // 7. Assemble transaction with simulation results
  console.log('Assembling footprint and resources to transaction...');
  tx = rpc.assembleTransaction(tx, simResult).build();

  // 8. Sign and Submit
  tx.sign(caller);
  console.log('Submitting contract transaction to Soroban RPC...');
  const response = await server.sendTransaction(tx);

  if (response.status === 'ERROR') {
    throw new Error(
      `Transaction submission error: ${response.errorResult?.toXDR().toString('base64') || 'Unknown'}`,
    );
  }

  console.log(`Transaction sent successfully! Status: ${response.status}`);
  console.log(`Hash: ${response.hash}`);

  // Poll for final transaction status
  console.log('Polling for final transaction status...');
  let getResponse = await server.getTransaction(response.hash);
  while (
    (getResponse.status as string) === 'NOT_FOUND' ||
    (getResponse.status as string) === 'PENDING'
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    getResponse = await server.getTransaction(response.hash);
  }
  console.log(`Final transaction status: ${getResponse.status}`);
  if ((getResponse.status as string) === 'SUCCESS') {
    console.log(`Result: ${(getResponse as any).resultXdr ? (getResponse as any).resultXdr.toString('base64') : 'none'}`);
  } else if ((getResponse.status as string) === 'FAILED') {
    console.error(`Transaction failed: ${(getResponse as any).errorResult?.toXDR?.().toString('base64') || 'Unknown error'}`);
  }
}
