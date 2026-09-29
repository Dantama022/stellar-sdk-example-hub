#!/usr/bin/env node
import dotenv from 'dotenv';
import {
  HorizonOfflineError,
  InvalidHorizonUrlError,
  inspectHorizonEndpoint,
} from './inspector/horizon';
import { run as runScval } from './examples/201-scval';
import { run as runScvalValidate } from './examples/202-scval-validate';
import { run as runContractArgs } from './examples/203-contract-args';
import { run as runContractTemplate } from './examples/204-contract-template';
import { run as runBuildArgs } from './examples/205-build-args';
import { run as runDecodeReturn } from './examples/206-decode-return';
import { run as runDecodeEvent } from './examples/207-decode-event';
import { run as runWatchEvents } from './examples/209-watch-events';
import { run as runReplayEvents } from './examples/210-replay-events';
import { run as runEventAnalytics } from './examples/211-event-analytics';
import { run as runEventValidate } from './examples/212-event-validate';
import { run as runEventSchemaDiff } from './examples/213-event-schema-diff';
import { run as runEventTypes } from './examples/214-event-types';
import { run as runEventCompat } from './examples/215-event-compat';
import { run as runStateDiff } from './examples/216-state-diff';
import {
  parseAuthorizationArgs,
  run as runAuthorizationSignatureInspection,
} from './examples/197-soroban-authorization-signature-inspection';
import { parseTtlArgs, run as runSorobanTtl } from './examples/198-soroban-ttl';
import {
  parseStateReportArgs,
  run as runSorobanStateReport,
} from './examples/199-soroban-state-report';
import {
  parseDecodeLedgerKeyArgs,
  run as runDecodeLedgerKey,
} from './examples/200-decode-ledger-key';
import { run as runStateDeps } from './examples/224-state-deps';
import { run as runWasmMemory } from './examples/244-wasm-memory';
import { run as runWasmCustomSections } from './examples/245-wasm-custom-sections';
import { run as runWasmGlobals } from './examples/246-wasm-globals';
import { run as runWasmInstructions } from './examples/247-wasm-instructions';
import { run as runWasmElements } from './examples/248-wasm-elements';
import { run as runWasmRecursion } from './examples/219-wasm-recursion';
import { WasmValidationError } from './utils/wasm-static-analysis';

dotenv.config();

function printUsage(): void {
  console.log('Usage: stellar-api-inspector <subcommand> [args]');
  console.log('Subcommands:');
  console.log('  horizon [--url <horizon-url>]');
  console.log('  scval <encode|decode> <value> [type]');
  console.log('  scval-validate <input> <expectedType>');
  console.log('  contract-args <contractId>');
  console.log('  contract-template <contractId> <function>');
  console.log('  build-args <contractId> <function> <argsJson>');
  console.log('  decode-return <base64ScVal>');
  console.log('  decode-event <eventJson>');
  console.log('  watch-events <contractId>');
  console.log('  replay-events <startLedger> <endLedger> [contractId]');
  console.log('  event-analytics <startLedger> <endLedger> [contractId]');
  console.log('  event-validate <event.json> <schema.json>');
  console.log('  event-schema-diff <oldSchema.json> <newSchema.json>');
  console.log('  event-types <schema.json>');
  console.log('  event-compat <schema.json> <events.json>');
  console.log('  state-diff <before.json> <after.json>');
  console.log('  auth-signature <authorizationEntryXdr> [...xdr] [--json]');
  console.log('  soroban-ttl <contractId> [--key <key>] [--warning-ledgers <n>] [--json]');
  console.log('  soroban-state-report <contractId> [--key <key>] [--warning-ledgers <n>] [--json]');
  console.log('  decode-ledger-key <xdr> [...xdr] [--compact] [--json]');
  console.log('  state-deps <snapshot.json>');
  console.log('  wasm-memory <wasmFile> [compareFile] [--json]');
  console.log('  wasm-custom-sections <wasmFile> [compareFile] [--json]');
  console.log('  wasm-globals <wasmFile> [compareFile] [--json]');
  console.log('  wasm-instructions <wasmFile> [compareFile] [--json]');
  console.log('  wasm-elements <wasmFile> [compareFile] [--json]');
  console.log('  wasm-recursion <wasmFile> [compareFile] [--json] [--dot] [--max-cycles <n>]');
}

function resolveHorizonUrl(args: string[]): string {
  const defaultUrl = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
  const urlFlagIndex = args.findIndex((arg) => arg === '--url' || arg === '-u');
  if (urlFlagIndex === -1) return defaultUrl;
  return args[urlFlagIndex + 1] || defaultUrl;
}

function parseWasmArgs(args: string[]): { wasmFile?: string; compareFile?: string; json: boolean } {
  const json = args.includes('--json') || args.includes('--json=true');
  const files = args.filter((arg) => arg !== '--json' && arg !== '--json=true');
  return { wasmFile: files[0], compareFile: files[1], json };
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
      case 'scval':
        await runScval({ action: cmdArgs[0], value: cmdArgs[1], type: cmdArgs[2] });
        return 0;
      case 'scval-validate':
        await runScvalValidate({ input: cmdArgs[0], expectedType: cmdArgs[1] });
        return 0;
      case 'contract-args':
        await runContractArgs({ contractId: cmdArgs[0] });
        return 0;
      case 'contract-template':
        await runContractTemplate({ contractId: cmdArgs[0], functionName: cmdArgs[1] });
        return 0;
      case 'build-args':
        await runBuildArgs({ contractId: cmdArgs[0], functionName: cmdArgs[1], args: cmdArgs[2] });
        return 0;
      case 'decode-return':
        await runDecodeReturn({ input: cmdArgs[0] });
        return 0;
      case 'decode-event':
        await runDecodeEvent({ eventInput: cmdArgs[0] });
        return 0;
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
      case 'auth-signature':
        await runAuthorizationSignatureInspection(parseAuthorizationArgs(cmdArgs));
        return 0;
      case 'soroban-ttl':
        await runSorobanTtl(parseTtlArgs(cmdArgs));
        return 0;
      case 'soroban-state-report':
        await runSorobanStateReport(parseStateReportArgs(cmdArgs));
        return 0;
      case 'decode-ledger-key':
        await runDecodeLedgerKey(parseDecodeLedgerKeyArgs(cmdArgs));
        return 0;
      case 'state-deps':
        await runStateDeps({ snapshotFile: cmdArgs[0] });
        return 0;
      case 'wasm-memory':
        await runWasmMemory(parseWasmArgs(cmdArgs));
        return 0;
      case 'wasm-custom-sections':
        await runWasmCustomSections(parseWasmArgs(cmdArgs));
        return 0;
      case 'wasm-globals':
        await runWasmGlobals(parseWasmArgs(cmdArgs));
        return 0;
      case 'wasm-instructions':
        await runWasmInstructions(parseWasmArgs(cmdArgs));
        return 0;
      case 'wasm-recursion': {
        const json = cmdArgs.includes('--json') || cmdArgs.includes('--json=true');
        const dot = cmdArgs.includes('--dot');
        const maxCyclesIdx = cmdArgs.findIndex((a) => a === '--max-cycles');
        const maxCycles = maxCyclesIdx !== -1 ? Number(cmdArgs[maxCyclesIdx + 1] ?? '0') : 0;
        const skipValues = new Set<string>();
        if (maxCyclesIdx !== -1 && cmdArgs[maxCyclesIdx + 1]) {
          skipValues.add(cmdArgs[maxCyclesIdx + 1]);
        }
        const files = cmdArgs.filter(
          (a) => !a.startsWith('--') && !skipValues.has(a),
        );
        await runWasmRecursion({ wasmFile: files[0], compareFile: files[1], json, dot, maxCycles });
        return 0;
      }
      default:
        printUsage();
        return 1;
    }
  } catch (error: unknown) {
    if (error instanceof InvalidHorizonUrlError || error instanceof HorizonOfflineError) {
      console.error(`Error: ${error.message}`);
    } else if (error instanceof WasmValidationError) {
      console.error(`WASM Validation Error: ${error.message}`);
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
