import { retrieveTransactionTimestamps } from './transaction-timestamps';
import { jsonReport } from '../_analysis/core';

async function main(): Promise<void> {
  const [network, from, to, resume] = process.argv.slice(2);
  if (!network || !from || !to) throw new Error('Usage: ts-node examples/ledger-analysis/index.ts <testnet|public> <startLedger> <endLedger> [lastCompletedLedger]');
  const report = await retrieveTransactionTimestamps({
    network: network as 'testnet' | 'public', start: Number(from), end: Number(to),
    resume: resume ? { lastCompletedLedger: Number(resume) } : undefined,
  });
  console.log(`Ledgers ${report.range.start}-${report.range.end}: ${report.transactionCount} transactions`);
  console.log(`Average observed ledger interval: ${report.timing.averageIntervalSeconds ?? 'n/a'} seconds`);
  console.log(jsonReport(report));
}
main().catch((error: unknown) => {
  const checkpoint = error && typeof error === 'object' && 'checkpoint' in error ? JSON.stringify(error.checkpoint) : null;
  console.error(String(error), checkpoint ? `Resume using checkpoint ${checkpoint}` : ''); process.exitCode = 1;
});
