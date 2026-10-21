/**
 * Command line entry point of the account merge readiness auditor
 * (ISSUE-378).
 *
 * The auditor is strictly read-only: it queries Horizon, prints an advisory
 * report and never signs or submits a transaction.
 *
 * Usage:
 *   node dist/examples/account-merge-readiness/index.js \
 *     --account G... --endpoint https://horizon-testnet.stellar.org \
 *     [--limit 200] [--output report.json] [--format console|json]
 */

import { writeFileSync } from 'fs';
import { analyzeMergeBlockers, classifyMergeReadiness } from './blocker-analysis';
import { DEFAULT_ENDPOINT, HorizonAccountDataSource, inspectAccount } from './account-inspector';
import { analyzeReserves } from './reserve-analysis';
import { buildAuditReport, formatAuditReport, formatAuditReportJson } from './report';
import type { MergeAuditReport } from './types';

/** Options of the command line interface. */
export interface AuditOptions {
  /** Public key of the account to audit. */
  account?: string;
  /** Horizon endpoint to query. */
  endpoint?: string;
  /** Maximum number of records to inspect for paginated collections. */
  limit?: number;
  /** Optional path the report is written to. */
  output?: string;
  /** `console` or `json`. */
  format?: string;
  /** Name of the network, used in the report. */
  network?: string;
}

/** Parses the command line arguments of the auditor. */
export function parseArgs(argv: string[]): AuditOptions {
  const options: AuditOptions = { format: 'console' };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[index + 1];

    switch (arg) {
      case '--account':
      case '-a':
        options.account = next();
        index += 1;
        break;
      case '--endpoint':
      case '-e':
        options.endpoint = next();
        index += 1;
        break;
      case '--limit':
      case '-l':
        options.limit = Number(next());
        index += 1;
        break;
      case '--output':
      case '-o':
        options.output = next();
        index += 1;
        break;
      case '--format':
      case '-f':
        options.format = next();
        index += 1;
        break;
      case '--network':
      case '-n':
        options.network = next();
        index += 1;
        break;
      default:
        if (arg.startsWith('--account=')) options.account = arg.slice('--account='.length);
        else if (arg.startsWith('--endpoint=')) options.endpoint = arg.slice('--endpoint='.length);
        else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length));
        else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
        else if (arg.startsWith('--format=')) options.format = arg.slice('--format='.length);
        else if (arg.startsWith('--network=')) options.network = arg.slice('--network='.length);
        break;
    }
  }

  return options;
}

/** Prints the usage of the auditor. */
export function printUsage(): void {
  console.log('Usage: account-merge-readiness --account <G...> [options]');
  console.log('');
  console.log('Options:');
  console.log('  -a, --account <G...>   Public key of the account to audit');
  console.log('  -e, --endpoint <url>   Horizon endpoint (default: testnet)');
  console.log('  -l, --limit <n>        Maximum number of records per collection');
  console.log('  -o, --output <path>    Write the report to a file');
  console.log('  -f, --format <format>  console (default) or json');
  console.log('  -n, --network <name>   Name of the network for the report');
}

/**
 * Runs the audit and returns the report.
 *
 * @throws {Error} when the account id is missing or invalid.
 */
export async function runAudit(options: AuditOptions): Promise<MergeAuditReport> {
  if (!options.account) {
    throw new Error('An account public key is required. Use --account <G...>.');
  }
  if (!/^G[A-Z2-7]{55}$/.test(options.account)) {
    throw new Error(`"${options.account}" is not a valid Stellar account public key.`);
  }

  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const source = new HorizonAccountDataSource(endpoint);
  const inspection = await inspectAccount({
    accountId: options.account,
    limit: options.limit,
    source,
  });

  if (!inspection.snapshot) {
    const reason = inspection.missingInformation[0]?.reason ?? 'The account could not be loaded.';
    throw new Error(`Unable to retrieve the account state: ${reason}`);
  }

  const snapshot = inspection.snapshot;
  const findings = analyzeMergeBlockers(snapshot, inspection.missingInformation);
  const { readiness, evidence } = classifyMergeReadiness(findings, inspection.missingInformation);
  const reserve = analyzeReserves(snapshot, {
    sponsoredEntryCount: snapshot.numSponsored,
  });

  return buildAuditReport({
    accountId: snapshot.accountId,
    network: options.network ?? 'testnet',
    endpoint,
    auditedAt: new Date().toISOString(),
    account: snapshot,
    findings,
    reserve,
    readiness,
    readinessEvidence: evidence,
    missingInformation: inspection.missingInformation,
  });
}

/** Entry point used when the module is executed directly. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);

  if (!options.account) {
    printUsage();
    return 1;
  }

  try {
    const report = await runAudit(options);
    const rendered =
      options.format === 'json' ? formatAuditReportJson(report) : formatAuditReport(report);

    if (options.output) {
      writeFileSync(options.output, `${rendered}\n`, 'utf8');
      console.log(`Audit report written to ${options.output}`);
    } else {
      console.log(rendered);
    }
    return 0;
  } catch (error) {
    console.error('Audit failed:', error instanceof Error ? error.message : 'Unknown error');
    return 1;
  }
}

/* istanbul ignore next */
if (require.main === module) {
  main().then((code) => process.exit(code));
}
