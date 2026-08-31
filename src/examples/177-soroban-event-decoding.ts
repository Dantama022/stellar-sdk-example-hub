import { rpc, StrKey } from '@stellar/stellar-sdk';

import { decodeScVal, DecodedScVal, renderDecodedValue } from '../utils/scval-decoder';

/**
 * Example 177: Soroban Contract Event Decoding and Filtering
 *
 * Retrieves, filters, decodes, and displays Soroban contract events. Supports
 * filtering by contract ID, topic, event type, and configurable ledger ranges.
 * Outputs both raw and decoded representations for topics and payloads.
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
const DEFAULT_LOOKBACK = 17280;
const DEFAULT_LIMIT = 10;

export interface EventDecodingParams {
  contractId?: string;
  startLedger?: number | string;
  endLedger?: number | string;
  limit?: number | string;
  eventType?: string;
  topicFilter?: string;
  rpcUrl?: string;
  json?: boolean;
}

export interface DecodedEvent {
  contractId: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  type: string;
  inSuccessfulContractCall: boolean;
  pagingToken: string;
  topics: DecodedScVal[];
  value: DecodedScVal;
}

function normalizeContractId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Missing contract ID.');
  if (!StrKey.isValidContract(trimmed)) {
    throw new Error(
      `Invalid contract ID "${trimmed}". Expected a 56-character strkey starting with "C".`,
    );
  }
  return trimmed;
}

function normalizeLimit(value?: number | string): number {
  const parsed = typeof value === 'string' ? parseInt(value.trim(), 10) : value;
  if (parsed === undefined || Number.isNaN(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), 200);
}

function parseLedgerInput(value?: number | string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'string' ? parseInt(value.trim(), 10) : value;
  if (Number.isNaN(parsed) || parsed < 1) return undefined;
  return Math.trunc(parsed);
}

function parseEventRecord(event: rpc.Api.EventResponse): DecodedEvent {
  const topics = (event.topic ?? []).map(decodeScVal);
  return {
    contractId: extractContractId(event.contractId),
    ledger: event.ledger ?? 0,
    ledgerClosedAt: event.ledgerClosedAt ?? '',
    txHash: event.txHash ?? '',
    type: event.type ?? 'contract',
    inSuccessfulContractCall: event.inSuccessfulContractCall !== false,
    pagingToken: event.pagingToken ?? '',
    topics,
    value: decodeScVal(event.value),
  };
}

function extractContractId(contractId: unknown): string {
  if (!contractId) return '';
  const candidate =
    typeof contractId === 'string' ? contractId : String((contractId as any)?.toString?.() ?? '');
  return StrKey.isValidContract(candidate) ? candidate : '';
}

function matchTopicFilter(topics: DecodedScVal[], filter: string): boolean {
  if (!filter) return true;
  const lowerFilter = filter.toLowerCase();
  return topics.some((t) => {
    if (!t.decoded) return false;
    const display = renderDecodedValue(t).toLowerCase();
    return display.includes(lowerFilter);
  });
}

function formatEvent(event: DecodedEvent, index: number): string {
  const lines: string[] = [];
  lines.push(`\n--- Event #${index + 1} ---`);
  lines.push(`Contract ID   : ${event.contractId || '(unavailable)'}`);
  lines.push(`Ledger        : ${event.ledger} (closed ${event.ledgerClosedAt})`);
  lines.push(`Tx Hash       : ${event.txHash}`);
  lines.push(`Type          : ${event.type}`);
  lines.push(`Successful    : ${event.inSuccessfulContractCall}`);

  lines.push(`Topics (${event.topics.length}):`);
  event.topics.forEach((topic, i) => {
    lines.push(`  [${i}] ${topic.xdrType.padEnd(16)} decoded : ${renderDecodedValue(topic)}`);
    lines.push(`      raw XDR : ${topic.rawXdr}`);
  });

  lines.push(`Payload:`);
  lines.push(`  ${event.value.xdrType} decoded : ${renderDecodedValue(event.value)}`);
  lines.push(`  raw XDR : ${event.value.rawXdr}`);

  return lines.join('\n');
}

function formatJsonOutput(events: DecodedEvent[]): string {
  const output = events.map((e) => ({
    contractId: e.contractId,
    ledger: e.ledger,
    ledgerClosedAt: e.ledgerClosedAt,
    txHash: e.txHash,
    type: e.type,
    inSuccessfulContractCall: e.inSuccessfulContractCall,
    topics: e.topics.map((t) => ({
      xdrType: t.xdrType,
      rawXdr: t.rawXdr,
      decoded: t.value,
      decodedOk: t.decoded,
    })),
    payload: {
      xdrType: e.value.xdrType,
      rawXdr: e.value.rawXdr,
      decoded: e.value.value,
      decodedOk: e.value.decoded,
    },
  }));
  return JSON.stringify(output, null, 2);
}

export async function run(params: EventDecodingParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl || process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URL;
  const contractInput =
    params.contractId?.trim() || process.env.CONTRACT_ID?.trim() || process.argv[3]?.trim();
  const limit = normalizeLimit(params.limit ?? process.env.EVENT_LIMIT ?? process.argv[5]);
  const startInput = parseLedgerInput(
    params.startLedger ?? process.env.START_LEDGER ?? process.argv[4],
  );
  const endInput = parseLedgerInput(params.endLedger ?? process.env.END_LEDGER ?? process.argv[6]);
  const eventType = normalizeEventType(params.eventType ?? process.env.EVENT_TYPE);
  const topicFilter = params.topicFilter?.trim() || process.env.TOPIC_FILTER?.trim() || '';
  const jsonOutput = params.json === true || process.env.JSON_OUTPUT === 'true';

  console.log('Soroban Contract Event Decoding and Filtering');
  console.log(`Soroban RPC: ${rpcUrl}`);

  let contractId: string | null = null;
  if (contractInput) {
    try {
      contractId = normalizeContractId(contractInput);
    } catch (err: any) {
      console.log(`\n${err?.message ?? err}`);
      return;
    }
    console.log(`Contract: ${contractId}`);
  } else {
    console.log('No contract ID specified — will discover a recently active contract.');
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
  const rangeLabel = endInput ? `${startLedger} -> ${endInput}` : `${startLedger} -> latest`;
  console.log(`Ledger range: ${rangeLabel} (limit ${limit})`);
  console.log(`Event type filter: ${eventType}`);
  if (topicFilter) console.log(`Topic filter: "${topicFilter}"`);

  // Discover contract if not provided
  if (!contractId) {
    console.log('\nDiscovering a recently active contract...');
    try {
      const discoveryResponse = await server.getEvents({
        startLedger,
        filters: [{ type: 'contract' }],
        limit: 100,
      });
      const discovered = pickMostActiveContract(discoveryResponse.events ?? []);
      if (!discovered) {
        console.log('No contract events found in the queried range.');
        console.log(
          'Supply a contract ID explicitly: npm run run-example -- 177-soroban-event-decoding <contract-id>',
        );
        return;
      }
      contractId = discovered;
      console.log(`Discovered active contract: ${contractId}`);
    } catch (err: any) {
      console.log(`Discovery failed: ${err?.message ?? err}`);
      return;
    }
  }

  // Query events
  console.log('\nQuerying events...');
  let allEvents: DecodedEvent[] = [];
  let cursor: string | undefined;

  try {
    const filters: rpc.Api.EventFilter[] = [{ type: eventType, contractIds: [contractId] }];
    const response = await server.getEvents({
      startLedger,
      ...(endInput ? { endLedger: endInput } : {}),
      filters,
      limit,
    });

    allEvents = (response.events ?? []).map(parseEventRecord);
    cursor = response.cursor;
  } catch (err: any) {
    const message = String(err?.message ?? err ?? '').toLowerCase();
    if (message.includes('ledger range') || message.includes('oldest ledger')) {
      console.log("\nThe requested ledger range is outside this server's retention window.");
      console.log('Retry with a more recent startLedger, or use an RPC with longer retention.');
      return;
    }
    console.log(`Could not retrieve events: ${err?.message ?? err}`);
    return;
  }

  // Apply topic filter
  let filteredEvents = allEvents;
  if (topicFilter) {
    filteredEvents = allEvents.filter((e) => matchTopicFilter(e.topics, topicFilter));
    if (filteredEvents.length < allEvents.length) {
      console.log(`Topic filter: ${filteredEvents.length} of ${allEvents.length} events match.`);
    }
  }

  // Handle empty results
  if (filteredEvents.length === 0) {
    console.log('\nNo events found matching the specified filters.');
    console.log(
      'This is a valid empty result — try widening the ledger range or removing filters.',
    );
    if (cursor) console.log(`Pagination cursor available: ${cursor}`);
    return;
  }

  // Output
  if (jsonOutput) {
    console.log('\n' + formatJsonOutput(filteredEvents));
  } else {
    console.log(`\nRetrieved ${filteredEvents.length} event(s):\n`);
    filteredEvents.forEach((event, index) => {
      console.log(formatEvent(event, index));
    });

    console.log('\n--- Summary ---');
    console.log(`Total events: ${filteredEvents.length}`);
    console.log(`Event type: ${eventType}`);
    const byType: Record<string, number> = {};
    filteredEvents.forEach((e) => {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
    });
    Object.entries(byType).forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });

    if (cursor) {
      console.log(`\nPagination cursor: ${cursor}`);
      console.log('Use cursor to fetch additional pages.');
    }
  }

  console.log('\nSoroban event decoding example completed.');
}

function normalizeEventType(value?: string): rpc.Api.EventType {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'system' || normalized === 'diagnostic') return normalized;
  return 'contract';
}

function pickMostActiveContract(events: rpc.Api.EventResponse[]): string | null {
  const counts = new Map<string, number>();
  for (const event of events) {
    const id = extractContractId(event.contractId);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, count] of counts.entries()) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}
