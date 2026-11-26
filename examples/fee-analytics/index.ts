import { retrieveFeeReport } from './transaction-fee-analysis';
import { jsonReport } from '../_analysis/core';
async function main(): Promise<void> {
  const [network, from, to] = process.argv.slice(2);
  if (!network || !from || !to) throw new Error('Usage: ts-node examples/fee-analytics/index.ts <testnet|public> <startLedger> <endLedger>');
  const report = await retrieveFeeReport({ network: network as 'testnet' | 'public', start: Number(from), end: Number(to) });
  console.log(`Actual fees: ${report.statistics.totalXlm} XLM across ${report.statistics.count} transactions`);
  console.log(`Median: ${report.statistics.medianStroops ?? 'n/a'} stroops`);
  console.log(jsonReport(report));
}
main().catch((error: unknown) => { console.error(String(error)); process.exitCode = 1; });
