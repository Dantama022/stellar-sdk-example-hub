import {
  Asset,
  Claimant,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
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
 * Creates a claimable balance with a time-based predicate and claims it from the claimant account.
 * The balance is locked until the predicate is satisfied, which lets the sender define when the
 * funds become claimable without needing a separate escrow service.
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Claimable Balances Example...');

  const source = Keypair.random();
  const claimant = Keypair.random();
  const asset = Asset.native();

  console.log(`Source Public Key:   ${source.publicKey()}`);
  console.log(`Claimant Public Key: ${claimant.publicKey()}`);

  console.log('\nFunding accounts via Friendbot...');
  await fundAccount(source.publicKey());
  await fundAccount(claimant.publicKey());

  const sourceAccount = await server.loadAccount(source.publicKey());
  const claimWindowMs = Date.now() + 60 * 60 * 1000;

  console.log('Building claimable balance transaction...');
  const createTx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.createClaimableBalance({
        asset,
        amount: '15',
        claimants: [
          new Claimant(
            claimant.publicKey(),
            Claimant.predicateBeforeAbsoluteTime(String(claimWindowMs)),
          ),
        ],
      }),
    )
    .setTimeout(30)
    .build();

  createTx.sign(source);
  const createResponse = await server.submitTransaction(createTx);
  console.log(`Claimable balance created. Transaction hash: ${createResponse.hash}`);

  const createEffects = await server.effects().forTransaction(createResponse.hash).call();
  const claimableBalanceEffect = createEffects.records.find(
    (effect) => effect.type === 'claimable_balance_created',
  ) as any;
  const balanceId = claimableBalanceEffect?.balance_id;
  if (!balanceId) {
    throw new Error('Unable to determine claimable balance ID from Horizon effects.');
  }

  console.log(`Claimable Balance ID: ${balanceId}`);
  console.log(`Claim predicate: claim before absolute time ${claimWindowMs}`);

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
  console.log(`Claim succeeded. Transaction hash: ${claimResponse.hash}`);
  console.log('The balance was created and then claimed as an atomic lifecycle on Testnet.');
}
