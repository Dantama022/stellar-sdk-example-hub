import {
  Account,
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const DEFAULT_AMOUNT = '0.0000001';

export type FeeStrategy = 'economy' | 'standard' | 'priority';

export interface FeeStatsSnapshot {
  statsLedger: number;
  latestLedger: number;
  ledgerLag: number;
  baseFee: number;
  minAcceptedFee: number;
  medianAcceptedFee: number;
  p90AcceptedFee: number;
}

export interface FeeBidEstimate {
  strategy: FeeStrategy;
  operationCount: number;
  feePerOperation: number;
  estimatedTotalFee: number;
  maxTotalFee: number;
  statsLedger: number;
  latestLedger: number;
  ledgerLag: number;
}

export interface FeeBidAnalysisParams {
  horizonUrl?: string;
  sourceAccountId?: string;
  destinationAccountId?: string;
  operationCount?: number | string;
  amount?: string;
  strategy?: FeeStrategy;
  maxTotalFee?: number | string;
  maxStatsLedgerLag?: number | string;
  submit?: boolean | string;
  json?: boolean | string;
  secretKey?: string;
}

function parseInteger(value: unknown, name: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  }
  return parsed;
}

function parseFeeField(stats: Record<string, unknown>, key: string): number {
  return parseInteger(stats[key], `fee_stats.${key}`, 100);
}

export function parseFeeStatsSnapshot(
  stats: Record<string, unknown>,
  latestLedger: number,
): FeeStatsSnapshot {
  const statsLedger = parseInteger(stats.last_ledger, 'fee_stats.last_ledger', 1);
  const currentLedger = parseInteger(latestLedger, 'latestLedger', 1);
  if (statsLedger > currentLedger) {
    throw new Error('Fee statistics report a ledger newer than Horizon’s latest ledger.');
  }

  return {
    statsLedger,
    latestLedger: currentLedger,
    ledgerLag: currentLedger - statsLedger,
    baseFee: parseFeeField(stats, 'last_ledger_base_fee'),
    minAcceptedFee: parseFeeField(stats, 'min_accepted_fee'),
    medianAcceptedFee: parseFeeField(stats, 'p50_accepted_fee'),
    p90AcceptedFee: parseFeeField(stats, 'p90_accepted_fee'),
  };
}

export function estimateFeeBid(
  snapshot: FeeStatsSnapshot,
  operationCount: number,
  strategy: FeeStrategy,
  maxTotalFee: number,
  maxStatsLedgerLag: number,
): FeeBidEstimate {
  const operations = parseInteger(operationCount, 'operationCount', 1);
  if (operations > 100) throw new Error('operationCount cannot exceed the Stellar limit of 100.');
  const feeCeiling = parseInteger(maxTotalFee, 'maxTotalFee', 100);
  const allowedLedgerLag = parseInteger(maxStatsLedgerLag, 'maxStatsLedgerLag', 0);
  if (!['economy', 'standard', 'priority'].includes(strategy)) {
    throw new Error(`Unsupported fee strategy: ${strategy}`);
  }
  if (snapshot.ledgerLag > allowedLedgerLag) {
    throw new Error(
      `Fee statistics are stale by ${snapshot.ledgerLag} ledgers; maximum allowed lag is ${allowedLedgerLag}. Refresh before preparing the transaction.`,
    );
  }

  const targetFee =
    strategy === 'economy'
      ? snapshot.minAcceptedFee
      : strategy === 'standard'
        ? snapshot.medianAcceptedFee
        : snapshot.p90AcceptedFee;
  const feePerOperation = Math.max(snapshot.baseFee, targetFee);
  const estimatedTotalFee = feePerOperation * operations;
  if (estimatedTotalFee > feeCeiling) {
    throw new Error(
      `Estimated total fee ${estimatedTotalFee} stroops exceeds maxTotalFee ${feeCeiling}; refusing to silently underbid.`,
    );
  }

  return {
    strategy,
    operationCount: operations,
    feePerOperation,
    estimatedTotalFee,
    maxTotalFee: feeCeiling,
    statsLedger: snapshot.statsLedger,
    latestLedger: snapshot.latestLedger,
    ledgerLag: snapshot.ledgerLag,
  };
}

async function fetchFreshFeeStats(
  server: Horizon.Server,
): Promise<FeeStatsSnapshot> {
  const [rawStats, ledgerPage] = await Promise.all([
    server.feeStats(),
    server.ledgers().order('desc').limit(1).call(),
  ]);
  const latestLedger = Number(ledgerPage.records[0]?.sequence);
  return parseFeeStatsSnapshot(rawStats as unknown as Record<string, unknown>, latestLedger);
}

function buildPaymentTransaction(
  account: Account,
  destinationAccountId: string,
  amount: string,
  estimate: FeeBidEstimate,
  networkPassphrase: string,
): Transaction {
  const builder = new TransactionBuilder(account, {
    fee: String(estimate.feePerOperation),
    networkPassphrase,
  });
  for (let index = 0; index < estimate.operationCount; index += 1) {
    builder.addOperation(
      Operation.payment({ destination: destinationAccountId, asset: Asset.native(), amount }),
    );
  }
  return builder.setTimeout(60).build();
}

function normalizeStrategy(value: unknown): FeeStrategy {
  if (value === 'economy' || value === 'standard' || value === 'priority') return value;
  throw new Error('strategy must be economy, standard, or priority.');
}

function normalizeAmount(value: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(value) || Number(value) <= 0) {
    throw new Error('amount must be a positive XLM amount with at most 7 decimal places.');
  }
  return value;
}

function wantsSubmission(value: boolean | string | undefined): boolean {
  return value === true || value === 'true' || process.env.SUBMIT_TRANSACTION === 'true';
}

export async function run(params: FeeBidAnalysisParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const sourceAccountId =
    params.sourceAccountId || process.env.SOURCE_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const destinationAccountId =
    params.destinationAccountId || process.env.DESTINATION_ACCOUNT_ID || sourceAccountId;
  const operationCount = parseInteger(
    params.operationCount ?? process.env.OPERATION_COUNT ?? 1,
    'operationCount',
    1,
  );
  const strategy = normalizeStrategy(params.strategy || process.env.FEE_STRATEGY || 'standard');
  const maxTotalFee = parseInteger(
    params.maxTotalFee ?? process.env.MAX_TOTAL_FEE ?? 5000,
    'maxTotalFee',
    100,
  );
  const maxStatsLedgerLag = parseInteger(
    params.maxStatsLedgerLag ?? process.env.MAX_STATS_LEDGER_LAG ?? 2,
    'maxStatsLedgerLag',
    0,
  );
  const amount = normalizeAmount(params.amount || process.env.PAYMENT_AMOUNT || DEFAULT_AMOUNT);
  const submit = wantsSubmission(params.submit);
  const json = params.json === true || params.json === 'true' || process.env.JSON_OUTPUT === 'true';

  if (operationCount > 100) throw new Error('operationCount cannot exceed the Stellar limit of 100.');
  if (!StrKey.isValidEd25519PublicKey(sourceAccountId)) {
    throw new Error('sourceAccountId must be a valid Stellar G... public key.');
  }
  if (!StrKey.isValidEd25519PublicKey(destinationAccountId)) {
    throw new Error('destinationAccountId must be a valid Stellar G... public key.');
  }

  const server = new Horizon.Server(horizonUrl);
  try {
    const initialSnapshot = await fetchFreshFeeStats(server);
    const estimate = estimateFeeBid(
      initialSnapshot,
      operationCount,
      strategy,
      maxTotalFee,
      maxStatsLedgerLag,
    );
    const sourceAccount = await server.loadAccount(sourceAccountId);
    let transaction = buildPaymentTransaction(
      sourceAccount,
      destinationAccountId,
      amount,
      estimate,
      process.env.NETWORK_PASSPHRASE || Networks.TESTNET,
    );

    const report: Record<string, unknown> = {
      horizonUrl,
      sourceAccountId,
      destinationAccountId,
      amount,
      feeEstimate: estimate,
      submissionEnabled: submit,
      preparedTransactionXdr: transaction.toXDR(),
    };

    if (!submit) {
      if (json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log('Transaction fee-bid analysis and preparation');
        console.log(JSON.stringify(report, null, 2));
        console.log('Transaction is unsigned and was not submitted.');
        console.log('Set SUBMIT_TRANSACTION=true to explicitly enable submission.');
      }
      return;
    }

    const secretKey = params.secretKey || process.env.SECRET_KEY;
    if (!secretKey) throw new Error('Submission requires SECRET_KEY and explicit submit=true.');

    const refreshedSnapshot = await fetchFreshFeeStats(server);
    const refreshedEstimate = estimateFeeBid(
      refreshedSnapshot,
      operationCount,
      strategy,
      maxTotalFee,
      maxStatsLedgerLag,
    );
    if (refreshedEstimate.feePerOperation !== estimate.feePerOperation) {
      transaction = buildPaymentTransaction(
        sourceAccount,
        destinationAccountId,
        amount,
        refreshedEstimate,
        process.env.NETWORK_PASSPHRASE || Networks.TESTNET,
      );
    }

    const signer = Keypair.fromSecret(secretKey);
    if (signer.publicKey() !== sourceAccountId) {
      throw new Error('SECRET_KEY does not match sourceAccountId.');
    }
    transaction.sign(signer);
    const submission = await server.submitTransaction(transaction);
    report.feeEstimate = refreshedEstimate;
    report.preparedTransactionXdr = transaction.toXDR();
    report.submission = { successful: true, hash: submission.hash };
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ error: message }, null, 2));
    else console.error(`Fee-bid analysis failed: ${message}`);
  }
}