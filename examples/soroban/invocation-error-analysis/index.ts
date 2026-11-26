/**
 * Soroban invocation error classification and recovery guidance.
 *
 * Analysis only: it reads an error or RPC response you already have. It never
 * retries, signs or submits anything, and its report is redacted.
 *
 *   npx ts-node index.ts
 */

import { classifyError, type Classification } from './error-classifier';
import { extractDiagnostics, type Diagnostics } from './diagnostics';
import { recoveryGuidance, type RecoveryGuidance } from './recovery-guidance';
import { buildErrorReport, formatReport, type ErrorReport } from './report';
import type { InvocationFailure } from './types';

export * from './types';
export * from './diagnostics';
export * from './error-classifier';
export * from './recovery-guidance';
export * from './report';

export interface Analysis {
  report: ErrorReport;
  classification: Classification;
  diagnostics: Diagnostics;
  guidance: RecoveryGuidance;
  /** The untouched input, kept for debugging. Not part of the report and not redacted: do not log it. */
  original: { error?: unknown; response?: unknown };
}

/** Classify a failed invocation step and produce recovery guidance. */
export function analyzeInvocationError(failure: InvocationFailure): Analysis {
  const diagnostics = extractDiagnostics({
    error: failure.error,
    response: failure.response,
    transactionHash: failure.transactionHash,
  });
  const classification = classifyError(failure, diagnostics);
  const guidance = recoveryGuidance(classification, diagnostics);
  const report = buildErrorReport({ context: failure.context, diagnostics, classification, guidance });
  return { report, classification, diagnostics, guidance, original: { error: failure.error, response: failure.response } };
}

function demo(): void {
  const samples: InvocationFailure[] = [
    {
      stage: 'simulation',
      error: new Error('HostError: Error(Contract, #3) Event log: contract failed with error 3'),
      context: { functionName: 'claim', contractAddress: 'CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA' },
    },
    { stage: 'submission', error: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }), transactionHash: 'a'.repeat(64) },
    { response: { status: 'PENDING', hash: 'b'.repeat(64), latestLedger: 1, latestLedgerCloseTime: 1 } },
  ];
  for (const s of samples) {
    console.log(formatReport(analyzeInvocationError(s).report));
    console.log('\n---\n');
  }
}

if (require.main === module) demo();
