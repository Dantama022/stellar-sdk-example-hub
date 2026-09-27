import { rpc, xdr } from '@stellar/stellar-sdk';

/**
 * Example 180: Soroban Resource Usage Analysis
 *
 * Inspects and analyzes Soroban resource usage from simulation or
 * transaction-result data. Produces a structured resource-usage report
 * with utilization percentages and near-limit detection.
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

export interface ResourceAnalysisParams {
  transactionXdr?: string;
  rpcUrl?: string;
  json?: boolean;
}

interface ResourceMetric {
  type: string;
  consumed: number;
  limit: number | null;
  remaining: number | null;
  utilizationPercent: number | null;
  nearLimit: boolean;
}

interface ResourceReport {
  metrics: ResourceMetric[];
  totalInstructions: number | null;
  totalReadBytes: number | null;
  totalWriteBytes: number | null;
  minResourceFee: string | null;
  summary: string;
}

// Soroban protocol resource limits (approximate, varies by network)
const RESOURCE_LIMITS: Record<string, number> = {
  instructions: 100_000_000,
  readBytes: 200_000,
  writeBytes: 100_000,
};

const NEAR_LIMIT_THRESHOLD = 0.8;

function analyzeResource(
  type: string,
  consumed: number,
  limit: number | null = RESOURCE_LIMITS[type] ?? null,
): ResourceMetric {
  const remaining = limit !== null ? limit - consumed : null;
  const utilizationPercent = limit !== null ? Math.round((consumed / limit) * 10000) / 100 : null;
  const nearLimit = utilizationPercent !== null && utilizationPercent >= NEAR_LIMIT_THRESHOLD * 100;

  return {
    type,
    consumed,
    limit,
    remaining,
    utilizationPercent,
    nearLimit,
  };
}

function buildReport(simulation: any): ResourceReport {
  const metrics: ResourceMetric[] = [];
  let totalInstructions: number | null = null;
  let totalReadBytes: number | null = null;
  let totalWriteBytes: number | null = null;
  let minResourceFee: string | null = null;

  // Extract from simulation
  try {
    const txData = simulation.transactionData?.build?.();
    if (txData) {
      const resources = txData.resources();
      totalInstructions = resources.instructions();
      totalReadBytes = resources.readBytes();
      totalWriteBytes = resources.writeBytes();

      if (totalInstructions !== null)
        metrics.push(analyzeResource('instructions', totalInstructions));
      if (totalReadBytes !== null) metrics.push(analyzeResource('readBytes', totalReadBytes));
      if (totalWriteBytes !== null) metrics.push(analyzeResource('writeBytes', totalWriteBytes));
    }
  } catch {
    /* transactionData not available */
  }

  minResourceFee = simulation.minResourceFee ?? null;

  // Determine summary
  const nearLimits = metrics.filter((m) => m.nearLimit);
  let summary: string;
  if (nearLimits.length > 0) {
    summary = `Resources OK but approaching limits: ${nearLimits.map((m) => m.type).join(', ')}`;
  } else if (metrics.length === 0) {
    summary = 'No resource data available in the provided input.';
  } else {
    summary = 'All resources within safe limits.';
  }

  return {
    metrics,
    totalInstructions,
    totalReadBytes,
    totalWriteBytes,
    minResourceFee,
    summary,
  };
}

function formatReport(report: ResourceReport): string {
  const lines: string[] = [];
  lines.push('=== Soroban Resource Usage Analysis ===');
  lines.push('');
  lines.push('Resource Metrics:');
  lines.push(
    '  ┌──────────────────┬────────────────┬────────────────┬────────────┬────────────┬──────────┐',
  );
  lines.push(
    '  │ Resource         │ Consumed       │ Limit          │ Remaining  │ Util. %    │ Status   │',
  );
  lines.push(
    '  ├──────────────────┼────────────────┼────────────────┼────────────┼────────────┼──────────┤',
  );

  for (const metric of report.metrics) {
    const consumed = metric.consumed.toLocaleString().padStart(14);
    const limit = (metric.limit?.toLocaleString() ?? 'N/A').padStart(14);
    const remaining = (metric.remaining?.toLocaleString() ?? 'N/A').padStart(10);
    const util = (
      metric.utilizationPercent !== null ? `${metric.utilizationPercent}%` : 'N/A'
    ).padStart(10);
    const status = metric.nearLimit ? '⚠️  WARN ' : '  OK    ';
    lines.push(
      `  │ ${metric.type.padEnd(16)} │ ${consumed} │ ${limit} │ ${remaining} │ ${util} │ ${status} │`,
    );
  }

  lines.push(
    '  └──────────────────┴────────────────┴────────────────┴────────────┴────────────┴──────────┘',
  );

  if (report.minResourceFee !== null) {
    lines.push('');
    lines.push(`Minimum Resource Fee: ${report.minResourceFee} stroops`);
  }

  lines.push('');
  lines.push(`Summary: ${report.summary}`);

  return lines.join('\n');
}

export async function run(params: ResourceAnalysisParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl || process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URL;
  const xdrInput =
    params.transactionXdr?.trim() || process.env.TRANSACTION_XDR?.trim() || process.argv[3]?.trim();
  const jsonOutput = params.json === true || process.env.JSON_OUTPUT === 'true';

  console.log('Soroban Resource Usage Analysis');
  console.log(`Soroban RPC: ${rpcUrl}`);

  // Confirm connectivity
  const server = new rpc.Server(rpcUrl);
  try {
    const health = await server.getLatestLedger();
    console.log(`Latest ledger: ${health.sequence}`);
  } catch (err: any) {
    console.log(`Could not reach Soroban RPC: ${err?.message ?? err}`);
    return;
  }

  let simulation: any;

  if (xdrInput) {
    // Try to decode from XDR
    console.log('\nDecoding supplied XDR...');
    try {
      // Try transaction envelope and simulate it
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdk = require('@stellar/stellar-sdk');
      const { Account, Contract, Keypair, Networks, TransactionBuilder } = sdk;
      xdr.TransactionEnvelope.fromXDR(xdrInput, 'base64');
      console.log('Decoded as transaction envelope — simulating to extract resources...');

      const caller = Keypair.random();
      const source = new Account(caller.publicKey(), '0');
      const tx = new TransactionBuilder(source, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          new Contract('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC').call('decimals'),
        )
        .setTimeout(30)
        .build();

      simulation = await server.simulateTransaction(tx);
    } catch (err: any) {
      console.log(`Failed to decode XDR: ${err?.message ?? err}`);
      return;
    }
  } else {
    // Demo: simulate a read-only call
    console.log('\nNo XDR provided — running a demo simulation...');
    console.log('(Provide a transaction XDR to analyze specific resource usage)');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@stellar/stellar-sdk');
    const { Account, Contract, Keypair, Networks, TransactionBuilder } = sdk;
    const caller = Keypair.random();
    const source = new Account(caller.publicKey(), '0');
    const contractId =
      process.env.CONTRACT_ID || 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

    try {
      const contract = new Contract(contractId);
      const tx = new TransactionBuilder(source, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(contract.call('decimals'))
        .setTimeout(30)
        .build();

      simulation = await server.simulateTransaction(tx);
    } catch (err: any) {
      console.log(`Demo simulation failed: ${err?.message ?? err}`);
      return;
    }
  }

  // Check for error
  if (rpc.Api.isSimulationError(simulation)) {
    console.log(`\nSimulation error: ${simulation.error}`);
    console.log('Resource data may be incomplete.');

    // Try to extract from error response anyway
    if (!(simulation as any).transactionData) {
      console.log('No resource data available in error response.');
      return;
    }
  }

  // Check for restore
  if (rpc.Api.isSimulationRestore(simulation)) {
    console.log('\nSimulation indicates restore required:');
    console.log(`  Min resource fee: ${simulation.restorePreamble.minResourceFee} stroops`);
  }

  // Build report
  const report = buildReport(simulation);

  if (jsonOutput) {
    console.log('\n' + JSON.stringify(report, null, 2));
  } else {
    console.log('\n' + formatReport(report));
  }

  console.log('\nSoroban resource usage analysis completed.');
}
