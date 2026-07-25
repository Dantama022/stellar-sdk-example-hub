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

export interface ClaimantRecordLike {
  destination: string;
  predicate: unknown;
}

export interface ClaimableBalanceLike {
  id: string;
  asset: string;
  amount: string;
  claimants: ClaimantRecordLike[];
}

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

export function extractClaimantDestinations(balance: ClaimableBalanceLike): string[] {
  return balance.claimants.map((claimant) => claimant.destination);
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

async function createSampleClaimableBalance(
  server: Horizon.Server,
  source: Keypair,
  claimant: Keypair,
): Promise<string> {
  const sourceAccount = await server.loadAccount(source.publicKey());

  const transaction = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: '3.5',
        claimants: [
          new Claimant(claimant.publicKey(), Claimant.predicateBeforeRelativeTime(String(60 * 60))),
        ],
      }),
    )
    .setTimeout(30)
    .build();

  transaction.sign(source);
  const submitResponse = await server.submitTransaction(transaction);

  const effectsPage = await server.effects().forTransaction(submitResponse.hash).call();
  return findCreatedClaimableBalanceId(
    effectsPage.records as Array<{ type: string; balance_id?: string }>,
  );
}

function displayClaimableBalance(balance: ClaimableBalanceLike): void {
  console.log(`- Balance ID: ${balance.id}`);
  console.log(`  Asset: ${balance.asset}`);
  console.log(`  Amount: ${balance.amount}`);

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

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);

  const source = Keypair.random();
  const claimant = Keypair.random();

  console.log('Starting Claimable Balance Inspection Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  console.log(`\nSource account:   ${source.publicKey()}`);
  console.log(`Claimant account: ${claimant.publicKey()}`);

  console.log('\nFunding test accounts via Friendbot...');
  await fundAccount(source.publicKey());
  await fundAccount(claimant.publicKey());

  console.log('\nCreating a claimable balance so we have deterministic inspection data...');
  const createdBalanceId = await createSampleClaimableBalance(server, source, claimant);
  console.log(`Created claimable balance ID: ${createdBalanceId}`);
  console.log('Claim operation note: this ID is required as the input to claimClaimableBalance.');

  const createdBalance = (await server
    .claimableBalances()
    .claimableBalance(createdBalanceId)
    .call()) as unknown as ClaimableBalanceLike;

  console.log('\nLoaded created balance details:');
  displayClaimableBalance(createdBalance);

  console.log(`\nQuerying claimable balances filtered by claimant ${claimant.publicKey()}...`);
  const claimantPage = await server
    .claimableBalances()
    .claimant(claimant.publicKey())
    .order('desc')
    .limit(10)
    .call();

  const claimantBalances = claimantPage.records as unknown as ClaimableBalanceLike[];

  if (claimantBalances.length === 0) {
    console.log('No claimable balances were returned for this claimant.');
  } else {
    claimantBalances.forEach((balance, index) => {
      console.log(`\nResult ${index + 1}:`);
      displayClaimableBalance(balance);
    });
  }

  const filteredByDestinations = claimantBalances.filter((balance) =>
    extractClaimantDestinations(balance).includes(claimant.publicKey()),
  );
  console.log(
    `\nManual claimant filter count (matching destination list): ${filteredByDestinations.length}`,
  );

  console.log('\nChecking graceful empty-result handling with a random unrelated account...');
  const unrelated = Keypair.random().publicKey();
  const unrelatedPage = await server.claimableBalances().claimant(unrelated).limit(1).call();
  if (unrelatedPage.records.length === 0) {
    console.log('No claimable balances found for unrelated account (expected behavior).');
  }

  console.log('\nClaimable balance inspection completed successfully.');
}
