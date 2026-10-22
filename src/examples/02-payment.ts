import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
} from '@stellar/stellar-sdk';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  // 1. Prepare sender keypair
  console.log('Preparing sender account...');
  const sender = Keypair.random();
  console.log(`Sender Public Key: ${sender.publicKey()}`);

  // Fund sender on testnet so it has balance to spend
  const fundUrl = `https://friendbot.stellar.org/?addr=${sender.publicKey()}`;
  await fetch(fundUrl);
  console.log('Sender funded with 10,000 XLM.');

  // 2. Prepare destination account
  const destination = Keypair.random();
  console.log(`Destination Public Key: ${destination.publicKey()}`);

  // 3. Load sender account sequence number
  const senderAccount = await server.loadAccount(sender.publicKey());

  // 4. Build Payment Transaction
  console.log('\nBuilding transaction envelope...');
  const tx = new TransactionBuilder(senderAccount, {
    fee: '100', // stroops (base fee is 100 stroops = 0.00001 XLM)
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destination.publicKey(),
        asset: Asset.native(),
        amount: '50.5', // 50.5 XLM
      }),
    )
    // Add timebounds (highly recommended in production)
    .setTimeout(30)
    .build();

  // 5. Sign transaction
  console.log('Signing transaction with sender secret key...');
  tx.sign(sender);

  // 6. Submit to Horizon
  console.log('Submitting transaction to Horizon Testnet...');
  const response = await server.submitTransaction(tx);
  console.log(`Transaction submitted successfully!`);
  console.log(`Hash: ${response.hash}`);
  console.log(`Ledger: ${response.ledger}`);
}
