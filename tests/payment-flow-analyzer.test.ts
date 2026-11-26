import { analyzeFlows, operationToEdge, summarizeFlows } from '../examples/payment-flow-analyzer/analyzer';
import type { RawOperation } from '../examples/payment-flow-analyzer/types';

const A = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const B = 'GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX';
const USD = `USD:${B}`;
const op = (id: number, overrides: Partial<RawOperation> = {}): RawOperation => ({
  id, paging_token: String(id), transaction_hash: `tx-${id}`, type: 'payment',
  source_account: A, from: A, to: B, amount: '1.0000000', asset_type: 'native',
  transaction_successful: true, ledger: 30, created_at: '2026-11-20T00:00:00Z', ...overrides,
});
const extra = { complete: true, pages: 1, accountPages: { [A]: 1, [B]: 1 }, warnings: [] as string[] };

test('reconstructs bidirectional multi-account flows and aggregates by distinct asset/issuer', () => {
  const operations = [op(1), op(2, { from: B, to: A, source_account: B, asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: B, amount: '2.5000000' }),
    op(3, { transaction_hash: 'tx-1', amount: '3.0000000' })];
  const report = summarizeFlows('testnet', [A, B], operations, { fromLedger: 1, toLedger: 100 }, extra);
  expect(report.relationships).toHaveLength(3);
  expect(report.accountsSummary[A].outgoing.XLM).toBe('4.0000000');
  expect(report.accountsSummary[A].incoming[USD]).toBe('2.5000000');
  expect(report.transactions.find(tx => tx.hash === 'tx-1')?.operations).toEqual(['1', '3']);
  expect(report.repeatParticipants).toContainEqual({ account: A, observations: 3 });
});

test('path payments preserve source and destination asset amounts rather than inventing a direct same-asset transfer', () => {
  const path = op(4, { type: 'path_payment_strict_send', source_amount: '3.0000000', amount: '2.0000000',
    source_asset_type: 'native', asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: B });
  expect(operationToEdge(path, 30)).toMatchObject({ kind: 'path', sentAmount: '3.0000000',
    sentAsset: 'XLM', receivedAmount: '2.0000000', receivedAsset: USD });
});

test('deduplicates operations, excludes failed transactions and explicitly reports unsupported ones', () => {
  const report = summarizeFlows('testnet', [A, B], [op(1), op(1), op(2, { transaction_successful: false }),
    op(3, { type: 'manage_sell_offer' })], { fromLedger: 1, toLedger: 100 }, extra);
  expect(report.inspectedOperations).toBe(3);
  expect(report.relationships).toHaveLength(1);
  expect(report.unsupportedOperations.manage_sell_offer).toBe(1);
});

test('records missing ledger metadata as incomplete for a ledger-filtered report', () => {
  const report = summarizeFlows('testnet', [A], [op(2, { ledger: undefined })], { fromLedger: 1 }, extra);
  expect(report.relationships).toHaveLength(0);
  expect(report.warnings.join(' ')).toContain('ledger unavailable');
});

test('handles paginated Horizon requests and deduplicates records discovered under multiple accounts', async () => {
  const first = Array.from({ length: 200 }, (_, i) => op(i + 1));
  const fetcher = jest.fn(async (url: string) => {
    const cursor = new URL(url).searchParams.get('cursor');
    const records = cursor ? [op(201)] : first;
    return { ok: true, json: async () => ({ _embedded: { records } }) } as Response;
  }) as unknown as typeof fetch;
  const report = await analyzeFlows({ accounts: [A, B], network: 'testnet', fromLedger: 1, toLedger: 100, fetcher });
  expect(report.relationships).toHaveLength(201);
  expect(report.pagination.complete).toBe(true);
  expect(report.pagination.pages).toBe(4);
});

test('flags interrupted pagination instead of reporting complete history', async () => {
  const first = Array.from({ length: 200 }, (_, i) => op(i + 1));
  const fetcher = jest.fn(async (url: string) => {
    if (new URL(url).searchParams.get('cursor')) throw new Error('timeout');
    return { ok: true, json: async () => ({ _embedded: { records: first } }) } as Response;
  }) as unknown as typeof fetch;
  const report = await analyzeFlows({ accounts: [A], network: 'testnet', fromLedger: 1, toLedger: 100, fetcher });
  expect(report.pagination.complete).toBe(false);
  expect(report.warnings.join(' ')).toMatch(/interrupted/);
});
