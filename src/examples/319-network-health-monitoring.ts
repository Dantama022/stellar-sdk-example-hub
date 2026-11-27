/**
 * 319-network-health-monitoring
 *
 * Practical Stellar service availability example.
 *
 * Checks a configured Horizon endpoint and Soroban RPC endpoint using only
 * read-only requests, measures response times, validates basic response shapes,
 * and reports healthy / degraded / unhealthy status. No transactions are
 * constructed or submitted.
 */

import chalk from 'chalk';

import {
  NETWORK_HEALTH_PRESETS,
  NetworkEndpointHealth,
  NetworkHealthConfig,
  NetworkHealthReport,
  NetworkPresetName,
  monitorNetworkHealth,
  sanitizeEndpointUrl,
} from '../utils/network-health';

const USAGE =
  'Usage: network-health-monitoring [--network testnet|mainnet] ' +
  '[--horizon-url <url>] [--soroban-rpc-url <url>] [--timeout <ms>] ' +
  '[--degraded-threshold <ms>] [--checks <n>] [--interval <ms>] [--json]';

export interface NetworkHealthExampleParams extends NetworkHealthConfig {
  network?: NetworkPresetName;
  json?: boolean;
}

function numericOption(value: string, flag: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`${flag} requires ${allowZero ? 'a non-negative' : 'a positive'} number`);
  }
  return parsed;
}

export function parseNetworkHealthArgs(args: string[]): NetworkHealthExampleParams {
  const params: NetworkHealthExampleParams = {
    json: args.includes('--json') || args.includes('--json=true'),
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json' || arg === '--json=true') continue;

    const [flag, inlineValue] = arg.split('=', 2);
    if (flag === '--network') {
      const value = inlineValue ?? args[++i];
      if (value !== 'testnet' && value !== 'mainnet') {
        throw new Error('--network must be "testnet" or "mainnet"');
      }
      params.network = value;
    } else if (flag === '--horizon-url') {
      const value = inlineValue ?? args[++i];
      if (!value) throw new Error('--horizon-url requires a URL');
      params.horizonUrl = value;
    } else if (flag === '--soroban-rpc-url') {
      const value = inlineValue ?? args[++i];
      if (!value) throw new Error('--soroban-rpc-url requires a URL');
      params.sorobanRpcUrl = value;
    } else if (flag === '--timeout') {
      const value = inlineValue ?? args[++i];
      if (value === undefined) throw new Error('--timeout requires milliseconds');
      params.timeoutMs = numericOption(value, '--timeout');
    } else if (flag === '--degraded-threshold') {
      const value = inlineValue ?? args[++i];
      if (value === undefined) {
        throw new Error('--degraded-threshold requires milliseconds');
      }
      params.degradedThresholdMs = numericOption(value, '--degraded-threshold', true);
    } else if (flag === '--checks') {
      const value = inlineValue ?? args[++i];
      if (value === undefined) throw new Error('--checks requires a count');
      const parsed = numericOption(value, '--checks');
      if (!Number.isInteger(parsed)) throw new Error('--checks must be an integer');
      params.checks = parsed;
    } else if (flag === '--interval') {
      const value = inlineValue ?? args[++i];
      if (value === undefined) throw new Error('--interval requires milliseconds');
      params.intervalMs = numericOption(value, '--interval', true);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown network-health-monitoring option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return params;
}

export function resolveNetworkHealthConfig(
  params: NetworkHealthExampleParams = {},
): NetworkHealthConfig {
  const presetName = params.network ?? 'testnet';
  const preset = NETWORK_HEALTH_PRESETS[presetName];
  return {
    horizonUrl: params.horizonUrl ?? process.env.HORIZON_URL ?? preset.horizonUrl,
    sorobanRpcUrl: params.sorobanRpcUrl ?? process.env.SOROBAN_RPC_URL ?? preset.sorobanRpcUrl,
    timeoutMs: params.timeoutMs,
    degradedThresholdMs: params.degradedThresholdMs,
    checks: params.checks,
    intervalMs: params.intervalMs,
  };
}

function statusColor(status: NetworkEndpointHealth['status']): (value: string) => string {
  if (status === 'healthy') return chalk.green;
  if (status === 'degraded') return chalk.yellow;
  return chalk.red;
}

function printEndpoint(endpoint: NetworkEndpointHealth): void {
  const color = statusColor(endpoint.status);
  const time = endpoint.responseTimeMs === null ? 'n/a' : `${endpoint.responseTimeMs}ms`;
  console.log(
    `  ${endpoint.name.padEnd(12)} ${color(endpoint.status.padEnd(9))} ` +
      `${time.padStart(7)}  ${endpoint.endpoint}`,
  );
  console.log(chalk.dim(`    ${endpoint.diagnostic}`));
  const detailEntries = Object.entries(endpoint.details).filter(([, value]) => value !== null);
  for (const [key, value] of detailEntries) {
    console.log(chalk.dim(`    ${key}: ${String(value)}`));
  }
}

function printReport(report: NetworkHealthReport, index: number, total: number): void {
  const title = total > 1 ? `Network Health Check ${index + 1}/${total}` : 'Network Health Check';
  console.log(chalk.bold(`\n=== ${title} ===`));
  console.log(`${chalk.bold('Checked at:')} ${report.checkedAt}`);
  for (const endpoint of report.endpoints) printEndpoint(endpoint);

  const color = statusColor(report.status);
  console.log(
    `\n${chalk.bold('Overall:')} ${color(report.status)} ` +
      `(${report.summary.healthy} healthy, ${report.summary.degraded} degraded, ` +
      `${report.summary.unhealthy} unhealthy)`,
  );
  for (const warning of report.warnings) {
    console.log(chalk.yellow(`Warning: ${warning}`));
  }
}

export async function run(params: NetworkHealthExampleParams = {}): Promise<void> {
  const config = resolveNetworkHealthConfig(params);
  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const checks = config.checks ?? 1;
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  if (checks > 1) process.once('SIGINT', onSigint);

  try {
    const reports = await monitorNetworkHealth(config, {
      signal: controller.signal,
    });
    if (json) {
      const payload = reports.length === 1 ? reports[0] : { runs: reports };
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    if (reports.length === 0) {
      console.log(chalk.yellow('No health checks were completed.'));
      return;
    }

    reports.forEach((report, index) => printReport(report, index, reports.length));
    console.log(
      chalk.dim(
        `\nChecked endpoints: ${reports[0].endpoints
          .map((endpoint) => sanitizeEndpointUrl(endpoint.endpoint))
          .join(', ')}`,
      ),
    );
  } finally {
    if (checks > 1) process.removeListener('SIGINT', onSigint);
  }
}

if (require.main === module) {
  try {
    run(parseNetworkHealthArgs(process.argv.slice(2))).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      console.error(USAGE);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 1;
  }
}
