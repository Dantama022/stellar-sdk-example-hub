/**
 * Soroban resource & cost analysis: prepare -> simulate -> analyse resources -> estimate fee -> report.
 * Read-only: nothing is signed or submitted.
 *
 * CLI:  ts-node index.ts --network testnet --contract C... --function name --source G... \
 *         [--arg type:value]... [--rpc-url URL] [--inclusion-fee STROOPS] [--json]
 */
import { CostRpcClient, createRpcClient, rpcCall } from './rpc';
import { buildInvocationTransaction, validateInvocation } from './invocation';
import { simulateInvocation } from './simulation';
import { analyzeResources, fetchNetworkLimits } from './resource-analysis';
import { addMarketContext, estimateFee } from './fee-estimation';
import { buildReport, formatReport, reportToJson } from './report';
import { ArgSpec, CostAnalysisError, CostReport, InvocationConfig, NetworkLimits } from './types';

export * from './types';
export * from './invocation';
export * from './rpc';
export * from './simulation';
export * from './resource-analysis';
export * from './fee-estimation';
export * from './report';

/**
 * Run the whole analysis. Throws CostAnalysisError for bad input or an unreachable RPC; every
 * simulation outcome (including failures) is returned as a report.
 */
export async function analyzeInvocation(config: InvocationConfig, client?: CostRpcClient): Promise<CostReport> {
  const inv = validateInvocation(config);
  const rpc = client ?? createRpcClient(inv.rpcUrl);

  // Refuse to analyse against a different network than the one selected.
  const live = await rpcCall('getNetwork', () => rpc.getNetwork());
  if (live.passphrase !== inv.networkPassphrase) {
    throw new CostAnalysisError('NETWORK_MISMATCH', `RPC reports "${live.passphrase}" but "${inv.network}" was selected.`);
  }

  // Prepare (no simulation yet), then simulate.
  const sequence = await rpcCall('getAccount', () => rpc.getSequence(inv.sourceAccount));
  const tx = buildInvocationTransaction(inv, sequence);
  const outcome = await simulateInvocation(rpc, tx);

  if (outcome.status !== 'success' || !outcome.resources) {
    const fee = estimateFee(tx, outcome); // reports not_available with the reason
    return buildReport(inv, outcome, undefined, undefined, fee);
  }

  // Limits are best-effort: if they cannot be read the report says so instead of failing.
  const extra: string[] = [];
  let limits: NetworkLimits | undefined;
  try {
    limits = await fetchNetworkLimits(rpc);
  } catch (e) {
    extra.push(`Could not read network limits: ${(e as Error).message}`);
  }
  const analysis = analyzeResources(outcome.resources, limits, inv.warnRatio);
  const fee = await addMarketContext(rpc, estimateFee(tx, outcome));
  return buildReport(inv, outcome, limits, analysis, fee, extra);
}

// ---- CLI --------------------------------------------------------------------------------

export function parseCli(argv: string[]): { config: InvocationConfig; json: boolean } {
  const opts: Record<string, string[]> = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a.startsWith('--')) (opts[a.slice(2)] ??= []).push(argv[++i] ?? '');
    else throw new CostAnalysisError('INVALID_ARGUMENTS', `Unexpected argument: ${a}`);
  }
  const one = (k: string) => opts[k]?.[0];
  const args: ArgSpec[] = (opts['arg'] ?? []).map((raw) => {
    const idx = raw.indexOf(':');
    if (idx < 1) throw new CostAnalysisError('INVALID_ARGUMENTS', `--arg must look like type:value, got "${raw}"`);
    return { type: raw.slice(0, idx) as ArgSpec['type'], value: raw.slice(idx + 1) };
  });
  return {
    json,
    config: {
      network: (one('network') ?? 'testnet') as InvocationConfig['network'],
      rpcUrl: one('rpc-url'),
      contractId: one('contract') ?? '',
      functionName: one('function') ?? '',
      sourceAccount: one('source') ?? '',
      inclusionFee: one('inclusion-fee'),
      args,
    },
  };
}

async function main(): Promise<void> {
  const { config, json } = parseCli(process.argv.slice(2));
  const report = await analyzeInvocation(config);
  console.log(json ? reportToJson(report) : formatReport(report));
  process.exitCode = report.assessment === 'do_not_submit' || report.assessment === 'inconclusive' ? 1 : 0;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof CostAnalysisError ? `${e.code}: ${e.message}` : e);
    process.exitCode = 2;
  });
}
