/**
 * Step 3: simulate and extract what the response actually contains.
 *
 * `simulateTransaction` runs the call against current ledger state without submitting it. Every
 * outcome is mapped to a SimulationOutcome; only status 'success' carries resources. Anything else
 * (error, restore needed, odd shape, missing fields) is reported as such and never as an estimate.
 */
import { Transaction, rpc } from '@stellar/stellar-sdk';
import { CostRpcClient, rpcCall } from './rpc';
import { DiagnosticsSummary, FailureKind, SimulatedResources, SimulationOutcome } from './types';

// Heuristics over free-text host error strings. They are best-effort: the RPC does not return a
// machine-readable failure category, so unmatched errors fall into 'other' with the raw message.
const MISSING_FUNCTION = /non-existent contract function|MissingValue|function .*not found/i;
const INVALID_ARGS = /UnexpectedType|InvalidInput|ConversionError|UnexpectedSize|wrong number of (args|arguments)|Error\(Value,/i;
const OUT_OF_RESOURCES = /ExceededLimit|exceeded|budget|resource limit/i;

export function classifyFailure(message: string): FailureKind {
  // Order matters: a missing function also surfaces as a WasmVm error, so check it first.
  if (MISSING_FUNCTION.test(message)) return 'missing_function';
  if (OUT_OF_RESOURCES.test(message)) return 'out_of_resources';
  if (INVALID_ARGS.test(message)) return 'invalid_arguments';
  return 'other';
}

function summarizeDiagnostics(sim: rpc.Api.SimulateTransactionSuccessResponse): DiagnosticsSummary {
  const events = Array.isArray(sim.events) ? sim.events : [];
  const eventTypes: Record<string, number> = {};
  let failedCallEvents = 0;
  for (const e of events) {
    const name = e.event().type().name; // "system" | "contract" | "diagnostic"
    eventTypes[name] = (eventTypes[name] ?? 0) + 1;
    if (!e.inSuccessfulContractCall()) failedCallEvents++;
  }
  return {
    eventCount: events.length,
    eventTypes,
    failedCallEvents,
    ...(Array.isArray(sim.stateChanges) ? { stateChangeCount: sim.stateChanges.length } : {}),
  };
}

/**
 * Read resources from the simulated SorobanTransactionData. Returns undefined if the response
 * does not carry them in a usable form: the caller must not invent numbers in that case.
 */
export function extractResources(sim: rpc.Api.SimulateTransactionSuccessResponse): SimulatedResources | undefined {
  try {
    const data = sim.transactionData.build();
    const res = data.resources();
    const footprint = res.footprint();
    const readOnly = footprint.readOnly().length;
    const readWrite = footprint.readWrite().length;
    return {
      instructions: BigInt(res.instructions()),
      readBytes: BigInt(res.readBytes()),
      writeBytes: BigInt(res.writeBytes()),
      readOnlyEntries: readOnly,
      readWriteEntries: readWrite,
      readEntries: readOnly + readWrite,
      writeEntries: readWrite,
      dataResourceFee: BigInt(data.resourceFee().toString()),
    };
  } catch {
    return undefined;
  }
}

function parseMinResourceFee(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  return BigInt(value);
}

/** Pure: turn any RPC simulation response (or garbage) into a SimulationOutcome. */
export function interpretSimulation(sim: unknown): SimulationOutcome {
  if (sim === null || typeof sim !== 'object') {
    return { status: 'unexpected_response', detail: `Simulation returned ${sim === null ? 'null' : typeof sim}, expected an object.` };
  }
  const response = sim as rpc.Api.SimulateTransactionResponse;
  const latestLedger = typeof response.latestLedger === 'number' ? response.latestLedger : undefined;

  if (rpc.Api.isSimulationError(response)) {
    const message = typeof response.error === 'string' ? response.error : JSON.stringify(response.error);
    return { status: 'failed', latestLedger, failure: { kind: classifyFailure(message), message } };
  }

  if (!rpc.Api.isSimulationSuccess(response)) {
    return { status: 'unexpected_response', latestLedger, detail: 'Response is neither a simulation error nor a success (no `error` or `transactionData`).' };
  }

  if (rpc.Api.isSimulationRestore(response)) {
    // Archived entries must be restored by a separate RestoreFootprint transaction first, so this
    // simulation does not describe a transaction that could succeed as-is.
    return {
      status: 'restore_required',
      latestLedger,
      detail: 'Simulation reports archived ledger entries that must be restored first. Costs for the restore transaction are not analysed here.',
    };
  }

  const resources = extractResources(response);
  const minResourceFee = parseMinResourceFee(response.minResourceFee);
  if (!resources || minResourceFee === undefined) {
    return {
      status: 'missing_resource_info',
      latestLedger,
      detail: `Response lacks usable ${[!resources && 'transactionData resources', minResourceFee === undefined && 'minResourceFee'].filter(Boolean).join(' and ')}.`,
    };
  }

  return {
    status: 'success',
    latestLedger,
    resources,
    minResourceFee,
    diagnostics: summarizeDiagnostics(response),
    raw: response,
  };
}

/** Simulate over RPC. Transport failures throw RPC_UNAVAILABLE; everything else is an outcome. */
export async function simulateInvocation(client: CostRpcClient, tx: Transaction): Promise<SimulationOutcome> {
  const sim = await rpcCall('simulateTransaction', () => client.simulateTransaction(tx));
  return interpretSimulation(sim);
}
