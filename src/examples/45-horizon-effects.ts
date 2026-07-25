import { Horizon, Networks } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const TRANSACTION_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

export interface HorizonEffectLike {
  id?: string;
  type: string;
  account?: string;
  source_account?: string;
  created_account?: string;
  destination?: string;
  trustor?: string;
  seller?: string;
  offer_id?: string | number;
  asset?: string;
  amount?: string;
  balance?: string;
}

export interface HorizonTransactionLike {
  hash: string;
  source_account: string;
}

export interface HorizonEffectsParams {
  transactionHash?: string;
  accountId?: string;
}

/**
 * Common effect meanings shown inline to help developers map effects back to
 * operation intent.
 */
export const COMMON_EFFECT_EXPLANATIONS: Record<string, string> = {
  account_created: 'A new account entry was created by a createAccount operation.',
  account_credited: 'An account balance increased (for example from payment receive).',
  account_debited: 'An account balance decreased (for example fee or payment send).',
  trustline_created: 'A trustline was added to an account via changeTrust.',
  trustline_removed: 'A trustline was removed, usually after reducing balance to zero.',
  trustline_authorized: 'Issuer authorized a trustline so the holder can use the asset.',
  trustline_deauthorized: 'Issuer removed trustline authorization for the holder.',
  offer_created: 'A new DEX offer entry was placed on the order book.',
  offer_removed: 'A DEX offer was deleted or consumed.',
  claimable_balance_created: 'A claimable balance entry was written to the ledger.',
  claimable_balance_claimed: 'A claimable balance was claimed by a claimant.',
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isValidTransactionHash(hash: string): boolean {
  return TRANSACTION_HASH_PATTERN.test(hash);
}

export function formatEffectSummary(effect: HorizonEffectLike): string {
  const actor =
    effect.account ??
    effect.destination ??
    effect.created_account ??
    effect.trustor ??
    effect.seller ??
    effect.source_account ??
    'n/a';

  const details: string[] = [`type=${effect.type}`, `actor=${actor}`];

  if (effect.asset) {
    details.push(`asset=${effect.asset}`);
  }

  if (effect.amount) {
    details.push(`amount=${effect.amount}`);
  }

  if (effect.balance) {
    details.push(`balance=${effect.balance}`);
  }

  if (effect.offer_id !== undefined) {
    details.push(`offer_id=${String(effect.offer_id)}`);
  }

  const explanation = COMMON_EFFECT_EXPLANATIONS[effect.type];
  if (explanation) {
    details.push(`note=${explanation}`);
  }

  return details.join(' | ');
}

export function isEffectRelatedToAccount(effect: HorizonEffectLike, accountId: string): boolean {
  const normalizedAccount = accountId.trim();

  if (normalizedAccount.length === 0) {
    return false;
  }

  return [
    effect.account,
    effect.source_account,
    effect.created_account,
    effect.destination,
    effect.trustor,
    effect.seller,
  ].includes(normalizedAccount);
}

async function retrieveLatestTransaction(server: Horizon.Server): Promise<HorizonTransactionLike> {
  const page = await server.transactions().order('desc').limit(1).call();
  const latest = page.records[0] as unknown as HorizonTransactionLike | undefined;

  if (!latest) {
    throw new Error('No transactions were returned by Horizon. Provide an explicit hash.');
  }

  return latest;
}

async function retrieveTransaction(
  server: Horizon.Server,
  params: HorizonEffectsParams,
): Promise<HorizonTransactionLike> {
  const fromParams = params.transactionHash?.trim();
  if (fromParams) {
    if (!isValidTransactionHash(fromParams)) {
      throw new Error(
        'Invalid transaction hash. A Stellar transaction hash must contain exactly 64 hexadecimal characters.',
      );
    }

    const tx = await server.transactions().transaction(fromParams).call();
    return tx as unknown as HorizonTransactionLike;
  }

  const argv = process.argv.slice(2).map((arg) => arg.trim());
  const exampleIndex = argv.indexOf('45-horizon-effects');
  const fromArgv = exampleIndex >= 0 ? argv[exampleIndex + 1] : argv[1];

  if (fromArgv) {
    if (!isValidTransactionHash(fromArgv)) {
      throw new Error(
        'Invalid transaction hash from CLI argument. Expected exactly 64 hexadecimal characters.',
      );
    }

    const tx = await server.transactions().transaction(fromArgv).call();
    return tx as unknown as HorizonTransactionLike;
  }

  const fromEnv = process.env.TRANSACTION_HASH?.trim();
  if (fromEnv) {
    if (!isValidTransactionHash(fromEnv)) {
      throw new Error(
        'Invalid TRANSACTION_HASH value. Expected exactly 64 hexadecimal characters.',
      );
    }

    const tx = await server.transactions().transaction(fromEnv).call();
    return tx as unknown as HorizonTransactionLike;
  }

  console.log('No transaction hash was provided. Using the latest transaction on Horizon.');
  return retrieveLatestTransaction(server);
}

async function retrieveEffectsForTransaction(
  server: Horizon.Server,
  transactionHash: string,
): Promise<HorizonEffectLike[]> {
  const effectPage = await server.effects().forTransaction(transactionHash).limit(200).call();

  return effectPage.records as unknown as HorizonEffectLike[];
}

async function retrieveOperationCount(
  server: Horizon.Server,
  transactionHash: string,
): Promise<number> {
  const operationPage = await server.operations().forTransaction(transactionHash).limit(200).call();
  return operationPage.records.length;
}

export async function run(params: HorizonEffectsParams = {}): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const networkPassphrase = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Horizon Effects Inspection Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log(`Network passphrase: ${networkPassphrase}`);

  let transaction: HorizonTransactionLike;

  try {
    transaction = await retrieveTransaction(server, params);
  } catch (error: unknown) {
    throw new Error(`Unable to load transaction for effects inspection: ${getErrorMessage(error)}`);
  }

  console.log(`\nTransaction selected: ${transaction.hash}`);

  const [operationCount, effects] = await Promise.all([
    retrieveOperationCount(server, transaction.hash),
    retrieveEffectsForTransaction(server, transaction.hash),
  ]);

  console.log('\nOperations vs Effects:');
  console.log(`- Operations requested: ${operationCount}`);
  console.log(`- Effects applied: ${effects.length}`);
  console.log(
    '- Operations describe requested actions; effects describe resulting ledger state changes.',
  );

  if (effects.length === 0) {
    console.log('\nNo effects were returned for this transaction.');
    return;
  }

  console.log('\nTransaction effects:');
  effects.forEach((effect, index) => {
    console.log(`${index + 1}. ${formatEffectSummary(effect)}`);
  });

  const filterAccount =
    params.accountId?.trim() || process.env.EFFECT_ACCOUNT?.trim() || transaction.source_account;

  if (filterAccount.length > 0) {
    const relatedEffects = effects.filter((effect) =>
      isEffectRelatedToAccount(effect, filterAccount),
    );

    console.log(`\nEffects related to account ${filterAccount}: ${relatedEffects.length}`);

    if (relatedEffects.length === 0) {
      console.log('No effects matched this account for the selected transaction.');
    } else {
      relatedEffects.forEach((effect, index) => {
        console.log(`  ${index + 1}. ${formatEffectSummary(effect)}`);
      });
    }
  }

  console.log('\nHorizon effects inspection completed successfully.');
}
