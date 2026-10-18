import { WorkflowError } from '../utils/example-input';
import dotenv from 'dotenv';
import { Horizon } from '@stellar/stellar-sdk';
import { resolveNetworkConfiguration } from './60-network-configuration';
import { accountId } from '../utils/example-input';
import { loadCheckpoint, saveCheckpoint, scan } from '../utils/reliable-scan';

export async function run(): Promise<void> {
  const config = resolveNetworkConfiguration();
  const account = accountId(process.env.ACCOUNT_ID);
  const file = process.env.CHECKPOINT_FILE || '.history-checkpoint.json';
  const scope = JSON.stringify([
    'transactions',
    config.horizonUrl,
    config.networkPassphrase,
    account,
    'asc',
  ]);
  const checkpoint = await loadCheckpoint(file, scope);
  const server = new Horizon.Server(config.horizonUrl);
  await scan<Horizon.ServerApi.TransactionRecord>({
    checkpoint,
    maxPages: 100,
    fetch: async (cursor) => {
      let query = server.transactions().forAccount(account).order('asc').limit(100);
      if (cursor) query = query.cursor(cursor);
      const page = await query.call();
      return { records: page.records, cursor: page.records.at(-1)?.paging_token };
    },
    identity: (tx) => tx.hash,
    process: async (tx) => {
      if (!tx.paging_token || !tx.hash) throw new WorkflowError('Malformed transaction');
      console.log(
        JSON.stringify({
          hash: tx.hash,
          ledger: tx.ledger,
          successful: tx.successful,
          createdAt: tx.created_at,
        }),
      );
    },
    save: (next) => saveCheckpoint(file, next),
  });
  console.log('Scan finished or reached its page budget; run again to retrieve newer history.');
}

if (require.main === module) {
  dotenv.config();
  run().catch((error: unknown) => {
    console.error(
      error instanceof WorkflowError
        ? error.message
        : 'Retrieval or processing failed; check network availability and checkpoint scope. The failing batch was not checkpointed.',
    );
    process.exitCode = 1;
  });
}
