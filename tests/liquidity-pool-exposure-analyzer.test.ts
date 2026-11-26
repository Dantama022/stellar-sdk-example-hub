import { analyzePool, calculateExposure, reportPool } from '../examples/liquidity-pool-exposure-analyzer/analyzer';
import type { PoolRecord } from '../examples/liquidity-pool-exposure-analyzer/types';
const POOL = '1'.repeat(64);
const ACCOUNT = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const pool: PoolRecord = { id: POOL, total_shares: '10.0000000', last_modified_ledger: 150,
  reserves: [{ asset: 'native', amount: '100.0000000' }, { asset: `USD:${ACCOUNT}`, amount: '25.0000000' }] };

test('calculates exact proportions and preserves native/issued asset identities', () => {
  const outcome = calculateExposure(pool.reserves, '2.5000000', '10.0000000');
  expect(outcome.ownershipPercent).toBe('25.000000');
  expect(outcome.estimatedExposure).toEqual([
    { asset: 'native', amount: '25.0000000' }, { asset: `USD:${ACCOUNT}`, amount: '6.2500000' },
  ]);
});

test('handles large quantities and seven-digit fraction precision', () => {
  const report = calculateExposure([{ asset: 'native', amount: '10000000000.0000001' },
    { asset: 'USDC:issuer', amount: '1.0000000' }], '0.0000001', '1.0000000');
  expect(report.estimatedExposure[0].amount).toBe('1000.0000000');
  expect(report.estimatedExposure[1].amount).toBe('0.0000001');
});

test('reports no trustline as zero shares and zero exposure rather than an account error', () => {
  const report = reportPool({ network: 'testnet', poolId: POOL, account: ACCOUNT }, pool, []);
  expect(report.accountShares).toBe('0.0000000');
  expect(report.estimatedExposure?.[0].amount).toBe('0.0000000');
});

test('exposes inconclusive status for missing account metadata or zero supply', () => {
  const missing = reportPool({ network: 'testnet', poolId: POOL, account: ACCOUNT }, pool);
  expect(missing.estimatedExposure).toBeNull(); expect(missing.complete).toBe(false);
  const zero = reportPool({ network: 'testnet', poolId: POOL, account: ACCOUNT },
    { ...pool, total_shares: '0.0000000' }, [{ asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL, balance: '1.0000000' }]);
  expect(zero.estimatedExposure).toBeNull();
  expect(zero.warnings.join(' ')).toMatch(/zero/);
});

test('rejects malformed pool IDs and invalid share values', () => {
  expect(() => reportPool({ network: 'testnet', poolId: 'bad' }, pool)).toThrow(/pool ID/);
  expect(() => calculateExposure(pool.reserves, '2.0000000', '1.0000000')).toThrow(/exceed/);
  expect(() => calculateExposure(pool.reserves, '0.0000001', 'not-a-number')).toThrow();
});

test('retrieves pool and account records via mocked Horizon and produces serializable report', async () => {
  const fetcher = jest.fn(async (url: string) => ({ ok: true,
    json: async () => url.includes('/liquidity_pools/') ? pool : { balances: [
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL, balance: '5.0000000' }] },
  } as Response)) as unknown as typeof fetch;
  const report = await analyzePool({ network: 'testnet', poolId: POOL, account: ACCOUNT, fetcher });
  expect(report.ownershipPercent).toBe('50.000000');
  expect(JSON.parse(JSON.stringify(report)).estimatedExposure).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('network failures remain visible', async () => {
  const fetcher = jest.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  await expect(analyzePool({ network: 'testnet', poolId: POOL, fetcher })).rejects.toThrow(/network failure/);
});
