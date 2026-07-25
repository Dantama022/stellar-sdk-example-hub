import { Keypair, Horizon, TransactionBuilder, Networks, Operation } from '@stellar/stellar-sdk';

export interface SponsorshipRevocationSummary {
  sponsorAccount: string;
  sponsoredAccount: string;
  sponsorOutstandingBefore: number;
  sponsorOutstandingAfter: number;
  sponsoredCountBefore: number;
  sponsoredCountAfter: number;
  dataEntrySponsorBefore: string | null;
  dataEntrySponsorAfter: string | null;
}

export function buildRevocationSummary(
  sponsorBefore: Record<string, unknown>,
  sponsorAfter: Record<string, unknown>,
  sponsoredBefore: Record<string, unknown>,
  sponsoredAfter: Record<string, unknown>,
  dataSponsorBefore: string | null,
  dataSponsorAfter: string | null,
): SponsorshipRevocationSummary {
  return {
    sponsorAccount: String(sponsorBefore.account_id ?? 'unknown'),
    sponsoredAccount: String(sponsoredBefore.account_id ?? 'unknown'),
    sponsorOutstandingBefore: Number(sponsorBefore.num_sponsoring ?? 0),
    sponsorOutstandingAfter: Number(sponsorAfter.num_sponsoring ?? 0),
    sponsoredCountBefore: Number(sponsoredBefore.num_sponsored ?? 0),
    sponsoredCountAfter: Number(sponsoredAfter.num_sponsored ?? 0),
    dataEntrySponsorBefore: dataSponsorBefore,
    dataEntrySponsorAfter: dataSponsorAfter,
  };
}

export function describeReserveResponsibility(summary: SponsorshipRevocationSummary): string {
  if (summary.dataEntrySponsorAfter) {
    return `The data entry remains sponsored by ${summary.dataEntrySponsorAfter}.`;
  }

  return `Reserve responsibility for the data entry returned to ${summary.sponsoredAccount} after revocation.`;
}

async function readDataEntrySponsor(
  server: Horizon.Server,
  accountId: string,
  dataName: string,
): Promise<string | null> {
  const data = await server.data(accountId, dataName).call();
  return (data as { sponsor?: string }).sponsor ?? null;
}

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);
  const dataName = 'revoke-demo';

  console.log('Starting Revoke Sponsorship Example...');
  console.log(
    'Revocation removes a sponsor from a ledger entry; the owning account becomes responsible for the reserve.',
  );

  const sponsor = Keypair.random();
  const sponsored = Keypair.random();

  console.log(`\nSponsor:   ${sponsor.publicKey()}`);
  console.log(`Sponsored: ${sponsored.publicKey()}`);

  await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(sponsor.publicKey())}`);

  const sponsorAccount = await server.loadAccount(sponsor.publicKey());

  console.log('\nCreating sponsored account and data entry...');
  const setupTx = new TransactionBuilder(sponsorAccount, {
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
        name: dataName,
        value: 'sponsored-entry',
      }),
    )
    .addOperation(
      Operation.endSponsoringFutureReserves({
        source: sponsored.publicKey(),
      }),
    )
    .setTimeout(30)
    .build();

  setupTx.sign(sponsor);
  setupTx.sign(sponsored);

  const setupResult = await server.submitTransaction(setupTx);
  console.log(`Setup transaction hash: ${setupResult.hash}`);

  const sponsorBefore = (await server.loadAccount(sponsor.publicKey())) as unknown as Record<
    string,
    unknown
  >;
  const sponsoredBefore = (await server.loadAccount(sponsored.publicKey())) as unknown as Record<
    string,
    unknown
  >;
  const dataSponsorBefore = await readDataEntrySponsor(server, sponsored.publicKey(), dataName);

  console.log('\n--- Before revocation ---');
  console.log(`Data entry sponsor: ${dataSponsorBefore ?? 'none'}`);
  console.log(`Sponsor num_sponsoring: ${sponsorBefore.num_sponsoring}`);
  console.log(`Sponsored num_sponsored: ${sponsoredBefore.num_sponsored}`);

  if (dataSponsorBefore !== sponsor.publicKey()) {
    throw new Error('Expected sponsor account to cover the data entry before revocation.');
  }

  const sponsorForRevoke = await server.loadAccount(sponsor.publicKey());
  const revokeTx = new TransactionBuilder(sponsorForRevoke, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.revokeDataSponsorship({
        account: sponsored.publicKey(),
        name: dataName,
      }),
    )
    .setTimeout(30)
    .build();

  revokeTx.sign(sponsor);
  const revokeResult = await server.submitTransaction(revokeTx);
  console.log(`\nRevocation transaction hash: ${revokeResult.hash}`);

  const sponsorAfter = (await server.loadAccount(sponsor.publicKey())) as unknown as Record<
    string,
    unknown
  >;
  const sponsoredAfter = (await server.loadAccount(sponsored.publicKey())) as unknown as Record<
    string,
    unknown
  >;
  const dataSponsorAfter = await readDataEntrySponsor(server, sponsored.publicKey(), dataName);

  const summary = buildRevocationSummary(
    sponsorBefore,
    sponsorAfter,
    sponsoredBefore,
    sponsoredAfter,
    dataSponsorBefore,
    dataSponsorAfter,
  );

  console.log('\n--- After revocation ---');
  console.log(`Data entry sponsor: ${summary.dataEntrySponsorAfter ?? 'none (owned by account)'}`);
  console.log(`Sponsor num_sponsoring: ${summary.sponsorOutstandingAfter}`);
  console.log(`Sponsored num_sponsored: ${summary.sponsoredCountAfter}`);
  console.log(`\n${describeReserveResponsibility(summary)}`);

  if (summary.dataEntrySponsorAfter !== null) {
    throw new Error('Sponsorship revocation failed: data entry still reports a sponsor.');
  }

  console.log('\nRevoke sponsorship workflow completed successfully.');
}
