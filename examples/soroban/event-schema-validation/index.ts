/**
 * index.ts — Soroban Contract Event Schema Validation
 *
 * Demonstrates how to retrieve Soroban contract events, decode their topics
 * and data payloads, validate the decoded structures against typed schemas,
 * and produce a human-readable report with actionable diagnostic output.
 *
 * Run against Testnet:
 *   npx ts-node examples/soroban/event-schema-validation/index.ts \
 *     --contract CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
 *     --limit 20
 *
 * Environment variables:
 *   SOROBAN_RPC_URL  — Override the default Testnet RPC endpoint.
 *   CONTRACT_ID      — Fallback contract address when --contract is omitted.
 */

import { rpc as stellarRpc } from '@stellar/stellar-sdk';
import { parseEventRecord } from './decoder';
import {
  EventFilter,
  normalizeContractId,
  normalizeEventType,
  normalizeLimit,
  parseLedgerInput,
  queryContractEvents,
  resolveLedgerRange,
} from './event-query';
import { DEFAULT_SCHEMA_REGISTRY, SchemaRegistry } from './schema';
import { validateEvents, ValidatedEvent } from './validator';

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

// ─── report formatting ────────────────────────────────────────────────────────

function pad(label: string, width = 14): string {
  return label.padEnd(width);
}

function formatValidationResult(validated: ValidatedEvent): string {
  const { event, validation } = validated;
  const lines: string[] = [];

  lines.push(`  ${pad('Event ID:')}    ${event.id}`);
  lines.push(`  ${pad('Ledger:')}      ${event.ledger}  (${event.ledgerClosedAt})`);
  lines.push(`  ${pad('Contract:')}    ${event.contractId || '(none)'}`);
  lines.push(`  ${pad('Tx Hash:')}     ${event.txHash || '(none)'}`);
  lines.push(`  ${pad('Type:')}        ${event.type}`);
  lines.push(`  ${pad('Event Name:')}  ${event.eventName ?? '(unnamed)'}`);
  lines.push(`  ${pad('Call OK:')}     ${event.inSuccessfulContractCall}`);
  lines.push('');

  lines.push('  Topics:');
  if (event.topics.length === 0) {
    lines.push('    (no topics)');
  } else {
    for (let i = 0; i < event.topics.length; i++) {
      const t = event.topics[i];
      const display = t.decoded ? JSON.stringify(t.value) : `[undecodable: ${t.xdrType}]`;
      lines.push(`    [${i}] ${t.xdrType.padEnd(16)} ${display}`);
    }
  }
  lines.push('');

  const v = event.value;
  lines.push('  Payload:');
  if (v.xdrType === 'void') {
    lines.push('    (void)');
  } else if (v.decoded) {
    lines.push(`    Type:  ${v.xdrType}`);
    lines.push(`    Value: ${JSON.stringify(v.value)}`);
  } else {
    lines.push(`    Type:  ${v.xdrType}  [undecodable]`);
    lines.push(`    Error: ${v.error}`);
    lines.push(`    Raw:   ${v.rawXdr}`);
  }
  lines.push('');

  const statusIcon = validation.valid ? '✓' : '✗';
  const schemaLabel = validation.schemaId ? ` (schema: ${validation.schemaId})` : ' (no schema)';
  lines.push(`  Validation: ${statusIcon}${schemaLabel}`);

  if (validation.findings.length) {
    for (const f of validation.findings) {
      const icon = f.severity === 'error' ? '  ✗' : f.severity === 'warning' ? '  ⚠' : '  ·';
      lines.push(`${icon} [${f.severity.padEnd(7)}] ${f.field}: ${f.message}`);
    }
  } else {
    lines.push('  · No validation findings.');
  }

  return lines.join('\n');
}

function formatReport(
  contractId: string,
  network: string,
  rpcUrl: string,
  eventType: string,
  startLedger: number,
  endLedger: number | undefined,
  latestLedger: number,
  validated: ValidatedEvent[],
): string {
  const lines: string[] = [];

  lines.push('═'.repeat(72));
  lines.push(' Soroban Contract Event Schema Validation');
  lines.push('═'.repeat(72));
  lines.push(`Network:       ${network}`);
  lines.push(`RPC:           ${rpcUrl}`);
  lines.push(`Contract:      ${contractId}`);
  lines.push(`Event type:    ${eventType}`);
  lines.push(`Ledger range:  ${startLedger} → ${endLedger ?? 'latest'}`);
  lines.push(`Latest ledger: ${latestLedger}`);
  lines.push('─'.repeat(72));

  if (validated.length === 0) {
    lines.push('No events found in the requested range.');
    lines.push('');
    lines.push('This is a valid, empty result. Possible reasons:');
    lines.push('  • The contract has not emitted events in this ledger range.');
    lines.push('  • The range predates the RPC retention window.');
    lines.push('  • The contract address is correct but inactive on this network.');
  } else {
    const valid = validated.filter((v) => v.validation.valid).length;
    const invalid = validated.length - valid;
    lines.push(`Events found:  ${validated.length}  (${valid} valid, ${invalid} failed validation)`);
    lines.push('─'.repeat(72));

    for (let i = 0; i < validated.length; i++) {
      lines.push(`\nEvent ${i + 1} of ${validated.length}`);
      lines.push(formatValidationResult(validated[i]));
      lines.push('─'.repeat(72));
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ─── main entry point ─────────────────────────────────────────────────────────

export interface RunParams {
  contractId?: string;
  startLedger?: number | string;
  endLedger?: number | string;
  limit?: number | string;
  eventType?: string;
  rpcUrl?: string;
  registry?: SchemaRegistry;
}

export async function run(params: RunParams = {}): Promise<void> {
  const rpcUrl =
    params.rpcUrl ??
    process.env['SOROBAN_RPC_URL'] ??
    DEFAULT_RPC_URL;

  const contractInput =
    params.contractId?.trim() ??
    process.env['CONTRACT_ID']?.trim() ??
    // Allow positional CLI usage: ts-node index.ts <contractId>
    process.argv[2]?.trim() ??
    'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  const contractId = normalizeContractId(contractInput);
  const limit = normalizeLimit(params.limit);
  const eventType = normalizeEventType(params.eventType);
  const registry = params.registry ?? DEFAULT_SCHEMA_REGISTRY;

  const server = new stellarRpc.Server(rpcUrl, { allowHttp: false });

  // Fetch the latest ledger first so we can resolve a sensible range.
  const { sequence: latestLedger } = await server.getLatestLedger();

  const range = resolveLedgerRange(latestLedger, {
    startLedger: parseLedgerInput(params.startLedger),
    endLedger: parseLedgerInput(params.endLedger),
  });

  const networkInfo = await server.getNetwork();
  const network = networkInfo.passphrase ?? rpcUrl;

  const filters: EventFilter[] = [
    { type: eventType, contractIds: [contractId] },
  ];

  const result = await queryContractEvents(server, {
    latestLedger,
    range,
    filters,
    limit,
  });

  const rawEvents = result.response.events ?? [];
  const parsed = rawEvents.map(parseEventRecord);
  const validated = validateEvents(parsed, registry);

  const report = formatReport(
    contractId,
    network,
    rpcUrl,
    eventType,
    result.range.startLedger,
    result.range.endLedger,
    result.response.latestLedger,
    validated,
  );

  console.log(report);
}

// Allow direct execution: ts-node index.ts [contractId]
if (require.main === module) {
  run().catch((err: unknown) => {
    console.error('Fatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
