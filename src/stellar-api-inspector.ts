#!/usr/bin/env node
import dotenv from 'dotenv';
import {
  HorizonOfflineError,
  InvalidHorizonUrlError,
  inspectHorizonEndpoint,
} from './inspector/horizon';
import { run as runWatchEvents } from './examples/209-watch-events';
import { run as runReplayEvents } from './examples/210-replay-events';
import { run as runEventAnalytics } from './examples/211-event-analytics';
import { run as runEventValidate } from './examples/212-event-validate';

dotenv.config();

function printUsage(): void {
  console.log('Usage: stellar-api-inspector <subcommand> [args]');
  console.log('Subcommands:');
  console.log('  horizon [--url <horizon-url>]');
  console.log('  watch-events <contractId>');
  console.log('  replay-events <startLedger> <endLedger> [contractId]');
  console.log('  event-analytics <startLedger> <endLedger> [contractId]');
  console.log('  event-validate <event.json> <schema.json>');
  console.log('  event-schema-diff <oldSchema.json> <newSchema.json>');
  console.log('  event-types <schema.json>');
  console.log('  event-compat <schema.json> <events.json>');
  console.log('  state-diff <before.json> <after.json>');
}

function resolveHorizonUrl(args: string[]): string {
  const defaultUrl = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
  const urlFlagIndex = args.findIndex((arg) => arg === '--url' || arg === '-u');
  if (urlFlagIndex === -1) return defaultUrl;
  return args[urlFlagIndex + 1] || defaultUrl;
}

export async function runInspectorCli(args: string[]): Promise<number> {
  const [subcommand, ...cmdArgs] = args;

  try {
    switch (subcommand) {
      case 'horizon': {
        const horizonUrl = resolveHorizonUrl(cmdArgs);
        console.log(`Inspecting Horizon endpoint: ${horizonUrl}`);
        const result = await inspectHorizonEndpoint(horizonUrl);
        console.log(
          `Connectivity: OK\nLatency: ${result.latencyMs} ms\nNetwork Passphrase: ${result.metadata.networkPassphrase}`,
        );
        return 0;
      }
      case 'watch-events':
        await runWatchEvents({ contractId: cmdArgs[0] });
        return 0;
      case 'replay-events':
        await runReplayEvents({
          startLedger: cmdArgs[0],
          endLedger: cmdArgs[1],
          contractId: cmdArgs[2],
        });
        return 0;
      case 'event-analytics':
        await runEventAnalytics({
          startLedger: cmdArgs[0],
          endLedger: cmdArgs[1],
          contractId: cmdArgs[2],
        });
        return 0;
      case 'event-validate':
        await runEventValidate({ eventFile: cmdArgs[0], schemaFile: cmdArgs[1] });
        return 0;
      default:
        printUsage();
        return 1;
    }
  } catch (error: unknown) {
    if (error instanceof InvalidHorizonUrlError || error instanceof HorizonOfflineError) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Unexpected Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}

if (require.main === module) {
  runInspectorCli(process.argv.slice(2))
    .then(process.exit)
    .catch((e) => {
      console.error(`Fatal Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
