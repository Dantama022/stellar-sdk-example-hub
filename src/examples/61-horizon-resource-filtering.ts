import { Asset, Horizon } from '@stellar/stellar-sdk';

/**
 * Example 61: Horizon Resource Filtering
 *
 * Horizon exposes a large number of resources that can be filtered using query
 * parameters such as account identifiers, asset pairs, cursors, limits, ordering,
 * and time ranges. Developers using the JavaScript SDK need to understand how
 * these filters affect the returned records and how to combine them safely.
 *
 * This example demonstrates building filtered Horizon queries across multiple
 * resource endpoints (transactions, operations, payments, effects, trades) and
 * explains which filters each resource supports.
 *
 * Quick Reference — Filter Support Matrix:
 *
 *   Filter                  tx    ops   payments  effects  trades
 *   ────────────────────────────────────────────────────────────────
 *   .forAccount(id)          ✓     ✓       ✓         ✓        ✗
 *   .forLedger(seq)          ✓     ✓       ✓         ✓        ✗
 *   .forTransaction(hash)    ✗     ✓       ✓         ✓        ✗
 *   .forOperation(id)        ✗     ✗       ✗         ✓        ✗
 *   .forLiquidityPool(id)    ✓     ✓       ✗         ✓        ✗
 *   .forClaimableBalance(id) ✓     ✓       ✓         ✓        ✗
 *   .forAssetPair(base,ctr)  ✗     ✗       ✗         ✗        ✓
 *   .includeFailed(bool)     ✓     ✓       ✗         ✗        ✗
 *   .order(direction)        ✓     ✓       ✓         ✓        ✓
 *   .limit(n)                ✓     ✓       ✓         ✓        ✓
 *   .cursor(token)           ✓     ✓       ✓         ✓        ✓
 *
 * Common chaining pattern:
 *   server.<resource>()
 *     .<filter>(value)       // resource-specific filter (optional)
 *     .order("desc")         // sort direction (optional)
 *     .limit(20)             // page size (1-200, optional)
 *     .cursor("token")       // cursor for pagination (optional)
 *     .call();               // execute the request
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_RESULT_LIMIT = 5;
const CURSOR_DEMO_LIMIT = 3;

// ── Reusable helpers ──────────────────────────────────────────────

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Formats a count with the record label for clear console output. */
function formatCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

// ── Filter configuration display ──────────────────────────────────

interface FilterConfig {
  resource: string;
  filters: string[];
  order: string;
  limit: number;
  cursor?: string;
}

function displayFilterConfig(config: FilterConfig): void {
  console.log('\n── Query Configuration ──');
  console.log(`  Resource: ${config.resource}`);
  console.log(
    `  Filters:  ${config.filters.length > 0 ? config.filters.join(', ') : '(none — global list)'}`,
  );
  console.log(`  Order:    ${config.order}`);
  console.log(`  Limit:    ${config.limit}`);
  if (config.cursor) {
    console.log(`  Cursor:   ${config.cursor}`);
  }
}

function separator(): void {
  console.log('\n' + '─'.repeat(64));
}

// ── Helper to extract record arrays from Horizon pages ────────────

type HorizonPage = { records: Array<Record<string, unknown>> };

// ── Resource Filter Support Matrix ────────────────────────────────

function displayFilterSupportMatrix(): void {
  console.log('\nHorizon Resource Filter Support:');
  console.log('');
  console.log('  Filter / Resource         tx    ops   payments  effects  trades');
  console.log('  ──────────────────────────────────────────────────────────────────');
  console.log('  .forAccount(id)            ✓      ✓       ✓         ✓        ✗');
  console.log('  .forLedger(seq)            ✓      ✓       ✓         ✓        ✗');
  console.log('  .forTransaction(hash)      ✗      ✓       ✓         ✓        ✗');
  console.log('  .forOperation(id)          ✗      ✗       ✗         ✓        ✗');
  console.log('  .forLiquidityPool(id)      ✓      ✓       ✗         ✓        ✗');
  console.log('  .forClaimableBalance(id)   ✓      ✓       ✓         ✓        ✗');
  console.log('  .forAssetPair(base, ctr)   ✗      ✗       ✗         ✗        ✓');
  console.log('  .includeFailed(bool)       ✓      ✓       ✗         ✗        ✗');
  console.log('  .order(direction)          ✓      ✓       ✓         ✓        ✓');
  console.log('  .limit(n)                  ✓      ✓       ✓         ✓        ✓');
  console.log('  .cursor(token)             ✓      ✓       ✓         ✓        ✓');
  console.log('');
  console.log('  Key: tx = transactions, ops = operations');
}

// ── 1. Filtering Operations by Account ────────────────────────────

async function demoOperationsByAccount(server: Horizon.Server, accountId: string): Promise<void> {
  const limit = DEFAULT_RESULT_LIMIT;
  const config: FilterConfig = {
    resource: 'operations',
    filters: [`forAccount(${accountId.slice(0, 8)}...)`],
    order: 'desc',
    limit,
  };

  separator();
  console.log('\n📌 DEMO 1: Filter Operations by Account');
  console.log('   .forAccount() limits results to operations where the account is either');
  console.log('   the source or a participant (destination, trustor, etc.).');
  displayFilterConfig(config);

  try {
    const page = await server.operations().forAccount(accountId).order('desc').limit(limit).call();

    console.log(`\n  → Returned ${formatCount(page.records.length, 'record')}`);

    if (page.records.length > 0) {
      console.log('\n  Sample operation types seen:');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const types = new Set(page.records.map((op: any) => op.type as string));
      for (const type of types) {
        console.log(`    - ${type}`);
      }
      console.log(`\n  Paging cursor (first record): ${page.records[0].paging_token}`);
    }
  } catch (error: unknown) {
    console.log(`\n  ⚠ Error: ${getErrorMessage(error)}`);
  }
}

// ── 2. Filtering Effects by Operation ─────────────────────────────

async function demoEffectsByOperation(server: Horizon.Server): Promise<void> {
  separator();
  console.log('\n📌 DEMO 2: Filter Effects by Operation and Transaction');
  console.log('   .forOperation() restricts effects to those produced by a single operation.');
  console.log('   .forTransaction() restricts effects to those from a single transaction.');

  console.log('\n   Fetching a recent operation to use as filter target...');
  try {
    const opsPage = await server.operations().order('desc').limit(1).call();
    if (opsPage.records.length === 0) {
      console.log('   No recent operations found.');
      return;
    }

    const operationId = opsPage.records[0].id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const txHash = (opsPage.records[0] as any).transaction_hash as string;

    // Demo forOperation
    const config: FilterConfig = {
      resource: 'effects',
      filters: [`forOperation(${operationId})`],
      order: 'asc',
      limit: DEFAULT_RESULT_LIMIT,
    };

    displayFilterConfig(config);

    const effectsPage = await server
      .effects()
      .forOperation(operationId)
      .order('asc')
      .limit(DEFAULT_RESULT_LIMIT)
      .call();

    console.log(`\n  → Returned ${formatCount(effectsPage.records.length, 'effect')}`);

    if (effectsPage.records.length > 0) {
      console.log('\n  Effects returned:');
      for (const effect of effectsPage.records.slice(0, 5)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const eff = effect as any;
        console.log(`    ${eff.type} → ${(eff.account as string)?.slice(0, 8)}...`);
      }
    }

    // Demo forTransaction on effects
    if (txHash) {
      console.log('\n   Also demonstrating .forTransaction() on effects:');
      const txEffectsPage = await server
        .effects()
        .forTransaction(txHash)
        .order('asc')
        .limit(DEFAULT_RESULT_LIMIT)
        .call();

      console.log(
        `   Effects for transaction ${txHash.slice(0, 8)}...: ${txEffectsPage.records.length}`,
      );
    }
  } catch (error: unknown) {
    console.log(`\n  ⚠ Error: ${getErrorMessage(error)}`);
  }
}

// ── 3. Limit and Ordering Parameters ──────────────────────────────

async function demoLimitAndOrdering(server: Horizon.Server, accountId: string): Promise<void> {
  separator();
  console.log('\n📌 DEMO 3: Limit and Ordering Parameters');
  console.log('   .limit(n) caps the number of records per page (1-200).');
  console.log('   .order("asc" | "desc") controls sort direction by ledger close time.');

  for (const order of ['desc', 'asc'] as const) {
    const config: FilterConfig = {
      resource: 'operations',
      filters: [`forAccount(${accountId.slice(0, 8)}...)`],
      order,
      limit: CURSOR_DEMO_LIMIT,
    };

    console.log(`\n  ── ${order.toUpperCase()} order ──`);
    displayFilterConfig(config);

    try {
      const page = await server
        .operations()
        .forAccount(accountId)
        .order(order)
        .limit(CURSOR_DEMO_LIMIT)
        .call();

      console.log(`\n  → Returned ${formatCount(page.records.length, 'record')}`);

      if (page.records.length > 0) {
        console.log('  Paging tokens (demonstrating sort direction):');
        for (const rec of page.records) {
          console.log(`    ${rec.paging_token} — ${rec.type}`);
        }
      }
    } catch (error: unknown) {
      console.log(`\n  ⚠ Error: ${getErrorMessage(error)}`);
    }
  }
}

// ── 4. Cursor-Based Filtering ─────────────────────────────────────

async function demoCursorBasedFiltering(server: Horizon.Server, accountId: string): Promise<void> {
  separator();
  console.log('\n📌 DEMO 4: Cursor-Based Filtering');
  console.log('   .cursor(token) returns records that come after the specified paging token.');
  console.log('   This is the foundation for reliable pagination and resume-after-failure.');

  console.log('\n   Step 1: Fetch first page (no cursor)');
  try {
    const firstPage = await server
      .operations()
      .forAccount(accountId)
      .order('asc')
      .limit(CURSOR_DEMO_LIMIT)
      .call();

    if (firstPage.records.length === 0) {
      console.log('   No operations found for this account.');
      return;
    }

    const lastRecord = firstPage.records[firstPage.records.length - 1];
    const cursor = lastRecord.paging_token;

    console.log(`   Fetched ${firstPage.records.length} records.`);
    console.log(`   Last record paging token (cursor): ${cursor}`);

    // Step 2: Fetch next page using cursor
    console.log('\n   Step 2: Fetch records after cursor');
    const cursorConfig: FilterConfig = {
      resource: 'operations',
      filters: [`forAccount(${accountId.slice(0, 8)}...)`],
      order: 'asc',
      limit: CURSOR_DEMO_LIMIT,
      cursor,
    };
    displayFilterConfig(cursorConfig);

    const nextPage = await server
      .operations()
      .forAccount(accountId)
      .order('asc')
      .cursor(cursor)
      .limit(CURSOR_DEMO_LIMIT)
      .call();

    console.log(`\n  → Returned ${formatCount(nextPage.records.length, 'record')}`);

    if (nextPage.records.length > 0) {
      console.log(
        `   First record after cursor: ${nextPage.records[0].paging_token} — ${nextPage.records[0].type}`,
      );
      console.log(
        '   ✓ Cursor-based pagination is working: these are new records after the cursor.',
      );
    } else {
      console.log('   No more records after cursor (account may have limited history).');
    }

    // Step 3: Demonstrate an invalid cursor
    console.log('\n   Step 3: Invalid cursor handling');
    console.log('   Attempting to query with cursor "invalid_cursor_token"...');
    try {
      await server
        .operations()
        .forAccount(accountId)
        .cursor('invalid_cursor_token')
        .limit(1)
        .call();

      console.log('   ⚠ Unexpected: invalid cursor did not trigger an error.');
    } catch (error: unknown) {
      console.log(`   ✓ Expected error with invalid cursor: ${getErrorMessage(error)}`);
    }
  } catch (error: unknown) {
    console.log(`\n  ⚠ Error: ${getErrorMessage(error)}`);
  }
}

// ── 5. Invalid/Incompatible Filter Combinations ───────────────────

async function demoInvalidFilterCombinations(
  server: Horizon.Server,
  accountId: string,
): Promise<void> {
  separator();
  console.log('\n📌 DEMO 5: Invalid and Incompatible Filter Handling');
  console.log(
    '   Horizon rejects queries with invalid parameter values (e.g., out-of-range limit,',
  );
  console.log('   invalid cursor format). These are surfaced as thrown errors.');
  console.log(
    '   Some "incompatible" combinations simply return empty results rather than errors.',
  );

  // 5a. Limit out of range (> 200)
  console.log('\n   ── Out-of-range limit (999) ──');
  console.log('   Horizon max limit is 200. Requesting 999...');
  try {
    await server.operations().forAccount(accountId).limit(999).call();
    console.log('   ⚠ Unexpectedly succeeded — Horizon may clamp the value internally.');
  } catch (error: unknown) {
    console.log(`   ✓ Caught expected error: ${getErrorMessage(error)}`);
  }

  // 5b. Invalid order value
  console.log('\n   ── Invalid order value ("random") ──');
  console.log('   Order must be "asc" or "desc". Passing "random"...');
  try {
    const page = await server
      .operations()
      .forAccount(accountId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .order('random' as any)
      .limit(1)
      .call();

    console.log(`   SDK did not throw. Returned ${page.records.length} record(s).`);
    console.log(
      '   Note: Horizon typically ignores unrecognised order values and defaults to asc.',
    );
  } catch (error: unknown) {
    console.log(`   ✓ Caught expected error: ${getErrorMessage(error)}`);
  }

  // 5c. Non-existent account (valid format, no ledger state)
  console.log('\n   ── Non-existent account ──');
  const fakeId = 'GDYSXG6GGAS4SG6KKLXBVRH6MRGGQSFQDE2ABHQNDQJBNFEYBKI6ENQD';
  console.log(`   Querying operations for ${fakeId.slice(0, 8)}... (valid format, no data)`);
  try {
    const page = await server.operations().forAccount(fakeId).limit(3).call();

    console.log(`   Returned ${page.records.length} record(s) — gracefully empty (valid result).`);
    console.log('   ✓ Querying a non-existent account returns an empty page, not an error.');
  } catch (error: unknown) {
    console.log(`   ⚠ Error: ${getErrorMessage(error)} (may get 404 on some endpoints)`);
  }
}

// ── 6. Cross-Resource Filtered Queries ────────────────────────────

async function demoCrossResourceFiltering(
  server: Horizon.Server,
  accountId: string,
): Promise<void> {
  separator();
  console.log('\n📌 DEMO 6: Cross-Resource Filtered Queries');
  console.log('   Demonstrating filtered queries across multiple resource types using');
  console.log('   the same account. Each resource supports different filters.');

  const queries: Array<{
    label: string;
    fetch: () => Promise<HorizonPage>;
    supportedFilters: string[];
  }> = [
    {
      label: 'Transactions for account',
      fetch: () =>
        server
          .transactions()
          .forAccount(accountId)
          .includeFailed(false)
          .limit(DEFAULT_RESULT_LIMIT)
          .order('desc')
          .call() as unknown as Promise<HorizonPage>,
      supportedFilters: ['forAccount', 'includeFailed'],
    },
    {
      label: 'Operations for account',
      fetch: () =>
        server
          .operations()
          .forAccount(accountId)
          .limit(DEFAULT_RESULT_LIMIT)
          .order('desc')
          .call() as unknown as Promise<HorizonPage>,
      supportedFilters: ['forAccount'],
    },
    {
      label: 'Payments for account',
      fetch: () =>
        server
          .payments()
          .forAccount(accountId)
          .limit(DEFAULT_RESULT_LIMIT)
          .order('desc')
          .call() as unknown as Promise<HorizonPage>,
      supportedFilters: ['forAccount'],
    },
    {
      label: 'Effects for account',
      fetch: () =>
        server
          .effects()
          .forAccount(accountId)
          .limit(DEFAULT_RESULT_LIMIT)
          .order('desc')
          .call() as unknown as Promise<HorizonPage>,
      supportedFilters: ['forAccount'],
    },
  ];

  for (const query of queries) {
    console.log(`\n  ── ${query.label} ──`);
    console.log(`  Applied filters: ${query.supportedFilters.join(', ')}`);
    try {
      const page = await query.fetch();
      console.log(`  → ${formatCount(page.records.length, 'record')}`);
    } catch (error: unknown) {
      console.log(`  ⚠ Error: ${getErrorMessage(error)}`);
    }
  }
}

// ── 7. Filtering Trades by Asset Pair ─────────────────────────────

async function demoTradesByAssetPair(server: Horizon.Server): Promise<void> {
  separator();
  console.log('\n📌 DEMO 7: Filter Trades by Asset Pair');
  console.log('   .forAssetPair() is unique to the trades endpoint. It filters completed SDEX');
  console.log('   trades to a specific base/counter asset pair using Asset objects.');

  // Discover an active asset pair from recent trades
  console.log('\n   Looking for a recently traded asset pair...');
  try {
    const recentTrade = await server.trades().order('desc').limit(1).call();
    if (recentTrade.records.length === 0) {
      console.log('   No recent trades found. Using a default native pair.');
      // Fallback: query trades for native vs a well-known asset
      const config: FilterConfig = {
        resource: 'trades',
        filters: ['forAssetPair(native, native) — native only'],
        order: 'desc',
        limit: DEFAULT_RESULT_LIMIT,
      };
      displayFilterConfig(config);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const record = recentTrade.records[0] as any;

    // Build Asset objects from the trade record
    const buildAsset = (type: unknown, code: unknown, issuer: unknown): Asset | null => {
      if (!type || type === 'native') {
        return Asset.native();
      }
      return code && issuer ? new Asset(String(code), String(issuer)) : null;
    };

    const baseAsset = buildAsset(
      record.base_asset_type,
      record.base_asset_code,
      record.base_asset_issuer,
    );
    const counterAsset = buildAsset(
      record.counter_asset_type,
      record.counter_asset_code,
      record.counter_asset_issuer,
    );

    if (!baseAsset || !counterAsset) {
      console.log('   Could not parse asset pair from trade record.');
      return;
    }

    const baseLabel = baseAsset.isNative()
      ? 'XLM (native)'
      : `${baseAsset.getCode()}:${baseAsset.getIssuer()}`;
    const counterLabel = counterAsset.isNative()
      ? 'XLM (native)'
      : `${counterAsset.getCode()}:${counterAsset.getIssuer()}`;

    console.log(`   Discovered pair: ${baseLabel} / ${counterLabel}`);

    const config: FilterConfig = {
      resource: 'trades',
      filters: [`forAssetPair(${baseLabel}, ${counterLabel})`],
      order: 'desc',
      limit: DEFAULT_RESULT_LIMIT,
    };
    displayFilterConfig(config);

    const page = await server
      .trades()
      .forAssetPair(baseAsset, counterAsset)
      .order('desc')
      .limit(DEFAULT_RESULT_LIMIT)
      .call();

    console.log(`\n  → Returned ${formatCount(page.records.length, 'trade')}`);

    if (page.records.length > 0) {
      console.log('\n  Recent trades:');
      for (const trade of page.records.slice(0, 5)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t = trade as any;
        const price = t.price as { n: number; d: number } | undefined;
        const priceStr =
          price?.n !== undefined && price?.d !== undefined ? `${price.n}/${price.d}` : 'n/a';
        console.log(
          `    ${t.ledger_close_time} — base: ${t.base_amount} — counter: ${t.counter_amount} — price: ${priceStr}`,
        );
      }
    }

    // Also demonstrate that .forAssetPair does not exist on other resources
    console.log('\n   Verifying .forAssetPair is exclusive to trades...');
    console.log('   (The SDK does not expose .forAssetPair on transactions, operations,');
    console.log('   payments, or effects — these resources lack an asset-pair index.)');
  } catch (error: unknown) {
    console.log(`\n  ⚠ Error: ${getErrorMessage(error)}`);
  }
}

// ── Chaining Pattern Recap ────────────────────────────────────────

function displayChainingPattern(): void {
  separator();
  console.log('\n📌 Common Query Chaining Pattern');
  console.log('');
  console.log('  const page = await server');
  console.log(
    '    .<resource>()            // transactions | operations | payments | effects | trades',
  );
  console.log('    .<filter>(value)         // e.g., .forAccount(id), .forTransaction(hash)');
  console.log('    .order("desc")           // "asc" or "desc"');
  console.log('    .limit(20)               // 1-200 records per page');
  console.log('    .cursor("paging_token")  // pagination resume point');
  console.log('    .call();                 // execute the HTTP request');
  console.log('');
  console.log('  // page.records contains the returned items');
  console.log('  // page.next() fetches the next page when available');
  console.log('  // page.prev() fetches the previous page when available');
}

// ── Main entry point ──────────────────────────────────────────────

export interface HorizonFilteringParams {
  accountId?: string;
  horizonUrl?: string;
}

export async function run(params: HorizonFilteringParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;

  const server = new Horizon.Server(horizonUrl);

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     Horizon Resource Filtering Example                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\nUsing Horizon: ${horizonUrl}`);
  console.log('\nThis example demonstrates building filtered Horizon queries using the');
  console.log('Stellar JavaScript SDK fluent API: server.<resource>().<filter>().call()');

  // Display the filter support matrix
  displayFilterSupportMatrix();

  // Resolve an account ID for account-specific demos
  let accountId =
    params.accountId?.trim() || process.env.ACCOUNT_ID?.trim() || process.argv[3]?.trim();

  if (!accountId) {
    console.log('\nNo account ID supplied. Fetching an active account from recent operations...');
    try {
      const recentOps = await server.operations().order('desc').limit(1).call();

      if (recentOps.records.length > 0) {
        accountId = recentOps.records[0].source_account;
        console.log(`Using account from recent operation: ${accountId}`);
      }
    } catch {
      // Falls through to hardcoded fallback below
    }
  }

  if (!accountId) {
    // Known active testnet account as fallback
    accountId = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
    console.log(`Using default account: ${accountId}`);
  }

  console.log(`Demonstration account: ${accountId}`);
  console.log('(This account is only read from Horizon; no transactions are submitted.)');

  // Run all demonstrations
  await demoOperationsByAccount(server, accountId);
  await demoEffectsByOperation(server);
  await demoLimitAndOrdering(server, accountId);
  await demoCursorBasedFiltering(server, accountId);
  await demoInvalidFilterCombinations(server, accountId);
  await demoCrossResourceFiltering(server, accountId);
  await demoTradesByAssetPair(server);

  // Display chaining pattern recap
  displayChainingPattern();

  separator();
  console.log('\nHorizon resource filtering example completed successfully.');
  console.log('\nKey takeaways:');
  console.log(
    '  • Each Horizon resource supports a specific set of filters — check the matrix above.',
  );
  console.log(
    '  • Filter by account (.forAccount) is the most commonly used filter across resources.',
  );
  console.log('  • .limit() and .order() work on every paginated endpoint.');
  console.log('  • .cursor() enables reliable forward pagination and stream resumption.');
  console.log(
    '  • .forAssetPair() is unique to the trades endpoint — filter SDEX trades by asset.',
  );
  console.log(
    '  • Invalid parameters typically produce 400 errors — validate inputs before querying.',
  );
  console.log('  • Non-existent accounts return empty pages, not errors — handle gracefully.');
  console.log('');
}
