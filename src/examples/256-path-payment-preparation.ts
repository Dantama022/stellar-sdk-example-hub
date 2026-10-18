import { WorkflowError } from '../utils/example-input';
import dotenv from 'dotenv';
import { Asset, Horizon, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { resolveNetworkConfiguration } from './60-network-configuration';
import { accountId, amount, amountUnits, asset } from '../utils/example-input';

export function routeAsset(raw: {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}): Asset {
  if (raw.asset_type === 'native') return Asset.native();
  if (!['credit_alphanum4', 'credit_alphanum12'].includes(raw.asset_type))
    throw new WorkflowError('Unsupported route asset');
  return asset(`${raw.asset_code}:${raw.asset_issuer}`);
}

export interface Route {
  source_asset_type: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  destination_asset_type: string;
  destination_asset_code?: string;
  destination_asset_issuer?: string;
  source_amount: string;
  destination_amount: string;
  path: { asset_type: string; asset_code?: string; asset_issuer?: string }[];
}

export function paymentOperation(
  mode: string,
  destination: string,
  source: Asset,
  target: Asset,
  fixed: string,
  bound: string,
  route: Route,
) {
  accountId(destination);
  amount(fixed);
  amount(bound);
  if (!Array.isArray(route.path) || route.path.length > 5)
    throw new WorkflowError('Malformed intermediate path');
  const from = routeAsset({
    asset_type: route.source_asset_type,
    asset_code: route.source_asset_code,
    asset_issuer: route.source_asset_issuer,
  });
  const to = routeAsset({
    asset_type: route.destination_asset_type,
    asset_code: route.destination_asset_code,
    asset_issuer: route.destination_asset_issuer,
  });
  if (!from.equals(source) || !to.equals(target)) throw new WorkflowError('Route asset mismatch');
  amount(route.source_amount);
  amount(route.destination_amount);
  const path = route.path.map(routeAsset);
  if (mode === 'send') {
    if (
      amountUnits(route.source_amount) !== amountUnits(fixed) ||
      amountUnits(bound) > amountUnits(route.destination_amount)
    )
      throw new WorkflowError('Route cannot satisfy destination minimum');
    return Operation.pathPaymentStrictSend({
      sendAsset: source,
      sendAmount: fixed,
      destination,
      destAsset: target,
      destMin: bound,
      path,
    });
  }
  if (mode !== 'receive') throw new WorkflowError('PATH_MODE must be send or receive');
  if (
    amountUnits(route.destination_amount) !== amountUnits(fixed) ||
    amountUnits(bound) < amountUnits(route.source_amount)
  )
    throw new WorkflowError('Route exceeds source maximum');
  return Operation.pathPaymentStrictReceive({
    sendAsset: source,
    sendMax: bound,
    destination,
    destAsset: target,
    destAmount: fixed,
    path,
  });
}

export async function run(): Promise<void> {
  const config = resolveNetworkConfiguration();
  const sourceAccount = accountId(process.env.SOURCE_ACCOUNT);
  const destination = accountId(process.env.DESTINATION_ACCOUNT);
  const source = asset(process.env.SOURCE_ASSET);
  const target = asset(process.env.DEST_ASSET);
  const fixed = amount(process.env.PATH_AMOUNT);
  const bound = amount(process.env.PATH_BOUND);
  const mode = process.env.PATH_MODE || 'receive';
  if (!['send', 'receive'].includes(mode))
    throw new WorkflowError('PATH_MODE must be send or receive');
  const server = new Horizon.Server(config.horizonUrl);
  const page = await (
    mode === 'send'
      ? server.strictSendPaths(source, fixed, [target])
      : server.strictReceivePaths([source], target, fixed)
  ).call();
  if (!Array.isArray(page.records)) throw new WorkflowError('Malformed route response');
  const routes = page.records as Route[];
  if (!routes.length) {
    console.log('No available path; check liquidity, assets, and amount.');
    return;
  }
  // Validate every estimate before ranking. Bigint comparison preserves seven-place precision.
  routes.forEach((r) =>
    paymentOperation(
      mode,
      destination,
      source,
      target,
      fixed,
      mode === 'send' ? amount(r.destination_amount) : amount(r.source_amount),
      r,
    ),
  );
  routes.sort((a, b) => {
    const left = amountUnits(mode === 'send' ? b.destination_amount : a.source_amount);
    const right = amountUnits(mode === 'send' ? a.destination_amount : b.source_amount);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  console.table(
    routes.map((r, index) => ({
      index,
      source: r.source_amount,
      destination: r.destination_amount,
      intermediate: r.path.map((a) => routeAsset(a).toString()).join(' -> ') || '(direct)',
    })),
  );
  const operation = paymentOperation(mode, destination, source, target, fixed, bound, routes[0]);
  const account = await server.loadAccount(sourceAccount);
  await server.loadAccount(destination);
  const transaction = new TransactionBuilder(account, {
    fee: String(await server.fetchBaseFee()),
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(180)
    .build();
  console.log('Estimate only; unsigned transaction XDR (not simulated or submitted):');
  console.log(transaction.toXDR());
}

if (require.main === module) {
  dotenv.config();
  run().catch((error: unknown) => {
    console.error(
      error instanceof WorkflowError
        ? error.message
        : 'Retrieval or processing failed; check network availability and checkpoint scope. The failing batch was not checkpointed.',
    );
    process.exitCode = 1;
  });
}
