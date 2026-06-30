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
 * Builds a time-bounded transaction, demonstrates the expected early failure, then waits for the
 * execution window to open and resubmits the same transaction successfully.
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Time-Locked Escrow Example...');

  const source = Keypair.random();
  const destination = Keypair.random();

  console.log(`Source Public Key:      ${source.publicKey()}`);
  console.log(`Destination Public Key: ${destination.publicKey()}`);

  console.log('\nFunding accounts via Friendbot...');
  await fundAccount(source.publicKey());
  await fundAccount(destination.publicKey());

  const sourceAccount = await server.loadAccount(source.publicKey());
  const openAt = Math.floor(Date.now() / 1000) + 5;
  const closeAt = openAt + 60;

  console.log(`Transaction valid from ${openAt} until ${closeAt}.`);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destination.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(0)
    .setTimebounds(openAt, closeAt)
    .build();

  tx.sign(source);

  try {
    console.log('Submitting before the valid execution window (expected to fail)...');
    await server.submitTransaction(tx);
    throw new Error('Expected the transaction to fail before minTime.');
  } catch (error: any) {
    const message = error.response?.data?.extras?.result_codes?.transaction || error.message;
    console.log(`Early submission rejected: ${message}`);
  }

  const waitMs = Math.max(openAt * 1000 - Date.now() + 1000, 0);
  if (waitMs > 0) {
    console.log('Waiting for the time window to open...');
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const response = await server.submitTransaction(tx);
  console.log(`Submission succeeded inside the window. Transaction hash: ${response.hash}`);
}
