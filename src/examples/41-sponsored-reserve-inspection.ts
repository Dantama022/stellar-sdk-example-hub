import { Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const BASE_FEE = '100';
const STROOPS_PER_XLM = 10_000_000;
const SPONSORED_DATA_NAME = 'sponsored-reserve-example';
const SPONSORED_DATA_VALUE = 'Reserve covered by sponsor';

/**
 * Horizon returns these sponsorship fields in its account JSON.
 *
 * Stellar SDK v13 copies the fields onto AccountResponse at runtime, but its
 * AccountResponse TypeScript declaration does not list them. This small local
 * interface lets the example inspect the documented Horizon fields without
 * using an unrestricted any cast.
 */
interface HorizonSponsorshipFields {
  sponsor?: unknown;
  num_sponsoring?: unknown;
  num_sponsored?: unknown;
}

export interface AccountSponsorshipSummary {
  accountId: string;
  accountEntrySponsor: string | null;
  sponsoringReserveUnits: number;
  sponsoredReserveUnits: number;
  subentryCount: number;
}

export interface SponsorshipEffectLike {
  type: string;
  account?: string;
  sponsor?: string;
}

export interface SponsorshipRelationship {
  entryType: string;
  sponsoredAccount: string;
  sponsorAccount: string;
}

export interface ReserveImpact {
  baseReserveStroops: number;
  baseReserveXlm: string;
  sponsoringReserveUnits: number;
  sponsoredReserveUnits: number;
  outgoingReserveResponsibilityXlm: string;
  incomingReserveReliefXlm: string;
  minimumBalanceWithoutIncomingSponsorshipXlm: string;
  effectiveMinimumBalanceXlm: string;
}

/**
 * Converts an integer number of stroops into an XLM value.
 *
 * One XLM contains 10,000,000 stroops.
 */
export function stroopsToXlm(stroops: number): string {
  return (stroops / STROOPS_PER_XLM).toFixed(7);
}

/**
 * Reads and validates the sponsorship fields returned by Horizon.
 *
 * A clear error is produced if the connected Horizon server does not provide
 * the expected fields.
 */
function readHorizonSponsorshipFields(account: Horizon.AccountResponse): {
  sponsor: string | null;
  numSponsoring: number;
  numSponsored: number;
} {
  const accountWithSponsorship = account as Horizon.AccountResponse & HorizonSponsorshipFields;

  if (typeof accountWithSponsorship.num_sponsoring !== 'number') {
    throw new Error(
      `Horizon account ${account.account_id} did not include a valid num_sponsoring field.`,
    );
  }

  if (typeof accountWithSponsorship.num_sponsored !== 'number') {
    throw new Error(
      `Horizon account ${account.account_id} did not include a valid num_sponsored field.`,
    );
  }

  const rawSponsor = accountWithSponsorship.sponsor;

  if (rawSponsor !== undefined && rawSponsor !== null && typeof rawSponsor !== 'string') {
    throw new Error(`Horizon account ${account.account_id} returned an invalid sponsor field.`);
  }

  return {
    sponsor: typeof rawSponsor === 'string' ? rawSponsor : null,
    numSponsoring: accountWithSponsorship.num_sponsoring,
    numSponsored: accountWithSponsorship.num_sponsored,
  };
}

/**
 * Extracts the Horizon account fields that describe sponsorship.
 *
 * num_sponsoring:
 *   The number of reserve units this account pays for on behalf of others.
 *
 * num_sponsored:
 *   The number of this account's reserve units that another account pays for.
 *
 * sponsor:
 *   The account paying the reserve for this account's account entry, when the
 *   account entry itself is sponsored.
 */
export function getAccountSponsorshipSummary(
  account: Horizon.AccountResponse,
): AccountSponsorshipSummary {
  const sponsorshipFields = readHorizonSponsorshipFields(account);

  return {
    accountId: account.account_id,
    accountEntrySponsor: sponsorshipFields.sponsor,
    sponsoringReserveUnits: sponsorshipFields.numSponsoring,
    sponsoredReserveUnits: sponsorshipFields.numSponsored,
    subentryCount: account.subentry_count,
  };
}

/**
 * Converts Horizon sponsorship-created effects into a small list that is easy
 * to display and test.
 *
 * Horizon effects identify the ledger-entry type, the affected account, and
 * the account responsible for the sponsored reserve.
 */
export function extractSponsorshipRelationships(
  records: SponsorshipEffectLike[],
): SponsorshipRelationship[] {
  return records
    .filter((record) => record.type.endsWith('_sponsorship_created'))
    .map((record) => ({
      entryType: record.type.replace(/_sponsorship_created$/, '').replace(/_/g, ' '),
      sponsoredAccount: record.account ?? 'unknown',
      sponsorAccount: record.sponsor ?? 'unknown',
    }));
}

/**
 * Calculates the effect of sponsorship on an account's minimum balance.
 *
 * Stellar's account reserve formula is based on:
 *
 *   2
 *   + subentry_count
 *   + num_sponsoring
 *   - num_sponsored
 *
 * Each unit is multiplied by the ledger's current base reserve.
 */
export function calculateReserveImpact(
  account: Horizon.AccountResponse,
  baseReserveStroops: number,
): ReserveImpact {
  const summary = getAccountSponsorshipSummary(account);

  const reserveUnitsWithoutIncomingSponsorship =
    2 + summary.subentryCount + summary.sponsoringReserveUnits;

  const effectiveReserveUnits = Math.max(
    0,
    reserveUnitsWithoutIncomingSponsorship - summary.sponsoredReserveUnits,
  );

  const outgoingReserveResponsibilityStroops = summary.sponsoringReserveUnits * baseReserveStroops;

  const incomingReserveReliefStroops = summary.sponsoredReserveUnits * baseReserveStroops;

  const minimumBalanceWithoutIncomingSponsorshipStroops =
    reserveUnitsWithoutIncomingSponsorship * baseReserveStroops;

  const effectiveMinimumBalanceStroops = effectiveReserveUnits * baseReserveStroops;

  return {
    baseReserveStroops,
    baseReserveXlm: stroopsToXlm(baseReserveStroops),
    sponsoringReserveUnits: summary.sponsoringReserveUnits,
    sponsoredReserveUnits: summary.sponsoredReserveUnits,
    outgoingReserveResponsibilityXlm: stroopsToXlm(outgoingReserveResponsibilityStroops),
    incomingReserveReliefXlm: stroopsToXlm(incomingReserveReliefStroops),
    minimumBalanceWithoutIncomingSponsorshipXlm: stroopsToXlm(
      minimumBalanceWithoutIncomingSponsorshipStroops,
    ),
    effectiveMinimumBalanceXlm: stroopsToXlm(effectiveMinimumBalanceStroops),
  };
}

/**
 * Prints the incoming and outgoing sponsorship state for one account.
 *
 * Accounts with no sponsorship relationships are handled explicitly instead
 * of being treated as an error.
 */
export function displayAccountSponsorship(label: string, account: Horizon.AccountResponse): void {
  const summary = getAccountSponsorshipSummary(account);

  console.log(`\n--- ${label} ---`);
  console.log(`Account ID: ${summary.accountId}`);
  console.log(`Account-entry sponsor: ${summary.accountEntrySponsor ?? 'None'}`);
  console.log(`Reserve units sponsored by this account: ${summary.sponsoringReserveUnits}`);
  console.log(`Reserve units sponsored for this account: ${summary.sponsoredReserveUnits}`);
  console.log(`Subentry count: ${summary.subentryCount}`);

  if (
    summary.sponsoringReserveUnits === 0 &&
    summary.sponsoredReserveUnits === 0 &&
    summary.accountEntrySponsor === null
  ) {
    console.log('Sponsorship status: no sponsored or sponsoring entries.');
    return;
  }

  if (summary.sponsoringReserveUnits === 0) {
    console.log('Outgoing sponsorship: this account is not paying reserves for another account.');
  }

  if (summary.sponsoredReserveUnits === 0 && summary.accountEntrySponsor === null) {
    console.log('Incoming sponsorship: this account has no reserves covered by another account.');
  }
}

/**
 * Prints the account's minimum-balance calculation and the amount transferred
 * between the sponsored account and sponsor as reserve responsibility.
 */
export function displayReserveImpact(label: string, impact: ReserveImpact): void {
  console.log(`\n--- ${label} ---`);
  console.log(
    `Current base reserve: ${impact.baseReserveXlm} XLM (${impact.baseReserveStroops} stroops)`,
  );
  console.log(`Reserve units sponsored by this account: ${impact.sponsoringReserveUnits}`);
  console.log(`Reserve units sponsored for this account: ${impact.sponsoredReserveUnits}`);
  console.log(`Additional reserve responsibility: ${impact.outgoingReserveResponsibilityXlm} XLM`);
  console.log(`Reserve responsibility transferred away: ${impact.incomingReserveReliefXlm} XLM`);
  console.log(
    `Minimum balance without incoming sponsorship: ${impact.minimumBalanceWithoutIncomingSponsorshipXlm} XLM`,
  );
  console.log(
    `Effective minimum balance after sponsorship: ${impact.effectiveMinimumBalanceXlm} XLM`,
  );
}

/**
 * Funds an account through Stellar Testnet Friendbot.
 */
async function fundTestnetAccount(publicKey: string): Promise<void> {
  const response = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(publicKey)}`);

  if (!response.ok) {
    const responseBody = await response.text();

    throw new Error(
      `Friendbot could not fund account ${publicKey}. ` +
        `HTTP ${response.status}: ${responseBody}`,
    );
  }
}

/**
 * Retrieves the latest base reserve from Horizon.
 */
async function getCurrentBaseReserve(server: Horizon.Server): Promise<number> {
  const ledgerPage = await server.ledgers().order('desc').limit(1).call();
  const latestLedger = ledgerPage.records[0];

  if (!latestLedger) {
    throw new Error('Horizon did not return a ledger from which to read the base reserve.');
  }

  const baseReserveStroops = Number(latestLedger.base_reserve_in_stroops);

  if (!Number.isFinite(baseReserveStroops) || baseReserveStroops <= 0) {
    throw new Error(
      `Horizon returned an invalid base reserve: ${latestLedger.base_reserve_in_stroops}`,
    );
  }

  console.log(`Latest ledger sequence: ${latestLedger.sequence}`);

  return baseReserveStroops;
}

/**
 * Demonstrates how sponsored reserves are represented in Horizon account data.
 *
 * The example creates a temporary sponsor and a new account whose account
 * entry and manage-data entry are sponsored. It then reloads both accounts,
 * inspects sponsorship effects, and calculates the reserve impact.
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);

  const sponsor = Keypair.random();
  const sponsoredAccountKeypair = Keypair.random();

  console.log('Starting Sponsored Account Reserve Inspection Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log(`Sponsor account: ${sponsor.publicKey()}`);
  console.log(`Sponsored account: ${sponsoredAccountKeypair.publicKey()}`);

  console.log('\nFunding the sponsor through Friendbot...');
  await fundTestnetAccount(sponsor.publicKey());

  /*
   * Before the demonstration transaction, the funded sponsor has no incoming
   * or outgoing sponsorship. Displaying this state also demonstrates that the
   * inspection helpers handle accounts without sponsorship entries.
   */
  const sponsorBeforeSponsorship = await server.loadAccount(sponsor.publicKey());

  displayAccountSponsorship('Sponsor Before Sponsorship', sponsorBeforeSponsorship);

  const baseReserveStroops = await getCurrentBaseReserve(server);

  console.log('\nCreating sponsored account and data entries...');

  const sponsorshipTransaction = new TransactionBuilder(sponsorBeforeSponsorship, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: sponsoredAccountKeypair.publicKey(),
      }),
    )
    .addOperation(
      Operation.createAccount({
        destination: sponsoredAccountKeypair.publicKey(),
        startingBalance: '1',
      }),
    )
    .addOperation(
      Operation.manageData({
        source: sponsoredAccountKeypair.publicKey(),
        name: SPONSORED_DATA_NAME,
        value: SPONSORED_DATA_VALUE,
      }),
    )
    .addOperation(
      Operation.endSponsoringFutureReserves({
        source: sponsoredAccountKeypair.publicKey(),
      }),
    )
    .setTimeout(30)
    .build();

  /*
   * The sponsor authorizes the transaction and begins sponsorship.
   * The new account also signs because it owns the manageData and
   * endSponsoringFutureReserves operations.
   */
  sponsorshipTransaction.sign(sponsor);
  sponsorshipTransaction.sign(sponsoredAccountKeypair);

  const submissionResult = await server.submitTransaction(sponsorshipTransaction);

  console.log(`Sponsorship transaction hash: ${submissionResult.hash}`);

  const [sponsorAfterSponsorship, sponsoredAccount] = await Promise.all([
    server.loadAccount(sponsor.publicKey()),
    server.loadAccount(sponsoredAccountKeypair.publicKey()),
  ]);

  displayAccountSponsorship('Sponsor After Sponsorship', sponsorAfterSponsorship);

  displayAccountSponsorship('Sponsored Account After Sponsorship', sponsoredAccount);

  const sponsorSummary = getAccountSponsorshipSummary(sponsorAfterSponsorship);

  const sponsoredAccountSummary = getAccountSponsorshipSummary(sponsoredAccount);

  if (sponsoredAccountSummary.accountEntrySponsor !== sponsor.publicKey()) {
    throw new Error(
      'Sponsorship verification failed: Horizon did not identify the expected account-entry sponsor.',
    );
  }

  if (sponsorSummary.sponsoringReserveUnits <= 0) {
    throw new Error(
      'Sponsorship verification failed: the sponsor has no sponsoring reserve units.',
    );
  }

  if (sponsoredAccountSummary.sponsoredReserveUnits <= 0) {
    throw new Error(
      'Sponsorship verification failed: the sponsored account has no sponsored reserve units.',
    );
  }

  if (!(SPONSORED_DATA_NAME in sponsoredAccount.data_attr)) {
    throw new Error(
      `Sponsorship verification failed: data entry "${SPONSORED_DATA_NAME}" was not found.`,
    );
  }

  console.log('\nRetrieving sponsorship effects from Horizon...');

  const effectsPage = await server
    .effects()
    .forTransaction(submissionResult.hash)
    .limit(200)
    .call();

  const relationships = extractSponsorshipRelationships(
    effectsPage.records as unknown as SponsorshipEffectLike[],
  );

  console.log('\n--- Sponsored Ledger Entries ---');

  if (relationships.length === 0) {
    console.log(
      'No sponsorship-created effects were returned. Account sponsorship fields remain available above.',
    );
  } else {
    relationships.forEach((relationship, index) => {
      console.log(`Entry ${index + 1}:`);
      console.log(`  Type: ${relationship.entryType}`);
      console.log(`  Sponsored account: ${relationship.sponsoredAccount}`);
      console.log(`  Sponsor account: ${relationship.sponsorAccount}`);
    });
  }

  const sponsorImpact = calculateReserveImpact(sponsorAfterSponsorship, baseReserveStroops);

  const sponsoredAccountImpact = calculateReserveImpact(sponsoredAccount, baseReserveStroops);

  displayReserveImpact('Sponsor Reserve Impact', sponsorImpact);
  displayReserveImpact('Sponsored Account Reserve Impact', sponsoredAccountImpact);

  console.log('\nHow reserve responsibility changed:');
  console.log(`- ${sponsor.publicKey()} now carries the reserve units shown by num_sponsoring.`);
  console.log(
    `- ${sponsoredAccountKeypair.publicKey()} receives the reserve reduction shown by num_sponsored.`,
  );
  console.log(
    '- Sponsorship changes who must maintain the reserve; it does not transfer ownership of the sponsored ledger entry.',
  );
  console.log(
    '- Transaction fees and required signatures remain separate from reserve sponsorship.',
  );

  console.log('\nSponsored account reserve inspection completed successfully.');
}
