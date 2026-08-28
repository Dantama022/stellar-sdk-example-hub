/**
 * 93-trustline-management
 *
 * Demonstrates the full trustline lifecycle on Stellar:
 *   1. Creating a trustline with a custom limit using changeTrust
 *   2. Inspecting trustline details (balance, limit, authorization status)
 *   3. Updating the trust limit
 *   4. Removing the trustline by setting the limit to zero
 *
 * Background
 * ----------
 * Every non-native Stellar asset (e.g. USDC, EURC, MYTOKEN) requires the
 * receiving account to explicitly opt in by establishing a trustline.  A
 * trustline records:
 *   - The asset the account trusts (code + issuer)
 *   - The maximum balance the account is willing to hold (the "limit")
 *   - The current balance
 *   - The authorization state (authorized / deauthorized / authorized-to-maintain-liabilities)
 *
 * Until a trustline exists, Stellar network nodes will reject any payment of
 * that asset to the account — even a payment of 0.  This protects accounts
 * from receiving assets they did not consent to hold, which would increase
 * their minimum reserve (0.5 XLM per subentry).
 *
 * The changeTrust operation creates, updates, or removes a trustline:
 *   - limit > "0"  →  create or update the trustline
 *   - limit = "0"  →  remove the trustline (only if balance is zero)
 *
 * Running
 * -------
 * npm run run-example 93-trustline-management
 *
 * Environment variables
 * ---------------------
 * HORIZON_URL   Horizon endpoint (default: Testnet)
 * ASSET_CODE    Asset code to trust (default: DEMO)
 */

import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
} from '@stellar/stellar-sdk';
import type { HorizonApi } from '@stellar/stellar-sdk/lib/horizon/horizon_api';
import chalk from 'chalk';

// ─── types ──────────────────────────────────────────────────────────────────

interface TrustlineManagementParams {
  assetCode?: string;
  horizonUrl?: string;
}

// Minimal shape shared by all BalanceLine variants from Horizon.
type BalanceLine = HorizonApi.BalanceLine;
type BalanceLineAsset = HorizonApi.BalanceLineAsset;

// ─── helpers ────────────────────────────────────────────────────────────────

function shortenKey(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function formatLimit(limit: string): string {
  if (limit === '922337203685.4775807') return `${limit} (maximum possible)`;
  return limit;
}

function authFlagLabel(flag: string): string {
  switch (flag) {
    case '0':
      return 'deauthorized – cannot send or receive this asset';
    case '1':
      return 'fully authorized – can send and receive';
    case '2':
      return 'authorized to maintain liabilities only – can hold but not transact';
    default:
      return `unknown (${flag})`;
  }
}

function printTrustline(tl: BalanceLine, label = 'Trustline details'): void {
  if (tl.asset_type === 'native') {
    console.log(chalk.gray(`  ${label}: native XLM (no trustline required)`));
    return;
  }

  const issued = tl as BalanceLineAsset;
  console.log(chalk.bold(`\n  ${label}`));
  console.log(`    Asset code:          ${issued.asset_code}`);
  console.log(`    Asset issuer:        ${issued.asset_issuer}`);
  console.log(`    Balance:             ${issued.balance}`);
  console.log(`    Limit:               ${formatLimit(issued.limit)}`);
  console.log(`    Authorization:       ${authFlagLabel(String(issued.is_authorized ? 1 : 0))}`);
  console.log(`    Buying liabilities:  ${issued.buying_liabilities ?? '0'}`);
  console.log(`    Selling liabilities: ${issued.selling_liabilities ?? '0'}`);
}

async function fundAccount(publicKey: string): Promise<void> {
  const url = `https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Friendbot funding failed: ${response.status} ${response.statusText}`);
  }
}

async function submitChangeTrust(
  server: Horizon.Server,
  account: Horizon.AccountResponse,
  keypair: Keypair,
  asset: Asset,
  limit: string,
  networkPassphrase: string,
): Promise<string> {
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase,
  })
    .addOperation(
      Operation.changeTrust({
        asset,
        limit,
      }),
    )
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  const response = await server.submitTransaction(tx);
  return response.hash;
}

// ─── main ────────────────────────────────────────────────────────────────────

export async function run(params: TrustlineManagementParams = {}): Promise<void> {
  const horizonUrl =
    params.horizonUrl ?? process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
  const assetCode = params.assetCode ?? process.env.ASSET_CODE ?? 'DEMO';

  const networkPassphrase = Networks.TESTNET;
  const server = new Horizon.Server(horizonUrl);

  // ── Introduction ───────────────────────────────────────────────────────────
  console.log(chalk.bold('\n═══════════════════════════════════════════'));
  console.log(chalk.bold(' Stellar Trustline Management Example'));
  console.log(chalk.bold('═══════════════════════════════════════════'));
  console.log(`
Trustlines are explicit opt-ins that allow an account to hold a non-native
Stellar asset.  Without a trustline the network rejects any payment of that
asset to the account, even zero-value payments.

Each trustline consumes one account subentry, which increases the account's
minimum reserve by 0.5 XLM (base reserve × 1 subentry).

The changeTrust operation creates, updates, or removes a trustline:
  • limit > "0"  — create or update
  • limit = "0"  — remove (balance must already be zero)
`);

  // ── Step 0: Prepare accounts ───────────────────────────────────────────────
  console.log(chalk.cyan('Step 0 — Preparing accounts'));

  // The holder is the account that will manage trustlines.
  const holder = Keypair.random();
  // The issuer controls the custom asset (simulated; in production this is the
  // real issuer's account).
  const issuer = Keypair.random();

  console.log(`  Holder public key:  ${holder.publicKey()}`);
  console.log(`  Issuer public key:  ${issuer.publicKey()}`);

  console.log(chalk.gray('  Funding both accounts via Friendbot…'));
  await Promise.all([fundAccount(holder.publicKey()), fundAccount(issuer.publicKey())]);
  console.log(chalk.green('  Both accounts funded.'));

  const asset = new Asset(assetCode, issuer.publicKey());
  console.log(`\n  Asset:  ${asset.code} issued by ${shortenKey(asset.issuer)}`);

  // ── Step 1: Inspect account before any trustlines ─────────────────────────
  console.log(chalk.cyan('\nStep 1 — Account state before trustline creation'));

  let holderAccount = await server.loadAccount(holder.publicKey());
  const nativeBefore = holderAccount.balances.find((b) => b.asset_type === 'native')!;
  const subEntriesBefore = holderAccount.subentry_count;
  console.log(`  XLM balance:   ${nativeBefore.balance}`);
  console.log(`  Subentries:    ${subEntriesBefore}  (each costs 0.5 XLM reserve)`);
  console.log(
    `  Trustlines:    ${holderAccount.balances.filter((b) => b.asset_type !== 'native').length}`,
  );

  // ── Step 2: Create trustline with a custom limit ───────────────────────────
  const initialLimit = '5000';
  console.log(
    chalk.cyan(`\nStep 2 — Creating trustline for ${asset.code} with limit ${initialLimit}`),
  );

  holderAccount = await server.loadAccount(holder.publicKey());
  const createHash = await submitChangeTrust(
    server,
    holderAccount,
    holder,
    asset,
    initialLimit,
    networkPassphrase,
  );
  console.log(chalk.green(`  Trustline created.  Transaction hash: ${createHash}`));
  console.log(`
  What happened:
    • The holder account submitted a changeTrust operation with limit="${initialLimit}".
    • A new ledger entry (trustline) was created linking the holder to ${asset.code}.
    • The holder's subentry count increased by 1, raising the minimum reserve by 0.5 XLM.
    • The trustline balance starts at 0 — no ${asset.code} has been received yet.
`);

  // ── Step 3: Inspect trustline details ──────────────────────────────────────
  console.log(chalk.cyan('Step 3 — Inspecting trustline details'));

  holderAccount = await server.loadAccount(holder.publicKey());
  const createdTrustline = holderAccount.balances.find(
    (b) =>
      b.asset_type !== 'native' &&
      (b as BalanceLineAsset).asset_code === assetCode &&
      (b as BalanceLineAsset).asset_issuer === issuer.publicKey(),
  );

  if (!createdTrustline) {
    throw new Error(`Trustline for ${assetCode} not found after creation`);
  }

  printTrustline(createdTrustline, 'Newly created trustline');

  const subEntriesAfterCreate = holderAccount.subentry_count;
  const nativeAfterCreate = holderAccount.balances.find((b) => b.asset_type === 'native')!;
  console.log(`\n  XLM balance after create:  ${nativeAfterCreate.balance}`);
  console.log(
    `  Subentries after create:   ${subEntriesAfterCreate}  (+${subEntriesAfterCreate - subEntriesBefore} from trustline)`,
  );
  console.log(`
  Authorization flags explained:
    0 — deauthorized         (issuer has revoked the account's permission)
    1 — fully authorized     (default for non-auth-required assets; can transact)
    2 — liabilities only     (can maintain existing positions but not transact)

  For assets whose issuer did NOT set AUTH_REQUIRED the trustline is
  immediately fully authorized (flag = 1) upon creation.  If AUTH_REQUIRED is
  set the trustline starts deauthorized until the issuer explicitly authorizes
  it via allowTrust or setTrustLineFlags.
`);

  // ── Step 4: Update the trust limit ─────────────────────────────────────────
  const updatedLimit = '25000';
  console.log(chalk.cyan(`Step 4 — Updating trust limit from ${initialLimit} to ${updatedLimit}`));

  holderAccount = await server.loadAccount(holder.publicKey());
  const updateHash = await submitChangeTrust(
    server,
    holderAccount,
    holder,
    asset,
    updatedLimit,
    networkPassphrase,
  );
  console.log(chalk.green(`  Limit updated.  Transaction hash: ${updateHash}`));

  holderAccount = await server.loadAccount(holder.publicKey());
  const updatedTrustline = holderAccount.balances.find(
    (b) => b.asset_type !== 'native' && (b as BalanceLineAsset).asset_code === assetCode,
  )!;
  printTrustline(updatedTrustline, 'Trustline after limit update');

  console.log(`
  Key constraint: the new limit must be ≥ the current balance + buying liabilities.
  Attempting to lower the limit below the balance would be rejected by the network.
`);

  // ── Step 5: Invalid asset — demonstrate graceful error handling ────────────
  console.log(chalk.cyan('Step 5 — Demonstrating invalid asset handling'));

  try {
    // An asset with an invalid issuer account ID will be rejected by the SDK
    // before any network request is made.
    new Asset('BAD', 'not-a-valid-stellar-account-id');
    console.log(chalk.red('  Expected error was not thrown — this should not happen'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.yellow(`  Invalid issuer correctly rejected: ${message}`));
  }

  // Demonstrate that the network rejects setting a limit below the balance.
  // We have balance = 0 here so we cannot demonstrate that easily without
  // issuing the asset first; instead we show the conceptual explanation.
  console.log(`
  Common trustline errors:
    • op_no_account         — source account does not exist
    • op_low_reserve        — account cannot afford the 0.5 XLM reserve for the new subentry
    • op_invalid_limit      — limit is negative or would be below current balance
    • op_self_not_allowed   — cannot create a trustline to your own issued asset
    • op_not_authorized     — asset's issuer has AUTH_REQUIRED set and has not authorized yet
`);

  // ── Step 6: Remove the trustline ──────────────────────────────────────────
  console.log(chalk.cyan('Step 6 — Removing the trustline (limit = "0")'));

  holderAccount = await server.loadAccount(holder.publicKey());
  const removeHash = await submitChangeTrust(
    server,
    holderAccount,
    holder,
    asset,
    '0', // limit = "0" removes the trustline
    networkPassphrase,
  );
  console.log(chalk.green(`  Trustline removed.  Transaction hash: ${removeHash}`));
  console.log(`
  What happened:
    • changeTrust with limit="0" is the standard way to close a trustline.
    • The network only allows this if the balance is 0 and there are no
      outstanding liabilities (open offers or claimable balances).
    • The account's subentry count decreased by 1, recovering 0.5 XLM of reserve.
`);

  // ── Step 7: Verify removal ─────────────────────────────────────────────────
  console.log(chalk.cyan('Step 7 — Verifying trustline removal'));

  holderAccount = await server.loadAccount(holder.publicKey());
  const removedTrustline = holderAccount.balances.find(
    (b) => b.asset_type !== 'native' && (b as BalanceLineAsset).asset_code === assetCode,
  );

  if (removedTrustline) {
    console.log(chalk.red('  Trustline still present — removal failed unexpectedly'));
  } else {
    console.log(chalk.green(`  Confirmed: no ${assetCode} trustline on account.`));
  }

  const nativeAfterRemove = holderAccount.balances.find((b) => b.asset_type === 'native')!;
  console.log(`  XLM balance:   ${nativeAfterRemove.balance}`);
  console.log(`  Subentries:    ${holderAccount.subentry_count}  (back to ${subEntriesBefore})`);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(chalk.bold('\n══════════════════════════════════'));
  console.log(chalk.bold(' Summary'));
  console.log(chalk.bold('══════════════════════════════════'));
  console.log(`
Trustline lifecycle completed:

  ✔  Created  a ${assetCode} trustline with limit=${initialLimit}
  ✔  Inspected balance, limit, and authorization status
  ✔  Updated  the limit to ${updatedLimit}
  ✔  Removed  the trustline and recovered the 0.5 XLM reserve

Key takeaways:
  • Non-native assets cannot be received until the receiver has a trustline.
  • Each trustline costs 0.5 XLM in minimum reserve (one subentry).
  • The limit is set by the holder, not the issuer.
  • Trustlines can be removed only when the balance and liabilities are zero.
  • If the issuer uses AUTH_REQUIRED, the trustline starts deauthorized.
`);
}
