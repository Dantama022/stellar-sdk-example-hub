import { WorkflowError } from '../utils/example-input';
import dotenv from 'dotenv';
import { rpc, StrKey, xdr, scValToNative } from '@stellar/stellar-sdk';
import { resolveNetworkConfiguration } from './60-network-configuration';
import { formatNativeValue } from './67-soroban-contract-events';
import { loadCheckpoint, retryRead, saveCheckpoint, scan } from '../utils/reliable-scan';

export function eventFilter(contract = '', topic?: string, type = 'contract'): rpc.Api.EventFilter {
  if (!StrKey.isValidContract(contract))
    throw new WorkflowError('Expected a valid C... contract address');
  if (type !== 'contract' && type !== 'system')
    throw new WorkflowError('Event type must be contract or system');
  if (topic !== undefined && !/^[a-zA-Z0-9_]{1,32}$/.test(topic))
    throw new WorkflowError('Topic must be an ScSymbol of 1–32 characters');
  return {
    type,
    contractIds: [contract],
    ...(topic
      ? {
          topics: [[xdr.ScVal.scvSymbol(topic).toXDR('base64'), '*', '*']],
        }
      : {}),
  };
}

export function decodeValue(value: unknown): unknown {
  try {
    // SDK decoding is schema independent; preserve large integers and byte arrays.
    return formatNativeValue(scValToNative(value as xdr.ScVal));
  } catch {
    return { undecodable: true };
  }
}

export async function run(): Promise<void> {
  const config = resolveNetworkConfiguration();
  const filter = eventFilter(
    process.env.CONTRACT_ID,
    process.env.EVENT_TOPIC,
    process.env.EVENT_TYPE,
  );
  const startLedger = Number(process.env.START_LEDGER);
  if (!Number.isSafeInteger(startLedger) || startLedger <= 0)
    throw new WorkflowError('START_LEDGER must be a positive integer');
  const server = new rpc.Server(config.sorobanRpcUrl, { timeout: 15 });
  const network = await retryRead(() => server.getNetwork());
  if (network.passphrase !== config.networkPassphrase)
    throw new WorkflowError('RPC network passphrase mismatch');
  const file = process.env.CHECKPOINT_FILE || '.events-checkpoint.json';
  const scope = JSON.stringify([
    'events',
    config.sorobanRpcUrl,
    config.networkPassphrase,
    startLedger,
    filter,
  ]);
  const checkpoint = await loadCheckpoint(file, scope);
  await scan<rpc.Api.EventResponse>({
    checkpoint,
    maxPages: 100,
    fetch: async (cursor) => {
      // Cursor and startLedger are mutually exclusive. Never silently skip unavailable history.
      const response = await server.getEvents({
        ...(cursor ? { cursor } : { startLedger }),
        filters: [filter],
        limit: 100,
      });
      if (!Array.isArray(response.events)) throw new WorkflowError('Malformed RPC events');
      return { records: response.events, cursor: response.cursor };
    },
    identity: (event) => event.id,
    process: async (event) => {
      if (!event.id || !Number.isSafeInteger(event.ledger) || !Array.isArray(event.topic))
        throw new WorkflowError('Malformed event metadata');
      console.log(
        JSON.stringify({
          id: event.id,
          contract: event.contractId?.contractId(),
          ledger: event.ledger,
          transaction: event.txHash,
          type: event.type,
          successfulCall: event.inSuccessfulContractCall,
          topics: event.topic.map(decodeValue),
          data: decodeValue(event.value),
        }),
      );
    },
    save: (next) => saveCheckpoint(file, next),
  });
  console.log('Bounded historical query complete. Re-run to poll from the checkpoint.');
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
