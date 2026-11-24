/**
 * Step 5: estimate the fee, kept separate from resource analysis.
 *
 * Soroban fees are computed by the network from the resources a transaction declares, plus ledger
 * state (for example write fees rise with ledger size). The simulator applies the CURRENT fee
 * schedule and returns `minResourceFee`; this file never recomputes it from constants.
 *
 * The documented SDK workflow is `rpc.assembleTransaction(tx, simulation)`: it sets the footprint
 * and resource limits from the simulation and sets the fee to  (fee on the original tx) +
 * minResourceFee. We call it only to get that unsigned, never-submitted transaction, and
 * cross-check the number against our own bigint sum.
 *
 * An estimate is not the charge. At execution the inclusion fee charged depends on network
 * surge pricing (never more than the bid); the refundable portion of the resource fee (rent,
 * events) is refunded if unused; and ledger state can change between simulation and inclusion.
 */
import { Transaction, rpc } from '@stellar/stellar-sdk';
import { CostRpcClient } from './rpc';
import { FeeEstimate, SimulationOutcome } from './types';

const UINT32_MAX = 0xffffffffn; // classic transaction `fee` field is a uint32 of stroops

export function estimateFee(tx: Transaction, outcome: SimulationOutcome): FeeEstimate {
  const warnings: string[] = [];
  if (outcome.status !== 'success' || outcome.minResourceFee === undefined || outcome.raw === undefined) {
    return { status: 'not_available', error: `No fee estimate: simulation status is "${outcome.status}".`, warnings };
  }
  try {
    const inclusionFee = BigInt(tx.fee);
    const resourceFee = outcome.minResourceFee;
    const maxFee = inclusionFee + resourceFee;

    // SDK-documented assembly (unsigned, not submitted). Cross-check its fee against ours.
    const assembled = rpc.assembleTransaction(tx, outcome.raw as rpc.Api.SimulateTransactionSuccessResponse).build();
    if (BigInt(assembled.fee) !== maxFee) {
      return {
        status: 'failed',
        error: `Fee mismatch: assembled transaction fee ${assembled.fee} != inclusion ${inclusionFee} + resource ${resourceFee}.`,
        warnings,
      };
    }
    if (maxFee > UINT32_MAX) {
      return { status: 'failed', error: `Total fee ${maxFee} stroops exceeds the transaction fee field maximum (${UINT32_MAX}).`, warnings };
    }
    const dataFee = outcome.resources?.dataResourceFee;
    if (dataFee !== undefined && dataFee !== resourceFee) {
      warnings.push(`Resource fee in the simulated transaction data (${dataFee}) differs from minResourceFee (${resourceFee}); the larger figure governs the minimum.`);
    }
    return { status: 'estimated', inclusionFee, resourceFee, maxFee, warnings };
  } catch (e) {
    return { status: 'failed', error: `Fee estimation failed: ${(e as Error).message}`, warnings };
  }
}

/**
 * Optional market context from getFeeStats. Purely informational; failure only adds a warning.
 * The percentile values are what other Soroban transactions recently paid as inclusion fees.
 */
export async function addMarketContext(client: CostRpcClient, fee: FeeEstimate): Promise<FeeEstimate> {
  if (fee.status !== 'estimated') return fee;
  try {
    const stats = await client.getFeeStats();
    const s = stats.sorobanInclusionFee;
    const marketInclusionFee = { p50: s.p50, p99: s.p99, ledgerCount: s.ledgerCount };
    const warnings = [...fee.warnings];
    if (fee.inclusionFee !== undefined && /^\d+$/.test(s.p99) && fee.inclusionFee < BigInt(s.p99)) {
      warnings.push(`Inclusion fee bid (${fee.inclusionFee}) is below the recent p99 Soroban inclusion fee (${s.p99}); inclusion may be slow under congestion.`);
    }
    return { ...fee, marketInclusionFee, warnings };
  } catch (e) {
    return { ...fee, warnings: [...fee.warnings, `Could not read fee statistics (${(e as Error).message}); no market context.`] };
  }
}

/** Format stroops as XLM without going through a floating-point number (1 XLM = 10^7 stroops). */
export function stroopsToXlm(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / 10_000_000n;
  const frac = (abs % 10_000_000n).toString().padStart(7, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}
