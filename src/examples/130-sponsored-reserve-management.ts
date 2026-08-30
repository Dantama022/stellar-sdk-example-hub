import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const STROOPS_PER_XLM = 10_000_000;
const SPONSORED_ASSET_CODE = 'SPONSCOIN';
const SPONSORED_DATA_NAME = 'sponsored-reserve-example';
const SPONSORED_DATA_VALUE = 'reserve covered by sponsor';

/**
 * Sponsored Reserve Management Example
 * ──────────────────────────────────────
 * Demonstrates the sponsorship lifecycle across more than one ledger-entry
 * type in a single account:
 *
 *   begin sponsorship
 *   -> create a sponsored trustline
 *   -> create a sponsored data entry
 *   -> end sponsorship (of future reserves)
 *   -> revoke sponsorship of one already-sponsored entry (return its reserve
 *      responsibility to the owning account)
 *
 * It also demonstrates two failure paths without ever submitting a doomed
 * transaction: a sponsor with insufficient XLM to cover the reserve it is
 * about to take on, and a request to sponsor an unsupported ledger-entry
 * type.
 */

interface HorizonSponsorshipFields {
  sponsor?: unknown;
  num_sponsoring?: unknown;
  num_sponsored?: unknown;
}

export interface SponsorshipSummary {
  accountId: string;
  accountEntrySponsor: string | null;
  sponsoringReserveUnits: number;
  sponsoredReserveUnits: number;
  subentryCount: number;
}

export interface ReserveImpact {
  baseReserveXlm: string;
  outgoingReserveResponsibilityXlm: string;
  incomingReserveReliefXlm: string;
}

export const SUPPORTED_SPONSORSHIP_TARGETS = [
  'account',
  'trustline',
  'data',
  'offer',
  'signer',
  'claimable_balance',
] as const;

export type SponsorshipTarget = (typeof SUPPORTED_SPONSORSHIP_TARGETS)[number];

export function stroopsToXlm(stroops: number): string {
  return (stroops / STROOPS_PER_XLM).toFixed(7);
}

export function isSupportedSponsorshipTarget(target: string): target is SponsorshipTarget {
  return (SUPPORTED_SPONSORSHIP_TARGETS as readonly string[]).includes(target);
}

/**
 * Client-side guard: a sponsor cannot begin sponsoring more reserve than it
 * can afford, on top of its own existing minimum balance. Checking this
 * before building the transaction turns a network-level `tx_insufficient_balance`
 * failure into a clear, actionable message.
 */
export function assertSponsorHasSufficientReserve(
  sponsorBalanceXlm: number,
  additionalReserveUnitsNeeded: number,
  baseReserveStroops: number,
  bufferXlm = 1,
): void {
  const additionalReserveXlm =
    (additionalReserveUnitsNeeded * baseReserveStroops) / STROOPS_PER_XLM;
  const requiredXlm = additionalReserveXlm + bufferXlm;

  if (sponsorBalanceXlm < requiredXlm) {
    throw new Error(
      `Insufficient sponsor balance: sponsor has ${sponsorBalanceXlm.toFixed(7)} XLM but needs ` +
        `at least ${requiredXlm.toFixed(7)} XLM to safely cover ${additionalReserveUnitsNeeded} ` +
        'additional reserve unit(s) plus a fee/operational buffer.',
    );
  }
}

function readSponsorshipFields(account: Horizon.AccountResponse): {
  sponsor: string | null;
  numSponsoring: number;
  numSponsored: number;
} {
  const withSponsorship = account as Horizon.AccountResponse & HorizonSponsorshipFields;
  return {
    sponsor: typeof withSponsorship.sponsor === 'string' ? withSponsorship.sponsor : null,
    numSponsoring: Number(withSponsorship.num_sponsoring ?? 0),
    numSponsored: Number(withSponsorship.num_sponsored ?? 0),
  };
}

export function getSponsorshipSummary(account: Horizon.AccountResponse): SponsorshipSummary {
  const fields = readSponsorshipFields(account);
  return {
    accountId: account.account_id,
    accountEntrySponsor: fields.sponsor,
    sponsoringReserveUnits: fields.numSponsoring,
    sponsoredReserveUnits: fields.numSponsored,
    subentryCount: account.subentry_count,
  };
}

export function calculateReserveImpact(
  summary: SponsorshipSummary,
  baseReserveStroops: number,
): ReserveImpact {
  return {
    baseReserveXlm: stroopsToXlm(baseReserveStroops),
    outgoingReserveResponsibilityXlm: stroopsToXlm(
      summary.sponsoringReserveUnits * baseReserveStroops,
    ),
    incomingReserveReliefXlm: stroopsToXlm(summary.sponsoredReserveUnits * baseReserveStroops),
  };
}

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to fund account ${publicKey}: ${response.statusText}`);
  }
}

async function getCurrentBaseReserve(server: Horizon.Server): Promise<number> {
  const ledgerPage = await server.ledgers().order('desc').limit(1).call();
  const latest = ledgerPage.records[0];
  if (!latest) throw new Error('Horizon did not return a ledger from which to read base reserve.');
  return Number(latest.base_reserve_in_stroops);
}

function displaySponsorship(label: string, summary: SponsorshipSummary): void {
  console.log(`\n--- ${label} ---`);
  console.log(`  Account ID: ${summary.accountId}`);
  console.log(`  Account-entry sponsor: ${summary.accountEntrySponsor ?? 'None'}`);
  console.log(`  Reserve units sponsored BY this account: ${summary.sponsoringReserveUnits}`);
  console.log(`  Reserve units sponsored FOR this account: ${summary.sponsoredReserveUnits}`);
  console.log(`  Subentry count: ${summary.subentryCount}`);
}

function isJsonOutputRequested(): boolean {
  return process.argv.includes('--json') || process.env.OUTPUT_FORMAT === 'json';
}

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);
  const jsonOutput = isJsonOutputRequested();

  const log = (...args: unknown[]) => {
    if (!jsonOutput) console.log(...args);
  };

  log('Starting Sponsored Reserve Management Example...');
  log(`Using Horizon: ${horizonUrl}`);
  log(
    'Sponsorship lifecycle: begin -> sponsored trustline -> sponsored data -> end -> revoke one entry',
  );

  const sponsor = Keypair.random();
  const sponsored = Keypair.random();
  const asset = new Asset(SPONSORED_ASSET_CODE, sponsor.publicKey());

  log(`\nSponsor account:   ${sponsor.publicKey()}`);
  log(`Sponsored account: ${sponsored.publicKey()}`);

  log('\nFunding sponsor account via Friendbot...');
  await fundAccount(sponsor.publicKey());

  // ── Unsupported-target guard (demonstrated, never submitted) ──────────
  const unsupportedTarget = 'liquidity_pool_participation';
  if (!isSupportedSponsorshipTarget(unsupportedTarget)) {
    log(
      `\nDemonstration: "${unsupportedTarget}" is not a supported sponsorship target in this ` +
        `example. Supported targets: ${SUPPORTED_SPONSORSHIP_TARGETS.join(', ')}.`,
    );
  }

  const baseReserveStroops = await getCurrentBaseReserve(server);
  const sponsorBefore = await server.loadAccount(sponsor.publicKey());

  // ── Insufficient-balance guard ─────────────────────────────────────────
  // The demo sponsor is about to take on responsibility for a new account
  // entry plus two subentries (trustline + data). Confirm affordability
  // before building the transaction.
  const additionalReserveUnitsNeeded = 3; // 1 account entry + trustline + data
  try {
    assertSponsorHasSufficientReserve(
      Number(sponsorBefore.balances.find((b) => b.asset_type === 'native')?.balance ?? '0'),
      additionalReserveUnitsNeeded,
      baseReserveStroops,
    );
    log('\nSponsor balance check passed: sufficient XLM to cover the planned sponsorship.');
  } catch (error) {
    log(`\nSponsor balance check failed: ${(error as Error).message}`);
    log('Stopping before submitting a transaction that the network would reject.');
    if (jsonOutput) {
      console.log(JSON.stringify({ error: (error as Error).message }, null, 2));
    }
    return;
  }

  displaySponsorship('Sponsor before sponsorship', getSponsorshipSummary(sponsorBefore));

  log('\nBuilding sponsorship transaction: create account, sponsored trustline, sponsored data...');
  const sponsorshipTx = new TransactionBuilder(sponsorBefore, {
    fee: '200',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: sponsored.publicKey() }))
    .addOperation(
      Operation.createAccount({ destination: sponsored.publicKey(), startingBalance: '0' }),
    )
    .addOperation(Operation.changeTrust({ source: sponsored.publicKey(), asset, limit: '10000' }))
    .addOperation(
      Operation.manageData({
        source: sponsored.publicKey(),
        name: SPONSORED_DATA_NAME,
        value: SPONSORED_DATA_VALUE,
      }),
    )
    .addOperation(Operation.endSponsoringFutureReserves({ source: sponsored.publicKey() }))
    .setTimeout(30)
    .build();

  sponsorshipTx.sign(sponsor);
  sponsorshipTx.sign(sponsored);

  const submitResult = await server.submitTransaction(sponsorshipTx);
  log(`Sponsorship transaction hash: ${submitResult.hash}`);

  const [sponsorAfter, sponsoredAfter] = await Promise.all([
    server.loadAccount(sponsor.publicKey()),
    server.loadAccount(sponsored.publicKey()),
  ]);

  const sponsorSummary = getSponsorshipSummary(sponsorAfter);
  const sponsoredSummary = getSponsorshipSummary(sponsoredAfter);

  displaySponsorship('Sponsor after sponsorship', sponsorSummary);
  displaySponsorship('Sponsored account after sponsorship', sponsoredSummary);

  if (sponsoredSummary.accountEntrySponsor !== sponsor.publicKey()) {
    throw new Error('Sponsorship verification failed: unexpected account-entry sponsor.');
  }
  if (sponsorSummary.sponsoringReserveUnits <= 0) {
    throw new Error('Sponsorship verification failed: sponsor has no sponsoring reserve units.');
  }

  log('\n--- Sponsored ledger entries created ---');
  log(`  1. trustline  (${SPONSORED_ASSET_CODE})  — sponsored account: ${sponsored.publicKey()}`);
  log(`  2. data       (${SPONSORED_DATA_NAME}) — sponsored account: ${sponsored.publicKey()}`);
  log(`  Sponsor of both: ${sponsor.publicKey()}`);

  const sponsorImpact = calculateReserveImpact(sponsorSummary, baseReserveStroops);
  const sponsoredImpact = calculateReserveImpact(sponsoredSummary, baseReserveStroops);

  log('\n--- Reserve responsibility ---');
  log(`  Base reserve: ${sponsorImpact.baseReserveXlm} XLM`);
  log(
    `  Sponsor's additional reserve responsibility: ${sponsorImpact.outgoingReserveResponsibilityXlm} XLM`,
  );
  log(`  Sponsored account's reserve relief: ${sponsoredImpact.incomingReserveReliefXlm} XLM`);
  log(
    '  Sponsorship changes who must maintain the reserve; it never transfers ownership of the entry itself.',
  );

  // ── End sponsorship of the data entry specifically ─────────────────────
  log(
    '\nRevoking sponsorship of the data entry (returning its reserve to the sponsored account)...',
  );
  const revokeAccount = await server.loadAccount(sponsor.publicKey());
  const revokeTx = new TransactionBuilder(revokeAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.revokeDataSponsorship({
        account: sponsored.publicKey(),
        name: SPONSORED_DATA_NAME,
      }),
    )
    .setTimeout(30)
    .build();
  revokeTx.sign(sponsor);
  const revokeResult = await server.submitTransaction(revokeTx);
  log(`Revoke-sponsorship transaction hash: ${revokeResult.hash}`);

  const [sponsorFinal, sponsoredFinal] = await Promise.all([
    server.loadAccount(sponsor.publicKey()),
    server.loadAccount(sponsored.publicKey()),
  ]);

  const sponsorFinalSummary = getSponsorshipSummary(sponsorFinal);
  const sponsoredFinalSummary = getSponsorshipSummary(sponsoredFinal);

  displaySponsorship('Sponsor after revoking data-entry sponsorship', sponsorFinalSummary);
  displaySponsorship(
    'Sponsored account after revoking data-entry sponsorship',
    sponsoredFinalSummary,
  );

  log('\nEffect of revocation:');
  log(
    `  Sponsor's sponsoring units dropped from ${sponsorSummary.sponsoringReserveUnits} to ` +
      `${sponsorFinalSummary.sponsoringReserveUnits} (the data entry's reserve returned to the sponsor's own account is no longer counted against it).`,
  );
  log(
    `  Sponsored account's sponsored units dropped from ${sponsoredSummary.sponsoredReserveUnits} to ` +
      `${sponsoredFinalSummary.sponsoredReserveUnits} (it now carries that entry's reserve itself, so its minimum balance requirement rises accordingly).`,
  );

  log('\nSponsored reserve management workflow completed successfully.');

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          sponsor: sponsor.publicKey(),
          sponsored: sponsored.publicKey(),
          sponsoredEntries: [
            { type: 'trustline', asset: `${SPONSORED_ASSET_CODE}:${sponsor.publicKey()}` },
            { type: 'data', name: SPONSORED_DATA_NAME },
          ],
          sponsorAfterSponsorship: sponsorSummary,
          sponsoredAfterSponsorship: sponsoredSummary,
          reserveImpact: { sponsor: sponsorImpact, sponsored: sponsoredImpact },
          sponsorAfterRevocation: sponsorFinalSummary,
          sponsoredAfterRevocation: sponsoredFinalSummary,
          unsupportedTargetDemo: unsupportedTarget,
        },
        null,
        2,
      ),
    );
  }
}
