import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
} from '@stellar/stellar-sdk';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Account Home Domain Example...');

  const accountKeypair = Keypair.random();
  console.log('Funding account via Friendbot...');
  await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(accountKeypair.publicKey())}`);

  const checkHomeDomain = async () => {
    const acc = await server.loadAccount(accountKeypair.publicKey());
    console.log(`Current Home Domain: ${acc.home_domain || '(None configured)'}`);
    return acc;
  };

  // 1. Initial State
  console.log('\n--- Initial Account State ---');
  await checkHomeDomain();

  // 2. Set Home Domain
  console.log('\n--- Setting Home Domain ---');
  const initialDomain = 'stellar.org';
  let account = await server.loadAccount(accountKeypair.publicKey());
  
  let tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.setOptions({ homeDomain: initialDomain }))
    .setTimeout(30)
    .build();

  tx.sign(accountKeypair);
  await server.submitTransaction(tx);
  console.log(`Successfully set home domain to: ${initialDomain}`);
  await checkHomeDomain();

  // 3. Update Home Domain
  console.log('\n--- Updating Home Domain ---');
  const updatedDomain = 'developers.stellar.org';
  account = await server.loadAccount(accountKeypair.publicKey());

  tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.setOptions({ homeDomain: updatedDomain }))
    .setTimeout(30)
    .build();

  tx.sign(accountKeypair);
  await server.submitTransaction(tx);
  console.log(`Successfully updated home domain to: ${updatedDomain}`);
  await checkHomeDomain();

  // 4. Remove Home Domain
  console.log('\n--- Removing Home Domain ---');
  account = await server.loadAccount(accountKeypair.publicKey());

  tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
    // Setting an empty string removes the home domain
    .addOperation(Operation.setOptions({ clearFlags: 0, homeDomain: '' }))
    .setTimeout(30)
    .build();

  tx.sign(accountKeypair);
  await server.submitTransaction(tx);
  console.log('Successfully removed home domain.');
  await checkHomeDomain();
}