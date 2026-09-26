#!/usr/bin/env node
import dotenv from 'dotenv';
import {
  HorizonOfflineError,
  InvalidHorizonUrlError,
  inspectHorizonEndpoint,
} from './inspector/horizon';
import { run as runEventSchemaDiff } from './examples/213-event-schema-diff';
import { run as runEventTypes } from './examples/214-event-types';
import { run as runEventCompat } from './examples/215-event-compat';
import { run as runStateDiff } from './examples/216-state-diff';

dotenv.config();

function printUsage(): void {
  console.log('Usage: stellar-api-inspector <subcommand> [args]');
  console.log('Subcommands:');
  console.log('  horizon [--url <horizon-url>]');
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
      case 'event-schema-diff':
        await runEventSchemaDiff({ oldSchema: cmdArgs[0], newSchema: cmdArgs[1] });
        return 0;
      case 'event-types':
        await runEventTypes({ schemaFile: cmdArgs[0] });
        return 0;
      case 'event-compat':
        await runEventCompat({ schemaFile: cmdArgs[0], eventsFile: cmdArgs[1] });
        return 0;
      case 'state-diff':
        await runStateDiff({ beforeFile: cmdArgs[0], afterFile: cmdArgs[1] });
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