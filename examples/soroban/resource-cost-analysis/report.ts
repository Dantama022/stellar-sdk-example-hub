/** Step 6: assemble the structured report and render it for humans. */
import { stroopsToXlm } from './fee-estimation';
import {
  Assessment,
  CostReport,
  FeeEstimate,
  NetworkLimits,
  ResourceAnalysis,
  SimulationOutcome,
  ValidatedInvocation,
} from './types';

const NOTES = [
  'Simulation is a prediction against the current ledger state, not a guarantee. State can change before inclusion, so on-chain usage and cost can differ.',
  'The resources shown are what simulation proposes the transaction declare; they are compared with network per-transaction limits, which are separate caps.',
  'The fee is an ESTIMATE of the maximum: inclusion-fee bid + simulated resource fee. The final charge can be lower (surge pricing never exceeds the bid; unused refundable resource fee is refunded).',
  'This tool is read-only: nothing was signed or submitted.',
];

export function assess(outcome: SimulationOutcome, analysis: ResourceAnalysis | undefined, fee: FeeEstimate): Assessment {
  if (outcome.status === 'failed' || outcome.status === 'restore_required') return 'do_not_submit';
  if (outcome.status !== 'success') return 'inconclusive';
  if (analysis?.lines.some((l) => l.status === 'exceeded')) return 'do_not_submit';
  if (fee.status !== 'estimated') return 'inconclusive';
  const hasWarning = analysis === undefined || analysis.warnings.length > 0 || fee.warnings.length > 0;
  return hasWarning ? 'caution' : 'ok';
}

export function buildReport(
  inv: ValidatedInvocation,
  outcome: SimulationOutcome,
  limits: NetworkLimits | undefined,
  analysis: ResourceAnalysis | undefined,
  fee: FeeEstimate,
  extraWarnings: string[] = []
): CostReport {
  const warnings = [...extraWarnings];
  if (outcome.status === 'failed') warnings.push(`Simulation failed (${outcome.failure?.kind}): ${outcome.failure?.message}`);
  else if (outcome.detail) warnings.push(outcome.detail);
  if (analysis) warnings.push(...analysis.warnings);
  if (fee.error && outcome.status === 'success') warnings.push(fee.error);
  warnings.push(...fee.warnings);
  if (outcome.diagnostics && outcome.diagnostics.failedCallEvents > 0) {
    warnings.push(`${outcome.diagnostics.failedCallEvents} diagnostic event(s) were emitted inside a failed contract call.`);
  }

  return {
    readOnly: true,
    network: { name: inv.network, passphrase: inv.networkPassphrase, rpcUrl: inv.rpcUrl },
    contractId: inv.contractId,
    functionName: inv.functionName,
    simulation: {
      status: outcome.status,
      latestLedger: outcome.latestLedger,
      detail: outcome.detail,
      failureKind: outcome.failure?.kind,
    },
    // Only a successful simulation yields resources or an estimate: never a misleading success.
    resources: outcome.status === 'success' ? outcome.resources : undefined,
    limits,
    analysis,
    fee,
    diagnostics: outcome.diagnostics,
    warnings,
    assessment: assess(outcome, analysis, fee),
    notes: NOTES,
  };
}

/** JSON with bigint rendered as decimal strings (JSON.stringify cannot serialize bigint). */
export function reportToJson(report: CostReport): string {
  return JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

export function formatReport(r: CostReport): string {
  const out: string[] = [];
  out.push('=== Soroban resource & cost analysis (read-only) ===');
  out.push(`Network:    ${r.network.name} (${r.network.passphrase})`);
  out.push(`RPC:        ${r.network.rpcUrl}`);
  out.push(`Contract:   ${r.contractId}`);
  out.push(`Function:   ${r.functionName}`);
  out.push(`Simulation: ${r.simulation.status}${r.simulation.latestLedger ? ` (ledger ${r.simulation.latestLedger})` : ''}`);

  if (r.analysis) {
    out.push('', 'Simulated resources vs per-transaction network limits:');
    for (const l of r.analysis.lines) {
      const lim = l.limit === undefined ? 'limit unknown' : `limit ${l.limit} (${l.percent}%)`;
      out.push(`  ${l.name.padEnd(24)} ${String(l.used).padStart(14)}  ${lim}  [${l.status}]`);
    }
  }
  if (r.resources) {
    out.push(`  Footprint: ${r.resources.readOnlyEntries} read-only, ${r.resources.readWriteEntries} read-write ledger keys`);
  }

  out.push('', 'Fee (ESTIMATE, in stroops; 1 XLM = 10,000,000 stroops):');
  if (r.fee.status === 'estimated' && r.fee.maxFee !== undefined) {
    out.push(`  Inclusion fee bid:   ${r.fee.inclusionFee}`);
    out.push(`  Resource fee (sim):  ${r.fee.resourceFee}`);
    out.push(`  Max fee estimate:    ${r.fee.maxFee} (${stroopsToXlm(r.fee.maxFee)} XLM)`);
    if (r.fee.marketInclusionFee) {
      out.push(`  Recent market inclusion fee: p50 ${r.fee.marketInclusionFee.p50}, p99 ${r.fee.marketInclusionFee.p99}`);
    }
  } else {
    out.push(`  none - ${r.fee.error ?? r.fee.status}`);
  }

  if (r.diagnostics) {
    out.push('', `Diagnostics: ${r.diagnostics.eventCount} event(s) ${JSON.stringify(r.diagnostics.eventTypes)}`);
  }
  if (r.warnings.length) {
    out.push('', 'Warnings:', ...r.warnings.map((w) => `  - ${w}`));
  }
  out.push('', `Assessment: ${r.assessment.toUpperCase()}`, '', 'Notes:', ...r.notes.map((n) => `  - ${n}`));
  return out.join('\n');
}
