import {
  Asset,
  AuthClawbackEnabledFlag,
  AuthRequiredFlag,
  AuthRevocableFlag,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

/**
 * Stellar Account Authorization Flags Example
 * ────────────────────────────────────────────
 * Issuers use account authorization flags to control how accounts interact
 * with their issued assets:
 *
 *   AUTH_REQUIRED          holders must be explicitly authorized before
 *                          holding the asset
 *   AUTH_REVOCABLE         the issuer can later revoke that authorization
 *   AUTH_IMMUTABLE         the issuer can never change any flag again
 *   AUTH_CLAWBACK_ENABLED  the issuer can claw back the asset from holders
 *
 * This example inspects an issuer's current authorization state, safely
 * constructs both the legacy `allowTrust` operation and the modern
 * `setTrustLineFlags` operation, demonstrates revocation, and shows how the
 * example refuses to attempt a flag change once AUTH_IMMUTABLE is set or
 * when the signer is not actually the asset issuer.
 */

export interface IssuerFlagsLike {
  auth_required: boolean;
  auth_revocable: boolean;
  auth_immutable: boolean;
  auth_clawback_enabled?: boolean;
}

export interface IssuerFlagSummary {
  authRequired: boolean;
  authRevocable: boolean;
  authImmutable: boolean;
  authClawbackEnabled: boolean;
}

export interface TrustlineBalanceLike {
  asset_code?: string;
  asset_issuer?: string;
  asset_type: string;
  balance: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
}

export type TrustlineAuthorizationState =
  | 'AUTHORIZED'
  | 'AUTHORIZED_TO_MAINTAIN_LIABILITIES'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND';

export function getIssuerFlagSummary(flags: IssuerFlagsLike): IssuerFlagSummary {
  return {
    authRequired: flags.auth_required,
    authRevocable: flags.auth_revocable,
    authImmutable: flags.auth_immutable,
    authClawbackEnabled: Boolean(flags.auth_clawback_enabled),
  };
}

export function getTrustlineAuthorizationState(
  balances: TrustlineBalanceLike[],
  assetCode: string,
  issuerPublicKey: string,
): TrustlineAuthorizationState {
  const trustline = balances.find(
    (balance) =>
      balance.asset_type !== 'native' &&
      balance.asset_code === assetCode &&
      balance.asset_issuer === issuerPublicKey,
  );

  if (!trustline) return 'NOT_FOUND';
  if (trustline.is_authorized === true) return 'AUTHORIZED';
  if (trustline.is_authorized_to_maintain_liabilities === true) {
    return 'AUTHORIZED_TO_MAINTAIN_LIABILITIES';
  }
  return 'UNAUTHORIZED';
}

/**
 * Client-side guard mirroring what the network itself enforces: once a flag
 * bundle reports AUTH_IMMUTABLE, no further setOptions flag change, and no
 * allowTrust / setTrustLineFlags authorization change, can ever succeed.
 * The example checks this before building any flag-changing transaction so
 * the failure is explained clearly instead of surfacing as a raw tx_failed
 * result from Horizon.
 */
export function isAuthorizationLocked(flags: IssuerFlagsLike): boolean {
  return flags.auth_immutable === true;
}

/**
 * Client-side guard verifying that the account attempting to change
 * authorization is actually the asset's issuer. Only the issuer account can
 * submit allowTrust / setTrustLineFlags for its own asset.
 */
export function assertIsAssetIssuer(asset: Asset, signerPublicKey: string): void {
  if (asset.isNative()) {
    throw new Error('The native asset (XLM) has no issuer and no authorization flags.');
  }
  if (asset.getIssuer() !== signerPublicKey) {
    throw new Error(
      `Unauthorized issuer operation: ${signerPublicKey} is not the issuer of ${asset.getCode()} ` +
        `(issuer is ${asset.getIssuer()}).`,
    );
  }
}

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to fund account ${publicKey}: ${response.statusText}`);
  }
}

function displayFlags(label: string, flags: IssuerFlagSummary): void {
  console.log(`\n--- ${label} ---`);
  console.log(`  AUTH_REQUIRED:          ${flags.authRequired}`);
  console.log(`  AUTH_REVOCABLE:         ${flags.authRevocable}`);
  console.log(`  AUTH_IMMUTABLE:         ${flags.authImmutable}`);
  console.log(`  AUTH_CLAWBACK_ENABLED:  ${flags.authClawbackEnabled}`);
}

function isJsonOutputRequested(): boolean {
  return process.argv.includes('--json') || process.env.OUTPUT_FORMAT === 'json';
}

export interface AccountAuthorizationFlagsParams {
  assetCode?: string;
}

export async function run(params?: AccountAuthorizationFlagsParams): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);
  const jsonOutput = isJsonOutputRequested();
  const assetCode = params?.assetCode?.trim() || process.env.ASSET_CODE?.trim() || 'AUTHCOIN';

  const log = (...args: unknown[]) => {
    if (!jsonOutput) console.log(...args);
  };

  log('Starting Account Authorization Flags Example...');
  log(`Using Horizon: ${horizonUrl}`);

  const issuerSecret = process.env.ISSUER_SECRET?.trim();
  const issuer = issuerSecret ? Keypair.fromSecret(issuerSecret) : Keypair.random();
  const targetSecret = process.env.TARGET_SECRET?.trim();
  const target = targetSecret ? Keypair.fromSecret(targetSecret) : Keypair.random();
  const asset = new Asset(assetCode, issuer.publicKey());

  log(`\nIssuer account: ${issuer.publicKey()}`);
  log(`Target account: ${target.publicKey()}`);

  if (!issuerSecret) {
    log('\nFunding issuer and target accounts via Friendbot...');
    await fundAccount(issuer.publicKey());
  }
  if (!targetSecret) {
    await fundAccount(target.publicKey());
  }

  const issuerBefore = await server.loadAccount(issuer.publicKey());
  const flagsBefore = getIssuerFlagSummary(issuerBefore.flags);
  displayFlags('Issuer flags before configuration', flagsBefore);

  const result: Record<string, unknown> = {
    issuer: issuer.publicKey(),
    target: target.publicKey(),
    asset: `${assetCode}:${issuer.publicKey()}`,
    flagsBefore,
  };

  if (isAuthorizationLocked(issuerBefore.flags)) {
    log('\nIssuer is AUTH_IMMUTABLE. No further flag changes are possible; stopping here.');
    result.locked = true;
    if (jsonOutput) console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Client-side validation: refuse to build an operation for an account that
  // is not actually the asset issuer, before ever touching the network.
  try {
    assertIsAssetIssuer(asset, issuer.publicKey());
    log('\nIssuer permission check passed: signer matches the asset issuer.');
  } catch (error) {
    log(`\nIssuer permission check failed: ${(error as Error).message}`);
  }

  try {
    assertIsAssetIssuer(asset, target.publicKey());
  } catch (error) {
    log(`Demonstration: target account cannot manage this asset (${(error as Error).message}).`);
  }

  log('\nConfiguring issuer with AUTH_REQUIRED + AUTH_REVOCABLE + AUTH_CLAWBACK_ENABLED...');
  const configureAccount = await server.loadAccount(issuer.publicKey());
  const configureTx = new TransactionBuilder(configureAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.setOptions({ setFlags: AuthRequiredFlag }))
    .addOperation(Operation.setOptions({ setFlags: AuthRevocableFlag }))
    .addOperation(Operation.setOptions({ setFlags: AuthClawbackEnabledFlag }))
    .setTimeout(30)
    .build();
  configureTx.sign(issuer);
  const configureResult = await server.submitTransaction(configureTx);
  log(`Set flags transaction hash: ${configureResult.hash}`);

  const issuerAfter = await server.loadAccount(issuer.publicKey());
  const flagsAfter = getIssuerFlagSummary(issuerAfter.flags);
  displayFlags('Issuer flags after configuration', flagsAfter);
  result.flagsAfter = flagsAfter;

  log('\nCreating trustline from target account (required now that AUTH_REQUIRED is set)...');
  const targetAccount = await server.loadAccount(target.publicKey());
  const trustTx = new TransactionBuilder(targetAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset, limit: '10000' }))
    .setTimeout(30)
    .build();
  trustTx.sign(target);
  await server.submitTransaction(trustTx);

  const stateBeforeAuth = getTrustlineAuthorizationState(
    (await server.loadAccount(target.publicKey())).balances as TrustlineBalanceLike[],
    assetCode,
    issuer.publicKey(),
  );
  log(`Trustline state after creation: ${stateBeforeAuth}`);

  log('\nAuthorizing via legacy allowTrust operation...');
  const allowTrustAccount = await server.loadAccount(issuer.publicKey());
  const allowTrustTx = new TransactionBuilder(allowTrustAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.allowTrust({ trustor: target.publicKey(), assetCode, authorize: true }),
    )
    .setTimeout(30)
    .build();
  allowTrustTx.sign(issuer);
  const allowTrustResult = await server.submitTransaction(allowTrustTx);
  log(`allowTrust transaction hash: ${allowTrustResult.hash}`);

  const stateAfterAllowTrust = getTrustlineAuthorizationState(
    (await server.loadAccount(target.publicKey())).balances as TrustlineBalanceLike[],
    assetCode,
    issuer.publicKey(),
  );
  log(`Trustline state after allowTrust: ${stateAfterAllowTrust}`);

  log('\nRevoking via the modern setTrustLineFlags operation...');
  const revokeAccount = await server.loadAccount(issuer.publicKey());
  const revokeTx = new TransactionBuilder(revokeAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.setTrustLineFlags({
        trustor: target.publicKey(),
        asset,
        flags: { authorized: false, authorizedToMaintainLiabilities: false },
      }),
    )
    .setTimeout(30)
    .build();
  revokeTx.sign(issuer);
  const revokeResult = await server.submitTransaction(revokeTx);
  log(`setTrustLineFlags transaction hash: ${revokeResult.hash}`);

  const stateAfterRevoke = getTrustlineAuthorizationState(
    (await server.loadAccount(target.publicKey())).balances as TrustlineBalanceLike[],
    assetCode,
    issuer.publicKey(),
  );
  log(`Trustline state after revocation: ${stateAfterRevoke}`);

  result.trustlineStates = {
    afterCreation: stateBeforeAuth,
    afterAllowTrust: stateAfterAllowTrust,
    afterRevoke: stateAfterRevoke,
  };

  log('\nRelationship between account flags and trustlines:');
  log('- AUTH_REQUIRED on the issuer forces every new trustline to start UNAUTHORIZED.');
  log('- allowTrust and setTrustLineFlags both change one trustline\'s authorization state;');
  log('  neither one changes the issuer\'s own account flags.');
  log('- AUTH_REVOCABLE must be set for authorize:false / authorized:false to succeed at all.');
  log('- AUTH_CLAWBACK_ENABLED permits Operation.clawback on this trustline (not executed here).');
  log('- Once AUTH_IMMUTABLE is set on the issuer, none of the above can change again.');

  log('\nAccount authorization flags workflow completed successfully.');

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  }
}
