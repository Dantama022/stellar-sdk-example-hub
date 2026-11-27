/**
 * Step 3: simulate the transaction and turn the RPC response into something safe to act on.
 *
 * `simulateTransaction` executes the call against current ledger state WITHOUT submitting it.
 * It returns the authorization entries the call needs, the resource footprint and the minimum
 * resource fee. A successful simulation is a prediction, not a guarantee: ledger state can change
 * between simulation and inclusion (for example the balance can be spent by another transaction).
 */
import { Transaction, rpc, xdr } from '@stellar/stellar-sdk';
import { TransferRpcClient, rpcCall } from './rpc';
import { TransferError } from './types';

export interface SimulationSummary {
  /** The raw successful response, as needed by `assembleTransaction`. */
  response: rpc.Api.SimulateTransactionSuccessResponse;
  /** Authorization entries recorded by the simulation (unsigned). */
  authEntries: xdr.SorobanAuthorizationEntry[];
  /** Minimum resource fee in stroops, on top of the inclusion fee. */
  minResourceFee: bigint;
  resources: { instructions: number; readBytes: number; writeBytes: number };
  diagnosticEventCount: number;
}

const INSUFFICIENT_BALANCE = /insufficient|not sufficient|underflow/i;
const INSUFFICIENT_RESOURCES = /budget|resource limit|exceeded|exhausted|out of/i;

/** Map a simulation error string to one of this example's error codes. Heuristic by nature. */
export function classifySimulationError(error: string): TransferError {
  if (INSUFFICIENT_BALANCE.test(error)) {
    return new TransferError(
      'INSUFFICIENT_BALANCE',
      `Simulation indicates the sender's balance is too low: ${error}`
    );
  }
  if (INSUFFICIENT_RESOURCES.test(error)) {
    return new TransferError(
      'INSUFFICIENT_RESOURCES',
      `Simulation ran out of resources (CPU, memory or ledger limits): ${error}`
    );
  }
  return new TransferError('SIMULATION_FAILED', `Simulation failed: ${error}`);
}

/** Inspect a simulation response. Throws unless the simulation succeeded and is usable. */
export function summarizeSimulation(sim: rpc.Api.SimulateTransactionResponse): SimulationSummary {
  if (rpc.Api.isSimulationError(sim)) {
    throw classifySimulationError(sim.error);
  }
  if (rpc.Api.isSimulationRestore(sim)) {
    // Archived ledger entries must be restored with a separate RestoreFootprint transaction first.
    throw new TransferError(
      'RESTORE_REQUIRED',
      'Simulation needs archived ledger entries restored first; this example does not restore state.'
    );
  }
  const success = sim as rpc.Api.SimulateTransactionSuccessResponse;
  if (!success.result) {
    throw new TransferError('SIMULATION_FAILED', 'Simulation returned no invocation result.');
  }
  const resources = success.transactionData.build().resources();
  return {
    response: success,
    authEntries: success.result.auth ?? [],
    minResourceFee: BigInt(success.minResourceFee),
    resources: {
      instructions: resources.instructions(),
      readBytes: resources.readBytes(),
      writeBytes: resources.writeBytes(),
    },
    diagnosticEventCount: success.events?.length ?? 0,
  };
}

export async function simulateTransfer(
  client: TransferRpcClient,
  tx: Transaction
): Promise<SimulationSummary> {
  const sim = await rpcCall(() => client.simulateTransaction(tx));
  return summarizeSimulation(sim);
}

/**
 * Apply simulation results (Soroban footprint, resource fee) to a transaction.
 *
 * `assembleTransaction` keeps any authorization already attached to the operation and ignores the
 * simulation's entries in that case, which is why signed entries are attached BEFORE assembling.
 * The result is unsigned and has the final fee: inclusion fee + minResourceFee.
 */
export function assembleSimulatedTransaction(tx: Transaction, summary: SimulationSummary): Transaction {
  return rpc.assembleTransaction(tx, summary.response).build() as Transaction;
}
