import fs from 'fs';
import path from 'path';

import {
  getRetryAfterMs,
  monitorTransaction,
  validateTransactionHash,
} from '../src/examples/120-transaction-lifecycle-monitor';
import {
  normalizeMaxRecords,
  normalizePageSize,
  paginateAccountOperations,
  validateAccountId,
} from '../src/examples/121-account-history-pagination';
import {
  analyzeOrderBook,
  normalizeDepth,
  parseTradingAsset,
} from '../src/examples/122-order-book-inspection';
import {
  calculateTradeStatistics,
  filterTradesByTime,
  parseHistoricalTrade,
  parseTimeFilter,
} from '../src/examples/123-trade-history-analysis';

describe('120 transaction lifecycle monitor', () => {
  test('validates transaction hashes', () => {
    expect(validateTransactionHash('A'.repeat(64))).toBe('a'.repeat(64));
    expect(() => validateTransactionHash('not-a-hash')).toThrow('64 hexadecimal');
  });

  test('keeps polling unavailable transactions and returns confirmation', async () => {
    let attempt = 0;
    const report = await monitorTransaction(
      'a'.repeat(64),
      async () => {
        attempt += 1;
        if (attempt === 1) {
          throw { response: { status: 404 } };
        }
        return {
          hash: 'a'.repeat(64),
          successful: true,
          ledger_attr: 123,
          created_at: '2026-01-01T00:00:00Z',
          operation_count: 2,
          fee_charged: '200',
        };
      },
      { pollIntervalMs: 0, timeoutMs: 100, sleep: async () => undefined },
    );

    expect(report.status).toBe('confirmed');
    expect(report.polls).toBe(2);
    expect(report.ledgerSequence).toBe(123);
    expect(report.successfulOperationCount).toBe(2);
  });

  test('reports failed transactions and parses retry-after', async () => {
    const report = await monitorTransaction(
      'b'.repeat(64),
      async () => ({ successful: false, operation_count: 3 }),
      { pollIntervalMs: 0, timeoutMs: 100 },
    );
    expect(report.status).toBe('failed');
    expect(report.resultCode).toBe('tx_failed');
    expect(getRetryAfterMs({ response: { headers: { 'retry-after': '2' } } })).toBe(2000);
  });
});

describe('121 account history pagination', () => {
  test('validates account IDs', () => {
    expect(() => validateAccountId('invalid')).toThrow('valid Stellar');
  });

  test('caps page size but allows maximum records to span multiple pages', () => {
    expect(normalizePageSize(500)).toBe(200);
    expect(normalizeMaxRecords(500)).toBe(500);
  });

  test('traverses pages, filters operations, and removes duplicates', async () => {
    const page2 = {
      records: [
        {
          id: '2',
          paging_token: '2',
          type: 'payment',
          transaction_hash: 'tx2',
          source_account: 'GSECOND',
          created_at: '2026-01-02T00:00:00Z',
        },
        {
          id: '3',
          paging_token: '3',
          type: 'create_account',
          transaction_hash: 'tx3',
        },
      ],
      next: async () => ({
        records: [],
        next: async () => {
          throw new Error('No further page expected');
        },
      }),
    };
    const page1 = {
      records: [
        {
          id: '1',
          paging_token: '1',
          type: 'payment',
          transaction_hash: 'tx1',
        },
        {
          id: '2',
          paging_token: '2',
          type: 'payment',
          transaction_hash: 'tx2',
        },
      ],
      next: async () => page2,
    };

    const report = await paginateAccountOperations(async () => page1, {
      pageSize: 2,
      maxRecords: 10,
      operationType: 'payment',
    });

    expect(report.pagesProcessed).toBe(2);
    expect(report.recordsProcessed).toBe(2);
    expect(report.duplicatesSkipped).toBe(1);
    expect(report.operations.map((operation) => operation.id)).toEqual(['1', '2']);
  });

  test('respects maximum record count', async () => {
    const page = {
      records: [
        { id: '1', paging_token: '1', type: 'payment' },
        { id: '2', paging_token: '2', type: 'payment' },
      ],
      next: async () => ({
        records: [],
        next: async () => {
          throw new Error('No further page expected');
        },
      }),
    };
    const report = await paginateAccountOperations(async () => page, {
      pageSize: 2,
      maxRecords: 1,
    });
    expect(report.recordsProcessed).toBe(1);
  });
});

describe('122 order book inspection', () => {
  test('validates assets and depth', () => {
    expect(parseTradingAsset('native').isNative()).toBe(true);
    expect(() => parseTradingAsset('USD')).toThrow('CODE:ISSUER');
    expect(normalizeDepth('500')).toBe(200);
  });

  test('calculates best prices, spread, midpoint, depth and liquidity', () => {
    const analysis = analyzeOrderBook(
      [
        { price: '2.0', amount: '3' },
        { price: '1.9', amount: '5' },
      ],
      [
        { price: '2.2', amount: '4' },
        { price: '2.1', amount: '6' },
      ],
      1,
    );

    expect(analysis.bestBid).toBe(2);
    expect(analysis.bestAsk).toBe(2.1);
    expect(analysis.spread).toBeCloseTo(0.1);
    expect(analysis.midMarketPrice).toBeCloseTo(2.05);
    expect(analysis.bidQuantity).toBe(3);
    expect(analysis.askQuantity).toBe(6);
    expect(analysis.priceLevels).toBe(2);
    expect(analysis.totalBidLiquidity).toBe(3);
    expect(analysis.totalAskLiquidity).toBe(6);
  });

  test('handles an empty order book', () => {
    const analysis = analyzeOrderBook([], [], 10);
    expect(analysis.bestBid).toBeNull();
    expect(analysis.bestAsk).toBeNull();
    expect(analysis.priceLevels).toBe(0);
  });
});

describe('123 trade history analysis', () => {
  const trade1 = parseHistoricalTrade({
    id: '1-0',
    ledger_close_time: '2026-01-01T00:00:00Z',
    trade_type: 'orderbook',
    base_amount: '2',
    counter_amount: '4',
    price: { n: 2, d: 1 },
    base_asset_type: 'native',
    counter_asset_type: 'credit_alphanum4',
    counter_asset_code: 'USD',
    counter_asset_issuer: 'GISSUER',
  });
  const trade2 = parseHistoricalTrade({
    id: '2-0',
    ledger_close_time: '2026-01-02T00:00:00Z',
    trade_type: 'liquidity_pool',
    base_amount: '4',
    counter_amount: '12',
    price: { n: 3, d: 1 },
    base_asset_type: 'native',
    counter_asset_type: 'credit_alphanum4',
    counter_asset_code: 'USD',
    counter_asset_issuer: 'GISSUER',
  });

  test('parses trades and calculates price and volume statistics', () => {
    const statistics = calculateTradeStatistics([trade1, trade2]);
    expect(trade1.price).toBe(2);
    expect(statistics.highestTradePrice).toBe(3);
    expect(statistics.lowestTradePrice).toBe(2);
    expect(statistics.averageTradePrice).toBe(2.5);
    expect(statistics.totalTradedVolume).toBe(6);
    expect(statistics.numberOfTrades).toBe(2);
  });

  test('filters trades by time', () => {
    const from = parseTimeFilter('2026-01-02T00:00:00Z', 'fromTime');
    expect(filterTradesByTime([trade1, trade2], from)).toEqual([trade2]);
  });

  test('handles an empty history', () => {
    expect(calculateTradeStatistics([])).toEqual({
      highestTradePrice: 0,
      lowestTradePrice: 0,
      averageTradePrice: 0,
      totalTradedVolume: 0,
      totalCounterVolume: 0,
      numberOfTrades: 0,
    });
  });
});

describe('runner registration and README documentation', () => {
  const expected = [
    [
      '120-transaction-lifecycle-monitor',
      ['transactionHash', 'pollIntervalMs', 'timeoutMs', 'json'],
    ],
    [
      '121-account-history-pagination',
      ['accountId', 'pageSize', 'maxRecords', 'operationType', 'json'],
    ],
    ['122-order-book-inspection', ['sellingAsset', 'buyingAsset', 'depth', 'json']],
    [
      '123-trade-history-analysis',
      ['sellingAsset', 'buyingAsset', 'limit', 'fromTime', 'toTime', 'json'],
    ],
  ] as const;

  test.each(expected)('registers %s in the interactive runner', (name, parameterNames) => {
    const catalog = fs.readFileSync(
      path.join(process.cwd(), 'src', 'runner', 'catalog.ts'),
      'utf8',
    );

    expect(catalog).toContain(`'${name}': {`);
    expect(catalog).toContain(`name: '${name}'`);
    expect(catalog).toContain(`loadExample('../examples/${name}')`);

    for (const parameterName of parameterNames) {
      expect(catalog).toContain(`name: '${parameterName}'`);
    }
  });

  test.each(expected)('documents %s in README', (name) => {
    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
    expect(readme).toContain(`**\`${name}\`**`);
    expect(readme).toContain(`npm run run-example ${name}`);
  });
});
