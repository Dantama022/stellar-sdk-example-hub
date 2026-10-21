/**
 * Report generation for the merge readiness auditor (ISSUE-378).
 *
 * The console report and the JSON report contain the same information; the
 * JSON output is the machine readable form of the very same audit.
 */

import type {
  AccountSnapshot,
  BlockerFinding,
  MergeAuditReport,
  MergeReadiness,
  MissingInformation,
  ReserveAnalysis,
} from './types';

/** The limitations that apply to every audit. */
export const AUDIT_LIMITATIONS = [
  'The audit is a static inspection of the ledger state at the time of the audit. It is ' +
    'not a guarantee that a merge transaction will succeed.',
  'The transaction fee, the current ledger state and any sponsorship change can change ' +
    'the outcome between the audit and the submission of the transaction.',
  'The audit never signs and never submits a transaction; no secret key is required.',
  'The destination account is not audited. It has to be able to hold the merged balance ' +
    'and the subentries of the source account.',
];

/** Builds the complete audit report. */
export function buildAuditReport(params: {
  accountId: string;
  network: string;
  endpoint: string;
  auditedAt: string;
  account: AccountSnapshot;
  findings: BlockerFinding[];
  reserve: ReserveAnalysis;
  readiness: MergeReadiness;
  readinessEvidence: string[];
  missingInformation: MissingInformation[];
}): MergeAuditReport {
  return {
    accountId: params.accountId,
    network: params.network,
    endpoint: params.endpoint,
    auditedAt: params.auditedAt,
    account: params.account,
    findings: params.findings,
    reserve: params.reserve,
    readiness: params.readiness,
    readinessEvidence: params.readinessEvidence,
    missingInformation: params.missingInformation,
    limitations: AUDIT_LIMITATIONS,
  };
}

/** Renders the audit report for the console. */
export function formatAuditReport(report: MergeAuditReport): string {
  const lines: string[] = [];

  lines.push('Stellar account merge readiness audit');
  lines.push('====================================');
  lines.push(`Account:  ${report.accountId}`);
  lines.push(`Network:  ${report.network}`);
  lines.push(`Endpoint: ${report.endpoint}`);
  lines.push(`Audited:  ${report.auditedAt}`);
  lines.push('');

  lines.push('Account state');
  lines.push('-------------');
  lines.push(`Native balance:   ${report.account.nativeBalance} XLM`);
  lines.push(`Sequence number:  ${report.account.sequence}`);
  lines.push(`Subentry count:   ${report.account.subentryCount}`);
  lines.push(`Trustlines:       ${report.account.trustlines.length}`);
  lines.push(`Offers:           ${report.account.offers.length}`);
  lines.push(`Signers:          ${report.account.signers.length}`);
  lines.push(`Data entries:     ${report.account.dataEntries.length}`);
  lines.push(`Claimable balances: ${report.account.claimableBalances.length}`);
  lines.push(
    `Sponsorship:      sponsoring=${report.account.numSponsoring} sponsored=${report.account.numSponsored}` +
      (report.account.sponsor ? ` sponsor=${report.account.sponsor}` : ''),
  );
  lines.push('');

  lines.push('Balance and reserve');
  lines.push('-------------------');
  lines.push(`Base reserve per entry: ${report.reserve.baseReserve} XLM`);
  lines.push(`Minimum balance:        ${report.reserve.minimumBalance} XLM`);
  lines.push(`Available balance:      ${report.reserve.availableBalance} XLM`);
  lines.push(`Released base reserve:  ${report.reserve.releasedBaseReserve} XLM`);
  lines.push(`Estimated fee:          ${report.reserve.estimatedFee} XLM`);
  lines.push(`Expected destination increase: ${report.reserve.projectedDestinationIncrease} XLM`);
  for (const assumption of report.reserve.assumptions) {
    lines.push(`  - ${assumption}`);
  }
  lines.push('');

  lines.push('Findings');
  lines.push('--------');
  if (report.findings.length === 0) {
    lines.push('  (none)');
  } else {
    for (const finding of report.findings) {
      lines.push(
        `  [${finding.severity.toUpperCase()}/${finding.status}] ${finding.title} (${finding.id})`,
      );
      lines.push(`    evidence: ${finding.evidence}`);
      lines.push(`    rule:     ${finding.protocolRule}`);
      if (finding.remediation) lines.push(`    action:   ${finding.remediation}`);
    }
  }
  lines.push('');

  lines.push('Readiness');
  lines.push('---------');
  lines.push(`Classification: ${report.readiness}`);
  for (const evidence of report.readinessEvidence) {
    lines.push(`  - ${evidence}`);
  }
  lines.push('');

  lines.push('Missing information');
  lines.push('-------------------');
  if (report.missingInformation.length === 0) {
    lines.push('  (none)');
  } else {
    for (const missing of report.missingInformation) {
      lines.push(`  - ${missing.field}: ${missing.reason}`);
    }
  }
  lines.push('');

  lines.push('Limitations');
  lines.push('-----------');
  for (const limitation of report.limitations) {
    lines.push(`  - ${limitation}`);
  }

  return lines.join('\n');
}

/** Renders the audit report as JSON. */
export function formatAuditReportJson(report: MergeAuditReport): string {
  return JSON.stringify(report, null, 2);
}
