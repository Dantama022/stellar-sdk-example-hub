import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  LiquidityPoolAsset,
  LiquidityPoolFeeV18,
  getLiquidityPoolId,
} from '@stellar/stellar-sdk';

export interface PriceBounds {
  minPrice: string;
  maxPrice: string;
}

function formatAmount(value: number): string {
  return value.toFixed(7);
}

export function derivePriceBounds(spotPrice: number, maxSlippageBps = 200): PriceBounds {
  const delta = spotPrice * (maxSlippageBps / 10_000);
  return {
    minPrice: formatAmount(spotPrice - delta),
    maxPrice: formatAmount(spotPrice + delta),
  };
}

export function readPoolShareBalance(
  balances: Array<Record<string, unknown>>,
  liquidityPoolId: string,
): string {
  const balance = balances.find(
    (entry) =>
      entry.asset_type === 'liquidity_pool_shares' && entry.liquidity_pool_id === liquidityPoolId,
  );
  return String(balance?.balance ?? '0');
}

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Liquidity Pool Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  const issuerA = Keypair.random();
  const issuerB = Keypair.random();
  const provider = Keypair.random();

  console.log(`Issuer A: ${issuerA.publicKey()}`);
  console.log(`Issuer B: ${issuerB.publicKey()}`);
  console.log(`Liquidity Provider: ${provider.publicKey()}`);

  for (const account of [issuerA, issuerB, provider]) {
    const response = await fetch(
      `https://friendbot.stellar.org/?addr=${encodeURIComponent(account.publicKey())}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fund account ${account.publicKey()}`);
    }
  }

  const assetA = new Asset('TOKA', issuerA.publicKey());
  const assetB = new Asset('TOKB', issuerB.publicKey());
  const poolAsset = new LiquidityPoolAsset(assetA, assetB, LiquidityPoolFeeV18);
  const liquidityPoolId = getLiquidityPoolId(
    'constant_product',
    poolAsset.getLiquidityPoolParameters(),
  ).toString('hex');

  console.log(`\nPool Information:`);
  console.log(`- Asset A: ${assetA.code}:${assetA.issuer}`);
  console.log(`- Asset B: ${assetB.code}:${assetB.issuer}`);
  console.log(`- Fee: ${LiquidityPoolFeeV18} bps`);
  console.log(`- Liquidity Pool ID: ${liquidityPoolId}`);

  const providerAccount = await server.loadAccount(provider.publicKey());

  const trustlineTx = new TransactionBuilder(providerAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.changeTrust({
        asset: assetA,
      }),
    )
    .addOperation(
      Operation.changeTrust({
        asset: assetB,
      }),
    )
    .addOperation(
      Operation.changeTrust({
        asset: poolAsset,
      }),
    )
    .setTimeout(30)
    .build();

  trustlineTx.sign(provider);
  const trustlineResult = await server.submitTransaction(trustlineTx);
  console.log(`\nTrustline creation succeeds: ${trustlineResult.hash}`);

  const issuerAAccount = await server.loadAccount(issuerA.publicKey());
  const issuerATx = new TransactionBuilder(issuerAAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: provider.publicKey(),
        asset: assetA,
        amount: '120',
      }),
    )
    .setTimeout(30)
    .build();

  issuerATx.sign(issuerA);
  await server.submitTransaction(issuerATx);

  const issuerBAccount = await server.loadAccount(issuerB.publicKey());
  const issuerBTx = new TransactionBuilder(issuerBAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: provider.publicKey(),
        asset: assetB,
        amount: '120',
      }),
    )
    .setTimeout(30)
    .build();

  issuerBTx.sign(issuerB);
  await server.submitTransaction(issuerBTx);

  const beforeDepositAccount = await server.loadAccount(provider.publicKey());
  const beforeShares = readPoolShareBalance(
    beforeDepositAccount.balances as any[],
    liquidityPoolId,
  );
  console.log(`\nShare balances before deposit: ${beforeShares}`);

  const bounds = derivePriceBounds(1.0, 300);
  console.log(
    `Slippage considerations: max 3.00%, accepted price boundary [${bounds.minPrice}, ${bounds.maxPrice}]`,
  );

  const depositAccount = await server.loadAccount(provider.publicKey());
  const depositTx = new TransactionBuilder(depositAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.liquidityPoolDeposit({
        liquidityPoolId,
        maxAmountA: '50',
        maxAmountB: '50',
        minPrice: bounds.minPrice,
        maxPrice: bounds.maxPrice,
      }),
    )
    .setTimeout(30)
    .build();

  depositTx.sign(provider);
  const depositResult = await server.submitTransaction(depositTx);
  console.log(`Deposit succeeds: ${depositResult.hash}`);

  const afterDepositAccount = await server.loadAccount(provider.publicKey());
  const afterDepositShares = readPoolShareBalance(
    afterDepositAccount.balances as any[],
    liquidityPoolId,
  );
  console.log(`Share balances after deposit: ${afterDepositShares}`);

  const withdrawAmount = Math.max(Number(afterDepositShares) / 2, 0.0000001);
  const withdrawAccount = await server.loadAccount(provider.publicKey());
  const withdrawTx = new TransactionBuilder(withdrawAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.liquidityPoolWithdraw({
        liquidityPoolId,
        amount: formatAmount(withdrawAmount),
        minAmountA: '0.0000001',
        minAmountB: '0.0000001',
      }),
    )
    .setTimeout(30)
    .build();

  withdrawTx.sign(provider);
  const withdrawResult = await server.submitTransaction(withdrawTx);
  console.log(`Withdrawal succeeds: ${withdrawResult.hash}`);

  const afterWithdrawAccount = await server.loadAccount(provider.publicKey());
  const afterWithdrawShares = readPoolShareBalance(
    afterWithdrawAccount.balances as any[],
    liquidityPoolId,
  );
  console.log(`Share balances after withdrawal: ${afterWithdrawShares}`);
  console.log('Liquidity pool workflow completed successfully.');
}
