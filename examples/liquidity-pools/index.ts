import { analyzeSwap } from './swap-quote';
import { jsonReport } from '../_analysis/core';

async function main(): Promise<void> {
  const [network, assetA, assetB, inputAsset, inputAmount, tolerance] = process.argv.slice(2);
  if (!network || !assetA || !assetB || !inputAsset || !inputAmount) {
    throw new Error('Usage: ts-node examples/liquidity-pools/index.ts <testnet|public> <assetA> <assetB> <inputAsset> <amount> [slippageBps]');
  }
  const report = await analyzeSwap({ network: network as 'testnet' | 'public', assetA, assetB, inputAsset, inputAmount, slippageBasisPoints: tolerance ? Number(tolerance) : 100 });
  console.log(`Pool ${report.poolId}: ${report.inputAmount} ${report.inputAsset} -> ~${report.estimatedOutput} ${report.outputAsset}`);
  console.log(`Minimum after slippage: ${report.minimumOutput}; price impact: ${report.priceImpactPercent}%`);
  console.log(jsonReport(report));
}
main().catch((error: unknown) => { console.error(String(error)); process.exitCode = 1; });
