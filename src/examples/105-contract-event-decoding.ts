import { rpc, StrKey } from '@stellar/stellar-sdk';

import {
  compareScVal,
  decodePayload,
  decodeTopics,
  formatEventDecodingReport,
} from '../utils/scval-decoder';

/**
 * Example 105: Soroban Contract Event Decoding
 *
 * Contract events carry topics (indexed ScVals) and a data payload (one ScVal).
 * This example retrieves events for a contract and decodes every topic and the
 * payload into human-readable values, showing raw base64 XDR alongside decoded
 * output for side-by-side comparison.
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
const DEFAULT_CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const DEFAULT_LOOKBACK = 17280;
const DEFAULT_LIMIT = 5;

export interface ContractEventDecodingParams {
  contractId?: string;
  startLedger?: number | string;
  limit?: number | string;
  rpcUrl?: string;
}

export function normalizeContractId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Missing contract ID. Provide a contract ID starting with "C".');
  }
  if (!StrKey.isValidContract(trimmed)) {
    throw new Error(`Invalid contract ID "${trimmed}".`);
  }
  return trimmed;
}

export function normalizeLimit(value?: number | string): number {
  const parsed = typeof value === 'string' ? parseInt(value.trim(), 10) : value;
  if (parsed === undefined || Number.isNaN(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), 50);
}

export function parseLedgerInput(value?: number | string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'string' ? parseInt(value.trim(), 10) : value;
  if (Number.isNaN(parsed) || parsed < 1) return undefined;
  return Math.trunc(parsed);
}

export async function run(params: ContractEventDecodingParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl || process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URL;
  const contractInput =
    params.contractId?.trim() ||
    process.env.CONTRACT_ID?.trim() ||
    process.argv[3]?.trim() ||
    DEFAULT_CONTRACT_ID;
  const limit = normalizeLimit(params.limit ?? process.env.EVENT_LIMIT ?? process.argv[5]);
  const startInput = parseLedgerInput(
    params.startLedger ?? process.env.START_LEDGER ?? process.argv[4],
  );

  console.log('Soroban Contract Event Decoding Example');
  console.log(`Soroban RPC: ${rpcUrl}`);

  let contractId: string;
  try {
    contractId = normalizeContractId(contractInput);
  } catch (err: any) {
    console.log(`\n${err?.message ?? err}`);
    return;
  }

  const server = new rpc.Server(rpcUrl);

  let latestLedger: number;
  try {
    latestLedger = (await server.getLatestLedger()).sequence;
    console.log(`Latest ledger: ${latestLedger}`);
  } catch (err: any) {
    console.log(`Could not reach Soroban RPC: ${err?.message ?? err}`);
    return;
  }

  const startLedger = startInput ?? Math.max(1, latestLedger - DEFAULT_LOOKBACK);
  console.log(`Contract: ${contractId}`);
  console.log(`Ledger range: ${startLedger} -> latest (limit ${limit})`);

  let response: rpc.Api.GetEventsResponse;
  try {
    response = await server.getEvents({
      startLedger,
      filters: [{ type: 'contract', contractIds: [contractId] }],
      limit,
    });
  } catch (err: any) {
    console.log(`\nCould not retrieve events: ${err?.message ?? err}`);
    return;
  }

  const events = response.events ?? [];
  if (events.length === 0) {
    console.log('\nNo contract events found in the queried ledger range.');
    console.log(
      'This is a valid empty result — try a more recent start ledger or another contract.',
    );
    return;
  }

  console.log(`\nRetrieved ${events.length} event(s). Decoding topics and payloads...\n`);

  events.forEach((event, index) => {
    console.log(
      formatEventDecodingReport({
        contractId,
        ledger: event.ledger ?? 0,
        txHash: event.txHash ?? '',
        topics: event.topic ?? [],
        value: event.value,
      }),
    );

    const topicComparisons = (event.topic ?? []).map(compareScVal);
    const payloadComparison = compareScVal(event.value);

    console.log('\nSide-by-side summary:');
    topicComparisons.forEach((row, topicIndex) => {
      console.log(
        `  topic[${topicIndex}] ${row.xdrType.padEnd(12)} raw=${row.rawXdr.slice(0, 24)}… decoded=${row.decodedDisplay}`,
      );
    });
    console.log(
      `  payload     ${payloadComparison.xdrType.padEnd(12)} raw=${payloadComparison.rawXdr.slice(0, 24)}… decoded=${payloadComparison.decodedDisplay}`,
    );

    const decodedTopics = decodeTopics(event.topic);
    const decodedPayload = decodePayload(event.value);
    const unsupported = [...decodedTopics, decodedPayload].filter((item) => !item.decoded);
    if (unsupported.length > 0) {
      console.log('\nUnsupported or undecodable values:');
      unsupported.forEach((item) => {
        console.log(`  - ${item.xdrType}: ${item.error ?? 'decode failed'}`);
      });
    }

    if (index < events.length - 1) {
      console.log('\n' + '-'.repeat(72));
    }
  });

  console.log('\nDecoding reference:');
  console.log('  Address  -> G… or C… strkey');
  console.log('  Symbol   -> short identifier string');
  console.log('  String   -> UTF-8 text');
  console.log('  Bool     -> true / false');
  console.log('  Integer  -> string (preserves i128/u256 precision)');
  console.log('  Bytes    -> 0x-prefixed hex');
  console.log('  Vec/Map  -> JSON array or object');
  console.log('\nContract event decoding example completed.');
}
