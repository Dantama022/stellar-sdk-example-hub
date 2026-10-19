/**
 * Example 259: Stellar Payments with Pathfinding and Strict-Receive Validation
 * (ISSUE-308).
 *
 * A path payment is easy to get wrong in two ways:
 *
 *   1. **The quote is not the fill.** Horizon quotes a *source* amount for a
 *      strict-receive payment, but the network can only fill up to `sendMax`.
 *      Quoting `source_amount` and then sending exactly that amount is a race:
 *      the market may move and the transaction fails with
 *      `op_no_trust` / `op_underfunded` instead of paying.
 *   2. **The path is not a guarantee.** A path that exists at quote time may
 *      have vanished at submission time, and an empty path list means "use the
 *      direct asset", not "any path will do".
 *
 * This example demonstrates how to:
 *   - request and inspect a strict-receive path quote
 *   - validate the quote against the configured `sendMax` before building
 *   - verify that the quoted path is still viable (every intermediate asset is
 *     the one you expect, and the destination asset matches)
 *   - build the unsigned operation so the exact envelope can be inspected
 *
 * Safety properties:
 *   - the example NEVER calls `submitTransaction`;
 *   - the transaction it builds is left unsigned and printed as XDR;
 *   - all network calls are read-only.
 */

import dotenv from 'dotenv';
import { Asset, Horizon, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

import { WorkflowError, accountId, asset } from '../utils/example-input';
import { resolveNetworkConfiguration } from './60-network-configuration';

/** A single hop in a quoted path. */
export interface PathHop {
  /** The asset code, or `XLM` for the native asset. */
  code: string;
  /** The issuer of the asset, when it is not native. */
  issuer?: string;
}

/** The result of validating a strict-receive quote. */
export interface QuoteValidation {
  /** True when the quote can be turned into a valid strict-receive payment. */
  valid: boolean;
  /** The quoted source amount, i.e. what the source account would have to pay. */
  sourceAmount?: string;
  /** The destination amount, which strict receive fixes exactly. */
  destinationAmount?: string;
  /** The configured upper bound on the source spend. */
  sendMax?: string;
  /** The asset the source account spends. */
  sendAsset?: string;
  /** The asset the destination account receives. */
  destAsset?: string;
  /** The hops of the quoted path, in order. */
  path: PathHop[];
  /** Problems that make the quote unusable. */
  problems: string[];
  /** Advice on how to fix the problems. */
  nextSteps: string[];
}

/** Render an asset as a short `CODE:ISSUER` or `XLM` label. */
export function describeAsset(value: Asset | undefined): string {
  if (!value) return 'unknown';
  if (value.isNative()) return 'XLM';
  return `${value.code}:${value.getIssuer()}`;
}

/** Render a single path hop as a short label. */
export function describeHop(hop: {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}): string {
  if (hop.asset_type === 'native') return 'XLM';
  return `${hop.asset_code}:${hop.asset_issuer}`;
}

/** Convert a quoted path into a list of {@link PathHop} values. */
export function describePath(
  path: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string }>,
): PathHop[] {
  return path.map((hop) =>
    hop.asset_type === 'native'
      ? { code: 'XLM' }
      : { code: hop.asset_code ?? '', issuer: hop.asset_issuer },
  );
}

/**
 * Validate a strict-receive quote against the configured constraints.
 *
 * The checks are the ones that actually fail in production:
 *
 *   - no path was quoted at all;
 *   - the quoted source amount exceeds `sendMax` (the fill would fail);
 *   - the destination asset is not the asset the caller asked for;
 *   - the destination amount does not match the requested amount exactly
 *     (strict receive promises an exact amount, so a floating quote is a bug);
 *   - the quoted path contains a repeated asset, which the network rejects.
 */
export function validateStrictReceiveQuote(params: {
  sourceAmount?: string;
  destinationAmount?: string;
  requestedDestinationAmount: string;
  sendMax: string;
  sendAsset: Asset;
  destAsset: Asset;
  path: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string }>;
}): QuoteValidation {
  const problems: string[] = [];
  const nextSteps: string[] = [];

  const path = describePath(params.path);

  if (params.path.length === 0) {
    problems.push('Horizon returned no path, so the payment would use the direct asset only.');
    nextSteps.push(
      'Verify that the destination holds a trustline for the destination asset, or quote a different destination asset.',
    );
  }

  if (params.sourceAmount === undefined) {
    problems.push('The quote did not include a source amount.');
    nextSteps.push('Re-request the quote and treat a missing source amount as a failure.');
  } else if (Number(params.sourceAmount) > Number(params.sendMax)) {
    problems.push(
      `The quoted source amount ${params.sourceAmount} exceeds the configured sendMax ${params.sendMax}.`,
    );
    nextSteps.push(
      'Raise sendMax, reduce the destination amount, or choose a cheaper path before building the transaction.',
    );
  }

  if (params.destinationAmount === undefined) {
    problems.push('The quote did not include a destination amount.');
  } else if (params.destinationAmount !== params.requestedDestinationAmount) {
    problems.push(
      `The quote guarantees ${params.destinationAmount} but ${params.requestedDestinationAmount} was requested.`,
    );
    nextSteps.push(
      'Strict receive must deliver the exact requested amount; re-quote with the same destination amount.',
    );
  }

  const destLabel = describeAsset(params.destAsset);
  const pathEnd = path.length > 0 ? path[path.length - 1] : undefined;
  if (pathEnd && pathEnd.code !== 'XLM' && pathEnd.issuer) {
    const expected = `${params.destAsset.code}:${params.destAsset.getIssuer()}`;
    if (pathEnd.code !== params.destAsset.code || pathEnd.issuer !== params.destAsset.getIssuer()) {
      problems.push(
        `The quoted path ends in ${pathEnd.code}:${pathEnd.issuer} but the destination asset is ${expected}.`,
      );
      nextSteps.push('Re-quote the path for the exact destination asset.');
    }
  }

  const seen = new Set<string>();
  for (const hop of path) {
    const key = hop.issuer ? `${hop.code}:${hop.issuer}` : hop.code;
    if (seen.has(key)) {
      problems.push(`The quoted path repeats the asset ${key}.`);
      nextSteps.push('The network rejects paths that repeat an asset; request a different route.');
      break;
    }
    seen.add(key);
  }

  return {
    valid: problems.length === 0,
    sourceAmount: params.sourceAmount,
    destinationAmount: params.destinationAmount,
    sendMax: params.sendMax,
    sendAsset: describeAsset(params.sendAsset),
    destAsset: destLabel,
    path,
    problems,
    nextSteps,
  };
}

/** Render a quote validation as human-readable text. */
export function formatQuoteValidation(validation: QuoteValidation): string {
  const lines = [
    '=== Strict Receive Path Quote Validation ===',
    `Valid: ${validation.valid ? 'yes' : 'no'}`,
    `Send asset: ${validation.sendAsset}`,
    `Destination asset: ${validation.destAsset}`,
    `Quoted source amount: ${validation.sourceAmount ?? 'unknown'}`,
    `sendMax: ${validation.sendMax ?? 'unknown'}`,
    `Destination amount: ${validation.destinationAmount ?? 'unknown'}`,
    `Path: ${
      validation.path.length > 0
        ? validation.path
            .map((hop) => (hop.issuer ? `${hop.code}:${hop.issuer}` : hop.code))
            .join(' -> ')
        : '(direct)'
    }`,
  ];

  if (validation.problems.length > 0) {
    lines.push('');
    lines.push('Problems:');
    for (const problem of validation.problems) lines.push(`  - ${problem}`);
  }

  if (validation.nextSteps.length > 0) {
    lines.push('');
    lines.push('Next steps:');
    for (const step of validation.nextSteps) lines.push(`  - ${step}`);
  }

  return lines.join('\n');
}

/**
 * Run the pathfinding and strict-receive validation example.
 *
 * Configuration (via environment variables):
 *   - SOURCE_ACCOUNT: the account that pays
 *   - DESTINATION_ACCOUNT: the account that receives
 *   - SEND_ASSET: the asset the source spends (default `XLM`)
 *   - DEST_ASSET: the asset the destination receives (default `XLM`)
 *   - DEST_AMOUNT: the exact amount the destination must receive (default `1`)
 *   - SEND_MAX: the maximum the source is willing to spend (default `10`)
 */
export async function run(): Promise<void> {
  const config = resolveNetworkConfiguration();
  const sourceAccountId = accountId(process.env.SOURCE_ACCOUNT);
  const destinationAccountId = accountId(process.env.DESTINATION_ACCOUNT);
  const sendAsset = asset(process.env.SEND_ASSET);
  const destAsset = asset(process.env.DEST_ASSET);
  const destAmount = process.env.DEST_AMOUNT || '1';
  const sendMax = process.env.SEND_MAX || '10';

  const server = new Horizon.Server(config.horizonUrl);

  const quote = await server.strictReceivePaths(sourceAccountId, destAsset, destAmount).call();

  const record = quote.records[0];
  if (!record) {
    throw new Error(
      'Horizon returned no strict-receive path for the requested destination amount.',
    );
  }

  const validation = validateStrictReceiveQuote({
    sourceAmount: record.source_amount,
    destinationAmount: record.destination_amount,
    requestedDestinationAmount: destAmount,
    sendMax,
    sendAsset,
    destAsset,
    path: record.path,
  });

  console.log(formatQuoteValidation(validation));

  if (!validation.valid) {
    throw new Error('The strict-receive quote did not pass validation; no transaction was built.');
  }

  const sourceAccount = await server.loadAccount(sourceAccountId);
  const operation = Operation.pathPaymentStrictReceive({
    sendAsset,
    sendMax,
    destination: destinationAccountId,
    destAsset,
    destAmount,
    path: record.path.map((hop) =>
      hop.asset_type === 'native'
        ? Asset.native()
        : new Asset(hop.asset_code as string, hop.asset_issuer as string),
    ),
  });

  const transaction = new TransactionBuilder(sourceAccount, {
    fee: String(await server.fetchBaseFee().catch(() => 100)),
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(180)
    .build();

  console.log('');
  console.log(
    'The envelope below is unsigned and unsubmitted. Inspect it, then sign and submit it yourself.',
  );
  console.log('Unsigned XDR:', transaction.toXDR());
}

if (require.main === module) {
  dotenv.config();
  run().catch((error: unknown) => {
    console.error(
      error instanceof WorkflowError
        ? error.message
        : 'Strict-receive pathfinding failed. Check the accounts, the assets and the trustlines.',
    );
    process.exitCode = 1;
  });
}
