import { readFileSync } from 'node:fs';
import { argsToObject, required } from '../_multi-analyzer/args';
import { terminalReport } from '../_multi-analyzer/common';
import { captureCurrent, compareSnapshots } from './analyzer';
import type { Snapshot } from './types';

async function main(): Promise<void> {
  const args = argsToObject(process.argv.slice(2));
  const load = (path: string): Snapshot => JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
  if (args['snapshot-a'] && args['snapshot-b']) {
    const report = compareSnapshots(load(args['snapshot-a']), load(args['snapshot-b']));
    console.log(args.json === 'true' ? JSON.stringify(report) : terminalReport(report));
  } else if (args['snapshot-a']) {
    const live = await captureCurrent({ rpcUrl: required(args.rpc, 'rpc'), keys: required(args.keys, 'keys').split(',') });
    const report = compareSnapshots(load(args['snapshot-a']), live);
    console.log(args.json === 'true' ? JSON.stringify(report) : terminalReport(report));
  } else {
    const snapshot = await captureCurrent({ rpcUrl: required(args.rpc, 'rpc'), keys: required(args.keys, 'keys').split(',') });
    console.log(args.json === 'true' ? JSON.stringify(snapshot) : terminalReport(snapshot));
  }
}
if (require.main === module) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
