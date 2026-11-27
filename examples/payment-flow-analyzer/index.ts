import { argsToObject, optionalInteger, required } from '../_multi-analyzer/args';
import type { Network } from '../_multi-analyzer/common';
import { terminalReport } from '../_multi-analyzer/common';
import { analyzeFlows } from './analyzer';

async function main(): Promise<void> {
  const args = argsToObject(process.argv.slice(2));
  const report = await analyzeFlows({
    accounts: required(args.accounts, 'accounts').split(',').filter(Boolean),
    network: (args.network ?? 'testnet') as Network,
    horizonUrl: args.horizon, fromLedger: optionalInteger(args['from-ledger']),
    toLedger: optionalInteger(args['to-ledger']), fromTime: args['from-time'], toTime: args['to-time'],
    maxPages: optionalInteger(args['max-pages']) ?? 5,
  });
  if (args.json === 'true') console.log(JSON.stringify(report));
  else console.log(terminalReport(report));
}
if (require.main === module) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
