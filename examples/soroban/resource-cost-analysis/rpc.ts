/**
 * The slice of Soroban RPC this example uses. Deliberately has NO sendTransaction: the example
 * cannot submit anything, and tests can mock it in a few lines.
 */
import { Transaction, rpc, xdr } from '@stellar/stellar-sdk';
import { CostAnalysisError } from './types';

export interface CostRpcClient {
  getNetwork(): Promise<{ passphrase: string }>;
  /** Current sequence number of the source account, as a string. */
  getSequence(accountId: string): Promise<string>;
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  getLedgerEntries(keys: xdr.LedgerKey[]): Promise<rpc.Api.GetLedgerEntriesResponse>;
  getFeeStats(): Promise<rpc.Api.GetFeeStatsResponse>;
}

export function createRpcClient(rpcUrl: string): CostRpcClient {
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  return {
    getNetwork: () => server.getNetwork(),
    getSequence: async (id) => (await server.getAccount(id)).sequenceNumber(),
    simulateTransaction: (tx) => server.simulateTransaction(tx),
    getLedgerEntries: (keys) => server.getLedgerEntries(...keys),
    getFeeStats: () => server.getFeeStats(),
  };
}

/** Wrap transport failures so callers can tell them from simulation failures. */
export async function rpcCall<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new CostAnalysisError('RPC_UNAVAILABLE', `RPC request failed (${what}): ${(e as Error).message}`);
  }
}
