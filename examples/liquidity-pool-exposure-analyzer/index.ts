import { argsToObject, required } from '../_multi-analyzer/args';
import type { Network } from '../_multi-analyzer/common';
import { terminalReport } from '../_multi-analyzer/common';
import { analyzePool } from './analyzer';

async function main(): Promise<void> {
  const args = argsToObject(process.argv.slice(2));
  const report = await analyzePool({ poolId: required(args.pool, 'pool'), account: args.account,
    network: (args.network ?? 'testnet') as Network, horizonUrl: args.horizon });
  console.log(args.json === 'true' ? JSON.stringify(report) : terminalReport(report));
}
if (require.main === module) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
