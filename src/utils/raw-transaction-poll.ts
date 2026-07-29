/**
 * Version-tolerant transaction polling.
 *
 * `rpc.Server.pollTransaction()` is the idiomatic way to wait for a Soroban
 * transaction, but it eagerly parses the response's `resultMetaXdr`. Protocol 23
 * introduced `TransactionMetaV4`, and an SDK built before that version cannot
 * decode it — the call throws `Bad union switch: 4` before returning anything,
 * even though the transaction itself succeeded.
 *
 * These helpers talk to the RPC's JSON-RPC endpoint directly and hand back the
 * status, ledger, and *unparsed* metadata, letting each caller decide whether it
 * needs to decode the metadata at all. Examples that only care whether a
 * transaction landed work on any protocol version this way; examples that want
 * the metadata can attempt to decode it and fall back when it is too new.
 */

/** Status/ledger/metadata for a transaction, with the metadata left as XDR. */
export interface RawTransactionResult {
  /** `SUCCESS`, `FAILED`, or `NOT_FOUND`. */
  status: string;
  /** Ledger the transaction was included in, once it is no longer NOT_FOUND. */
  ledger?: number;
  /** Base64 `TransactionMeta`, of whatever version the network produced. */
  resultMetaXdr?: string;
  /** Base64 `TransactionResult`. */
  resultXdr?: string;
}

export interface PollOptions {
  /** Maximum number of `getTransaction` calls before giving up. Default 25. */
  attempts?: number;
  /** Delay between attempts, in milliseconds. Default 2000. */
  intervalMs?: number;
}

/** Issues a single `getTransaction` JSON-RPC call. */
export async function getRawTransaction(
  rpcUrl: string,
  hash: string,
): Promise<RawTransactionResult> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: { hash },
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    error?: { message?: string };
    result?: RawTransactionResult;
  };

  if (payload.error) {
    throw new Error(payload.error.message ?? 'RPC returned an error');
  }
  if (!payload.result) {
    throw new Error('RPC returned no result');
  }
  return payload.result;
}

/**
 * Polls `getTransaction` until the transaction leaves `NOT_FOUND` or the attempts
 * run out. Returns the last response seen — callers check `status` themselves,
 * exactly as they would with `pollTransaction`.
 */
export async function pollRawTransaction(
  rpcUrl: string,
  hash: string,
  options: PollOptions = {},
): Promise<RawTransactionResult> {
  const attempts = options.attempts ?? 25;
  const intervalMs = options.intervalMs ?? 2000;

  let last: RawTransactionResult = { status: 'NOT_FOUND' };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await getRawTransaction(rpcUrl, hash);
    if (last.status !== 'NOT_FOUND') return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return last;
}
