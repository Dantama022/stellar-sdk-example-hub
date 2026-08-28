import {
  Asset,
  Claimant,
  Horizon,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_RESULT_LIMIT = 10;

export interface ClaimableBalanceInspectionParams {
  accountId?: string;
  claimableBalanceId?: string;
  limit?: string;
}

export interface ClaimantRecordLike {
  destination: string;
  predicate: unknown;
}

export interface ClaimableBalanceLike {
  id: string;
  asset: string;
  amount: string;
  claimants: ClaimantRecordLike[];
  last_modified_ledger?: number;
}

export function stringifyClaimPredicate(predicate: unknown): string {
  if (!predicate || typeof predicate !== 'object') {
    return 'unknown';
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

  return 'unknown';
}

function parseLimit(limit?: string): number {
  const parsed = Number(limit?.trim() || DEFAULT_RESULT_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RESULT_LIMIT;
  }

  return Math.min(Math.max(Math.floor(parsed), 1), 100);
}

function isValidAccountId(accountId: string): boolean {
  return StrKey.isValidEd25519PublicKey(accountId);
}

function isHorizonNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as Record<string, unknown>).name === 'NotFoundError'
  );
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
): Promise<{ balanceId: string; claimantPublicKey: string }> {
  const source = Keypair.random();
  const claimant = Keypair.random();

  console.log('No account was provided. Creating a sample source account and claimant account...');
  console.log(`Source account: ${source.publicKey()}`);
  console.log(`Claimant account: ${claimant.publicKey()}`);

  await fundAccount(source.publicKey());
  await fundAccount(claimant.publicKey());

  const sourceAccount = await server.loadAccount(source.publicKey());
  const transaction = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: '5',
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
  const created = (
    effectsPage.records as Array<{
      type: string;
      balance_id?: string;
    }>
  ).find((record) => record.type === 'claimable_balance_created');

  if (!created?.balance_id) {
    throw new Error('Failed to retrieve the created claimable balance ID from Horizon effects.');
  }

  return {
    balanceId: created.balance_id,
    claimantPublicKey: claimant.publicKey(),
  };
}

function displayClaimableBalance(balance: ClaimableBalanceLike): void {
  console.log(`- Balance ID: ${balance.id}`);
  console.log(`  Asset: ${balance.asset}`);
  console.log(`  Amount: ${balance.amount}`);
  if (balance.last_modified_ledger !== undefined) {
    console.log(`  Last modified ledger: ${balance.last_modified_ledger}`);
  }

  if (!balance.claimants || balance.claimants.length === 0) {
    console.log('  Claimants: none');
    return;
  }

  console.log('  Claimants:');
  balance.claimants.forEach((claimant, index) => {
    console.log(`    ${index + 1}. ${claimant.destination}`);
    console.log(`       Predicate: ${stringifyClaimPredicate(claimant.predicate)}`);
  });
}

export async function run(params: ClaimableBalanceInspectionParams = {}): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);

  const accountId = params.accountId?.trim() || process.env.ACCOUNT_ID?.trim();
  const claimableBalanceId =
    params.claimableBalanceId?.trim() || process.env.CLAIMABLE_BALANCE_ID?.trim();
  const limit = parseLimit(params.limit || process.env.RESULT_LIMIT);

  console.log('Starting Claimable Balance Inspection Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log(
    'Claimable balances are ledger objects that remain unclaimed until a claimant submits a claim.',
  );
  console.log(
    'Unlike a direct payment, a claimable balance does not immediately credit the destination account balance.',
  );

  let inspectedAccountId = accountId;
  let sampleBalanceId: string | undefined;

  if (claimableBalanceId) {
    console.log(`
Inspecting claimable balance ID: ${claimableBalanceId}`);
    try {
      const balance = (await server
        .claimableBalances()
        .claimableBalance(claimableBalanceId)
        .call()) as unknown as ClaimableBalanceLike;

      console.log('\nLoaded claimable balance details:');
      displayClaimableBalance(balance);
    } catch (error: unknown) {
      if (isHorizonNotFoundError(error)) {
        console.log(
          `Claimable balance ID ${claimableBalanceId} was not found on the connected Horizon network.`,
        );
        return;
      }
      throw error;
    }
  }

  if (!inspectedAccountId) {
    const sample = await createSampleClaimableBalance(server);
    sampleBalanceId = sample.balanceId;
    inspectedAccountId = sample.claimantPublicKey;

    console.log(`\nCreated sample claimable balance ID: ${sampleBalanceId}`);
    console.log(`Querying claimable balances for claimant ${inspectedAccountId}...`);
  }

  if (inspectedAccountId) {
    if (!isValidAccountId(inspectedAccountId)) {
      throw new Error(
        `Invalid Stellar account ID: ${inspectedAccountId}. Provide a valid public key starting with G.`,
      );
    }

    console.log(
      `\nQuerying claimable balances for claimant ${inspectedAccountId} (limit ${limit})...`,
    );
    const page = await server
      .claimableBalances()
      .claimant(inspectedAccountId)
      .order('desc')
      .limit(limit)
      .call();

    const balances = page.records as unknown as ClaimableBalanceLike[];
    if (balances.length === 0) {
      console.log('No claimable balances were found for this account.');
      console.log(
        'A claimable balance is different from a direct payment because it is held as a ledger object until claimed.',
      );
      return;
    }

    console.log(`\nFound ${balances.length} claimable balance(s):`);
    balances.forEach((balance, index) => {
      console.log(`\nResult ${index + 1}:`);
      displayClaimableBalance(balance);
    });

    if (sampleBalanceId) {
      console.log(
        `\nThe sample claimable balance ${sampleBalanceId} is available for the claimant above and remains unclaimed until claimed with a separate operation.`,
      );
    }
  }

  console.log('\nClaimable balance inspection completed successfully.');
}
