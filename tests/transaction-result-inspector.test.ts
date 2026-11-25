import * as fs from 'fs';
import * as path from 'path';

import {
  TransactionNotFoundError,
  decodeTransactionMetadata,
  decodeTransactionResult,
  formatExecutionReport,
  inspectTransaction,
  isValidTransactionHash,
  reportToJson,
  toJsonSafe,
} from '../src/examples/262-transaction-result-inspector';

import type {
  ExecutionReport,
  RetrievalSource,
  TransactionDataProvider,
} from '../src/examples/262-transaction-result-inspector';

interface Fixture {
  name: string;
  description: string;
  networkPassphrase: string;
  transactionHash: string;
  ledger: number;
  envelopeXdr: string | null;
  resultXdr: string | null;
  resultMetaXdr: string | null;
}

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'transaction-result');

const fixtureCache = new Map<string, Fixture>();

function fixture(name: string): Fixture {
  const cached = fixtureCache.get(name);

  if (cached) {
    return cached;
  }

  const loaded = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'),
  ) as Fixture;

  fixtureCache.set(name, loaded);

  return loaded;
}

function providerFor(
  data: Fixture,
  source: RetrievalSource = 'horizon',
  overrides: Partial<Awaited<ReturnType<TransactionDataProvider['fetchTransaction']>>> = {},
): TransactionDataProvider {
  return {
    source,
    endpoint: `https://${source}.example.test`,
    async fetchTransaction(hash: string) {
      return {
        source,
        endpoint: `https://${source}.example.test`,
        hash: data.transactionHash,
        ledger: data.ledger,
        successful: null,
        envelopeXdr: data.envelopeXdr,
        resultXdr: data.resultXdr,
        resultMetaXdr: data.resultMetaXdr,
        warnings: [],
        ...overrides,
        // Keep the requested hash unless a test explicitly overrides it.
        ...(overrides.hash === undefined ? { hash } : {}),
      };
    },
  };
}

function notFoundProvider(source: RetrievalSource = 'horizon'): TransactionDataProvider {
  return {
    source,
    endpoint: `https://${source}.example.test`,
    async fetchTransaction() {
      throw new TransactionNotFoundError(`No transaction found at ${source}.`);
    },
  };
}

function failingProvider(source: RetrievalSource = 'horizon'): TransactionDataProvider {
  return {
    source,
    endpoint: `https://${source}.example.test`,
    async fetchTransaction() {
      throw new Error(`${source} connection reset`);
    },
  };
}

function inspectFixture(
  name: string,
  source: RetrievalSource = 'horizon',
): Promise<ExecutionReport> {
  const data = fixture(name);

  return inspectTransaction(
    data.transactionHash,
    { source, networkPassphrase: data.networkPassphrase },
    {
      horizon: source === 'horizon' ? providerFor(data, 'horizon') : notFoundProvider('horizon'),
      rpc: source === 'rpc' ? providerFor(data, 'rpc') : notFoundProvider('rpc'),
    },
  );
}

describe('transaction result inspector', () => {
  describe('retrieval', () => {
    it('retrieves a transaction and validates its hash format', async () => {
      const report = await inspectFixture('classic-success');

      expect(report.retrieval.status).toBe('retrieved');
      expect(report.retrieval.source).toBe('horizon');
      expect(report.transactionHash).toBe(fixture('classic-success').transactionHash);
      expect(report.network).toBe('testnet');
      expect(report.ledger).toBe(4321);
      expect(isValidTransactionHash(report.transactionHash)).toBe(true);
    });

    it('rejects a malformed transaction hash without calling an endpoint', async () => {
      const horizon = providerFor(fixture('classic-success'));
      const spy = jest.spyOn(horizon, 'fetchTransaction');

      const report = await inspectTransaction(
        'not-a-hash',
        { source: 'horizon' },
        { horizon, rpc: notFoundProvider('rpc') },
      );

      expect(report.retrieval.status).toBe('invalid-hash');
      expect(report.result.status).toBe('unavailable');
      expect(spy).not.toHaveBeenCalled();
    });

    it('reports a missing transaction instead of inventing a result', async () => {
      const report = await inspectTransaction(
        'a'.repeat(64),
        { source: 'auto' },
        { horizon: notFoundProvider('horizon'), rpc: notFoundProvider('rpc') },
      );

      expect(report.retrieval.status).toBe('not-found');
      expect(report.unavailable).toContain('transaction');
      expect(report.result.status).toBe('unavailable');
      expect(report.warnings.map((warning) => warning.message).join(' ')).toContain('not found');
    });

    it('falls back to Soroban RPC when Horizon has no record', async () => {
      const data = fixture('soroban-success');

      const report = await inspectTransaction(
        data.transactionHash,
        { source: 'auto', networkPassphrase: data.networkPassphrase },
        { horizon: notFoundProvider('horizon'), rpc: providerFor(data, 'rpc') },
      );

      expect(report.retrieval.status).toBe('retrieved');
      expect(report.retrieval.source).toBe('rpc');
      expect(report.result.code).toBe('txSuccess');
    });

    it('distinguishes endpoint request failures from transaction failures', async () => {
      const report = await inspectTransaction(
        'b'.repeat(64),
        { source: 'auto' },
        { horizon: failingProvider('horizon'), rpc: failingProvider('rpc') },
      );

      expect(report.retrieval.status).toBe('request-failed');
      expect(report.retrieval.error).toContain('connection reset');
      expect(report.result.status).toBe('unavailable');
      expect(report.warnings.map((warning) => warning.message).join(' ')).toContain(
        'retrieval failure',
      );
    });

    it('warns when the endpoint returns a different transaction hash', async () => {
      const data = fixture('classic-success');
      const requested = 'c'.repeat(64);

      const report = await inspectTransaction(
        requested,
        { source: 'horizon', networkPassphrase: data.networkPassphrase },
        {
          horizon: providerFor(data, 'horizon', { hash: data.transactionHash }),
          rpc: notFoundProvider('rpc'),
        },
      );

      expect(report.warnings.some((warning) => warning.message.includes('does not match'))).toBe(
        true,
      );
    });
  });

  describe('result XDR decoding', () => {
    it('decodes a successful classic transaction', async () => {
      const report = await inspectFixture('classic-success');

      expect(report.result.status).toBe('decoded');
      expect(report.result.code).toBe('txSuccess');
      expect(report.result.successful).toBe(true);
      expect(report.result.feeCharged).toBe('200');
      expect(report.result.operationResults).toHaveLength(2);
      expect(report.result.operationResults[0]).toMatchObject({
        operationType: 'payment',
        code: 'paymentSuccess',
        success: true,
      });
      expect(report.transactionType).toBe('classic');
    });

    it('distinguishes a transaction-level failure from operation results', async () => {
      const report = await inspectFixture('classic-failed');

      expect(report.result.status).toBe('decoded');
      expect(report.result.code).toBe('txBadSeq');
      expect(report.result.successful).toBe(false);
      expect(report.result.transactionLevelFailure).toBe(true);
      expect(report.result.operationResults).toHaveLength(0);
    });

    it('reports each operation result in a multi-operation transaction', async () => {
      const report = await inspectFixture('multi-operation-results');

      expect(report.result.code).toBe('txFailed');
      expect(report.result.operationResults).toHaveLength(2);

      const [successful, failed] = report.result.operationResults;

      expect(successful.success).toBe(true);
      expect(failed.success).toBe(false);
      expect(failed.code).toBe('paymentUnderfunded');
      expect(failed.detail).toContain('balance');
    });

    it('handles malformed result XDR safely', async () => {
      const report = await inspectFixture('malformed-result');

      expect(report.retrieval.status).toBe('retrieved');
      expect(report.result.status).toBe('invalid');
      expect(report.unavailable).toContain('result');
      expect(report.result.warnings[0].message).toContain('could not be decoded');
      expect(report.result.xdr).toBe(fixture('malformed-result').resultXdr);
    });

    it('returns an unavailable status when result XDR is absent', () => {
      const decoded = decodeTransactionResult(null);

      expect(decoded.status).toBe('unavailable');
      expect(decoded.code).toBeNull();
      expect(decoded.warnings).toHaveLength(1);
    });
  });

  describe('metadata inspection', () => {
    it('decodes ledger changes and distinguishes created and updated entries', async () => {
      const report = await inspectFixture('classic-success');

      expect(report.metadata.status).toBe('decoded');
      expect(report.metadata.version).toBe(2);
      expect(report.metadata.hasChanges).toBe(true);
      expect(report.metadata.changeCounts.created).toBe(1);
      expect(report.metadata.changeCounts.updated).toBe(1);
      expect(report.metadata.changes.map((change) => change.entryType)).toContain('account');
      expect(report.metadata.changes.map((change) => change.entryType)).toContain('data');
    });

    it('decodes metadata version 0', async () => {
      const report = await inspectFixture('metadata-v0');

      expect(report.metadata.status).toBe('decoded');
      expect(report.metadata.version).toBe(0);
      expect(report.metadata.changes).toHaveLength(1);
    });

    it('decodes metadata version 1 including removed entries', async () => {
      const report = await inspectFixture('metadata-v1');

      expect(report.metadata.status).toBe('decoded');
      expect(report.metadata.version).toBe(1);
      expect(report.metadata.changeCounts).toEqual({
        created: 1,
        updated: 1,
        removed: 1,
        state: 0,
        restored: 0,
        unknown: 0,
      });
      expect(report.metadata.changes.some((change) => change.kind === 'removed')).toBe(true);
    });

    it('decodes metadata version 4 including operation meta v2 and transaction events', async () => {
      const report = await inspectFixture('metadata-v4');

      expect(report.metadata.status).toBe('decoded');
      expect(report.metadata.version).toBe(4);
      expect(report.metadata.changeCounts.created).toBe(2);
      expect(report.metadata.changeCounts.updated).toBe(1);
      expect(report.metadata.soroban.contractEvents).toHaveLength(2);
      expect(report.metadata.soroban.contractEvents.some((event) => event.stage !== null)).toBe(
        true,
      );
      expect(report.metadata.soroban.returnValue?.native).toBe('7');
    });

    it('distinguishes metadata with no changes from unavailable metadata', async () => {
      const report = await inspectFixture('metadata-empty-changes');

      expect(report.metadata.status).toBe('decoded');
      expect(report.metadata.hasChanges).toBe(false);
      expect(report.unavailable).not.toContain('metadata');
      expect(report.warnings.map((warning) => warning.message).join(' ')).toContain(
        'no ledger entry changes',
      );
    });

    it('reports unavailable metadata without failing the report', async () => {
      const report = await inspectFixture('missing-metadata');

      expect(report.metadata.status).toBe('unavailable');
      expect(report.metadata.version).toBeNull();
      expect(report.unavailable).toContain('metadata');
      expect(report.result.status).toBe('decoded');
    });

    it('reports an unsupported metadata version safely', async () => {
      const report = await inspectFixture('unsupported-metadata-version');

      expect(report.metadata.status).toBe('unsupported');
      expect(report.metadata.version).toBe(5);
      expect(report.metadata.changes).toHaveLength(0);
      expect(report.unavailable).toContain('metadata:v5');
      expect(report.metadata.warnings[0].message).toContain('not supported');
    });

    it('reports malformed metadata XDR safely', () => {
      const decoded = decodeTransactionMetadata('AAAA-not-xdr');

      expect(decoded.status).toBe('invalid');
      expect(decoded.xdr).toBe('AAAA-not-xdr');
      expect(decoded.warnings[0].message).toContain('could not be decoded');
    });
  });

  describe('Soroban execution', () => {
    it('extracts return values, contract events and diagnostic events', async () => {
      const report = await inspectFixture('soroban-success');

      expect(report.transactionType).toBe('soroban');
      expect(report.soroban.applicable).toBe(true);
      expect(report.soroban.returnValue).toMatchObject({
        xdrType: 'scvI64',
        native: '42',
        decoded: true,
      });
      expect(report.soroban.contractEvents).toHaveLength(1);
      expect(report.soroban.diagnosticEvents).toHaveLength(1);
      expect(report.soroban.diagnosticEvents[0].inSuccessfulContractCall).toBe(true);
      expect(report.soroban.contractFailures).toEqual([]);
    });

    it('normalizes map return values with large integers into JSON-safe data', async () => {
      const report = await inspectFixture('soroban-return-map');

      expect(report.soroban.returnValue?.decoded).toBe(true);

      const serialized = reportToJson(report);

      expect(serialized).toContain('12345678901234567890');
      expect(() => JSON.parse(serialized)).not.toThrow();
    });

    it('identifies a failed contract invocation and its diagnostic error', async () => {
      const report = await inspectFixture('soroban-contract-failure');

      expect(report.transactionType).toBe('soroban');
      expect(report.result.operationResults[0].code).toBe('invokeHostFunctionTrapped');
      expect(report.result.operationResults[0].success).toBe(false);
      expect(report.soroban.contractFailures.length).toBeGreaterThan(0);
      expect(report.soroban.contractFailures.join(' ')).toContain('invokeHostFunctionTrapped');
      expect(report.soroban.contractFailures.join(' ')).toContain('ContractError(code=5)');
      expect(report.soroban.diagnosticEvents.some((event) => event.error !== null)).toBe(true);
    });

    it('summarizes prepared resource limits from the submitted envelope', async () => {
      const report = await inspectFixture('soroban-success');

      expect(report.soroban.resourceInfo).not.toBeNull();
      expect(report.soroban.resourceInfo).toMatchObject({
        source: 'envelope',
        instructions: 1000000,
        diskReadBytes: 2000,
        writeBytes: 3000,
        readOnlyEntries: 1,
        readWriteEntries: 1,
      });
    });

    it('marks Soroban details unavailable for classic transactions', async () => {
      const report = await inspectFixture('classic-success');

      expect(report.soroban.applicable).toBe(false);
      expect(report.unavailable).toContain('soroban');
    });
  });

  describe('reports and export', () => {
    it('generates a human-readable report containing every required section', async () => {
      const report = await inspectFixture('soroban-success');
      const text = formatExecutionReport(report);

      expect(text).toContain('TRANSACTION EXECUTION REPORT');
      expect(text).toContain(report.transactionHash);
      expect(text).toContain('txSuccess');
      expect(text).toContain('Operation results');
      expect(text).toContain('Transaction metadata');
      expect(text).toContain('Metadata version');
      expect(text).toContain('Ledger changes');
      expect(text).toContain('Soroban execution');
      expect(text).toContain('Return value');
      expect(text).toContain('Diagnostic events');
      expect(text).toContain('Raw XDR');
      expect(text).toContain('Unavailable or unsupported fields');
      expect(text).toContain('Warnings');
    });

    it('produces JSON output that preserves the original XDR', async () => {
      const data = fixture('classic-success');
      const report = await inspectFixture('classic-success');

      const parsed = JSON.parse(reportToJson(report)) as ExecutionReport;

      expect(parsed.result.xdr).toBe(data.resultXdr);
      expect(parsed.metadata.xdr).toBe(data.resultMetaXdr);
      expect(parsed.envelope?.xdr).toBe(data.envelopeXdr);
      expect(parsed.transactionType).toBe('classic');
      expect(parsed.metadata.changeCounts).toBeDefined();
    });

    it('normalizes bigint and binary values for JSON export', () => {
      expect(toJsonSafe(42n)).toBe('42');
      expect(toJsonSafe(Buffer.from([0xde, 0xad]))).toBe('0xdead');
      expect(toJsonSafe(new Map([['key', 7n]]))).toEqual([['key', '7']]);
      expect(JSON.stringify(toJsonSafe({ nested: [1n, undefined] }))).toBe('{"nested":["1",null]}');
    });

    it('generates a report for an unreachable transaction without throwing', async () => {
      const report = await inspectTransaction(
        'd'.repeat(64),
        { source: 'rpc' },
        { horizon: notFoundProvider('horizon'), rpc: failingProvider('rpc') },
      );

      expect(report.retrieval.status).toBe('request-failed');
      expect(report.transactionType).toBe('unknown');
      expect(() => formatExecutionReport(report)).not.toThrow();
      expect(() => JSON.parse(reportToJson(report))).not.toThrow();
    });
  });
});
