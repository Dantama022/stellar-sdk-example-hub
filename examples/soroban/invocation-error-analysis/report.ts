/**
 * Structured error report. Everything in it has passed through redaction; the
 * un-redacted original lives only on the in-memory analysis result.
 */

import type { Diagnostics } from './diagnostics';
import { redactSensitive } from './diagnostics';
import type { Classification } from './error-classifier';
import type { RecoveryGuidance } from './recovery-guidance';
import type { Category, Confidence, InvocationContext, Stage, SubmissionStatus } from './types';

export interface ErrorReport {
  stage: Stage;
  stageSource: Classification['stageSource'];
  category: Category;
  errorCode?: string;
  originalMessage: string;
  contractAddress?: string;
  functionName?: string;
  transactionHash?: string;
  submissionStatus: SubmissionStatus;
  diagnostics: {
    errorName?: string;
    httpStatus?: number;
    rpcStatus?: string;
    latestLedger?: number;
    hostError?: Diagnostics['hostError'];
    contractErrorCode?: number;
    transactionResultCode?: string;
    operationResultCodes: string[];
    diagnosticEvents: Diagnostics['diagnosticEvents'];
    metadataAvailable: boolean;
  };
  classificationSignals: string[];
  confidence: Confidence;
  recommendations: string[];
  retrySafety: RecoveryGuidance['retrySafety'];
  warnings: string[];
  /** This analysis never retries or submits anything. */
  automaticRetry: false;
}

export function buildErrorReport(input: {
  context?: InvocationContext;
  diagnostics: Diagnostics;
  classification: Classification;
  guidance: RecoveryGuidance;
}): ErrorReport {
  const { diagnostics: d, classification: c, guidance: g, context } = input;
  const metadataAvailable = Boolean(d.hostError || d.transactionResultCode || d.rpcStatus || d.httpStatus || d.diagnosticEvents.length);
  const warnings = [...g.warnings];
  if (!metadataAvailable) warnings.push('No structured diagnostic metadata was available; this provider or error type may not return it.');
  if (c.stageSource === 'undetermined') warnings.push('The stage could not be determined. Pass `stage` when you capture the failure.');

  return {
    stage: c.stage,
    stageSource: c.stageSource,
    category: c.category,
    errorCode: c.code,
    originalMessage: d.message,
    contractAddress: context?.contractAddress,
    functionName: context?.functionName,
    transactionHash: d.transactionHash,
    submissionStatus: c.submissionStatus,
    diagnostics: {
      errorName: d.errorName,
      httpStatus: d.httpStatus,
      rpcStatus: d.rpcStatus,
      latestLedger: d.latestLedger,
      hostError: d.hostError,
      contractErrorCode: d.contractErrorCode,
      transactionResultCode: d.transactionResultCode,
      operationResultCodes: d.operationResultCodes,
      diagnosticEvents: redactSensitive(d.diagnosticEvents) as Diagnostics['diagnosticEvents'],
      metadataAvailable,
    },
    classificationSignals: c.signals,
    confidence: c.confidence,
    recommendations: g.recommendations,
    retrySafety: g.retrySafety,
    warnings,
    automaticRetry: false,
  };
}

export function formatReport(r: ErrorReport): string {
  const lines = [
    `Stage:       ${r.stage}${r.stageSource === 'undetermined' ? ' (undetermined)' : r.stageSource === 'inferred' ? ' (inferred)' : ''}`,
    `Category:    ${r.category}${r.errorCode ? ` [${r.errorCode}]` : ''}  (confidence: ${r.confidence})`,
    `Submission:  ${r.submissionStatus}`,
    `Retry:       ${r.retrySafety}`,
  ];
  if (r.contractAddress) lines.push(`Contract:    ${r.contractAddress}`);
  if (r.functionName) lines.push(`Function:    ${r.functionName}`);
  if (r.transactionHash) lines.push(`Tx hash:     ${r.transactionHash}`);
  lines.push(`Message:     ${r.originalMessage || '(none)'}`);
  lines.push('', 'Recommendations:');
  r.recommendations.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n');
}
