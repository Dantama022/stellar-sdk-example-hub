import { rpc } from '@stellar/stellar-sdk';
import { parseEventRecord } from './67-soroban-contract-events';

export async function run(params: { contractId?: string; rpcUrl?: string } = {}) {
  const contractId = params.contractId || process.argv[3];
  const rpcUrl =
    params.rpcUrl || process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';

  if (!contractId) throw new Error('Missing contract ID. Usage: watch-events <contractId>');

  const server = new rpc.Server(rpcUrl);
  let latestLedger = (await server.getLatestLedger()).sequence;
  let cursor: string | undefined = undefined;
  let isRunning = true;

  console.log(`=== Monitoring Soroban Events ===`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Contract: ${contractId}`);
  console.log(`Starting from Ledger: ${latestLedger}`);
  console.log(`Press Ctrl+C to stop gracefully.\n`);

  process.on('SIGINT', () => {
    console.log(`\nStopping event monitor...`);
    isRunning = false;
  });

  const pollInterval = 3000;

  while (isRunning) {
    try {
      // Cast the request parameters to 'any' to bypass strict property checks for the cursor argument
      const requestParams: any = {
        startLedger: latestLedger,
        filters: [{ type: 'contract', contractIds: [contractId] }],
        limit: 50,
      };

      if (cursor) {
        requestParams.cursor = cursor;
      }

      const response = await server.getEvents(requestParams);

      const records = response.events ?? [];
      if (records.length > 0) {
        records.forEach((raw) => {
          const parsed = parseEventRecord(raw as any);
          console.log(
            `[Ledger ${parsed.ledger}] Event: ${parsed.eventName || 'unnamed'} | Tx: ${parsed.txHash}`,
          );
        });

        cursor = response.cursor;
        // Advance the latest ledger safely
        const maxLedger = Math.max(...records.map((e) => parseInt(e.ledger as any, 10) || 0));
        if (maxLedger > latestLedger) {
          latestLedger = maxLedger;
        }
      }
    } catch (e: any) {
      console.warn(`[RPC Issue] Continuing polling... Error: ${e.message}`);
    }

    if (isRunning) await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  console.log(`Monitor shut down. Last processed ledger: ${latestLedger}. Cursor: ${cursor}`);
}
