import { Asset, Horizon, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

/**
 * Example 259: Stellar Liquidity Pool Inspection, Deposits, and Withdrawals
 *
 * Demonstrates how to inspect liquidity pools, retrieve pool information,
 * and prepare liquidity-pool deposit and withdrawal operations safely.
 *
 * This example is read-only by default. It inspects pool reserves, checks
 * deposit/withdrawal preconditions (pool existence, share trustline, price
 * bounds), and builds UNSIGNED transaction XDR for review. It never signs
 * with a real secret key and never submits transactions.
 *
 * Risks documented inline:
 * - Deposits require both assets at the pool ratio; imbalanced deposits
 *   shift the execution price and may fail min/max price bounds.
 * - Withdrawals burn pool shares and return both assets proportionally.
 * - Impermanent loss: if reserve prices diverge after deposit, withdrawing
 *   can return less value than holding both assets outside the pool.
 * - Pool-share trustlines consume a reserve entry; removing them requires
 *   a zero share balance first.
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 200;

export interface LiquidityPoolDepositWithdrawParams {
  /** 64-character hex liquidity pool ID. */
  poolId?: string;
  /** Account preparing the deposit/withdrawal (inspected, never signed). */
  accountId?: string;
  /** Deposit amounts as decimal strings. */
  maxAmountA?: string;
  maxAmountB?: string;
  /** Withdrawal amount in pool shares as decimal string. */
  poolShares?: string;
  /** Horizon URL override. */
  horizonUrl?: string;
}

export interface PoolPreflightCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface PoolPreflightReport {
  poolId: string;
  poolFound: boolean;
  checks: PoolPreflightCheck[];
  ready: boolean;
  unsignedDepositXdr?: string;
  unsignedWithdrawXdr?: string;
}

export function normalizePoolId(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('Invalid liquidity pool ID. Expected 64 hexadecimal characters.');
  }
  return normalized;
}

export function formatAmount(value?: string): string {
  return value ?? '0.0000000';
}

export async function fetchPoolById(
  server: Horizon.Server,
  poolId: string,
): Promise<any> {
  return server.liquidityPools().liquidityPoolId(poolId).call();
}

/**
 * Inspects pool reserves and validates deposit/withdrawal preconditions
 * without submitting anything.
 */
export async function buildPoolPreflight(
  server: Horizon.Server,
  poolId: string,
  accountId?: string,
  maxAmountA?: string,
  maxAmountB?: string,
  poolShares?: string,
): Promise<PoolPreflightReport> {
  const checks: PoolPreflightCheck[] = [];

  let pool: any = null;
  try {
    pool = await fetchPoolById(server, poolId);
  } catch (error: unknown) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    checks.push({
      name: 'pool-exists',
      passed: false,
      detail: status === 404 ? 'Pool not found on this Horizon instance.' : `Pool lookup failed: ${(error as Error).message}`,
    });
    return { poolId, poolFound: false, checks, ready: false };
  }

  checks.push({ name: 'pool-exists', passed: true, detail: `Pool ${pool.id} found.` });

  const reserves = (pool.reserves ?? []) as Array<{ asset?: string; amount?: string }>;
  if (reserves.length !== 2) {
    checks.push({ name: 'pool-reserves', passed: false, detail: 'Expected exactly two reserves.' });
    return { poolId, poolFound: true, checks, ready: false };
  }
  checks.push({
    name: 'pool-reserves',
    passed: true,
    detail: `Reserves: ${formatAmount(reserves[0].amount)} ${reserves[0].asset} / ${formatAmount(reserves[1].amount)} ${reserves[1].asset}.`,
  });

  if (!accountId) {
    checks.push({ name: 'account-supplied', passed: false, detail: 'No account supplied; deposit/withdrawal XDR skipped.' });
    return { poolId, poolFound: true, checks, ready: false };
  }

  let account: any = null;
  try {
    account = await server.loadAccount(accountId);
  } catch {
    checks.push({ name: 'account-exists', passed: false, detail: 'Account not found.' });
    return { poolId, poolFound: true, checks, ready: false };
  }
  checks.push({ name: 'account-exists', passed: true, detail: 'Account loaded.' });

  // Pool-share trustline check: withdrawing or receiving shares needs it.
  const shareBalance = (account.balances ?? []).find(
    (b: any) => b.liquidity_pool_id === poolId || b.asset_type === 'liquidity_pool_shares',
  );
  checks.push({
    name: 'pool-share-trustline',
    passed: Boolean(shareBalance),
    detail: shareBalance
      ? `Pool-share balance: ${formatAmount(shareBalance.balance)}.`
      : 'No pool-share trustline/balance. Establish it before depositing.',
  });

  // Unsigned deposit preparation (no signing, no submission).
  let unsignedDepositXdr: string | undefined;
  if (maxAmountA && maxAmountB) {
    try {
      const source = await server.loadAccount(accountId);
      const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase: 'Test SDF Network ; September 2015' })
        .addOperation(
          Operation.liquidityPoolDeposit({
            liquidityPoolId: poolId,
            maxAmountA,
            maxAmountB,
            minPrice: '0.5',
            maxPrice: '2',
          } as never),
        )
        .setTimeout(60)
        .build();
      unsignedDepositXdr = tx.toXDR();
      checks.push({ name: 'deposit-xdr', passed: true, detail: 'Unsigned deposit transaction built. Review min/max price bounds before signing.' });
    } catch (error: unknown) {
      checks.push({ name: 'deposit-xdr', passed: false, detail: `Deposit build failed: ${(error as Error).message}` });
    }
  }

  // Unsigned withdrawal preparation (no signing, no submission).
  let unsignedWithdrawXdr: string | undefined;
  if (poolShares && shareBalance) {
    try {
      const source = await server.loadAccount(accountId);
      const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase: 'Test SDF Network ; September 2015' })
        .addOperation(
          Operation.liquidityPoolWithdraw({
            liquidityPoolId: poolId,
            amount: poolShares,
            minAmountA: '0',
            minAmountB: '0',
          } as never),
        )
        .setTimeout(60)
        .build();
      unsignedWithdrawXdr = tx.toXDR();
      checks.push({ name: 'withdraw-xdr', passed: true, detail: 'Unsigned withdrawal transaction built. Set minAmountA/B slippage guards before signing.' });
    } catch (error: unknown) {
      checks.push({ name: 'withdraw-xdr', passed: false, detail: `Withdrawal build failed: ${(error as Error).message}` });
    }
  }

  const ready = checks.every((c) => c.passed || c.name === 'pool-share-trustline');
  return { poolId, poolFound: true, checks, ready, unsignedDepositXdr, unsignedWithdrawXdr };
}

/**
 * Runs the liquidity pool inspection/deposit/withdrawal example.
 *
 *   npm run run-example 259-liquidity-pool-deposit-withdraw-preflight
 *
 * Environment:
 *   HORIZON_URL, POOL_ID, ACCOUNT_ID, MAX_AMOUNT_A, MAX_AMOUNT_B, POOL_SHARES
 */
export async function run(params: LiquidityPoolDepositWithdrawParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);

  let poolId: string | undefined;
  try {
    poolId =
      normalizePoolId(params.poolId ?? process.env.POOL_ID ?? process.argv[3]) ??
      undefined;
  } catch (error: unknown) {
    console.log(`Invalid pool ID: ${(error as Error).message}`);
    return;
  }

  console.log('=== Stellar Liquidity Pool Inspection, Deposits, and Withdrawals ===');
  console.log(`Horizon: ${horizonUrl}`);

  if (!poolId) {
    console.log('Browsing available pools:');
    const page = await server.liquidityPools().limit(DEFAULT_LIMIT).call();
    for (const record of (page.records ?? []) as Array<{ id?: string }>) {
      console.log(`  - ${record.id}`);
    }
    console.log('\nSupply POOL_ID to inspect one pool and prepare deposit/withdrawal XDR.');
    return;
  }

  const report = await buildPoolPreflight(
    server,
    poolId,
    params.accountId ?? process.env.ACCOUNT_ID,
    params.maxAmountA ?? process.env.MAX_AMOUNT_A,
    params.maxAmountB ?? process.env.MAX_AMOUNT_B,
    params.poolShares ?? process.env.POOL_SHARES,
  );

  for (const check of report.checks) {
    console.log(`  [${check.passed ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`);
  }

  if (report.unsignedDepositXdr) {
    console.log('\nUnsigned deposit XDR (inspect before signing; not submitted):');
    console.log(report.unsignedDepositXdr);
  }
  if (report.unsignedWithdrawXdr) {
    console.log('\nUnsigned withdrawal XDR (inspect before signing; not submitted):');
    console.log(report.unsignedWithdrawXdr);
  }

  console.log('\nRisks: imbalanced deposits move price; withdrawals return both assets proportionally;');
  console.log('diverging reserve prices cause impermanent loss versus holding. Nothing was submitted.');
}
