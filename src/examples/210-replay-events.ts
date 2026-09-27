import { rpc } from '@stellar/stellar-sdk';
import { parseEventRecord } from './67-soroban-contract-events';
import fs from 'fs';

export async function run(
  params: { startLedger?: string; endLedger?: string; contractId?: string } = {},
) {
  const startLedger = parseInt(params.startLedger || process.argv[3] || '0', 10);
  const endLedger = parseInt(params.endLedger || process.argv[4] || '0', 10);
  const contractId = params.contractId || process.argv[5];
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';

  if (!startLedger || !endLedger) throw new Error('Missing ledger boundaries.');

  const server = new rpc.Server(rpcUrl);
  let cursor: string | undefined = undefined;
  const events: any[] = [];

  console.log(`Replaying events from ledger ${startLedger} to ${endLedger}...`);

  let fetching = true;
  while (fetching) {
    const filters = contractId
      ? [{ type: 'contract' as any, contractIds: [contractId] }]
      : [{ type: 'contract' as any }];

    const requestPayload: any = {
      startLedger,
      endLedger,
      filters,
      limit: 100,
    };

    if (cursor) {
      requestPayload.cursor = cursor;
    }

    const response = await server.getEvents(requestPayload);

    const records = response.events ?? [];
    if (records.length === 0) {
      fetching = false;
      break;
    }

    records.forEach((r) => events.push(parseEventRecord(r as any)));
    cursor = response.cursor;

    if (records.length < 100) {
      fetching = false;
      break;
    }
  }

  events.sort((a, b) => a.ledger - b.ledger || a.id.localeCompare(b.id));

  console.log(`Replay complete. Scanned ${endLedger - startLedger} ledgers.`);
  console.log(`Retrieved ${events.length} deterministic events.`);

  const outFile = `events_${startLedger}_${endLedger}.json`;
  fs.writeFileSync(outFile, JSON.stringify(events, null, 2));
  console.log(`Exported output to ${outFile}.`);
}
