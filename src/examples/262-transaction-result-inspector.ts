import {
  Address,
  FeeBumpTransaction,
  Horizon,
  Networks,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from 'stellar-sdk-v16';
import chalk from 'chalk';

/**
 * ISSUE-420: Stellar Transaction Return Value and Diagnostic Metadata Inspector
 *
 * A transaction being included in a ledger does not prove that every expected
 * application-level outcome happened. This example retrieves a transaction,
 * decodes its result XDR and metadata, extracts Soroban return values and
 * diagnostic events, and produces a structured execution report.
 *
 * The implementation is split into four independent stages:
 *
 *   1. Retrieval   - Horizon or Soroban RPC, behind a small provider interface.
 *   2. Decoding    - result XDR, TransactionMeta, the submitted envelope.
 *   3. Normalizing - JSON-safe values, ledger change summaries, diagnostics.
 *   4. Reporting   - a human-readable report and a JSON export.
 *
 * Original XDR strings are preserved on the report so callers can re-inspect
 * them with other tooling.
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

/** Metadata versions understood by the installed Stellar SDK. */
export const SUPPORTED_METADATA_VERSIONS = [0, 1, 2, 3, 4];

const SOROBAN_OPERATION_TYPES = new Set([
  'invokeHostFunction',
  'extendFootprintTtl',
  'restoreFootprint',
]);

const LEDGER_CHANGE_KINDS = ['created', 'updated', 'removed', 'state', 'restored'] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RetrievalSource = 'horizon' | 'rpc';

export type TransactionType = 'classic' | 'soroban' | 'unknown';

export type RetrievalStatus =
  'retrieved' | 'not-found' | 'request-failed' | 'invalid-hash' | 'skipped';

export type DecodingStatus = 'decoded' | 'unavailable' | 'invalid';

export type MetadataStatus = 'decoded' | 'unavailable' | 'unsupported' | 'invalid';

export type LedgerChangeKind = (typeof LEDGER_CHANGE_KINDS)[number] | 'unknown';

export interface InspectorWarning {
  field: string;
  message: string;
}

export interface FormattedScVal {
  xdrType: string;
  native: unknown;
  xdr: string;
  decoded: boolean;
  error: string | null;
}

export interface OperationResultSummary {
  index: number;
  operationType: string | null;
  outerResult: string;
  code: string | null;
  success: boolean;
  detail: string | null;
}

export interface DecodedTransactionResult {
  status: DecodingStatus;
  code: string | null;
  successful: boolean | null;
  transactionLevelFailure: boolean;
  feeCharged: string | null;
  feeBumpInnerResult: boolean;
  operationResults: OperationResultSummary[];
  xdr: string | null;
  warnings: InspectorWarning[];
}

export interface LedgerChangeSummary {
  kind: LedgerChangeKind;
  entryType: string;
  label: string;
}

export interface ContractEventSummary {
  index: number;
  stage: string | null;
  type: string;
  contractId: string | null;
  topics: string[];
  data: string;
}

export interface DiagnosticEventSummary extends ContractEventSummary {
  inSuccessfulContractCall: boolean;
  error: string | null;
}

export interface SorobanMetadataSummary {
  present: boolean;
  returnValue: FormattedScVal | null;
  contractEvents: ContractEventSummary[];
  diagnosticEvents: DiagnosticEventSummary[];
}

export interface DecodedMetadata {
  status: MetadataStatus;
  version: number | null;
  changes: LedgerChangeSummary[];
  changeCounts: Record<LedgerChangeKind, number>;
  hasChanges: boolean;
  soroban: SorobanMetadataSummary;
  xdr: string | null;
  warnings: InspectorWarning[];
}

export interface SorobanResourceInfo {
  source: 'envelope';
  instructions: number;
  diskReadBytes: number;
  writeBytes: number;
  resourceFee: string;
  readOnlyEntries: number;
  readWriteEntries: number;
}

export interface EnvelopeSummary {
  decoded: boolean;
  feeBump: boolean;
  sourceAccount: string | null;
  operationTypes: string[];
  hash: string | null;
  xdr: string | null;
  warnings: InspectorWarning[];
}

export interface SorobanExecutionSummary {
  applicable: boolean;
  returnValue: FormattedScVal | null;
  contractEvents: ContractEventSummary[];
  diagnosticEvents: DiagnosticEventSummary[];
  contractFailures: string[];
  resourceInfo: SorobanResourceInfo | null;
}

export interface RetrievalSummary {
  status: RetrievalStatus;
  source: RetrievalSource | null;
  endpoint: string | null;
  error: string | null;
}

export interface ExecutionReport {
  transactionHash: string;
  networkPassphrase: string | null;
  network: string | null;
  retrieval: RetrievalSummary;
  ledger: number | null;
  successful: boolean | null;
  transactionType: TransactionType;
  feeBump: boolean;
  envelope: EnvelopeSummary | null;
  result: DecodedTransactionResult;
  metadata: DecodedMetadata;
  soroban: SorobanExecutionSummary;
  unavailable: string[];
  warnings: InspectorWarning[];
}

export interface RetrievedTransaction {
  source: RetrievalSource;
  endpoint: string;
  hash: string;
  ledger: number | null;
  successful: boolean | null;
  envelopeXdr: string | null;
  resultXdr: string | null;
  resultMetaXdr: string | null;
  warnings: InspectorWarning[];
}

export interface TransactionDataProvider {
  readonly source: RetrievalSource;
  readonly endpoint: string;
  fetchTransaction(hash: string): Promise<RetrievedTransaction>;
}

export interface InspectionOptions {
  /** `auto` tries Horizon first, then Soroban RPC when a hash is not found. */
  source?: 'auto' | RetrievalSource;
  horizonUrl?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
}

export interface InspectorParams {
  transactionHash?: string;
  horizonUrl?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  source?: string;
  json?: boolean | string;
}

/** Raised by providers when an endpoint has no record for the hash. */
export class TransactionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Stage 1: retrieval
// ---------------------------------------------------------------------------

export function isValidTransactionHash(hash: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(hash.trim());
}

export function createHorizonProvider(horizonUrl: string): TransactionDataProvider {
  const endpoint = horizonUrl.trim();

  return {
    source: 'horizon',
    endpoint,
    async fetchTransaction(hash: string): Promise<RetrievedTransaction> {
      const server = new Horizon.Server(endpoint);

      let record: Record<string, unknown>;

      try {
        record = (await server.transactions().transaction(hash).call()) as unknown as Record<
          string,
          unknown
        >;
      } catch (error: unknown) {
        if (isHttpNotFound(error)) {
          throw new TransactionNotFoundError(
            `Horizon has no transaction record for ${hash} at ${endpoint}.`,
          );
        }

        throw new Error(`Horizon request failed: ${getErrorMessage(error)}`);
      }

      const warnings: InspectorWarning[] = [];
      const resultXdr = optionalString(record.result_xdr);
      const resultMetaXdr = optionalString(record.result_meta_xdr);
      const envelopeXdr = optionalString(record.envelope_xdr);

      if (!resultXdr) {
        warnings.push({
          field: 'resultXdr',
          message: 'Horizon did not return result_xdr for this transaction.',
        });
      }

      if (!resultMetaXdr) {
        warnings.push({
          field: 'resultMetaXdr',
          message: 'Horizon did not return result_meta_xdr for this transaction.',
        });
      }

      return {
        source: 'horizon',
        endpoint,
        hash: optionalString(record.hash) ?? hash,
        ledger: optionalNumber(record.ledger),
        successful: typeof record.successful === 'boolean' ? record.successful : null,
        envelopeXdr,
        resultXdr,
        resultMetaXdr,
        warnings,
      };
    },
  };
}

export function createRpcProvider(rpcUrl: string): TransactionDataProvider {
  const endpoint = rpcUrl.trim();

  return {
    source: 'rpc',
    endpoint,
    async fetchTransaction(hash: string): Promise<RetrievedTransaction> {
      const server = new rpc.Server(endpoint);

      let response: unknown;

      try {
        response = await server.getTransaction(hash);
      } catch (error: unknown) {
        throw new Error(`Soroban RPC request failed: ${getErrorMessage(error)}`);
      }

      const record = response as Record<string, unknown>;
      const status = String(record.status ?? '');

      if (status === rpc.Api.GetTransactionStatus.NOT_FOUND || status === 'NOT_FOUND') {
        throw new TransactionNotFoundError(
          `Soroban RPC has no terminal transaction record for ${hash} at ${endpoint}.`,
        );
      }

      const warnings: InspectorWarning[] = [];

      const resultXdr = toBase64Xdr(record.resultXdr);
      const resultMetaXdr = toBase64Xdr(record.resultMetaXdr);
      const envelopeXdr = toBase64Xdr(record.envelopeXdr);

      if (!resultXdr) {
        warnings.push({
          field: 'resultXdr',
          message: 'Soroban RPC did not return decodable result XDR.',
        });
      }

      if (!resultMetaXdr) {
        warnings.push({
          field: 'resultMetaXdr',
          message:
            'Soroban RPC did not return result metadata. Older RPC nodes may omit it or it may have been pruned.',
        });
      }

      return {
        source: 'rpc',
        endpoint,
        hash: typeof record.txHash === 'string' ? record.txHash : hash,
        ledger: optionalNumber(record.ledger),
        successful:
          status === rpc.Api.GetTransactionStatus.SUCCESS || status === 'SUCCESS'
            ? true
            : status === rpc.Api.GetTransactionStatus.FAILED || status === 'FAILED'
              ? false
              : null,
        envelopeXdr,
        resultXdr,
        resultMetaXdr,
        warnings,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 2: decoding
// ---------------------------------------------------------------------------

export function decodeTransactionResult(
  resultXdr: string | null | undefined,
): DecodedTransactionResult {
  const warnings: InspectorWarning[] = [];

  if (!resultXdr || resultXdr.trim().length === 0) {
    return {
      status: 'unavailable',
      code: null,
      successful: null,
      transactionLevelFailure: false,
      feeCharged: null,
      feeBumpInnerResult: false,
      operationResults: [],
      xdr: null,
      warnings: [
        {
          field: 'resultXdr',
          message: 'Result XDR is unavailable for this transaction at the selected endpoint.',
        },
      ],
    };
  }

  let result: xdr.TransactionResult;

  try {
    result = xdr.TransactionResult.fromXDR(resultXdr.trim(), 'base64');
  } catch (error: unknown) {
    return {
      status: 'invalid',
      code: null,
      successful: null,
      transactionLevelFailure: false,
      feeCharged: null,
      feeBumpInnerResult: false,
      operationResults: [],
      xdr: resultXdr,
      warnings: [
        {
          field: 'resultXdr',
          message: `Result XDR could not be decoded: ${getErrorMessage(error)}`,
        },
      ],
    };
  }

  const feeCharged = safeCall(() => result.feeCharged().toString(), null);

  const outerResult = result.result();
  let resultBody: xdr.TransactionResultResult | xdr.InnerTransactionResultResult = outerResult;
  let feeBumpInnerResult = false;

  const outerCode = outerResult.switch().name;

  /*
   * Fee-bump envelopes wrap the inner transaction result. The operation-level
   * results of a fee-bump transaction live inside the inner result pair.
   */
  if (outerCode === 'txFeeBumpInnerSuccess' || outerCode === 'txFeeBumpInnerFailed') {
    feeBumpInnerResult = true;

    const innerPair = safeCall(() => outerResult.innerResultPair(), null);
    const innerResult = innerPair ? safeCall(() => innerPair.result(), null) : null;

    if (innerResult) {
      resultBody = innerResult.result();
    } else {
      warnings.push({
        field: 'resultXdr',
        message: 'Fee-bump inner transaction result could not be extracted.',
      });
    }
  }

  const code = resultBody.switch().name;
  const successful = code === 'txSuccess';

  /*
   * Only txSuccess and txFailed carry per-operation results. Every other
   * transaction result code is a validation failure: no operation ran.
   */
  const hasOperationResults = code === 'txSuccess' || code === 'txFailed';

  const operationResults: OperationResultSummary[] = [];

  if (hasOperationResults) {
    const rawResults = safeCall(() => resultBody.results() as xdr.OperationResult[], []);

    rawResults.forEach((operationResult, index) => {
      operationResults.push(decodeOperationResult(operationResult, index, warnings));
    });
  }

  return {
    status: 'decoded',
    code,
    successful,
    transactionLevelFailure: !hasOperationResults,
    feeCharged,
    feeBumpInnerResult,
    operationResults,
    xdr: resultXdr,
    warnings,
  };
}

export function decodeTransactionMetadata(
  resultMetaXdr: string | null | undefined,
): DecodedMetadata {
  const emptySoroban = (): SorobanMetadataSummary => ({
    present: false,
    returnValue: null,
    contractEvents: [],
    diagnosticEvents: [],
  });

  const emptyCounts = (): Record<LedgerChangeKind, number> => ({
    created: 0,
    updated: 0,
    removed: 0,
    state: 0,
    restored: 0,
    unknown: 0,
  });

  if (!resultMetaXdr || resultMetaXdr.trim().length === 0) {
    return {
      status: 'unavailable',
      version: null,
      changes: [],
      changeCounts: emptyCounts(),
      hasChanges: false,
      soroban: emptySoroban(),
      xdr: null,
      warnings: [
        {
          field: 'resultMetaXdr',
          message: 'Transaction metadata is unavailable for this transaction.',
        },
      ],
    };
  }

  const warnings: InspectorWarning[] = [];
  const version = peekMetadataVersion(resultMetaXdr);

  /*
   * The installed SDK can only parse metadata versions it knows. Reading the
   * union discriminant lets us report "unsupported version" instead of a
   * generic parse failure, without hand-decoding any metadata contents.
   */
  if (version !== null && !SUPPORTED_METADATA_VERSIONS.includes(version)) {
    return {
      status: 'unsupported',
      version,
      changes: [],
      changeCounts: emptyCounts(),
      hasChanges: false,
      soroban: emptySoroban(),
      xdr: resultMetaXdr,
      warnings: [
        {
          field: 'resultMetaXdr',
          message:
            `Transaction metadata version ${version} is not supported by the installed Stellar SDK ` +
            `(supported versions: ${SUPPORTED_METADATA_VERSIONS.join(', ')}).`,
        },
      ],
    };
  }

  let meta: xdr.TransactionMeta;

  try {
    meta = xdr.TransactionMeta.fromXDR(resultMetaXdr.trim(), 'base64');
  } catch (error: unknown) {
    return {
      status: 'invalid',
      version,
      changes: [],
      changeCounts: emptyCounts(),
      hasChanges: false,
      soroban: emptySoroban(),
      xdr: resultMetaXdr,
      warnings: [
        {
          field: 'resultMetaXdr',
          message: `Transaction metadata could not be decoded: ${getErrorMessage(error)}`,
        },
      ],
    };
  }

  const metaVersion = meta.switch();
  const changeGroups: xdr.LedgerEntryChange[][] = [];
  const soroban = emptySoroban();

  if (metaVersion === 0) {
    changeGroups.push(...operationChanges(meta.operations()));
  } else if (metaVersion === 1) {
    const v1 = meta.v1();
    changeGroups.push(v1.txChanges(), ...operationChanges(v1.operations()));
  } else if (metaVersion === 2) {
    const v2 = meta.v2();
    changeGroups.push(v2.txChangesBefore(), ...operationChanges(v2.operations()));
    changeGroups.push(v2.txChangesAfter());
  } else if (metaVersion === 3) {
    const v3 = meta.v3();
    changeGroups.push(v3.txChangesBefore(), ...operationChanges(v3.operations()));
    changeGroups.push(v3.txChangesAfter());

    const sorobanMeta = v3.sorobanMeta();

    if (sorobanMeta) {
      soroban.present = true;
      soroban.returnValue = formatScVal(sorobanMeta.returnValue());
      soroban.contractEvents = summarizeContractEvents(sorobanMeta.events(), null);
      soroban.diagnosticEvents = summarizeDiagnosticEvents(sorobanMeta.diagnosticEvents());
    }
  } else if (metaVersion === 4) {
    const v4 = meta.v4();
    changeGroups.push(v4.txChangesBefore());

    v4.operations().forEach((operation) => {
      changeGroups.push(operation.changes());
    });

    changeGroups.push(v4.txChangesAfter());

    const sorobanMeta = v4.sorobanMeta();

    if (sorobanMeta) {
      soroban.present = true;

      const returnValue = sorobanMeta.returnValue();

      if (returnValue) {
        soroban.returnValue = formatScVal(returnValue);
      }
    }

    /*
     * Version 4 moves contract events to two places: the operation meta and
     * the transaction-level event list. Both are reported.
     */
    const operationEvents = v4.operations().flatMap((operation) => operation.events());

    soroban.contractEvents = [
      ...summarizeContractEvents(
        v4.events().map((transactionEvent) => transactionEvent.event()),
        v4.events(),
      ),
      ...summarizeContractEvents(operationEvents, null).map((event) => ({
        ...event,
        index: event.index + v4.events().length,
      })),
    ];

    soroban.diagnosticEvents = summarizeDiagnosticEvents(v4.diagnosticEvents());
  } else {
    warnings.push({
      field: 'resultMetaXdr',
      message: `Transaction metadata version ${metaVersion} has no known decoder in this example.`,
    });
  }

  const changes: LedgerChangeSummary[] = [];
  const changeCounts = emptyCounts();

  changeGroups.forEach((group) => {
    group.forEach((change) => {
      const summary = summarizeLedgerChange(change);

      changes.push(summary);
      changeCounts[summary.kind] += 1;
    });
  });

  return {
    status: 'decoded',
    version: metaVersion,
    changes,
    changeCounts,
    hasChanges: changes.length > 0,
    soroban,
    xdr: resultMetaXdr,
    warnings,
  };
}

export function inspectEnvelope(
  envelopeXdr: string | null | undefined,
  networkPassphrase: string,
): EnvelopeSummary | null {
  if (!envelopeXdr || envelopeXdr.trim().length === 0) {
    return null;
  }

  const warnings: InspectorWarning[] = [];

  try {
    const parsed = TransactionBuilder.fromXDR(envelopeXdr.trim(), networkPassphrase);
    const feeBump = parsed instanceof FeeBumpTransaction;
    const inner = feeBump ? parsed.innerTransaction : parsed;

    return {
      decoded: true,
      feeBump,
      sourceAccount: inner.source ?? null,
      operationTypes: inner.operations.map((operation) => operation.type),
      hash: safeCall(() => parsed.hash().toString('hex'), null),
      xdr: envelopeXdr,
      warnings,
    };
  } catch (error: unknown) {
    warnings.push({
      field: 'envelopeXdr',
      message:
        'The submitted envelope could not be decoded. Transaction type falls back to the ' +
        `available result data: ${getErrorMessage(error)}`,
    });

    return {
      decoded: false,
      feeBump: false,
      sourceAccount: null,
      operationTypes: [],
      hash: null,
      xdr: envelopeXdr,
      warnings,
    };
  }
}

// ---------------------------------------------------------------------------
// Stage 3: normalization
// ---------------------------------------------------------------------------

export function formatScVal(value: xdr.ScVal): FormattedScVal {
  const xdrType = safeCall(() => value.switch().name, 'unknown');
  const rawXdr = safeCall(() => value.toXDR('base64'), '');

  if (xdrType === 'scvError') {
    const error = safeCall(() => formatScError(value.error()), 'ScError(undecodable)');

    return {
      xdrType,
      native: error,
      xdr: rawXdr,
      decoded: true,
      error,
    };
  }

  try {
    return {
      xdrType,
      native: toJsonSafe(scValToNative(value)),
      xdr: rawXdr,
      decoded: true,
      error: null,
    };
  } catch (error: unknown) {
    return {
      xdrType,
      native: null,
      xdr: rawXdr,
      decoded: false,
      error: getErrorMessage(error),
    };
  }
}

export function formatScError(error: xdr.ScError): string {
  const type = safeCall(() => error.switch().name, 'unknown');

  if (type === 'sceContract') {
    return `ContractError(code=${safeCall(() => error.contractCode(), -1)})`;
  }

  const code = safeCall(() => error.code().name, 'unknown');

  return `ScError(type=${type}, code=${code})`;
}

/**
 * Convert SDK-native values into JSON-serializable data.
 */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString('hex')}`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item));
  }

  if (value instanceof Map) {
    return Array.from(value.entries()).map(([key, item]) => [toJsonSafe(key), toJsonSafe(item)]);
  }

  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};

    Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
      output[key] = toJsonSafe(item);
    });

    return output;
  }

  return value;
}

export const LEDGER_CHANGE_KIND_BY_NAME: Record<string, LedgerChangeKind> = {
  ledgerEntryCreated: 'created',
  ledgerEntryUpdated: 'updated',
  ledgerEntryRemoved: 'removed',
  ledgerEntryState: 'state',
  ledgerEntryRestored: 'restored',
};

function summarizeLedgerChange(change: xdr.LedgerEntryChange): LedgerChangeSummary {
  const kindName = safeCall(() => change.switch().name, 'unknown');
  const kind: LedgerChangeKind = LEDGER_CHANGE_KIND_BY_NAME[kindName] ?? 'unknown';

  try {
    if (kind === 'removed') {
      const key = change.removed();

      return {
        kind,
        entryType: key.switch().name,
        label: describeLedgerKey(key),
      };
    }

    /*
     * Reading a union arm that is not selected throws, so each kind reads only
     * its own arm instead of chaining optional calls.
     */
    const entry =
      kind === 'created'
        ? change.created()
        : kind === 'updated'
          ? change.updated()
          : kind === 'state'
            ? change.state()
            : kind === 'restored'
              ? change.restored()
              : null;

    if (!entry) {
      return { kind, entryType: 'unknown', label: '(unavailable ledger entry)' };
    }

    return {
      kind,
      entryType: entry.data().switch().name,
      label: describeLedgerEntry(entry),
    };
  } catch (error: unknown) {
    return {
      kind,
      entryType: 'unknown',
      label: `(undecodable change: ${getErrorMessage(error)})`,
    };
  }
}

export function summarizeContractEvents(
  events: xdr.ContractEvent[],
  transactionEvents: xdr.TransactionEvent[] | null,
): ContractEventSummary[] {
  return events.map((event, index) => {
    const stage = safeCall(() => transactionEvents?.[index]?.stage().name ?? null, null);

    const topics: string[] = [];
    let data = '';
    let type = 'unknown';
    let contractId: string | null = null;

    try {
      type = event.type().name;
      topics.push(
        ...event
          .body()
          .v0()
          .topics()
          .map((topic) => formatScValText(topic)),
      );
      data = formatScValText(event.body().v0().data());
      contractId = event.contractId()
        ? Address.fromScAddress(contractAddress(event)).toString()
        : null;
    } catch {
      // Malformed events are still reported, with whatever was decoded.
    }

    return { index, stage, type, contractId, topics, data };
  });
}

export function summarizeDiagnosticEvents(events: xdr.DiagnosticEvent[]): DiagnosticEventSummary[] {
  return events.map((diagnostic, index) => {
    const summary: DiagnosticEventSummary = {
      index,
      stage: null,
      inSuccessfulContractCall: safeCall(() => diagnostic.inSuccessfulContractCall(), false),
      type: 'unknown',
      contractId: null,
      topics: [],
      data: '',
      error: null,
    };

    try {
      const event = diagnostic.event();
      const body = event.body().v0();

      summary.type = event.type().name;
      summary.topics = body.topics().map((topic) => formatScValText(topic));
      summary.data = formatScValText(body.data());
      summary.contractId = event.contractId()
        ? Address.fromScAddress(contractAddress(event)).toString()
        : null;

      if (body.data().switch().name === 'scvError') {
        summary.error = formatScError(body.data().error());
      }
    } catch (error: unknown) {
      summary.data = `(undecodable diagnostic event: ${getErrorMessage(error)})`;
    }

    return summary;
  });
}

export function extractResourceInfo(
  envelopeXdr: string | null | undefined,
  networkPassphrase: string,
): SorobanResourceInfo | null {
  if (!envelopeXdr || envelopeXdr.trim().length === 0) {
    return null;
  }

  try {
    const parsed = TransactionBuilder.fromXDR(envelopeXdr.trim(), networkPassphrase);
    const envelope = parsed.toEnvelope();
    const envelopeType = envelope.switch().name;

    let transaction: xdr.Transaction | null = null;

    if (envelopeType === 'envelopeTypeTx') {
      transaction = envelope.v1().tx();
    } else if (envelopeType === 'envelopeTypeTxFeeBump') {
      transaction = envelope.feeBump().tx().innerTx().v1().tx();
    }

    if (!transaction) {
      return null;
    }

    const extension = transaction.ext();

    if (extension.switch() !== 1) {
      return null;
    }

    const sorobanData = extension.sorobanData();

    const resources = sorobanData.resources();
    const footprint = resources.footprint();

    return {
      source: 'envelope',
      instructions: resources.instructions(),
      diskReadBytes: resources.diskReadBytes(),
      writeBytes: resources.writeBytes(),
      resourceFee: sorobanData.resourceFee().toString(),
      readOnlyEntries: footprint.readOnly().length,
      readWriteEntries: footprint.readWrite().length,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stage 4: reporting
// ---------------------------------------------------------------------------

export function inspectTransaction(
  transactionHash: string,
  options: InspectionOptions = {},
  providers: { horizon?: TransactionDataProvider; rpc?: TransactionDataProvider } = {},
): Promise<ExecutionReport> {
  return runInspection(transactionHash.trim(), options, providers);
}

async function runInspection(
  transactionHash: string,
  options: InspectionOptions,
  injected: { horizon?: TransactionDataProvider; rpc?: TransactionDataProvider },
): Promise<ExecutionReport> {
  const networkPassphrase =
    options.networkPassphrase?.trim() || process.env.NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;

  if (!isValidTransactionHash(transactionHash)) {
    return emptyReport(transactionHash, networkPassphrase, {
      status: 'invalid-hash',
      source: null,
      endpoint: null,
      error: 'A transaction hash must be exactly 64 hexadecimal characters.',
    });
  }

  const horizonUrl =
    options.horizonUrl?.trim() || process.env.HORIZON_URL?.trim() || DEFAULT_HORIZON_URL;
  const rpcUrl = options.rpcUrl?.trim() || process.env.SOROBAN_RPC_URL?.trim() || DEFAULT_RPC_URL;

  const horizon = injected.horizon ?? createHorizonProvider(horizonUrl);
  const rpcProvider = injected.rpc ?? createRpcProvider(rpcUrl);

  const order: TransactionDataProvider[] =
    options.source === 'horizon'
      ? [horizon]
      : options.source === 'rpc'
        ? [rpcProvider]
        : [horizon, rpcProvider];

  let retrieved: RetrievedTransaction | null = null;
  let retrieval: RetrievalSummary = {
    status: 'skipped',
    source: null,
    endpoint: null,
    error: null,
  };

  for (const provider of order) {
    try {
      retrieved = await provider.fetchTransaction(transactionHash);

      retrieval = {
        status: 'retrieved',
        source: provider.source,
        endpoint: provider.endpoint,
        error: null,
      };

      break;
    } catch (error: unknown) {
      const notFound = error instanceof TransactionNotFoundError;

      retrieval = {
        status: notFound ? 'not-found' : 'request-failed',
        source: provider.source,
        endpoint: provider.endpoint,
        error: getErrorMessage(error),
      };

      /*
       * A transport or protocol failure means this endpoint could not answer.
       * With `auto` we still try the next endpoint; a not-found response also
       * falls through because retention windows differ between services.
       */
    }
  }

  const warnings: InspectorWarning[] = [];
  const unavailable: string[] = [];

  if (!retrieved) {
    if (retrieval.status === 'request-failed') {
      warnings.push({
        field: 'retrieval',
        message:
          'No endpoint returned transaction data. This is a retrieval failure, not a ' +
          'transaction failure.',
      });
    } else {
      warnings.push({
        field: 'retrieval',
        message:
          'The transaction was not found on the selected endpoint(s). It may still be ' +
          'pending, may belong to another network, or may be older than the retention window.',
      });
    }

    unavailable.push('transaction');

    return {
      ...emptyReport(transactionHash, networkPassphrase, retrieval),
      transactionType: 'unknown',
      unavailable,
      warnings,
    };
  }

  if (retrieved.hash.toLowerCase() !== transactionHash.toLowerCase()) {
    warnings.push({
      field: 'retrieval',
      message: `The endpoint returned transaction ${retrieved.hash}, which does not match the requested hash.`,
    });
  }

  warnings.push(...retrieved.warnings);

  const envelope = inspectEnvelope(retrieved.envelopeXdr, networkPassphrase);

  if (envelope) {
    warnings.push(...envelope.warnings);
  }

  const result = decodeTransactionResult(retrieved.resultXdr);
  const metadata = decodeTransactionMetadata(retrieved.resultMetaXdr);

  warnings.push(...result.warnings, ...metadata.warnings);

  const soroban = buildSorobanSummary(result, metadata, envelope, retrieved, networkPassphrase);

  const transactionType = detectTransactionType(envelope, result, metadata);

  if (!envelope && transactionType === 'unknown') {
    unavailable.push('envelope');
  }

  if (result.status !== 'decoded') {
    unavailable.push('result');
  }

  if (metadata.status === 'unavailable') {
    unavailable.push('metadata');
  } else if (metadata.status === 'unsupported') {
    unavailable.push(`metadata:v${metadata.version ?? '?'}`);
  }

  if (metadata.status === 'decoded' && !metadata.hasChanges) {
    warnings.push({
      field: 'resultMetaXdr',
      message:
        'Transaction metadata is available and decoded successfully, but it contains no ledger ' +
        'entry changes. This is different from metadata being unavailable.',
    });
  }

  if (transactionType !== 'soroban') {
    unavailable.push('soroban');
  } else {
    if (!soroban.returnValue) {
      unavailable.push('soroban.returnValue');
    }

    if (!soroban.resourceInfo) {
      unavailable.push('soroban.resourceInfo');
    }
  }

  return {
    transactionHash,
    networkPassphrase,
    network: networkName(networkPassphrase),
    retrieval,
    ledger: retrieved.ledger,
    successful: retrieved.successful,
    transactionType,
    feeBump: envelope?.feeBump ?? result.feeBumpInnerResult,
    envelope,
    result,
    metadata,
    soroban,
    unavailable,
    warnings,
  };
}

function emptyReport(
  transactionHash: string,
  networkPassphrase: string,
  retrieval: RetrievalSummary,
): ExecutionReport {
  return {
    transactionHash,
    networkPassphrase,
    network: networkName(networkPassphrase),
    retrieval,
    ledger: null,
    successful: null,
    transactionType: 'unknown',
    feeBump: false,
    envelope: null,
    result: decodeTransactionResult(null),
    metadata: decodeTransactionMetadata(null),
    soroban: {
      applicable: false,
      returnValue: null,
      contractEvents: [],
      diagnosticEvents: [],
      contractFailures: [],
      resourceInfo: null,
    },
    unavailable: ['transaction'],
    warnings: [],
  };
}

function buildSorobanSummary(
  result: DecodedTransactionResult,
  metadata: DecodedMetadata,
  envelope: EnvelopeSummary | null,
  retrieved: RetrievedTransaction,
  networkPassphrase: string,
): SorobanExecutionSummary {
  const applicable =
    detectTransactionType(envelope, result, metadata) === 'soroban' || metadata.soroban.present;

  const contractFailures: string[] = [];

  result.operationResults.forEach((operation) => {
    if (!operation.operationType || !SOROBAN_OPERATION_TYPES.has(operation.operationType)) {
      return;
    }

    if (!operation.success) {
      const detail = operation.code ? describeOperationFailure(operation.code) : null;

      contractFailures.push(
        `Operation [${operation.index}] ${operation.operationType} failed with ` +
          `${operation.code ?? operation.outerResult}${detail ? `: ${detail}` : '.'}`,
      );
    }
  });

  metadata.soroban.diagnosticEvents.forEach((event) => {
    if (event.error) {
      contractFailures.push(
        `Diagnostic event [${event.index}] reported ${event.error}` +
          (event.inSuccessfulContractCall
            ? ' during a successful call.'
            : ' during a failed call.'),
      );
    }
  });

  const returnValue = metadata.soroban.returnValue;

  if (returnValue && returnValue.decoded && returnValue.xdrType === 'scvError') {
    contractFailures.push(`The Soroban return value is an error: ${String(returnValue.native)}`);
  }

  return {
    applicable,
    returnValue,
    contractEvents: metadata.soroban.contractEvents,
    diagnosticEvents: metadata.soroban.diagnosticEvents,
    contractFailures,
    resourceInfo: extractResourceInfo(retrieved.envelopeXdr, networkPassphrase),
  };
}

function detectTransactionType(
  envelope: EnvelopeSummary | null,
  result: DecodedTransactionResult,
  metadata: DecodedMetadata,
): TransactionType {
  if (envelope?.decoded) {
    return envelope.operationTypes.some((type) => SOROBAN_OPERATION_TYPES.has(type))
      ? 'soroban'
      : 'classic';
  }

  if (
    result.operationResults.some(
      (operation) =>
        operation.operationType && SOROBAN_OPERATION_TYPES.has(operation.operationType),
    ) ||
    metadata.soroban.present
  ) {
    return 'soroban';
  }

  if (result.status === 'decoded' && result.operationResults.length > 0) {
    return 'classic';
  }

  return 'unknown';
}

export function formatExecutionReport(report: ExecutionReport): string {
  const lines: string[] = [];

  lines.push(chalk.bold('\n========== TRANSACTION EXECUTION REPORT =========='));
  lines.push(`Transaction hash : ${report.transactionHash}`);
  lines.push(`Network          : ${describeNetwork(report)}`);
  lines.push(`Retrieval        : ${describeRetrieval(report.retrieval)}`);
  lines.push(`Ledger           : ${report.ledger ?? '(not available)'}`);
  lines.push(`Included         : ${describeInclusion(report.successful)}`);
  lines.push(`Transaction type : ${report.transactionType}${report.feeBump ? ' (fee bump)' : ''}`);

  if (report.envelope?.sourceAccount) {
    lines.push(`Source account   : ${report.envelope.sourceAccount}`);
  }

  // -------------------------------------------------------------------------
  // Result
  // -------------------------------------------------------------------------
  lines.push(chalk.bold('\nOverall result'));
  lines.push(`  Result status      : ${report.result.status}`);
  lines.push(`  Result code        : ${report.result.code ?? '(not available)'}`);
  lines.push(`  Fee charged        : ${report.result.feeCharged ?? '(not available)'} stroops`);

  if (report.result.feeBumpInnerResult) {
    lines.push('  Fee-bump inner     : yes (results decoded from the inner transaction)');
  }

  if (report.result.transactionLevelFailure) {
    lines.push(
      '  Failure scope      : transaction-level (validation failed before any operation ran)',
    );
  }

  lines.push('  Operation results  :');

  if (report.result.operationResults.length === 0) {
    lines.push('    (none reported)');
  } else {
    report.result.operationResults.forEach((operation) => {
      const status = operation.success ? 'SUCCESS' : 'FAILED';
      const type = operation.operationType ?? 'unknown';

      lines.push(
        `    [${operation.index}] ${type} ${status}` +
          ` (outer=${operation.outerResult}${operation.code ? `, code=${operation.code}` : ''})`,
      );

      if (operation.detail) {
        lines.push(`        ${operation.detail}`);
      }
    });
  }

  lines.push(
    '  Note               : inclusion and txSuccess do not prove that an application-level ' +
      'business outcome was achieved; inspect operation results and return values.',
  );

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------
  lines.push(chalk.bold('\nTransaction metadata'));
  lines.push(`  Status             : ${report.metadata.status}`);
  lines.push(`  Metadata version   : ${report.metadata.version ?? '(not available)'}`);
  lines.push(
    `  Ledger changes     : ${report.metadata.changes.length}` +
      (report.metadata.hasChanges ? '' : ' (metadata decoded, no changes recorded)'),
  );

  if (report.metadata.changes.length > 0) {
    const counts = LEDGER_CHANGE_KINDS.map(
      (kind) => `${kind}=${report.metadata.changeCounts[kind]}`,
    )
      .filter((entry) => !entry.endsWith('=0'))
      .join(', ');

    lines.push(`  Change summary     : ${counts || '(none)'}`);

    report.metadata.changes.slice(0, 25).forEach((change) => {
      lines.push(`    - ${change.kind} ${change.entryType}: ${change.label}`);
    });

    if (report.metadata.changes.length > 25) {
      lines.push(`    ... ${report.metadata.changes.length - 25} more changes in the JSON export`);
    }
  }

  // -------------------------------------------------------------------------
  // Soroban
  // -------------------------------------------------------------------------
  lines.push(chalk.bold('\nSoroban execution'));
  lines.push(`  Applicable         : ${report.soroban.applicable ? 'yes' : 'no'}`);

  if (report.soroban.applicable) {
    lines.push(`  Return value       : ${describeReturnValue(report.soroban.returnValue)}`);
    lines.push(`  Contract events    : ${report.soroban.contractEvents.length}`);
    lines.push(`  Diagnostic events  : ${report.soroban.diagnosticEvents.length}`);

    report.soroban.diagnosticEvents.slice(0, 10).forEach((event) => {
      const status = event.inSuccessfulContractCall ? 'success' : 'failure';
      lines.push(
        `    [${event.index}] ${event.type} (${status}) topics=[${event.topics.join(', ')}]`,
      );

      if (event.data) {
        lines.push(`        data: ${event.data}`);
      }

      if (event.error) {
        lines.push(`        error: ${event.error}`);
      }
    });

    if (report.soroban.diagnosticEvents.length > 10) {
      lines.push('    ... additional diagnostic events in the JSON export');
    }

    if (report.soroban.contractFailures.length > 0) {
      lines.push('  Execution failure details:');
      report.soroban.contractFailures.forEach((failure) => {
        lines.push(`    - ${failure}`);
      });
    } else {
      lines.push('  Execution failure details: none detected');
    }

    if (report.soroban.resourceInfo) {
      const resources = report.soroban.resourceInfo;

      lines.push('  Prepared resource limits (from the submitted envelope, not actual usage):');
      lines.push(`    Instructions       : ${resources.instructions}`);
      lines.push(`    Disk read bytes    : ${resources.diskReadBytes}`);
      lines.push(`    Write bytes        : ${resources.writeBytes}`);
      lines.push(`    Resource fee       : ${resources.resourceFee} stroops`);
      lines.push(
        `    Footprint          : ${resources.readOnlyEntries} read-only, ` +
          `${resources.readWriteEntries} read-write`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Raw XDR and gaps
  // -------------------------------------------------------------------------
  lines.push(chalk.bold('\nRaw XDR (retained for further inspection)'));
  lines.push(`  Envelope XDR       : ${report.envelope?.xdr ?? '(not available)'}`);
  lines.push(`  Result XDR         : ${report.result.xdr ?? '(not available)'}`);
  lines.push(`  Metadata XDR       : ${report.metadata.xdr ?? '(not available)'}`);

  lines.push(chalk.bold('\nUnavailable or unsupported fields'));
  if (report.unavailable.length === 0) {
    lines.push('  (none)');
  } else {
    report.unavailable.forEach((field) => lines.push(`  - ${field}`));
  }

  lines.push(chalk.bold('\nWarnings'));
  if (report.warnings.length === 0) {
    lines.push('  (none)');
  } else {
    report.warnings.forEach((warning) => {
      lines.push(`  - [${warning.field}] ${warning.message}`);
    });
  }

  lines.push(chalk.bold('================================================='));

  return lines.join('\n');
}

export function reportToJson(report: ExecutionReport): string {
  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function run(params: InspectorParams = {}): Promise<void> {
  /*
   * The runner passes the example name as argv[2]. A positional hash (argv[3])
   * is only accepted when it really looks like a hash, so flags such as --json
   * are never mistaken for one.
   */
  const positionalArg = process.argv[3]?.trim() ?? '';
  const positionalHash = isValidTransactionHash(positionalArg) ? positionalArg : '';

  const transactionHash =
    params.transactionHash?.trim() || process.env.TRANSACTION_HASH?.trim() || positionalHash;

  console.log(chalk.bold('\nStellar Transaction Return Value & Metadata Inspector'));
  console.log(
    chalk.gray(
      'Retrieves a transaction, decodes result XDR and metadata, and builds an execution report.',
    ),
  );

  if (!transactionHash) {
    console.log(chalk.yellow('\nNo transaction hash supplied.'));
    console.log(
      chalk.gray(
        '  Usage: TRANSACTION_HASH=<64 hex characters> npm run run-example ' +
          '262-transaction-result-inspector',
      ),
    );
    return;
  }

  const sourceInput = (params.source ?? process.env.RESULT_INSPECTOR_SOURCE ?? 'auto')
    .toString()
    .trim()
    .toLowerCase();

  const source: InspectionOptions['source'] =
    sourceInput === 'horizon' || sourceInput === 'rpc' ? sourceInput : 'auto';

  const json =
    params.json === true || params.json === 'true' || process.argv.slice(2).includes('--json');

  console.log(chalk.yellow('\nConfiguration'));
  console.log(`  Transaction hash : ${transactionHash}`);
  console.log(`  Source           : ${source}`);
  console.log(
    `  Horizon endpoint : ${params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL}`,
  );
  console.log(
    `  Soroban RPC      : ${params.rpcUrl || process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URL}`,
  );

  const report = await inspectTransaction(transactionHash, {
    source,
    horizonUrl: params.horizonUrl,
    rpcUrl: params.rpcUrl,
    networkPassphrase: params.networkPassphrase,
  });

  if (json) {
    console.log(reportToJson(report));
  } else {
    console.log(formatExecutionReport(report));
  }

  if (report.retrieval.status === 'invalid-hash') {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function decodeOperationResult(
  operationResult: xdr.OperationResult,
  index: number,
  warnings: InspectorWarning[],
): OperationResultSummary {
  const outerResult = safeCall(() => operationResult.switch().name, 'unknown');

  if (outerResult !== 'opInner') {
    return {
      index,
      operationType: null,
      outerResult,
      code: outerResult,
      success: false,
      detail: describeOperationFailure(outerResult),
    };
  }

  const transactionResult = safeCall(() => operationResult.tr(), null);

  if (!transactionResult) {
    warnings.push({
      field: `resultXdr.operation[${index}]`,
      message: 'The inner operation result could not be decoded.',
    });

    return {
      index,
      operationType: null,
      outerResult,
      code: null,
      success: false,
      detail: null,
    };
  }

  const operationType = safeCall(() => transactionResult.switch().name, 'unknown');

  let code: string | null = null;

  try {
    /*
     * The operation result union stores the per-operation result object as its
     * value. Reading it generically avoids a 30-arm switch statement and still
     * uses the SDK's generated decoder for each operation result type.
     */
    const innerResult = safeCall(
      () => transactionResult.value() as unknown as { switch(): { name: string } },
      null,
    );

    code = innerResult ? safeCall(() => innerResult.switch().name, null) : null;
  } catch (error: unknown) {
    warnings.push({
      field: `resultXdr.operation[${index}]`,
      message: `The ${operationType} result code could not be decoded: ${getErrorMessage(error)}`,
    });
  }

  const success = code?.toLowerCase().endsWith('success') ?? false;

  return {
    index,
    operationType,
    outerResult,
    code,
    success,
    detail: success ? null : describeOperationFailure(code ?? outerResult),
  };
}

function describeOperationFailure(code: string): string | null {
  const normalized = code.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

  const messages: Record<string, string> = {
    payment_underfunded: 'The source balance could not cover the payment amount.',
    payment_no_destination: 'The destination account does not exist.',
    payment_no_trust: 'The destination has no trustline for the asset.',
    payment_not_authorized: 'The destination trustline is not authorized.',
    payment_line_full: 'The destination trustline limit would be exceeded.',
    payment_src_no_trust: 'The source has no trustline for the asset.',
    payment_src_not_authorized: 'The source trustline is not authorized.',
    payment_no_issuer: 'The asset issuer account does not exist.',
    invoke_host_function_trapped: 'The Soroban host trapped while executing the contract call.',
    invoke_host_function_malformed: 'The Soroban invocation was malformed.',
    invoke_host_function_resource_limit_exceeded:
      'The invocation exceeded its declared Soroban resource limits.',
    invoke_host_function_entry_archived:
      'A required ledger entry was archived and must be restored first.',
    invoke_host_function_insufficient_refundable_fee:
      'The declared refundable resource fee was insufficient.',
    op_bad_auth: 'The operation failed authorization.',
    op_no_account: 'The operation source account does not exist.',
    op_not_supported: 'The operation is not supported by the current protocol.',
    op_too_many_subentries: 'The account would exceed its subentry limit.',
    op_exceeded_work_limit: 'The operation exceeded the network work limit.',
    op_too_many_sponsoring: 'The account is sponsoring too many entries.',
    tx_bad_seq: 'The transaction sequence number does not match the source account.',
    tx_bad_auth: 'The transaction signatures or thresholds are insufficient.',
    tx_insufficient_balance: 'The source account cannot cover the fee and reserves.',
    tx_insufficient_fee: 'The declared fee was below the network minimum.',
    tx_too_early: 'The transaction time or ledger bounds are not yet valid.',
    tx_too_late: 'The transaction time or ledger bounds have expired.',
    tx_soroban_invalid: 'The Soroban transaction data, footprint, or resources were invalid.',
    tx_no_account: 'The source account does not exist.',
    tx_missing_operation: 'The transaction contained no operations.',
  };

  return messages[normalized] ?? null;
}

function operationChanges(operations: xdr.OperationMeta[]): xdr.LedgerEntryChange[][] {
  return operations.map((operation) => operation.changes());
}

function peekMetadataVersion(resultMetaXdr: string): number | null {
  const trimmed = resultMetaXdr.trim();

  /*
   * XDR is always 4-byte aligned. Only read the version tag from input that is
   * plausibly XDR, so a malformed string is reported as invalid rather than as
   * a future metadata version.
   */
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    return null;
  }

  try {
    const raw = Buffer.from(trimmed, 'base64');

    if (raw.length < 4 || raw.length % 4 !== 0) {
      return null;
    }

    const version = raw.readUInt32BE(0);

    return version >= 0 && version < 1024 ? version : null;
  } catch {
    return null;
  }
}

function contractAddress(event: xdr.ContractEvent): xdr.ScAddress {
  const contractId = event.contractId();

  if (!contractId) {
    throw new Error('Contract event has no contract ID.');
  }

  return xdr.ScAddress.scAddressTypeContract(contractId);
}

function formatScValText(value: xdr.ScVal): string {
  const formatted = formatScVal(value);

  if (formatted.xdrType === 'scvError') {
    return String(formatted.native);
  }

  if (!formatted.decoded) {
    return `${formatted.xdrType} (undecodable: ${formatted.error ?? 'unknown error'})`;
  }

  try {
    const json = JSON.stringify(formatted.native);

    return json === undefined ? formatted.xdrType : json;
  } catch {
    return formatted.xdrType;
  }
}

function describeLedgerEntry(entry: xdr.LedgerEntry): string {
  const data = entry.data();

  try {
    switch (data.switch().name) {
      case 'account':
        return `account ${describeAccountId(data.account().accountId())}`;

      case 'trustline':
        return `trustline for ${describeAccountId(data.trustLine().accountId())}`;

      case 'data':
        return `data entry "${data.data().dataName()}" on ${describeAccountId(
          data.data().accountId(),
        )}`;

      case 'offer':
        return `offer #${data.offer().offerId()} by ${describeAccountId(data.offer().sellerId())}`;

      case 'contractData':
        return `contract ${describeScAddress(
          data.contractData().contract(),
        )} key=${formatScValText(data.contractData().key())}`;

      case 'contractCode':
        return `contract code ${data.contractCode().hash().toString('hex')}`;

      case 'claimableBalance':
        return `claimable balance ${data.claimableBalance().balanceId().value().toString('hex')}`;

      case 'liquidityPool':
        return `liquidity pool ${poolIdToHex(data.liquidityPool().liquidityPoolId())}`;

      case 'ttl':
        return `TTL entry for key ${data.ttl().keyHash().toString('hex')}`;

      case 'configSetting':
        return `config setting ${safeCall(() => data.configSetting().switch().name, 'unknown')}`;

      default:
        return data.switch().name;
    }
  } catch (error: unknown) {
    return `(${data.switch().name} could not be described: ${getErrorMessage(error)})`;
  }
}

function describeLedgerKey(key: xdr.LedgerKey): string {
  try {
    switch (key.switch().name) {
      case 'account':
        return `account ${describeAccountId(key.account().accountId())}`;

      case 'trustline':
        return `trustline for ${describeAccountId(key.trustLine().accountId())}`;

      case 'data':
        return `data entry "${key.data().dataName()}" on ${describeAccountId(
          key.data().accountId(),
        )}`;

      case 'offer':
        return `offer #${key.offer().offerId()} by ${describeAccountId(key.offer().sellerId())}`;

      case 'contractData':
        return `contract ${describeScAddress(
          key.contractData().contract(),
        )} key=${formatScValText(key.contractData().key())}`;

      case 'contractCode':
        return `contract code ${key.contractCode().hash().toString('hex')}`;

      case 'claimableBalance':
        return `claimable balance ${key.claimableBalance().balanceId().value().toString('hex')}`;

      case 'liquidityPool':
        return `liquidity pool ${poolIdToHex(key.liquidityPool().liquidityPoolId())}`;

      default:
        return key.switch().name;
    }
  } catch (error: unknown) {
    return `(${key.switch().name} key could not be described: ${getErrorMessage(error)})`;
  }
}

function describeAccountId(accountId: xdr.AccountId): string {
  try {
    return StrKey.encodeEd25519PublicKey(accountId.ed25519());
  } catch {
    return '(unknown account)';
  }
}

function poolIdToHex(poolId: unknown): string {
  try {
    return Buffer.from(poolId as Uint8Array).toString('hex');
  } catch {
    return String(poolId);
  }
}

function describeScAddress(address: xdr.ScAddress): string {
  try {
    return Address.fromScAddress(address).toString();
  } catch {
    return '(unknown address)';
  }
}

function describeNetwork(report: ExecutionReport): string {
  const name = report.network ?? 'unknown';
  const passphrase = report.networkPassphrase ?? '(unknown passphrase)';

  return `${name} (${passphrase})`;
}

function describeRetrieval(retrieval: RetrievalSummary): string {
  if (retrieval.status !== 'retrieved') {
    return `${retrieval.status}${retrieval.error ? ` - ${retrieval.error}` : ''}`;
  }

  return `${retrieval.source} @ ${retrieval.endpoint}`;
}

function describeInclusion(successful: boolean | null): string {
  if (successful === null) {
    return '(not reported)';
  }

  return successful ? 'included, provider reports success' : 'included, provider reports failure';
}

function describeReturnValue(returnValue: FormattedScVal | null): string {
  if (!returnValue) {
    return '(not available)';
  }

  if (!returnValue.decoded) {
    return `${returnValue.xdrType} (undecodable: ${returnValue.error ?? 'unknown error'})`;
  }

  let rendered: string;

  try {
    rendered = JSON.stringify(returnValue.native) ?? String(returnValue.native);
  } catch {
    rendered = String(returnValue.native);
  }

  return `${returnValue.xdrType} ${rendered}`;
}

export function networkName(passphrase: string | null): string | null {
  if (!passphrase) {
    return null;
  }

  if (passphrase === Networks.PUBLIC) {
    return 'mainnet';
  }

  if (passphrase === Networks.TESTNET) {
    return 'testnet';
  }

  if (passphrase === Networks.FUTURENET) {
    return 'futurenet';
  }

  return 'custom';
}

function safeCall<T>(callback: () => T, fallback: T): T {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

function toBase64Xdr(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as { toXDR?: (format: 'base64') => string };

  if (typeof candidate.toXDR !== 'function') {
    return null;
  }

  try {
    return candidate.toXDR('base64');
  } catch {
    return null;
  }
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isHttpNotFound(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }

  const response = (error as { response?: { status?: number } }).response;

  return response?.status === 404;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error !== null && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }

  return String(error);
}
