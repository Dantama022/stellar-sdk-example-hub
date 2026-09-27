import fs from 'fs';
import { run as replayEvents } from './210-replay-events';

export async function run(
  params: { startLedger?: string; endLedger?: string; contractId?: string } = {},
) {
  const startLedger = params.startLedger || process.argv[3];
  const endLedger = params.endLedger || process.argv[4];

  if (!startLedger || !endLedger) throw new Error('Missing ledger boundaries.');

  // Leverage replay function to gather data temporarily, then analyze
  const outFile = `events_${startLedger}_${endLedger}.json`;
  console.log(`Gathering data via replay...`);
  await replayEvents(params);

  const events = JSON.parse(fs.readFileSync(outFile, 'utf8'));

  const ledgers = new Set<number>();
  const txs = new Set<string>();
  const byTopic: Record<string, number> = {};
  const byContract: Record<string, number> = {};

  events.forEach((e: any) => {
    ledgers.add(e.ledger);
    txs.add(e.txHash);
    const eventName = e.eventName || 'unknown';
    byTopic[eventName] = (byTopic[eventName] || 0) + 1;
    byContract[e.contractId] = (byContract[e.contractId] || 0) + 1;
  });

  console.log(`\n=== Soroban Event Analytics ===`);
  console.log(`Total Events: ${events.length}`);
  console.log(`Active Ledgers: ${ledgers.size}`);
  console.log(`Unique Transactions: ${txs.size}`);

  console.log(`\n--- Top Event Names (Topics) ---`);
  Object.entries(byTopic)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([t, c]) => console.log(`  ${t}: ${c}`));

  console.log(`\n--- Contracts Interacted ---`);
  Object.entries(byContract)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([c, count]) => console.log(`  ${c}: ${count}`));

  fs.unlinkSync(outFile); // Cleanup
}
