#!/usr/bin/env node
import dotenv from 'dotenv';
import {
  HorizonOfflineError,
  InvalidHorizonUrlError,
  inspectHorizonEndpoint,
} from './inspector/horizon';

dotenv.config();

function printUsage(): void {
  console.log('Usage: stellar-api-inspector horizon [--url <horizon-url>]');
}

function resolveHorizonUrl(args: string[]): string {
  const defaultUrl = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
  const urlFlagIndex = args.findIndex((arg) => arg === '--url' || arg === '-u');

  if (urlFlagIndex === -1) {
    return defaultUrl;
  }

  const flaggedValue = args[urlFlagIndex + 1];
  return flaggedValue || defaultUrl;
}

export async function runInspectorCli(args: string[]): Promise<number> {
  const [subcommand] = args;

  if (subcommand !== 'horizon') {
    printUsage();
    return 1;
  }

  const horizonUrl = resolveHorizonUrl(args.slice(1));
  console.log(`Inspecting Horizon endpoint: ${horizonUrl}`);

  try {
    const result = await inspectHorizonEndpoint(horizonUrl);
    console.log(`Connectivity: OK`);
    console.log(`Latency: ${result.latencyMs} ms`);
    console.log(`Network Passphrase: ${result.metadata.networkPassphrase}`);
    console.log(`Protocol Version: ${result.metadata.protocolVersion}`);
    console.log(`Core Version: ${result.metadata.coreVersion}`);
    console.log(`Horizon Version: ${result.metadata.horizonVersion}`);
    return 0;
  } catch (error: unknown) {
    if (error instanceof InvalidHorizonUrlError) {
      console.error(`Validation Error: ${error.message}`);
      return 1;
    }

    if (error instanceof HorizonOfflineError) {
      console.error(`Connectivity Error: ${error.message}`);
      return 1;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unexpected Error: ${message}`);
    return 1;
  }
}

if (require.main === module) {
  runInspectorCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Fatal Error: ${message}`);
      process.exit(1);
    });
}
