import { argsToObject, optionalInteger, required } from '../_multi-analyzer/args';
import type { Network } from '../_multi-analyzer/common';
import { terminalReport } from '../_multi-analyzer/common';
import { analyzeOrderbook } from './analyzer';

async function main(): Promise<void> {
  const args = argsToObject(process.argv.slice(2));
  const report = await analyzeOrderbook({ selling: required(args.selling, 'selling'), buying: required(args.buying, 'buying'),
    network: (args.network ?? 'testnet') as Network, horizonUrl: args.horizon,
    limit: optionalInteger(args.limit), priceLimits: args['price-limits']?.split(',') });
  console.log(args.json === 'true' ? JSON.stringify(report) : terminalReport(report));
}
if (require.main === module) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
