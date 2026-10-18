import {
  Account,
  FeeBumpTransaction,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Asset,
} from '@stellar/stellar-sdk';

export type FeeBumpErrorCategory =
  | 'insufficient-fee-balance'
  | 'insufficient-fee'
  | 'invalid-signature'
  | 'malformed-envelope'
  | 'network'
  | 'unknown';

export interface FeeBumpErrorReport {
  category: FeeBumpErrorCategory;
  message: string;
}

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to fund account ${publicKey}: ${response.statusText}`);
  }
}

/**
 * Builds the inner payment, signs it with the source account, then wraps it in a
 * fee-bump envelope paid by the sponsor and signs that envelope with the sponsor.
 *
 * The inner transaction keeps its own source and signature. Signing the outer
 * envelope does not replace it: Stellar checks the inner signatures separately.
 */
export function buildSponsoredFeeBump(params: {
  source: Keypair;
  sponsor: Keypair;
  destination: Keypair;
  sourceAccount: Account;
  networkPassphrase?: string;
  innerBaseFee?: string;
  bumpBaseFee?: string;
}): FeeBumpTransaction {
  const networkPassphrase = params.networkPassphrase ?? Networks.TESTNET;
  const innerTx = new TransactionBuilder(params.sourceAccount, {
    fee: params.innerBaseFee ?? '100',
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: params.destination.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(30)
    .build();

  innerTx.sign(params.source);

  const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
    params.sponsor.publicKey(),
    params.bumpBaseFee ?? '200',
    innerTx,
    networkPassphrase,
  );
  feeBumpTx.sign(params.sponsor);
  return feeBumpTx;
}

/**
 * Turns a failed submission into one actionable message. Horizon reports the
 * reason in `response.data.extras.result_codes`. A failure with no response is a
 * transport error. The message never includes key material.
 */
export function describeFeeBumpError(err: unknown): FeeBumpErrorReport {
  const e = err as {
    message?: string;
    response?: {
      data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } };
    };
  };
  const codes = e?.response?.data?.extras?.result_codes;
  const transaction = codes?.transaction ?? '';
  const operations = codes?.operations ?? [];

  if (transaction === 'tx_insufficient_balance' || operations.includes('op_underfunded')) {
    return {
      category: 'insufficient-fee-balance',
      message:
        'The fee source does not hold enough XLM to pay the fee. Fund the sponsor account and retry.',
    };
  }
  if (transaction === 'tx_insufficient_fee') {
    return {
      category: 'insufficient-fee',
      message: 'The fee-bump fee is below the network minimum. Raise the bump base fee and retry.',
    };
  }
  if (transaction === 'tx_bad_auth' || transaction === 'tx_bad_auth_extra') {
    return {
      category: 'invalid-signature',
      message:
        'A signature is missing or does not match the required signer. The inner transaction must be signed by its source account, and the envelope by the fee source.',
    };
  }
  if (transaction === 'tx_malformed') {
    return {
      category: 'malformed-envelope',
      message: 'Horizon rejected the envelope as malformed. Rebuild the transaction and check its operations.',
    };
  }
  if (!e?.response) {
    // Only the error code or name is shown. The raw message is not, because a
    // caller error could contain key material.
    const reason = (err as { code?: string })?.code ?? (err as { name?: string })?.name ?? 'unknown error';
    return {
      category: 'network',
      message: `Could not reach Horizon (${reason}). Check HORIZON_URL and your connection.`,
    };
  }
  return {
    category: 'unknown',
    message: `Horizon rejected the transaction${transaction ? ` (${transaction})` : ''}.`,
  };
}

/**
 * Demonstrates fee-bump architecture: the inner transaction is signed by the source account,
 * then wrapped so a sponsor account pays the network fee on submission.
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Fee-Bump Transaction Example...');

  const source = Keypair.random();
  const sponsor = Keypair.random();
  const destination = Keypair.random();

  console.log(`Source Public Key:   ${source.publicKey()}`);
  console.log(`Sponsor Public Key:  ${sponsor.publicKey()}`);
  console.log(`Destination Public Key: ${destination.publicKey()}`);

  console.log('\nFunding accounts via Friendbot...');
  await fundAccount(source.publicKey());
  await fundAccount(sponsor.publicKey());
  await fundAccount(destination.publicKey());
  const sourceAccount = await server.loadAccount(source.publicKey());

  const feeBumpTx = buildSponsoredFeeBump({
    source,
    sponsor,
    destination,
    sourceAccount,
  });
  console.log('Inner transaction created and signed by the source account.');
  console.log('Fee-bump envelope signed by the sponsor.');

  console.log('Submitting fee-bump transaction with sponsor-paid fees...');
  let response: Awaited<ReturnType<typeof server.submitTransaction>>;
  try {
    response = await server.submitTransaction(feeBumpTx);
  } catch (err) {
    const report = describeFeeBumpError(err);
    console.error(`Fee-bump submission failed (${report.category}): ${report.message}`);
    throw new Error(report.message);
  }
  console.log(`Transaction Hash: ${response.hash}`);
  console.log(`Fee Payer: ${sponsor.publicKey()}`);
  console.log(`Transaction Source: ${source.publicKey()}`);

  const sourceBalances = await server.loadAccount(source.publicKey());
  const sponsorBalances = await server.loadAccount(sponsor.publicKey());
  const sourceNative = sourceBalances.balances.find(
    (balance) => balance.asset_type === 'native',
  )?.balance;
  const sponsorNative = sponsorBalances.balances.find(
    (balance) => balance.asset_type === 'native',
  )?.balance;

  console.log(`Source native balance: ${sourceNative}`);
  console.log(`Sponsor native balance: ${sponsorNative}`);
}
