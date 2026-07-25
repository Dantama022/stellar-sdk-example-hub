import { Keypair, Horizon, TransactionBuilder, Networks, Operation } from '@stellar/stellar-sdk';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting End Sponsoring Future Reserves Example...');

  const sponsor = Keypair.random();
  const sponsored = Keypair.random();

  console.log(`\nSponsor account: ${sponsor.publicKey()}`);
  console.log(`Sponsored account: ${sponsored.publicKey()}`);

  console.log('\nFunding Sponsor account via Friendbot...');
  await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(sponsor.publicKey())}`);

  const sponsorAccount = await server.loadAccount(sponsor.publicKey());

  console.log('\nExecuting Sponsorship Lifecycle...');
  console.log('1. Begin Sponsoring Future Reserves');
  console.log('2. Create Account and Sponsored Data Entry');
  console.log('3. End Sponsoring Future Reserves');

  // To be valid, beginSponsoringFutureReserves and endSponsoringFutureReserves
  // must bracket the operations that create the sponsored entries in the same transaction.
  const tx = new TransactionBuilder(sponsorAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: sponsored.publicKey(),
      }),
    )
    .addOperation(
      Operation.createAccount({
        destination: sponsored.publicKey(),
        startingBalance: '2',
      }),
    )
    .addOperation(
      Operation.manageData({
        source: sponsored.publicKey(),
        name: 'sponsored-config',
        value: 'active',
      }),
    )
    .addOperation(
      Operation.endSponsoringFutureReserves({
        source: sponsored.publicKey(),
      }),
    )
    .setTimeout(30)
    .build();

  // Both the sponsor and the sponsored account must sign
  tx.sign(sponsor);
  tx.sign(sponsored);

  const result = await server.submitTransaction(tx);
  console.log(`\nSponsorship flow completed successfully! Hash: ${result.hash}`);

  const sponsoredAcc = await server.loadAccount(sponsored.publicKey());
  const sponsorAccRefresh = await server.loadAccount(sponsor.publicKey());

  console.log('\n--- Account States After Workflow ---');
  console.log(
    `Sponsored Data (sponsored-config): ${sponsoredAcc.data_attr['sponsored-config'] ? 'Present' : 'Missing'}`,
  );
  console.log(`Sponsor Outstanding Sponsored Count: ${(sponsorAccRefresh as any).num_sponsoring}`);
  console.log(`Sponsored Account Sponsored Count: ${(sponsoredAcc as any).num_sponsored}`);
}
