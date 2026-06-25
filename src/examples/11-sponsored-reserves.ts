import { Keypair, Horizon, TransactionBuilder, Networks, Operation } from '@stellar/stellar-sdk';

export interface SponsorshipSummary {
  sponsorAccount: string;
  sponsoredAccount: string;
  sponsorOutstandingCount: number;
  sponsoredResourceCount: number;
}

export function extractSponsorshipSummary(
  sponsor: Record<string, unknown>,
  sponsored: Record<string, unknown>,
): SponsorshipSummary {
  return {
    sponsorAccount: String(sponsor.account_id ?? 'unknown'),
    sponsoredAccount: String(sponsored.account_id ?? 'unknown'),
    sponsorOutstandingCount: Number(sponsor.num_sponsoring ?? 0),
    sponsoredResourceCount: Number(sponsored.num_sponsored ?? 0),
  };
}

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Sponsored Reserves Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log(
    'Sponsorship lifecycle: begin sponsorship -> create sponsored resources -> end sponsorship',
  );
  console.log('Reserve requirements: sponsor account covers reserve for sponsored subentries.');
  console.log(
    'Sponsorship limitations: sponsorship does not bypass fee payment or signature checks.',
  );
  console.log(
    'Signing requirements: both sponsor and sponsored accounts sign source-owned operations.',
  );
  console.log(
    'Common use cases: custodial onboarding, subsidized account setup, app-sponsored metadata.',
  );

  const sponsor = Keypair.random();
  const sponsored = Keypair.random();

  console.log(`\nSponsor account: ${sponsor.publicKey()}`);
  console.log(`Sponsored account: ${sponsored.publicKey()}`);

  const fundResponse = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(sponsor.publicKey())}`,
  );
  if (!fundResponse.ok) {
    throw new Error('Failed to fund sponsor account');
  }

  const sponsorAccount = await server.loadAccount(sponsor.publicKey());

  const sponsorshipTx = new TransactionBuilder(sponsorAccount, {
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
        startingBalance: '1.5',
      }),
    )
    .addOperation(
      Operation.manageData({
        source: sponsored.publicKey(),
        name: 'sponsored-note',
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

  sponsorshipTx.sign(sponsor);
  sponsorshipTx.sign(sponsored);

  const sponsorshipResult = await server.submitTransaction(sponsorshipTx);
  console.log(
    `\nSponsorship begins successfully and transaction submitted: ${sponsorshipResult.hash}`,
  );

  const refreshedSponsor = (await server.loadAccount(sponsor.publicKey())) as unknown as Record<
    string,
    unknown
  >;
  const refreshedSponsored = (await server.loadAccount(sponsored.publicKey())) as unknown as Record<
    string,
    unknown
  >;

  const summary = extractSponsorshipSummary(refreshedSponsor, refreshedSponsored);

  console.log(`Sponsored resource creation succeeds: data entry sponsored-note exists.`);
  console.log(`Sponsorship ends successfully in the same transaction envelope.`);
  console.log(`\nReserve allocation:`);
  console.log(`- Sponsor outstanding sponsorships: ${summary.sponsorOutstandingCount}`);
  console.log(`- Sponsored resource count: ${summary.sponsoredResourceCount}`);

  const sponsoredData = (refreshedSponsored.data_attr as Record<string, string> | undefined) ?? {};
  const hasSponsoredData = Boolean(sponsoredData['sponsored-note']);

  console.log(`\nSponsorship details:`);
  console.log(`- Sponsor account: ${summary.sponsorAccount}`);
  console.log(`- Sponsored account: ${summary.sponsoredAccount}`);
  console.log(`- Verification results: sponsored data present=${hasSponsoredData}`);

  if (!hasSponsoredData) {
    throw new Error('Sponsorship verification failed: expected sponsored data entry not found.');
  }

  console.log('Sponsored reserves workflow completed successfully.');
}
