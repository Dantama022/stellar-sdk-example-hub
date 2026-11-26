import { retrieveCurrentData, retrieveDataHistory } from './data-entry-history';
import { buildAudit } from './data-entry-audit';
import { jsonReport } from '../_analysis/core';
async function main(): Promise<void> {
  const [network, account, from, to] = process.argv.slice(2);
  if (!network || !account || !from || !to) throw new Error('Usage: ts-node examples/account-data/index.ts <testnet|public> <G-account> <startLedger> <endLedger>');
  const config = { network: network as 'testnet' | 'public', account, start: Number(from), end: Number(to) };
  const [current, history] = await Promise.all([
    retrieveCurrentData(config.network, account), retrieveDataHistory(config),
  ]);
  const report = buildAudit({ ...config, current, history });
  console.log(`Account ${account}: ${report.counts.examined} observed changes, reconstruction complete=${report.complete}`);
  console.log(jsonReport({ current, report }));
}
main().catch((error: unknown) => { console.error(String(error)); process.exitCode = 1; });
