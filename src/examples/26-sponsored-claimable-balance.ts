import {
  Asset,
  Claimant,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

export interface ClaimableBalanceEffectLike {
  type: string;
  balance_id?: string;
}

export interface NativeBalanceLike {
  asset_type: string;
  balance: string;
}

export function findCreatedClaimableBalanceId(records: ClaimableBalanceEffectLike[]): string {
  const effect = records.find((record) => record.type === 'claimable_balance_created');

  if (!effect?.balance_id) {
    throw new Error('Unable to determine claimable balance ID from Horizon effects.');
  }

  return effect.balance_id;
}

export function getNativeBalance(balances: NativeBalanceLike[]): string {
  const nativeBalance = balances.find((balance) => balance.asset_type === 'native');
  return nativeBalance?.balance ?? '0';
}

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`,
  );

  if (!response.ok) {
    throw new Error(`Failed to fund account ${publicKey}: ${response.statusText}`);
  }
}

/**
 * Demonstrates a sponsored claimable balance lifecycle on Stellar Testnet.
 *
 * The sponsor covers the reserve requirement for the claimable balance entry,
 * the sender funds the balance amount, and the claimant claims the balance.
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  const sponsor = Keypair.random();
  const sender = Keypair.random();
  const claimant = Keypair.random();
  const asset = Asset.native();
  const amount = process.env.SPONSORED_CLAIMABLE_AMOUNT || '5';

  console.log('Starting Sponsored Claimable Balance Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log('\nWorkflow:');
  console.log('- Sponsor begins future-reserve sponsorship for the sender.');
  console.log('- Sender creates a claimable balance for the claimant.');
  console.log('- Sender ends the sponsorship scope in the same transaction.');
  console.log('- Claimant claims the balance in a follow-up transaction.');

  console.log(`\nSponsor Public Key: ${sponsor.publicKey()}`);
  console.log(`Sender Public Key:  ${sender.publicKey()}`);
  console.log(`Claimant Public Key:${claimant.publicKey()}`);

  console.log('\nFunding Testnet accounts via Friendbot...');
  await fundAccount(sponsor.publicKey());
  await fundAccount(sender.publicKey());
  await fundAccount(claimant.publicKey());

  const sponsorAccount = await server.loadAccount(sponsor.publicKey());

  console.log('\nBuilding sponsored claimable balance transaction...');
  const createTx = new TransactionBuilder(sponsorAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: sender.publicKey(),
      }),
    )
    .addOperation(
      Operation.createClaimableBalance({
        source: sender.publicKey(),
        asset,
        amount,
        claimants: [new Claimant(claimant.publicKey(), Claimant.predicateUnconditional())],
      }),
    )
    .addOperation(
      Operation.endSponsoringFutureReserves({
        source: sender.publicKey(),
      }),
    )
    .setTimeout(30)
    .build();

  createTx.sign(sponsor);
  createTx.sign(sender);

  const createResponse = await server.submitTransaction(createTx);
  console.log(`Sponsored claimable balance created. Hash: ${createResponse.hash}`);

  const createEffects = await server.effects().forTransaction(createResponse.hash).call();
  const balanceId = findCreatedClaimableBalanceId(
    createEffects.records as ClaimableBalanceEffectLike[],
  );
  console.log(`Claimable Balance ID: ${balanceId}`);

  const createdBalance = (await server.claimableBalances().claimableBalance(balanceId).call()) as {
    sponsor?: string;
    amount: string;
    asset: string;
  };

  console.log('\nCreated balance details:');
  console.log(`- Sponsor recorded by Horizon: ${createdBalance.sponsor ?? 'unknown'}`);
  console.log(`- Asset: ${createdBalance.asset}`);
  console.log(`- Amount: ${createdBalance.amount}`);
  console.log(`- Claimant: ${claimant.publicKey()}`);

  const claimantBefore = await server.loadAccount(claimant.publicKey());
  console.log(
    `\nClaimant native balance before claim: ${getNativeBalance(claimantBefore.balances)}`,
  );

  console.log('\nBuilding claim transaction from the claimant account...');
  const claimantAccount = await server.loadAccount(claimant.publicKey());
  const claimTx = new TransactionBuilder(claimantAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .setTimeout(30)
    .build();

  claimTx.sign(claimant);
  const claimResponse = await server.submitTransaction(claimTx);
  console.log(`Claim succeeded. Hash: ${claimResponse.hash}`);

  const claimantAfter = await server.loadAccount(claimant.publicKey());
  console.log(`Claimant native balance after claim:  ${getNativeBalance(claimantAfter.balances)}`);

  console.log('\nSponsored claimable balance workflow completed successfully.');
}
