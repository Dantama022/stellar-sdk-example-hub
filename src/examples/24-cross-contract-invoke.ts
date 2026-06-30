import {
  Keypair,
  rpc,
  Contract,
  xdr,
  Networks,
  TransactionBuilder,
  Account,
  scValToNative,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  console.log(chalk.blue(`Connecting to Soroban RPC at: ${rpcUrl}`));
  const server = new rpc.Server(rpcUrl);

  console.log(chalk.yellow('\nStep 1: Setting up Caller Account...'));
  const caller = Keypair.random();
  console.log(`Caller Public Key: ${caller.publicKey()}`);

  const fundRes = await fetch(`https://friendbot.stellar.org/?addr=${caller.publicKey()}`);
  if (!fundRes.ok) throw new Error('Failed to fund caller account');
  console.log(chalk.green('Caller account funded.'));

  // In a real scenario, you'd deploy Contract A and Contract B,
  // or use existing deployed instances. We'll use mock contract IDs to demonstrate the workflow.
  const contractAId = 'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';
  const contractBId = 'CBW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';

  console.log(chalk.yellow('\nStep 2: Preparing Cross-Contract Invocation...'));
  console.log(`Contract A: ${contractAId}`);
  console.log(`Contract B (Dependency): ${contractBId}`);

  const contractA = new Contract(contractAId);

  // We want Contract A to invoke Contract B.
  // Usually, Contract A's method takes Contract B's ID as an argument (Address format).
  console.log('Configuring dependency and building invocation...');
  const contractBAddressVal = new Contract(contractBId).address().toScVal();
  const paramVal = xdr.ScVal.scvSymbol('Init');

  // Call "proxy_call" on Contract A, passing Contract B's address
  const callOp = contractA.call('proxy_call', contractBAddressVal, paramVal);

  const sourceAccount = new Account(caller.publicKey(), '1');

  let tx = new TransactionBuilder(sourceAccount, {
    fee: '1000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(callOp)
    .setTimeout(30)
    .build();

  console.log(chalk.yellow('\nStep 3: Simulating Transaction and Resource Estimation...'));
  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    console.warn(
      chalk.red('Simulation failed (Expected with mock contract IDs or expired contracts).'),
    );
    console.log(chalk.gray(`Simulation Error: ${simResult.error}`));
    console.log(
      chalk.cyan(
        '\nSummary: Demonstrated how to construct a cross-contract invocation, including passing contract addresses as parameters, and handling simulation failures gracefully.',
      ),
    );
    return;
  }

  console.log(chalk.green('Simulation success!'));
  console.log(`Minimum Resource Fee: ${simResult.minResourceFee} stroops`);

  console.log(chalk.yellow('\nStep 4: Assembling and Submitting Transaction...'));
  tx = rpc.assembleTransaction(tx, simResult).build();
  tx.sign(caller);

  const response = await server.sendTransaction(tx);
  if (response.status === 'ERROR') {
    console.error(
      chalk.red('Transaction submission failed.'),
      response.errorResult?.toXDR().toString('base64'),
    );
    return;
  }

  console.log(chalk.green(`Transaction successful! Hash: ${response.hash}`));

  // To decode return values, we would normally wait for the transaction to complete
  // using getTransaction, and then parse its returnValue.
  // For demonstration, if we had a return value from simulation:
  if (simResult.result?.retval) {
    console.log(chalk.yellow('\nStep 5: Decoding Returned Values...'));
    try {
      const decodedResult = scValToNative(simResult.result.retval);
      console.log(`Decoded Return Value:`, JSON.stringify(decodedResult));
    } catch (err) {
      console.error(chalk.red('Failed to decode return value:'), err);
    }
  }

  console.log(
    chalk.cyan(
      '\nSummary: Successfully demonstrated constructing and executing a cross-contract invocation, resource estimation, and return value decoding.',
    ),
  );
}
