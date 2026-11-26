/**
 * Recovery guidance, keyed off a classification. Kept separate from
 * classification so wording can change without touching detection logic.
 *
 * Nothing here retries or submits anything. The guidance tells a person (or
 * calling code) what to check next. The one hard rule: if the transaction may
 * have reached the network, status must be checked before any resubmission.
 */

import type { Classification } from './error-classifier';
import type { Diagnostics } from './diagnostics';
import type { Category } from './types';

export type RetrySafety =
  /** Resubmitting without checking could duplicate or conflict with an earlier submission. */
  | 'check-status-first'
  /** Change something first (input, fee, auth, configuration), then re-simulate. */
  | 'after-fix'
  /** Failure was transient and nothing reached the network; retry only with backoff. */
  | 'after-backoff'
  /** Retrying will not help without changing the contract call or contract state. */
  | 'not-recommended';

export interface RecoveryGuidance {
  recommendations: string[];
  retrySafety: RetrySafety;
  /** Extra caution shown prominently. */
  warnings: string[];
}

const BASE: Record<Category, { steps: string[]; retry: RetrySafety }> = {
  'invalid-input': {
    steps: [
      'Correct the argument, address or contract ID that was rejected; check types and ranges against the contract specification.',
      'Re-simulate the corrected call before building a transaction to submit.',
    ],
    retry: 'after-fix',
  },
  'contract-not-found': {
    steps: [
      'Verify the contract ID is correct and was deployed on the network you are using (testnet and mainnet are separate).',
      'Confirm the RPC endpoint and network passphrase match that network.',
      'If the contract was deployed recently, confirm the deployment transaction succeeded and the contract has not expired (its ledger entries may need a TTL extension or restore).',
    ],
    retry: 'after-fix',
  },
  authorization: {
    steps: [
      'Review which addresses the function calls require_auth for, and make sure each one signs (transaction signature and, where needed, authorization entries).',
      'Check that the signer matches the address the contract expects and that authorization entries have not expired (signature expiration ledger).',
      'Re-simulate after changing signers or authorization, since simulation records the required authorization.',
    ],
    retry: 'after-fix',
  },
  'contract-execution': {
    steps: [
      'The contract rejected or trapped the call. Look up the contract error code in the contract source or its error enum to see what it means.',
      'Check the contract state and your inputs against that rule (balances, allowances, ledger time, already-initialised flags).',
      'Re-simulate after the condition is fixed. Retrying the identical call will fail the same way.',
    ],
    retry: 'not-recommended',
  },
  'resource-limit': {
    steps: [
      'The call needed more CPU, memory or ledger I/O than allowed. Re-simulate and use the fresh resource estimate when assembling the transaction.',
      'Reduce the work in one call (smaller batches, fewer entries) if the estimate still exceeds network limits.',
      'Check resource and fee settings; a custom resource override can be too low.',
    ],
    retry: 'after-fix',
  },
  'fee-or-configuration': {
    steps: [
      'Check the fee, sequence number, time bounds and source account balance in the transaction configuration.',
      'Re-simulate and rebuild the transaction so fee, resources and sequence number are current, then sign again.',
      'If a ledger entry is archived, restore it before invoking the contract.',
    ],
    retry: 'after-fix',
  },
  'network-connectivity': {
    steps: [
      'Check the RPC URL, your connection and the provider status page.',
      'Retry reads with exponential backoff and a limit on attempts.',
      'If failures persist, contact the RPC provider or switch to another endpoint.',
    ],
    retry: 'after-backoff',
  },
  'transaction-rejected': {
    steps: [
      'The network did not accept the transaction. Inspect the result code and diagnostics for the reason.',
      'Rebuild and re-simulate before sending a new transaction; do not resend the same signed envelope unchanged unless the reason was transient load.',
    ],
    retry: 'after-fix',
  },
  'transaction-pending': {
    steps: [
      'The outcome is not final. Poll getTransaction with the transaction hash until it reports SUCCESS or FAILED.',
      'Do not treat this as a failure and do not resubmit while the transaction could still be applied.',
      'If it stays NOT_FOUND past the time bounds, treat it as expired only after confirming the hash was never included.',
    ],
    retry: 'check-status-first',
  },
  unknown: {
    steps: [
      'The error did not match a known pattern. Inspect the original message, stage and any diagnostic details in the report.',
      'Re-simulate to see whether the problem is reproducible, and check the SDK and RPC versions you are using.',
    ],
    retry: 'not-recommended',
  },
};

export function recoveryGuidance(c: Classification, d: Diagnostics): RecoveryGuidance {
  const base = BASE[c.category];
  const recommendations = [...base.steps];
  const warnings: string[] = [];
  let retrySafety = base.retry;

  if (c.confidence === 'low' || c.confidence === 'none') {
    warnings.push('Low-confidence classification: treat these steps as suggestions and confirm against the original error.');
  }

  if (c.category === 'contract-execution' && d.contractErrorCode !== undefined) {
    recommendations.unshift(`Contract error #${d.contractErrorCode}: find it in the contract's error definitions.`);
  }

  // The submission outcome may be unknown: that overrides any other retry advice.
  if (c.submissionStatus === 'unknown' || c.submissionStatus === 'pending') {
    retrySafety = 'check-status-first';
    warnings.push(
      d.transactionHash
        ? `The transaction may have been applied. Check status for ${d.transactionHash} (getTransaction) before submitting anything again.`
        : 'The transaction may have been applied but no hash was captured. Compute the hash from your signed envelope and check its status before resubmitting; if you cannot, check the account sequence number and recent transactions.',
    );
    if (c.category === 'network-connectivity') {
      // Backoff-and-retry advice is for reads; for an in-flight submission it could double-submit.
      const idx = recommendations.findIndex((r) => r.startsWith('Retry reads'));
      if (idx >= 0) recommendations[idx] = 'Once the transaction status is resolved, retry reads with exponential backoff. Do not retry the submission itself yet.';
      recommendations.unshift('The connection failed while the transaction may have been in flight: this is an unresolved submission, not a confirmed failure.');
    }
  }

  if (c.submissionStatus === 'included' && c.category !== 'transaction-pending') {
    warnings.push('The transaction was included in a ledger and failed there. A resubmission is a new transaction (new sequence number) and fees were likely charged.');
  }

  return { recommendations, retrySafety, warnings };
}
