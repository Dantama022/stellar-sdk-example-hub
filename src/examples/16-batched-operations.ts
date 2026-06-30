import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to fund account ${publicKey}: ${response.statusText}`);
  }
}

/**
 * Demonstrates atomic batching: each payment is bundled into one transaction, so either all
 * payments succeed together or the entire envelope fails and none of the transfers apply.
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Batched Operations Example...');

  const sender = Keypair.random();
  const recipients = [Keypair.random(), Keypair.random(), Keypair.random()];

  console.log(`Sender Public Key: ${sender.publicKey()}`);
  recipients.forEach((recipient, index) => {
    console.log(`Recipient ${index + 1} Public Key: ${recipient.publicKey()}`);
  });

  console.log('\nFunding accounts via Friendbot...');
  await fundAccount(sender.publicKey());
  await Promise.all(recipients.map((recipient) => fundAccount(recipient.publicKey())));

  const senderAccount = await server.loadAccount(sender.publicKey());
  const tx = new TransactionBuilder(senderAccount, {
    fee: '300',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: recipients[0].publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .addOperation(
      Operation.payment({
        destination: recipients[1].publicKey(),
        asset: Asset.native(),
        amount: '2',
      }),
    )
    .addOperation(
      Operation.payment({
        destination: recipients[2].publicKey(),
        asset: Asset.native(),
        amount: '3',
      }),
    )
    .setTimeout(30)
    .build();

  console.log(`Transaction contains ${tx.operations.length} payment operations.`);

  tx.sign(sender);
  const response = await server.submitTransaction(tx);
  console.log(`Transaction Hash: ${response.hash}`);

  const operations = await server.operations().forTransaction(response.hash).call();
  console.log('Executed operations:');
  for (const record of operations.records) {
    if (record.type === 'payment') {
      console.log(`  - ${record.amount} XLM to ${record.to}`);
    }
  }
  console.log('All payment operations executed atomically in one transaction.');
}
