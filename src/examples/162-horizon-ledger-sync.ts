import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const SYNC_TOLERANCE_MS = 60_000;

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);
  const latest = await server.ledgers().order('desc').limit(1).call();
  const record = latest.records[0] as { sequence?: number; closed_at?: string } | undefined;

  if (!record?.closed_at) {
    console.log('No ledger records were returned by Horizon.');
    return;
  }

  const closedAtMs = Date.parse(record.closed_at);
  const lagMs = Math.max(0, Date.now() - closedAtMs);

  console.log('=== Horizon Ledger Synchronization Inspector ===');
  console.log(`Latest Ledger: ${record.sequence ?? 'unknown'}`);
  console.log(`Closed At: ${record.closed_at}`);
  console.log(`Observed Lag: ${lagMs}ms`);
  console.log(`Sync Status: ${lagMs <= SYNC_TOLERANCE_MS ? 'in-sync' : 'lagging'}`);
}
