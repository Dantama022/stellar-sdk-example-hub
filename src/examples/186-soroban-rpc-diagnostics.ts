import { rpc } from '@stellar/stellar-sdk';
import chalk from 'chalk';

export interface SorobanRpcDiagnosticsParams {
  rpcUrl?: string;
  timeoutMs?: number | string;
  json?: boolean | string;
}

export interface LedgerFreshnessResult {
  ageMs: number;
  freshness: 'fresh' | 'stale' | 'unknown';
  isStale: boolean;
  staleThresholdMs: number;
}

export interface SorobanRpcDiagnosticsReport {
  rpcUrl: string;
  connectionStatus: 'connected' | 'error';
  healthStatus: string;
  networkPassphrase?: string;
  protocolVersion?: string;
  latestLedgerSequence?: number;
  latestLedgerHash?: string;
  ledgerCloseTime?: string;
  ledgerFreshness: LedgerFreshnessResult;
  error?: string;
  checkedAt: string;
}

function prefersJson(params?: SorobanRpcDiagnosticsParams): boolean {
  return (
    params?.json === true ||
    params?.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json')
  );
}

export function validateRpcUrl(value?: string): string {
  const raw = (value ?? '').trim();
  if (!raw) {
    throw new Error('Missing Soroban RPC URL. Provide an http:// or https:// endpoint.');
  }

  if (!/^https?:\/\//i.test(raw)) {
    throw new Error(`Invalid Soroban RPC URL "${raw}". Use an http:// or https:// URL.`);
  }

  try {
    const parsed = new URL(raw);
    if (!parsed.hostname) {
      throw new Error('No hostname found in the RPC URL.');
    }
    const normalised = parsed.toString();
    if (raw.endsWith('/')) {
      return normalised;
    }
    return normalised.replace(/\/$/, '');
  } catch {
    throw new Error(`Invalid Soroban RPC URL "${raw}".`);
  }
}

export function calculateLedgerFreshness(
  latestLedgerSequence?: number,
  nowMs = Date.now(),
  closeTimeMs?: number,
): LedgerFreshnessResult {
  const staleThresholdMs = 2 * 60 * 1000;

  if (typeof latestLedgerSequence !== 'number' || !Number.isFinite(latestLedgerSequence) || latestLedgerSequence <= 0) {
    return { ageMs: 0, freshness: 'unknown', isStale: false, staleThresholdMs };
  }

  const estimateCloseTimeMs = closeTimeMs ?? nowMs - latestLedgerSequence * 5000;
  const ageMs = Math.max(0, nowMs - estimateCloseTimeMs);
  const isStale = ageMs > staleThresholdMs;

  return {
    ageMs,
    freshness: isStale ? 'stale' : 'fresh',
    isStale,
    staleThresholdMs,
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export async function inspectSorobanRpcDiagnostics(
  rpcUrl: string,
  timeoutMs = 15_000,
): Promise<SorobanRpcDiagnosticsReport> {
  const server = new rpc.Server(rpcUrl);
  const checkedAt = new Date().toISOString();

  try {
    const health = await Promise.race([
      server.getHealth(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`RPC request timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

    const network = await Promise.race([
      server.getNetwork(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`RPC request timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

    const latestLedger = await Promise.race([
      server.getLatestLedger(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`RPC request timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

    const latestLedgerSequence = typeof latestLedger?.sequence === 'number' ? latestLedger.sequence : undefined;
    const ledgerCloseTime = typeof latestLedger?.id === 'string' ? checkedAt : undefined;
    const ledgerFreshness = calculateLedgerFreshness(latestLedgerSequence, Date.now(), undefined);

    return {
      rpcUrl,
      connectionStatus: 'connected',
      healthStatus: String((health as any)?.status ?? 'unknown'),
      networkPassphrase: (network as any)?.passphrase ?? (network as any)?.networkPassphrase,
      protocolVersion: (network as any)?.protocolVersion ?? (network as any)?.protocol_version,
      latestLedgerSequence,
      latestLedgerHash: (latestLedger as any)?.id,
      ledgerCloseTime,
      ledgerFreshness,
      checkedAt,
    };
  } catch (error) {
    return {
      rpcUrl,
      connectionStatus: 'error',
      healthStatus: 'unavailable',
      ledgerFreshness: { ageMs: 0, freshness: 'unknown', isStale: false, staleThresholdMs: 2 * 60 * 1000 },
      error: error instanceof Error ? error.message : String(error),
      checkedAt,
    };
  }
}

function printHumanReport(report: SorobanRpcDiagnosticsReport): void {
  console.log(chalk.bold('\n=== Soroban RPC Diagnostic Report ==='));
  console.log(`RPC endpoint:          ${report.rpcUrl}`);
  console.log(`Connection status:     ${report.connectionStatus === 'connected' ? chalk.green('connected') : chalk.red('error')}`);
  console.log(`Health status:         ${report.healthStatus}`);
  console.log(`Network passphrase:    ${report.networkPassphrase ?? 'n/a'}`);
  console.log(`Protocol version:      ${report.protocolVersion ?? 'n/a'}`);
  console.log(`Latest ledger:         ${report.latestLedgerSequence ?? 'n/a'}`);
  console.log(`Latest ledger hash:    ${report.latestLedgerHash ?? 'n/a'}`);
  console.log(`Ledger close time:     ${report.ledgerCloseTime ?? 'n/a'}`);
  console.log(
    `Ledger freshness:       ${report.ledgerFreshness.freshness} (${formatDuration(report.ledgerFreshness.ageMs)})`,
  );

  if (report.error) {
    console.log(chalk.red(`Error:                 ${report.error}`));
  }
}

export async function run(params: SorobanRpcDiagnosticsParams = {}): Promise<void> {
  const rpcUrl = validateRpcUrl(params.rpcUrl ?? process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org');
  const timeoutMs = Number(params.timeoutMs ?? process.env.RPC_TIMEOUT_MS ?? '15000');
  const jsonOutput = prefersJson(params);

  if (!jsonOutput) {
    console.log(chalk.bold('Soroban RPC Diagnostics Example'));
    console.log(chalk.gray(`Inspecting endpoint: ${rpcUrl}`));
  }

  const report = await inspectSorobanRpcDiagnostics(rpcUrl, Number.isFinite(timeoutMs) ? timeoutMs : 15000);

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printHumanReport(report);
}
