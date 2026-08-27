import {
  Asset,
  Claimant,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

/**
 * Claimable Balance Inspection and Claiming Example
 * ──────────────────────────────────────────────────
 * Demonstrates the complete claimable-balance lifecycle:
 *
 *   discover -> inspect -> decode predicate -> determine eligibility
 *   -> filter by asset -> construct claim -> validate -> submit -> confirm
 *
 * By default the example is self-contained: it creates a source account and
 * a claimant account, funds them via Friendbot, and creates a small set of
 * claimable balances (one immediately claimable, one not-yet-claimable, one
 * in a different asset) so every code path below can run without any manual
 * setup.
 *
 * To inspect a real account instead, set ACCOUNT_ID (and optionally
 * CLAIMANT_SECRET, if you want the example to attempt an actual claim on
 * your behalf). ASSET_FILTER narrows results to one asset ("native" or
 * "CODE:ISSUER"). Pass --json (or OUTPUT_FORMAT=json) for machine-readable
 * output.
 */

export type PredicateEligibility = 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'UNKNOWN';

export interface ClaimantRecordLike {
  destination: string;
  predicate: unknown;
}

export interface ClaimableBalanceLike {
  id: string;
  asset: string;
  amount: string;
  claimants: ClaimantRecordLike[];
  last_modified_time?: string;
}

export interface ClaimableBalanceReport {
  id: string;
  asset: string;
  amount: string;
  claimants: Array<{ destination: string; predicate: string }>;
  eligibility: PredicateEligibility;
  claimedByThisRun: boolean;
  transactionHash?: string;
  skipReason?: string;
}

/** Renders a claim predicate as a short, readable string. */
export function stringifyClaimPredicate(predicate: unknown): string {
  if (!predicate || typeof predicate !== 'object') {
    return 'unknown predicate';
  }

  const value = predicate as Record<string, unknown>;

  if ('unconditional' in value) {
    return 'unconditional';
  }
  if (typeof value.before_absolute_time === 'string') {
    return `before_absolute_time(${value.before_absolute_time})`;
  }
  if (typeof value.before_relative_time === 'string') {
    return `before_relative_time(${value.before_relative_time})`;
  }
  if (value.not !== undefined) {
    return `not(${stringifyClaimPredicate(value.not)})`;
  }
  if (Array.isArray(value.and)) {
    return `and(${value.and.map((item) => stringifyClaimPredicate(item)).join(', ')})`;
  }
  if (Array.isArray(value.or)) {
    return `or(${value.or.map((item) => stringifyClaimPredicate(item)).join(', ')})`;
  }

  return 'unknown predicate';
}

/**
 * Evaluates whether a predicate currently permits a claim.
 *
 * `before_relative_time` predicates are relative to the balance's creation
 * ledger close time, which is not carried on the predicate itself. Without
 * that reference the example reports UNKNOWN rather than guessing, and
 * treats UNKNOWN balances as not safe to auto-claim.
 */
export function evaluatePredicateEligibility(
  predicate: unknown,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): PredicateEligibility {
  if (!predicate || typeof predicate !== 'object') {
    return 'UNKNOWN';
  }

  const value = predicate as Record<string, unknown>;

  if ('unconditional' in value) {
    return 'ELIGIBLE';
  }

  if (typeof value.before_absolute_time === 'string') {
    const deadline = Number(value.before_absolute_time);
    if (!Number.isFinite(deadline)) return 'UNKNOWN';
    return nowSeconds < deadline ? 'ELIGIBLE' : 'NOT_ELIGIBLE';
  }

  if (typeof value.before_relative_time === 'string') {
    return 'UNKNOWN';
  }

  if (value.not !== undefined) {
    const inner = evaluatePredicateEligibility(value.not, nowSeconds);
    if (inner === 'UNKNOWN') return 'UNKNOWN';
    return inner === 'ELIGIBLE' ? 'NOT_ELIGIBLE' : 'ELIGIBLE';
  }

  if (Array.isArray(value.and)) {
    const results = value.and.map((item) => evaluatePredicateEligibility(item, nowSeconds));
    if (results.some((result) => result === 'UNKNOWN')) return 'UNKNOWN';
    return results.every((result) => result === 'ELIGIBLE') ? 'ELIGIBLE' : 'NOT_ELIGIBLE';
  }

  if (Array.isArray(value.or)) {
    const results = value.or.map((item) => evaluatePredicateEligibility(item, nowSeconds));
    if (results.some((result) => result === 'ELIGIBLE')) return 'ELIGIBLE';
    if (results.some((result) => result === 'UNKNOWN')) return 'UNKNOWN';
    return 'NOT_ELIGIBLE';
  }

  return 'UNKNOWN';
}

/** Determines whether a given account is even listed as an eligible claimant. */
export function findClaimantRecord(
  balance: ClaimableBalanceLike,
  claimantPublicKey: string,
): ClaimantRecordLike | undefined {
  return balance.claimants.find((claimant) => claimant.destination === claimantPublicKey);
}

/** Filters a list of claimable balances down to one asset ("native" or "CODE:ISSUER"). */
export function filterByAsset(
  balances: ClaimableBalanceLike[],
  assetFilter: string | undefined,
): ClaimableBalanceLike[] {
  if (!assetFilter) return balances;
  const normalized = assetFilter.trim().toLowerCase();
  if (normalized === 'native' || normalized === 'xlm') {
    return balances.filter((balance) => balance.asset === 'native');
  }
  return balances.filter((balance) => balance.asset.toLowerCase() === normalized);
}

export function findCreatedClaimableBalanceId(
  effects: Array<{ type: string; balance_id?: string }>,
): string {
  const created = effects.find((effect) => effect.type === 'claimable_balance_created');
  if (!created?.balance_id) {
    throw new Error('Unable to determine claimable balance ID from Horizon effects.');
  }
  return created.balance_id;
}

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to fund account ${publicKey}: ${response.statusText}`);
  }
}

async function createDemoClaimableBalances(
  server: Horizon.Server,
  source: Keypair,
  claimant: Keypair,
): Promise<{ eligibleId: string; futureId: string }> {
  const sourceAccount = await server.loadAccount(source.publicKey());

  const transaction = new TransactionBuilder(sourceAccount, {
    fee: '200',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: '3.5',
        claimants: [new Claimant(claimant.publicKey(), Claimant.predicateUnconditional())],
      }),
    )
    .addOperation(
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: '1.25',
        claimants: [
          new Claimant(
            claimant.publicKey(),
            Claimant.predicateNot(Claimant.predicateUnconditional()),
          ),
        ],
      }),
    )
    .setTimeout(30)
    .build();

  transaction.sign(source);
  const submitResponse = await server.submitTransaction(transaction);

  const effectsPage = await server.effects().forTransaction(submitResponse.hash).call();
  const createdEffects = (effectsPage.records as Array<{ type: string; balance_id?: string }>)
    .filter((effect) => effect.type === 'claimable_balance_created');

  if (createdEffects.length < 2) {
    throw new Error('Expected two claimable_balance_created effects from the demo setup.');
  }

  return { eligibleId: createdEffects[0].balance_id!, futureId: createdEffects[1].balance_id! };
}

function displayBalance(balance: ClaimableBalanceLike, eligibility: PredicateEligibility): void {
  console.log(`- Balance ID: ${balance.id}`);
  console.log(`  Asset: ${balance.asset}`);
  console.log(`  Amount: ${balance.amount}`);
  console.log(`  Claim status: ${eligibility}`);
  if (balance.claimants.length === 0) {
    console.log('  Claimants: none');
    return;
  }
  console.log('  Claimants:');
  balance.claimants.forEach((claimant, index) => {
    console.log(`    ${index + 1}. ${claimant.destination}`);
    console.log(`       Predicate: ${stringifyClaimPredicate(claimant.predicate)}`);
  });
}

async function attemptClaim(
  server: Horizon.Server,
  claimant: Keypair,
  balanceId: string,
): Promise<{ success: boolean; hash?: string; reason?: string }> {
  try {
    const claimantAccount = await server.loadAccount(claimant.publicKey());
    const claimTx = new TransactionBuilder(claimantAccount, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.claimClaimableBalance({ balanceId }))
      .setTimeout(30)
      .build();

    claimTx.sign(claimant);
    const response = await server.submitTransaction(claimTx);
    return { success: true, hash: response.hash };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, reason: message };
  }
}

function isJsonOutputRequested(): boolean {
  return process.argv.includes('--json') || process.env.OUTPUT_FORMAT === 'json';
}

export interface ClaimableBalanceManagementParams {
  assetFilter?: string;
}

export async function run(params?: ClaimableBalanceManagementParams): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);
  const jsonOutput = isJsonOutputRequested();
  const assetFilter = params?.assetFilter?.trim() || process.env.ASSET_FILTER;

  const log = (...args: unknown[]) => {
    if (!jsonOutput) console.log(...args);
  };

  log('Starting Claimable Balance Management Example...');
  log(`Using Horizon: ${horizonUrl}`);

  let accountId = process.env.ACCOUNT_ID?.trim();
  const claimantSecret = process.env.CLAIMANT_SECRET?.trim();
  let claimantKeypair: Keypair | undefined = claimantSecret
    ? Keypair.fromSecret(claimantSecret)
    : undefined;

  const report: ClaimableBalanceReport[] = [];

  if (!accountId) {
    log('\nNo ACCOUNT_ID supplied — running self-contained demo setup...');
    const source = Keypair.random();
    const claimant = Keypair.random();
    claimantKeypair = claimant;
    accountId = claimant.publicKey();

    log(`Source account:   ${source.publicKey()}`);
    log(`Claimant account: ${claimant.publicKey()}`);

    log('\nFunding demo accounts via Friendbot...');
    await fundAccount(source.publicKey());
    await fundAccount(claimant.publicKey());

    log('\nCreating demo claimable balances (one eligible, one not-yet-eligible)...');
    await createDemoClaimableBalances(server, source, claimant);
  }

  log(`\nRetrieving claimable balances for claimant ${accountId}...`);
  const claimantPage = await server
    .claimableBalances()
    .claimant(accountId)
    .order('desc')
    .limit(50)
    .call();

  let balances = claimantPage.records as unknown as ClaimableBalanceLike[];
  balances = filterByAsset(balances, assetFilter);

  if (balances.length === 0) {
    log('\nNo claimable balances found for this account (or asset filter).');
    if (jsonOutput) {
      console.log(JSON.stringify({ accountId, assetFilter: assetFilter ?? null, balances: [] }, null, 2));
    }
    return;
  }

  log(`\nFound ${balances.length} claimable balance(s).`);

  for (const balance of balances) {
    const claimantRecord = findClaimantRecord(balance, accountId);
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (!claimantRecord) {
      report.push({
        id: balance.id,
        asset: balance.asset,
        amount: balance.amount,
        claimants: balance.claimants.map((c) => ({
          destination: c.destination,
          predicate: stringifyClaimPredicate(c.predicate),
        })),
        eligibility: 'NOT_ELIGIBLE',
        claimedByThisRun: false,
        skipReason: 'Account is not a listed claimant on this balance.',
      });
      continue;
    }

    const eligibility = evaluatePredicateEligibility(claimantRecord.predicate, nowSeconds);
    log('');
    displayBalance(balance, eligibility);

    const entry: ClaimableBalanceReport = {
      id: balance.id,
      asset: balance.asset,
      amount: balance.amount,
      claimants: balance.claimants.map((c) => ({
        destination: c.destination,
        predicate: stringifyClaimPredicate(c.predicate),
      })),
      eligibility,
      claimedByThisRun: false,
    };

    if (eligibility !== 'ELIGIBLE') {
      entry.skipReason =
        eligibility === 'UNKNOWN'
          ? 'Predicate could not be safely evaluated (relative-time reference unavailable); skipped rather than risk a failed or premature claim.'
          : 'Predicate does not currently permit a claim.';
      log(`  -> Skipping claim: ${entry.skipReason}`);
      report.push(entry);
      continue;
    }

    if (!claimantKeypair || claimantKeypair.publicKey() !== accountId) {
      entry.skipReason = 'Eligible, but no matching CLAIMANT_SECRET was supplied to sign a claim.';
      log(`  -> Skipping claim: ${entry.skipReason}`);
      report.push(entry);
      continue;
    }

    log('  -> Eligible. Constructing and submitting claimClaimableBalance...');
    const claimResult = await attemptClaim(server, claimantKeypair, balance.id);

    if (claimResult.success) {
      entry.claimedByThisRun = true;
      entry.transactionHash = claimResult.hash;
      log(`  -> Claim submitted successfully. Transaction hash: ${claimResult.hash}`);
    } else {
      entry.skipReason = `Claim submission failed: ${claimResult.reason}`;
      log(`  -> Claim failed gracefully: ${claimResult.reason}`);
    }

    report.push(entry);
  }

  const claimedCount = report.filter((r) => r.claimedByThisRun).length;
  log(`\nClaimed ${claimedCount} of ${report.length} inspected balance(s).`);
  log('\nClaimable balance management workflow completed successfully.');

  if (jsonOutput) {
    console.log(
      JSON.stringify({ accountId, assetFilter: assetFilter ?? null, balances: report }, null, 2),
    );
  }
}
