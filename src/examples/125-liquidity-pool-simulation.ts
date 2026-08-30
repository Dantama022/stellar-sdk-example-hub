import { Asset, Horizon, getLiquidityPoolId } from '@stellar/stellar-sdk';

export async function run(params?: any): Promise<void> {
  const server = new Horizon.Server(
    process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org',
  );

  try {
    const parseAsset = (input: string) =>
      input === 'native' ? Asset.native() : new Asset(input.split(':')[0], input.split(':')[1]);

    const assetAInput = params?.assetA || 'native';
    const assetBInput =
      params?.assetB || 'USDC:GB6ZS324HT6VEEDZ6MG6CESWE7YZSY7WAJDRQSP2GZCRZ5GBND377A2F';

    const assetA = parseAsset(assetAInput);
    const assetB = parseAsset(assetBInput);

    const poolId = getLiquidityPoolId('constant_product', {
      assetA,
      assetB,
      fee: 30,
    }).toString('hex');

    console.log(`Fetching Pool ID: ${poolId} for simulation...`);
    const pool = await server.liquidityPools().liquidityPoolId(poolId).call();

    const reserveA = parseFloat(pool.reserves[0].amount);
    const reserveB = parseFloat(pool.reserves[1].amount);
    const totalShares = parseFloat(pool.total_shares);

    const depositA = parseFloat(params?.depositA || '10');
    const depositB = parseFloat(params?.depositB || '10');

    const estimatedSharesA = (depositA / reserveA) * totalShares;
    const estimatedSharesB = (depositB / reserveB) * totalShares;
    const estimatedSharesReceived = Math.min(estimatedSharesA, estimatedSharesB);

    console.log('\n=== Simulation Results ===');
    console.log(
      `Current Reserves: ${pool.reserves[0].asset} = ${reserveA}, ${pool.reserves[1].asset} = ${reserveB}`,
    );
    console.log(`Current Total Pool Shares: ${totalShares}`);
    console.log(
      `Deposit Amounts: ${depositA} ${pool.reserves[0].asset}, ${depositB} ${pool.reserves[1].asset}`,
    );
    console.log(`Estimated Shares Received: ${estimatedSharesReceived.toFixed(7)}`);
    console.log('\nSimulation complete. No on-chain state was modified.');
  } catch (error: any) {
    if (error.response?.status === 404) {
      console.error('Liquidity pool does not exist or has no reserves.');
    } else {
      console.error('Error during simulation:', error.message);
    }
  }
}
