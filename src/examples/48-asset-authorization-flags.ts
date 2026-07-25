import {
  Asset,
  AuthRequiredFlag,
  AuthRevocableFlag,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

export interface TrustlineBalanceLike {
  asset_code?: string;
  asset_issuer?: string;
  asset_type: string;
  balance: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
}

export interface IssuerFlagsLike {
  auth_required: boolean;
  auth_revocable: boolean;
  auth_immutable: boolean;
}

export interface IssuerFlagSummary {
  authRequired: boolean;
  authRevocable: boolean;
  authImmutable: boolean;
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

  if (!trustline) {
    return 'NOT_FOUND';
  }

  if (trustline.is_authorized === true) {
    return 'AUTHORIZED';
  }

  if (trustline.is_authorized_to_maintain_liabilities === true) {
    return 'AUTHORIZED_TO_MAINTAIN_LIABILITIES';
  }

  return 'UNAUTHORIZED';
}

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`,
  );

  if (!response.ok) {
    throw new Error(`Failed to fund account ${publicKey}: ${response.statusText}`);
  }
}

async function submitIssuerOperation(
  server: Horizon.Server,
  issuer: Keypair,
  operation: ReturnType<typeof Operation.setOptions> | ReturnType<typeof Operation.allowTrust>,
): Promise<string> {
  const issuerAccount = await server.loadAccount(issuer.publicKey());

  const transaction = new TransactionBuilder(issuerAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  transaction.sign(issuer);
  const response = await server.submitTransaction(transaction);
  return response.hash;
}

async function configureIssuerAuthorizationFlags(
  server: Horizon.Server,
  issuer: Keypair,
): Promise<string> {
  const issuerAccount = await server.loadAccount(issuer.publicKey());

  const transaction = new TransactionBuilder(issuerAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.setOptions({
        setFlags: AuthRequiredFlag,
      }),
    )
    .addOperation(
      Operation.setOptions({
        setFlags: AuthRevocableFlag,
      }),
    )
    .setTimeout(30)
    .build();

  transaction.sign(issuer);
  const response = await server.submitTransaction(transaction);
  return response.hash;
}

async function createTrustline(
  server: Horizon.Server,
  distribution: Keypair,
  asset: Asset,
  limit: string,
): Promise<string> {
  const distributionAccount = await server.loadAccount(distribution.publicKey());

  const transaction = new TransactionBuilder(distributionAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.changeTrust({
        asset,
        limit,
      }),
    )
    .setTimeout(30)
    .build();

  transaction.sign(distribution);
  const response = await server.submitTransaction(transaction);
  return response.hash;
}

async function readTrustlineState(
  server: Horizon.Server,
  distributionPublicKey: string,
  assetCode: string,
  issuerPublicKey: string,
): Promise<TrustlineAuthorizationState> {
  const distributionAccount = await server.loadAccount(distributionPublicKey);
  return getTrustlineAuthorizationState(
    distributionAccount.balances as TrustlineBalanceLike[],
    assetCode,
    issuerPublicKey,
  );
}

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);

  const issuer = Keypair.random();
  const distribution = Keypair.random();
  const assetCode = process.env.ASSET_CODE?.trim() || 'REGCOIN';
  const asset = new Asset(assetCode, issuer.publicKey());

  console.log('Starting Asset Authorization Flags Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log('Flags shown: AUTH_REQUIRED, AUTH_REVOCABLE, AUTH_IMMUTABLE');

  console.log(`\nIssuer:       ${issuer.publicKey()}`);
  console.log(`Distribution: ${distribution.publicKey()}`);

  console.log('\nFunding issuer and distribution accounts via Friendbot...');
  await fundAccount(issuer.publicKey());
  await fundAccount(distribution.publicKey());

  const issuerBefore = await server.loadAccount(issuer.publicKey());
  const beforeFlags = getIssuerFlagSummary(issuerBefore.flags);
  console.log('\nIssuer flags before configuration:');
  console.log(`- AUTH_REQUIRED: ${beforeFlags.authRequired}`);
  console.log(`- AUTH_REVOCABLE: ${beforeFlags.authRevocable}`);
  console.log(`- AUTH_IMMUTABLE: ${beforeFlags.authImmutable}`);

  console.log('\nConfiguring issuer with AUTH_REQUIRED + AUTH_REVOCABLE...');
  const setFlagsHash = await configureIssuerAuthorizationFlags(server, issuer);
  console.log(`Set flags transaction hash: ${setFlagsHash}`);

  const issuerAfter = await server.loadAccount(issuer.publicKey());
  const afterFlags = getIssuerFlagSummary(issuerAfter.flags);
  console.log('Issuer flags after configuration:');
  console.log(`- AUTH_REQUIRED: ${afterFlags.authRequired}`);
  console.log(`- AUTH_REVOCABLE: ${afterFlags.authRevocable}`);
  console.log(`- AUTH_IMMUTABLE: ${afterFlags.authImmutable}`);

  console.log('\nCreating trustline from distribution account...');
  const trustlineHash = await createTrustline(server, distribution, asset, '10000');
  console.log(`Trustline transaction hash: ${trustlineHash}`);

  const stateAfterTrustline = await readTrustlineState(
    server,
    distribution.publicKey(),
    assetCode,
    issuer.publicKey(),
  );
  console.log(`Trustline state after creation: ${stateAfterTrustline}`);

  console.log('\nAuthorizing trustline from issuer...');
  const authorizeHash = await submitIssuerOperation(
    server,
    issuer,
    Operation.allowTrust({
      trustor: distribution.publicKey(),
      assetCode,
      authorize: true,
    }),
  );
  console.log(`Authorize transaction hash: ${authorizeHash}`);

  const stateAfterAuthorize = await readTrustlineState(
    server,
    distribution.publicKey(),
    assetCode,
    issuer.publicKey(),
  );
  console.log(`Trustline state after authorization: ${stateAfterAuthorize}`);

  console.log('\nRevoking trustline authorization...');
  const revokeHash = await submitIssuerOperation(
    server,
    issuer,
    Operation.allowTrust({
      trustor: distribution.publicKey(),
      assetCode,
      authorize: false,
    }),
  );
  console.log(`Revoke transaction hash: ${revokeHash}`);

  const stateAfterRevoke = await readTrustlineState(
    server,
    distribution.publicKey(),
    assetCode,
    issuer.publicKey(),
  );
  console.log(`Trustline state after revocation: ${stateAfterRevoke}`);

  console.log('\nOperational implications:');
  console.log('- AUTH_REQUIRED means holders must be approved before they can use the asset.');
  console.log('- AUTH_REVOCABLE means approval can be removed later for compliance workflows.');
  console.log(
    '- Do not set AUTH_IMMUTABLE until issuer policy is final, because it is irreversible.',
  );

  console.log('\nAsset authorization flags workflow completed successfully.');
}
