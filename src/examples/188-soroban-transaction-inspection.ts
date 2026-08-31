import { Networks, rpc, scValToNative, xdr } from 'stellar-sdk-v16';
import chalk from 'chalk';

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_MS = 30000;

export interface SorobanTransactionInspectionParams {
  transactionHash?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  pollIntervalMs?: number | string;
  pollTimeoutMs?: number | string;
  pollUntilFinal?: boolean;
  json?: boolean;
}

export interface DecodedSorobanEvent {
  index: number;
  type: string;
  contractId?: string;
  topics: Array<{
    xdrType: string;
    decoded: boolean;
    value: unknown;
    rawXdr?: string;
    error?: string;
  }>;
  data: {
    xdrType: string;
    decoded: boolean;
    value: unknown;
    rawXdr?: string;
    error?: string;
  };
  inSuccessfulContractCall?: boolean;
}

export interface SorobanTransactionReport {
  hash: string;
  status: string;
  rpcStatus: string;
  ledger: number | null;
  ledgerCloseTime?: string | null;
  applicationReturnValue: unknown;
  resultXdr: string | null;
  transactionEnvelopeXdr: string | null;
  feeCharged: string | null;
  feeBump: boolean;
  resourceInfo: Record<string, unknown>;
  resultCode: string | null;
  contractEvents: DecodedSorobanEvent[];
  diagnosticEvents: Array<Record<string, unknown>>;
  raw: {
    resultXdr?: string | null;
    resultMetaXdr?: string | null;
    envelopeXdr?: string | null;
    feeMetaXdr?: string | null;
  };
  error?: string;
}

export function isValidTransactionHash(hash: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test((hash ?? '').trim());
}

function normalizePositiveInteger(
  value: number | string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString('hex')}`;
  }

  if (Array.isArray(value)) {
    return value.map(safeJsonValue);
  }

  if (value instanceof Map) {
    return Array.from(value.entries()).map(([key, item]) => [safeJsonValue(key), safeJsonValue(item)]);
  }

  if (value !== null && typeof value === 'object') {
    const fixed: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      fixed[key] = safeJsonValue(item);
    }
    return fixed;
  }

  return value;
}

function decodeScVal(value: xdr.ScVal | undefined): {
  xdrType: string;
  decoded: boolean;
  value: unknown;
  rawXdr?: string;
  error?: string;
} {
  if (!value) {
    return { xdrType: 'void', decoded: true, value: null, rawXdr: undefined };
  }

  const xdrType = value.switch().name || 'unknown';
  const rawXdr = value.toXDR('base64');

  try {
    return {
      xdrType,
      decoded: true,
      value: safeJsonValue(scValToNative(value)),
      rawXdr,
    };
  } catch (error: unknown) {
    return {
      xdrType,
      decoded: false,
      value: null,
      rawXdr,
      error: getErrorMessage(error),
    };
  }
}

function extractResourceInfo(response: rpc.Api.GetTransactionResponse): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  try {
    const meta = (response as any).resultMetaXdr;
    if (meta) {
      const parsedMeta = xdr.TransactionMeta.fromXDR(meta, 'base64');
      const versioned = (parsedMeta as any).v3?.();
      const sorobanMeta = versioned?.sorobanMeta?.();
      if (sorobanMeta) {
        const resources = sorobanMeta.resources?.();
        const ledgerFootprint = resources?.footprint?.();
        const totalBytes = (resources as any)?.writeBytes?.();
        const readBytes = (resources as any)?.readBytes?.();
        const instructions = (resources as any)?.instructions?.();
        const readOnlyCount = ledgerFootprint?.readOnly?.().length ?? 0;
        const readWriteCount = ledgerFootprint?.readWrite?.().length ?? 0;

        output.instructions = instructions?.toString?.() ?? instructions ?? null;
        output.diskReadBytes = readBytes?.toString?.() ?? readBytes ?? null;
        output.writeBytes = totalBytes?.toString?.() ?? totalBytes ?? null;
        output.readOnlyEntries = readOnlyCount;
        output.readWriteEntries = readWriteCount;
        output.resourceFee = (sorobanMeta as any)?.resourceFee?.()?.toString?.() ?? null;
      }
    }
  } catch {
    // Best effort only.
  }

  if (typeof (response as any).minResourceFee === 'string' || typeof (response as any).minResourceFee === 'number') {
    output.minResourceFee = String((response as any).minResourceFee);
  }

  if (typeof (response as any).feeBump === 'boolean') {
    output.feeBump = (response as any).feeBump;
  }

  if (typeof (response as any).feeCharged === 'string' || typeof (response as any).feeCharged === 'number') {
    output.feeCharged = String((response as any).feeCharged);
  }

  return output;
}

function extractDiagnosticEvents(response: rpc.Api.GetTransactionResponse): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];

  try {
    const metaXdr = (response as any).resultMetaXdr;
    if (!metaXdr) {
      return output;
    }

    const meta = xdr.TransactionMeta.fromXDR(metaXdr, 'base64');
    const versioned = (meta as any).v3?.();
    const sorobanMeta = versioned?.sorobanMeta?.();
    const events = sorobanMeta?.events?.() ?? [];

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const topicValues = (event.topic ?? []).map((topic: xdr.ScVal) => decodeScVal(topic));
      const value = decodeScVal(event.data ?? event.value ?? undefined);
      output.push({
        index,
        type: event.type?.() ? event.type().name : 'diagnostic',
        contractId: event.contractId ? String(event.contractId()) : undefined,
        topics: topicValues,
        data: value,
      });
    }
  } catch {
    // Best effort only.
  }

  return output;
}

function extractContractEvents(response: rpc.Api.GetTransactionResponse): DecodedSorobanEvent[] {
  const recorded: DecodedSorobanEvent[] = [];

  try {
    const metaXdr = (response as any).resultMetaXdr;
    if (!metaXdr) {
      return recorded;
    }

    const meta = xdr.TransactionMeta.fromXDR(metaXdr, 'base64');
    const versioned = (meta as any).v3?.();
    const sorobanMeta = versioned?.sorobanMeta?.();
    const events = sorobanMeta?.events?.() ?? [];

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const contractId = event.contractId ? String(event.contractId()) : undefined;
      const topics = (event.topic ?? []).map((topic: xdr.ScVal) => decodeScVal(topic));
      const data = decodeScVal(event.data ?? event.value ?? undefined);

      recorded.push({
        index,
        type: event.type?.() ? event.type().name : 'contract',
        contractId,
        topics,
        data,
        inSuccessfulContractCall: event.inSuccessfulContractCall !== false,
      });
    }
  } catch {
    // Best effort only.
  }

  return recorded;
}

function extractApplicationReturnValue(response: rpc.Api.GetTransactionResponse): unknown {
  if ((response as any).returnValue !== undefined) {
    return safeJsonValue((response as any).returnValue);
  }

  try {
    if ((response as any).resultXdr) {
      const result = xdr.TransactionResult.fromXDR((response as any).resultXdr, 'base64');
      const switchVal = result.result().switch();
      if (switchVal.name === 'txSuccess') {
        const txResult = result.result().value();
        return txResult ? safeJsonValue(txResult) : null;
      }
    }
  } catch {
    // Best effort only.
  }

  return null;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function buildTransactionReport(
  hash: string,
  response: rpc.Api.GetTransactionResponse,
  networkPassphrase: string,
): SorobanTransactionReport {
  const resultXdr = (response as any).resultXdr ?? null;
  const envelopeXdr = (response as any).envelopeXdr ?? null;
  const resultMetaXdr = (response as any).resultMetaXdr ?? null;
  const feeMetaXdr = (response as any).feeMetaXdr ?? null;

  let resultCode: string | null = null;
  let feeCharged: string | null = null;

  if (resultXdr) {
    try {
      const txResult = xdr.TransactionResult.fromXDR(resultXdr, 'base64');
      resultCode = txResult.result().switch().name ?? null;
      feeCharged = txResult.feeCharged().toString();
    } catch {
      // keep best-effort values.
    }
  }

  const report: SorobanTransactionReport = {
    hash,
    status: String((response as any).status ?? 'UNKNOWN'),
    rpcStatus: String((response as any).status ?? 'UNKNOWN'),
    ledger: typeof (response as any).ledger === 'number' ? (response as any).ledger : null,
    ledgerCloseTime:
      typeof (response as any).createdAt === 'string'
        ? (response as any).createdAt
        : typeof (response as any).closedAt === 'string'
          ? (response as any).closedAt
          : null,
    applicationReturnValue: extractApplicationReturnValue(response),
    resultXdr,
    transactionEnvelopeXdr: envelopeXdr,
    feeCharged,
    feeBump: Boolean((response as any).feeBump),
    resourceInfo: extractResourceInfo(response),
    resultCode,
    contractEvents: extractContractEvents(response),
    diagnosticEvents: extractDiagnosticEvents(response),
    raw: {
      resultXdr,
      resultMetaXdr,
      envelopeXdr,
      feeMetaXdr,
    },
  };

  if (networkPassphrase) {
    report.raw = {
      ...report.raw,
      networkPassphrase,
    } as any;
  }

  return report;
}

function printReport(report: SorobanTransactionReport, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(chalk.bold('\n=== Soroban Transaction Inspection Report ==='));
  console.log(`${chalk.bold('Hash:')} ${report.hash}`);
  console.log(`${chalk.bold('Status:')} ${report.status}`);
  console.log(`${chalk.bold('Ledger:')} ${report.ledger ?? 'n/a'}`);
  console.log(`${chalk.bold('Close time:')} ${report.ledgerCloseTime ?? 'n/a'}`);
  console.log(`${chalk.bold('Result code:')} ${report.resultCode ?? 'n/a'}`);
  console.log(`${chalk.bold('Fee charged:')} ${report.feeCharged ?? 'n/a'} stroops`);
  console.log(`${chalk.bold('Fee bump:')} ${report.feeBump ? 'yes' : 'no'}`);

  console.log(chalk.bold('\n--- Return value ---'));
  console.log(JSON.stringify(report.applicationReturnValue, null, 2));

  console.log(chalk.bold('\n--- Resource info ---'));
  console.log(JSON.stringify(report.resourceInfo, null, 2));

  console.log(chalk.bold('\n--- Contract events ---'));
  if (report.contractEvents.length === 0) {
    console.log(chalk.gray('none'));
  } else {
    for (const event of report.contractEvents) {
      console.log(`Event[${event.index}] type=${event.type} contract=${event.contractId ?? 'n/a'}`);
      console.log(`  topics: ${JSON.stringify(event.topics, null, 2)}`);
      console.log(`  data: ${JSON.stringify(event.data, null, 2)}`);
    }
  }

  console.log(chalk.bold('\n--- Diagnostic events ---'));
  if (report.diagnosticEvents.length === 0) {
    console.log(chalk.gray('none'));
  } else {
    console.log(JSON.stringify(report.diagnosticEvents, null, 2));
  }

  console.log(chalk.bold('\n--- Raw XDR ---'));
  console.log(`resultXdr: ${report.raw.resultXdr ? report.raw.resultXdr.slice(0, 80) + '…' : 'n/a'}`);
  console.log(`envelopeXdr: ${report.raw.envelopeXdr ? report.raw.envelopeXdr.slice(0, 80) + '…' : 'n/a'}`);
  console.log(`resultMetaXdr: ${report.raw.resultMetaXdr ? report.raw.resultMetaXdr.slice(0, 80) + '…' : 'n/a'}`);
}

export async function run(params: SorobanTransactionInspectionParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl?.trim() || process.env.SOROBAN_RPC_URL?.trim() || DEFAULT_RPC_URL;
  const networkPassphrase =
    params.networkPassphrase?.trim() || process.env.NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;

  const suppliedHash = params.transactionHash?.trim() || process.env.TRANSACTION_HASH?.trim() || process.argv[3]?.trim();

  const pollIntervalMs = normalizePositiveInteger(
    params.pollIntervalMs ?? process.env.POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
  );

  const pollTimeoutMs = normalizePositiveInteger(
    params.pollTimeoutMs ?? process.env.POLL_TIMEOUT_MS,
    DEFAULT_POLL_TIMEOUT_MS,
  );

  const jsonOutput = params.json === true || process.env.JSON_OUTPUT === 'true' || process.argv.includes('--json');
  const shouldPollUntilFinal = params.pollUntilFinal ?? true;

  if (!suppliedHash) {
    const message = 'Missing transaction hash. Supply a 64-character Stellar Soroban transaction hash.';
    if (jsonOutput) {
      console.log(JSON.stringify({ error: message }));
    } else {
      console.error(chalk.red(message));
    }
    return;
  }

  if (!isValidTransactionHash(suppliedHash)) {
    const message = `Invalid transaction hash: "${suppliedHash}". Expected exactly 64 hexadecimal characters.`;
    if (jsonOutput) {
      console.log(JSON.stringify({ error: message }));
    } else {
      console.error(chalk.red(message));
    }
    return;
  }

  const server = new rpc.Server(rpcUrl);

  try {
    const latestLedger = await server.getLatestLedger();
    if (!jsonOutput) {
      console.log(chalk.bold('\nSoroban Transaction Inspection Example'));
      console.log(chalk.gray(`RPC: ${rpcUrl}`));
      console.log(chalk.gray(`Network: ${networkPassphrase}`));
      console.log(chalk.gray(`Latest ledger: ${latestLedger.sequence}`));
    }
  } catch (error: unknown) {
    const message = `RPC connection failed: ${getErrorMessage(error)}`;
    if (jsonOutput) {
      console.log(JSON.stringify({ error: message }));
    } else {
      console.error(chalk.red(message));
    }
    return;
  }

  let response: rpc.Api.GetTransactionResponse;

  try {
    response = shouldPollUntilFinal
      ? await pollForTerminalTransaction(server, suppliedHash, {
          intervalMs: pollIntervalMs,
          timeoutMs: pollTimeoutMs,
        })
      : await server.getTransaction(suppliedHash);
  } catch (error: unknown) {
    const message = `Unable to fetch transaction ${suppliedHash}: ${getErrorMessage(error)}`;
    if (jsonOutput) {
      console.log(JSON.stringify({ error: message }));
    } else {
      console.error(chalk.red(message));
    }
    return;
  }

  const report = buildTransactionReport(suppliedHash, response, networkPassphrase);

  if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    report.error = 'Transaction is not currently available from this RPC node. It may still be pending or outside this node\'s retained ledger window.';
  }

  printReport(report, jsonOutput);
}

async function pollForTerminalTransaction(
  server: rpc.Server,
  hash: string,
  options: { intervalMs: number; timeoutMs: number },
): Promise<rpc.Api.GetTransactionResponse> {
  const startedAt = Date.now();

  while (true) {
    const response = await server.getTransaction(hash);

    if (
      response.status === rpc.Api.GetTransactionStatus.SUCCESS ||
      response.status === rpc.Api.GetTransactionStatus.FAILED
    ) {
      return response;
    }

    if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= options.timeoutMs) {
        return response;
      }
      await sleep(Math.min(options.intervalMs, options.timeoutMs - elapsed));
      continue;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= options.timeoutMs) {
      return response;
    }

    await sleep(Math.min(options.intervalMs, options.timeoutMs - elapsed));
  }
}
