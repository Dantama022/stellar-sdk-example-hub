import { Keypair, Horizon, TransactionBuilder, Networks, Operation } from '@stellar/stellar-sdk';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Account Inflation Destination Example...');

  // Historical note on inflation
  console.log('Note: The Stellar network inflation mechanism was disabled in Protocol 12 (2019).');
  console.log(
    'However, configuring an inflation destination remains a valid account option and is supported by the protocol and SDK.',
  );

  const source = Keypair.random();
  const destination = Keypair.random();

  console.log(`\nSource account: ${source.publicKey()}`);
  console.log(`Inflation Destination account: ${destination.publicKey()}`);

  console.log('Funding accounts via Friendbot...');
  await Promise.all([
    fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(source.publicKey())}`),
    fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(destination.publicKey())}`),
  ]);

  let sourceAccount = await server.loadAccount(source.publicKey());

  // 1. Set the inflation destination
  console.log('\nSetting inflation destination...');
  let tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.setOptions({
        inflationDest: destination.publicKey(),
      }),
    )
    .setTimeout(30)
    .build();

  tx.sign(source);
  let result = await server.submitTransaction(tx);
  console.log(`Transaction submitted successfully! Hash: ${result.hash}`);

  // Query and Verify
  sourceAccount = await server.loadAccount(source.publicKey());
  console.log(`Current Inflation Destination: ${sourceAccount.inflation_destination}`);

  // 2. Remove the inflation destination
  // Note: The Stellar protocol does not have a "clear" flag for the inflation destination.
  // The standard mechanism to "remove" it is to set the destination to the account's own ID.
  console.log('\nRemoving inflation destination (setting it to the account itself)...');
  tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.setOptions({
        inflationDest: source.publicKey(),
      }),
    )
    .setTimeout(30)
    .build();

  tx.sign(source);
  result = await server.submitTransaction(tx);
  console.log(`Transaction submitted successfully! Hash: ${result.hash}`);

  // Query and Verify
  sourceAccount = await server.loadAccount(source.publicKey());
  console.log(`Updated Inflation Destination: ${sourceAccount.inflation_destination}`);

  if (sourceAccount.inflation_destination === source.publicKey()) {
    console.log('Inflation destination successfully cleared (pointed to self).');
  }
}
