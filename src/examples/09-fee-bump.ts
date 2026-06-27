import {
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Asset,
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
 * Demonstrates fee-bump architecture: the inner transaction is signed by the source account,
 * then wrapped so a sponsor account pays the network fee on submission.
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Fee-Bump Transaction Example...');

  const source = Keypair.random();
  const sponsor = Keypair.random();
  const destination = Keypair.random();

  console.log(`Source Public Key:   ${source.publicKey()}`);
  console.log(`Sponsor Public Key:  ${sponsor.publicKey()}`);
  console.log(`Destination Public Key: ${destination.publicKey()}`);

  console.log('\nFunding accounts via Friendbot...');
  await fundAccount(source.publicKey());
  await fundAccount(sponsor.publicKey());
  await fundAccount(destination.publicKey());
  const sourceAccount = await server.loadAccount(source.publicKey());
  const innerTx = new TransactionBuilder(sourceAccount, {
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
    .setTimeout(30)
    .build();

  innerTx.sign(source);
  console.log('Inner transaction created and signed by the source account.');

  const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
    sponsor.publicKey(),
    '200',
    innerTx,
    Networks.TESTNET,
  );
  feeBumpTx.sign(sponsor);

  console.log('Submitting fee-bump transaction with sponsor-paid fees...');
  const response = await server.submitTransaction(feeBumpTx);
  console.log(`Transaction Hash: ${response.hash}`);
  console.log(`Fee Payer: ${sponsor.publicKey()}`);
  console.log(`Transaction Source: ${source.publicKey()}`);

  const sourceBalances = await server.loadAccount(source.publicKey());
  const sponsorBalances = await server.loadAccount(sponsor.publicKey());
  const sourceNative = sourceBalances.balances.find(
    (balance) => balance.asset_type === 'native',
  )?.balance;
  const sponsorNative = sponsorBalances.balances.find(
    (balance) => balance.asset_type === 'native',
  )?.balance;

  console.log(`Source native balance: ${sourceNative}`);
  console.log(`Sponsor native balance: ${sponsorNative}`);
}
