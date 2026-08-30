import { Asset, Horizon, getLiquidityPoolId } from '@stellar/stellar-sdk';

export async function run(params?: any): Promise<void> {
  const server = new Horizon.Server(
    process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org',
  );

  try {
    const parseAsset = (input: string) =>
      input === 'native' ? Asset.native() : new Asset(input.split(':')[0], input.split(':')[1]);

    // Provide a valid default issued asset if none is passed via CLI
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

    console.log(`Fetching Pool ID: ${poolId}`);
    const pool = await server.liquidityPools().liquidityPoolId(poolId).call();

    const reserveA = pool.reserves[0].amount;
    const reserveB = pool.reserves[1].amount;
    const ratio = parseFloat(reserveA) / parseFloat(reserveB);

    const output = {
      poolId: pool.id,
      assetA: pool.reserves[0].asset,
      assetB: pool.reserves[1].asset,
      reserveA,
      reserveB,
      totalShares: pool.total_shares,
      fee: pool.fee_bp,
      lastModifiedLedger: (pool as any).last_modified_ledger || (pool as any).lastModifiedLedger,
      reserveRatio: ratio.toFixed(4),
      impliedPrice: (1 / ratio).toFixed(4),
    };

    console.log(params?.json ? JSON.stringify(output, null, 2) : output);
  } catch (error: any) {
    if (error.response?.status === 404) {
      console.error('Liquidity pool does not exist or has no reserves.');
    } else {
      console.error('Error inspecting pool:', error.message);
    }
  }
}
