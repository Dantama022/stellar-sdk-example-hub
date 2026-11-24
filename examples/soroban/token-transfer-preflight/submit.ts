/**
 * Step 6: submit and confirm.
 *
 * Submission is refused unless the preflight report is clean. After `sendTransaction` the
 * transaction is only QUEUED: success or failure is learned by polling `getTransaction`.
 *
 * There is deliberately no automatic resubmission. A transaction that was accepted may still land
 * in a ledger later, and re-sending a different transaction with the same sequence number risks a
 * duplicate transfer or a `txBadSeq` failure. Resubmitting the exact same signed transaction is
 * idempotent (same hash), but check its status first.
 */
import { Transaction, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { TransferRpcClient } from './rpc';
import { PreflightReport, SubmissionResult, TransferError } from './types';

export interface SubmitOptions {
  /** Maximum number of getTransaction calls before reporting "pending". Default 10. */
  attempts?: number;
  /** Delay between polls. Default 2000 ms. */
  intervalMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function describeEvents(events: xdr.DiagnosticEvent[] | undefined): string[] {
  return (events ?? []).slice(0, 5).map((e) => {
    try {
      const body = e.event().body().v0();
      const topics = body.topics().map((t) => String(scValToNative(t)));
      return topics.join(' / ');
    } catch {
      return 'undecodable event';
    }
  });
}

const resultCode = (r: xdr.TransactionResult | undefined): string | undefined =>
  r?.result().switch().name;

export async function submitTransaction(
  client: TransferRpcClient,
  tx: Transaction,
  report: PreflightReport,
  opts: SubmitOptions = {}
): Promise<SubmissionResult> {
  // Hard gate: this is the only path to sendTransaction in the example.
  if (!report.ok) {
    const failed = report.checks.filter((c) => !c.passed).map((c) => c.id);
    throw new TransferError('PREFLIGHT_FAILED', `Refusing to submit: failed checks: ${failed.join(', ')}.`);
  }

  const hash = tx.hash().toString('hex'); // known locally, before the network ever sees it
  const attempts = opts.attempts ?? 10;
  const intervalMs = opts.intervalMs ?? 2000;
  const sleep = opts.sleep ?? defaultSleep;

  let sent: rpc.Api.SendTransactionResponse;
  try {
    sent = await client.sendTransaction(tx);
  } catch (e) {
    return {
      outcome: 'unknown',
      hash,
      message: `The submit request failed (${(e as Error).message}). The network may or may not have received the transaction: check getTransaction for this hash before sending anything again.`,
    };
  }

  if (sent.status === 'ERROR') {
    return {
      outcome: 'rejected',
      hash,
      message: 'The network rejected the transaction at submission.',
      resultCode: resultCode(sent.errorResult),
      diagnostics: describeEvents(sent.diagnosticEvents),
    };
  }
  if (sent.status === 'TRY_AGAIN_LATER') {
    return {
      outcome: 'not_accepted',
      hash,
      message: 'The network is busy and did not accept the transaction. Nothing was queued. Retry deliberately, not in a tight loop.',
    };
  }
  // PENDING, or DUPLICATE (already known to the network): either way, follow it by hash.

  let lastError: string | undefined;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(intervalMs);
    let status: rpc.Api.GetTransactionResponse;
    try {
      status = await client.getTransaction(hash);
    } catch (e) {
      lastError = (e as Error).message; // transient: the transaction is still in flight
      continue;
    }
    if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        outcome: 'success',
        hash,
        message: 'Transaction executed successfully.',
        ledger: status.ledger,
        resultCode: resultCode(status.resultXdr),
      };
    }
    if (status.status === rpc.Api.GetTransactionStatus.FAILED) {
      return {
        outcome: 'failed',
        hash,
        message: 'The transaction was included in a ledger but its execution failed. Fees were charged and no tokens moved.',
        ledger: status.ledger,
        resultCode: resultCode(status.resultXdr),
        diagnostics: describeEvents(status.diagnosticEventsXdr),
      };
    }
    // NOT_FOUND: not in a ledger yet. Keep polling.
  }

  return {
    outcome: 'pending',
    hash,
    message: `Not confirmed after ${attempts} checks${lastError ? ` (last RPC error: ${lastError})` : ''}. The transaction may still be applied or may expire (its time bounds are 5 minutes): check this hash again before doing anything else.`,
  };
}
