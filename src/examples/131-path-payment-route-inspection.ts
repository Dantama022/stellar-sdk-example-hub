import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_MAX_ROUTES = 5;

/**
 * Path Payment Route Inspection Example
 * ────────────────────────────────────────
 * Discovers and compares candidate payment routes for a strict-receive path
 * payment (fixed destination amount) without ever constructing or
 * submitting a payment transaction.
 *
 * Stellar path payments can route through intermediate assets using either
 * the SDEX order books or AMM liquidity pools (or both, hop by hop) to
 * convert a source asset into a destination asset. `strictReceivePaths`
 * asks Horizon: "given this destination amount, what is the cheapest way to
 * pay for it starting from this source, and what would it cost?"
 *
 * Inputs (env vars, all optional):
 *   SOURCE_ACCOUNT   account whose balances are used to find paths
 *                    (if omitted, a self-contained demo market is created)
 *   SOURCE_ASSET     "native" or "CODE:ISSUER" (used with a demo/no-account query)
 *   DEST_ASSET       "native" or "CODE:ISSUER"
 *   DEST_AMOUNT      fixed amount the destination should receive
 *   MAX_ROUTES       maximum number of candidate routes to display/rank
 */

export interface HorizonPathHop {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}

export interface HorizonPathRecord {
  source_asset_type: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  source_amount: string;
  destination_asset_type: string;
  destination_asset_code?: string;
  destination_asset_issuer?: string;
  destination_amount: string;
  path: HorizonPathHop[];
}

export interface RouteReport {
  hops: string[];
  intermediateAssets: string[];
  sourceAmount: string;
  destinationAmount: string;
  effectiveRate: string;
}

export function formatAsset(hop: {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}): string {
  if (hop.asset_type === 'native') return 'XLM';
  return `${hop.asset_code}:${hop.asset_issuer?.slice(0, 8)}…`;
}

export function formatPath(path: HorizonPathHop[]): string[] {
  return path.map((hop) => formatAsset(hop));
}

/** Effective rate = destination units received per 1 unit of source spent. */
export function calculateEffectiveRate(sourceAmount: string, destinationAmount: string): string {
  const source = Number(sourceAmount);
  const destination = Number(destinationAmount);
  if (!Number.isFinite(source) || source <= 0) return 'n/a';
  return (destination / source).toFixed(7);
}

export function buildRouteReport(record: HorizonPathRecord): RouteReport {
  return {
    hops: [
      formatAsset({
        asset_type: record.source_asset_type,
        asset_code: record.source_asset_code,
        asset_issuer: record.source_asset_issuer,
      }),
      ...formatPath(record.path),
      formatAsset({
        asset_type: record.destination_asset_type,
        asset_code: record.destination_asset_code,
        asset_issuer: record.destination_asset_issuer,
      }),
    ],
    intermediateAssets: formatPath(record.path),
    sourceAmount: record.source_amount,
    destinationAmount: record.destination_amount,
    effectiveRate: calculateEffectiveRate(record.source_amount, record.destination_amount),
  };
}

/** Ranks routes by ascending source amount: for a fixed destination amount, less source spent is more efficient. */
export function rankRoutesByEfficiency(routes: RouteReport[]): RouteReport[] {
  return [...routes].sort((a, b) => Number(a.sourceAmount) - Number(b.sourceAmount));
}

export function parseAssetDefinition(rawAsset: string): Asset {
  const trimmed = rawAsset.trim();
  if (!trimmed) {
    throw new Error('Asset definition cannot be empty.');
  }
  if (trimmed.toLowerCase() === 'native' || trimmed.toLowerCase() === 'xlm') {
    return Asset.native();
  }
  const parts = trimmed.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid asset definition "${rawAsset}". Expected "native" or "CODE:ISSUER".`);
  }
  return new Asset(parts[0], parts[1]);
}

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to fund account ${publicKey}: ${response.statusText}`);
  }
}

/** Sets up a small standalone SDEX market so the example produces at least one route with zero manual setup. */
async function createDemoMarket(
  server: Horizon.Server,
): Promise<{ sourceAccountId: string; destAsset: Asset }> {
  const issuer = Keypair.random();
  const source = Keypair.random();

  await Promise.all([fundAccount(issuer.publicKey()), fundAccount(source.publicKey())]);

  const destAsset = new Asset('ROUTEAST', issuer.publicKey());

  const sourceAccount = await server.loadAccount(source.publicKey());
  const trustTx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: destAsset }))
    .setTimeout(30)
    .build();
  trustTx.sign(source);
  await server.submitTransaction(trustTx);

  const issuerAccount = await server.loadAccount(issuer.publicKey());
  const offerTx = new TransactionBuilder(issuerAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.manageSellOffer({
        selling: destAsset,
        buying: Asset.native(),
        amount: '5000',
        price: '1',
      }),
    )
    .setTimeout(30)
    .build();
  offerTx.sign(issuer);
  await server.submitTransaction(offerTx);

  return { sourceAccountId: source.publicKey(), destAsset };
}

function displayRoute(index: number, route: RouteReport): void {
  console.log(`\nRoute ${index + 1}:`);
  console.log(`  Path: ${route.hops.join(' -> ')}`);
  console.log(`  Intermediate assets: ${route.intermediateAssets.length > 0 ? route.intermediateAssets.join(', ') : 'none (direct)'}`);
  console.log(`  Source amount (required): ${route.sourceAmount}`);
  console.log(`  Destination amount (fixed): ${route.destinationAmount}`);
  console.log(`  Effective rate (dest per source unit): ${route.effectiveRate}`);
}

function isJsonOutputRequested(): boolean {
  return process.argv.includes('--json') || process.env.OUTPUT_FORMAT === 'json';
}

export interface PathPaymentRouteInspectionParams {
  destAmount?: string;
  maxRoutes?: string;
}

export async function run(params?: PathPaymentRouteInspectionParams): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);
  const jsonOutput = isJsonOutputRequested();
  const rawMaxRoutes = params?.maxRoutes?.trim() || process.env.MAX_ROUTES;
  const maxRoutes = Number(rawMaxRoutes) > 0 ? Number(rawMaxRoutes) : DEFAULT_MAX_ROUTES;

  const log = (...args: unknown[]) => {
    if (!jsonOutput) console.log(...args);
  };

  log('Starting Path Payment Route Inspection Example...');
  log(`Using Horizon: ${horizonUrl}`);
  log(
    'This example only discovers and ranks routes; it never constructs or submits a payment.',
  );

  let sourceAccountId = process.env.SOURCE_ACCOUNT?.trim();
  let destAsset: Asset;
  const destAmount = params?.destAmount?.trim() || process.env.DEST_AMOUNT?.trim() || '25';

  try {
    if (!sourceAccountId) {
      log('\nNo SOURCE_ACCOUNT supplied — setting up a self-contained demo market...');
      const demo = await createDemoMarket(server);
      sourceAccountId = demo.sourceAccountId;
      destAsset = demo.destAsset;
      log(`Demo source account: ${sourceAccountId}`);
      log(`Demo destination asset: ${destAsset.getCode()}:${destAsset.getIssuer()}`);
    } else {
      const destAssetRaw = process.env.DEST_ASSET;
      if (!destAssetRaw) {
        throw new Error('DEST_ASSET is required when SOURCE_ACCOUNT is supplied.');
      }
      destAsset = parseAssetDefinition(destAssetRaw);
    }
  } catch (error) {
    const message = (error as Error).message;
    log(`\nInvalid asset definition: ${message}`);
    if (jsonOutput) console.log(JSON.stringify({ error: message }, null, 2));
    return;
  }

  log(`\nQuerying strict-receive paths for ${destAmount} of the destination asset...`);

  let pathsPage;
  try {
    pathsPage = await server.strictReceivePaths(sourceAccountId, destAsset, destAmount).call();
  } catch (error) {
    const message = (error as Error).message;
    log(`\nPath query failed: ${message}`);
    if (jsonOutput) console.log(JSON.stringify({ error: message }, null, 2));
    return;
  }

  const records = pathsPage.records as unknown as HorizonPathRecord[];

  if (records.length === 0) {
    log('\nNo viable payment path was found for this source account and destination amount.');
    log('This can mean there is no connected liquidity, or the amount exceeds available depth.');
    if (jsonOutput) {
      console.log(JSON.stringify({ sourceAccountId, destAmount, routes: [] }, null, 2));
    }
    return;
  }

  const allRoutes = records.map(buildRouteReport);
  const ranked = rankRoutesByEfficiency(allRoutes).slice(0, maxRoutes);

  log(`\nFound ${records.length} candidate route(s); showing top ${ranked.length} by efficiency.`);
  ranked.forEach((route, index) => displayRoute(index, route));

  const best = ranked[0];
  log(`\nMost efficient route: ${best.hops.join(' -> ')}`);
  log(`It requires spending only ${best.sourceAmount} to receive the fixed ${best.destinationAmount}.`);

  log('\nHow routing works:');
  log('- Each hop in "path" is a Stellar asset the payment is converted through en route.');
  log('- Horizon evaluates both SDEX order books and AMM liquidity pools when finding a hop\'s rate.');
  log('- A shorter path is not automatically cheaper — it depends entirely on available liquidity depth.');
  log('- strictReceivePaths fixes the destination amount and varies the source cost (this example).');
  log('- strictSendPaths does the opposite: it fixes the source amount and varies the destination received.');

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          sourceAccountId,
          destAsset: destAsset.isNative() ? 'native' : `${destAsset.getCode()}:${destAsset.getIssuer()}`,
          destAmount,
          routeCount: records.length,
          routes: ranked,
          mostEfficientRoute: best,
        },
        null,
        2,
      ),
    );
  }
}
