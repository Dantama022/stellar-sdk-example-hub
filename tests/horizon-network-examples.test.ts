import {
  computeReconnectDelay,
  formatConnectionStatus,
  isMalformedStreamRecord,
} from '../src/examples/158-resilient-horizon-streaming';
import {
  evaluateFilterPipeline,
  matchesAccountFilter,
  matchesAmountRangeFilter,
  matchesOperationTypeFilter,
} from '../src/examples/159-horizon-stream-filtering';
import {
  classifyHorizonError,
  computeRetryDelay,
  executeWithRetry,
  isRateLimitError,
  isRetryableError,
  parseRetryAfterMs,
} from '../src/examples/160-horizon-retry-rate-limit';
import { defaultRecordId, paginateHorizonCollection } from '../src/examples/157-horizon-pagination';
import { examples } from '../src/runner/catalog';

describe('Horizon network examples helpers', () => {
  it('deduplicates paginated records and stops early', async () => {
    const pages = [
      {
        records: [{ id: '1' }, { id: '2' }],
        next: async () => ({
          records: [{ id: '2' }, { id: '3' }],
          next: async () => ({ records: [], next: async () => ({ records: [] }) }),
        }),
      },
    ];

    const { records, metrics } = await paginateHorizonCollection(
      'operations',
      async () => pages[0] as never,
      {
        pageSize: 2,
        maxRecords: 10,
        shouldStop: (record) => record.id === '3',
      },
    );

    expect(records.map((record) => record.id)).toEqual(['1', '2', '3']);
    expect(metrics.pagesProcessed).toBe(2);
    expect(metrics.duplicatesSkipped).toBe(1);
    expect(metrics.status).toBe('early_termination');
  });

  it('builds stable default record identifiers', () => {
    expect(defaultRecordId({ hash: 'abc', id: 'ignored' })).toBe('ignored');
    expect(defaultRecordId({ hash: 'abc' })).toBe('abc');
  });

  it('computes reconnect backoff delays', () => {
    expect(computeReconnectDelay(1, 1000, 5000)).toBe(1000);
    expect(computeReconnectDelay(3, 1000, 5000)).toBe(4000);
    expect(
      formatConnectionStatus('reconnecting', { cursor: 'now', attempt: 2, delayMs: 1000 }),
    ).toContain('attempt 2');
  });

  it('detects malformed stream records', () => {
    expect(isMalformedStreamRecord({ paging_token: '123' })).toBe(false);
    expect(isMalformedStreamRecord({ paging_token: '' })).toBe(true);
    expect(isMalformedStreamRecord(null)).toBe(true);
  });

  it('evaluates stream filter pipelines', () => {
    const record = {
      id: '1',
      type: 'payment',
      paging_token: '100',
      transaction_hash: 'abc',
      transaction_successful: true,
      amount: '25',
      asset_code: 'USDC',
      asset_issuer: 'GISSUER',
      from: 'GACCOUNT',
    } as never;

    expect(
      evaluateFilterPipeline(
        record,
        {
          account: 'GACCOUNT',
          assetCode: 'USDC',
          assetIssuer: 'GISSUER',
          operationType: 'payment',
          successOnly: true,
          minAmount: 10,
          maxAmount: 50,
        },
        'and',
      ),
    ).toBe(true);

    expect(matchesOperationTypeFilter(record, 'create_account')).toBe(false);
    expect(matchesAccountFilter(record, 'GOTHER')).toBe(false);
    expect(matchesAmountRangeFilter(record, 30)).toBe(false);
  });

  it('classifies retryable and rate-limit errors', () => {
    const rateLimit = classifyHorizonError({
      response: { status: 429, headers: { 'retry-after': '2' } },
    });
    expect(isRateLimitError(rateLimit)).toBe(true);
    expect(isRetryableError(rateLimit)).toBe(true);
    expect(parseRetryAfterMs('2')).toBe(2000);

    const clientError = classifyHorizonError({ response: { status: 404 } });
    expect(isRetryableError(clientError)).toBe(false);
    expect(computeRetryDelay(2, 500, 4000, 1500)).toBe(1500);
  });

  it('retries transient failures and eventually succeeds', async () => {
    let attempts = 0;
    const { value, diagnostics } = await executeWithRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw { response: { status: 503 } };
        }
        return 'ok';
      },
      { maxRetries: 4, baseDelayMs: 1, maxDelayMs: 2 },
    );

    expect(value).toBe('ok');
    expect(diagnostics.attempts).toBe(3);
    expect(diagnostics.retried).toBe(true);
  });
});

describe('Horizon network example registration', () => {
  const expectedExamples = [
    '157-horizon-pagination',
    '158-resilient-horizon-streaming',
    '159-horizon-stream-filtering',
    '160-horizon-retry-rate-limit',
  ];

  test.each(expectedExamples)('registers %s in the runner catalog', (name) => {
    expect(examples[name]).toBeDefined();
    expect(typeof examples[name].run).toBe('function');
  });
});
