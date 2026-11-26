import {
  Account,
  Asset,
  FeeBumpTransaction,
  Memo,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

export interface InspectEnvelopeOptions {
  networkPassphrase?: string;
  largeAmountThreshold?: string;
  expectedOperationTypes?: string[];
}

export interface ParsedEnvelopeContext {
  originalXdr: string;
  networkPassphrase: string;
  transactionHash: string;
  sourceAccount: string;
  sequenceNumber: string;
  feeStroops: string;
  memoType: string;
  memoValue: string | null;
  operationCount: number;
  transaction: Transaction;
}

export interface AssetSummary {
  code: string;
  issuer: string | null;
  isNative: boolean;
}

export interface OperationSummary {
  index: number;
  type: string;
  effectiveSourceAccount: string;
  inheritsTransactionSource: boolean;
  supportedForDetailedSummary: boolean;
  destination?: string;
  asset?: AssetSummary;
  amount?: string;
  limit?: string;
  configChanges?: Record<string, unknown>;
  details: Record<string, unknown>;
  note?: string;
}

export interface ReviewWarning {
  rule:
    | 'unexpected_operation_type'
    | 'distinct_operation_source'
    | 'large_amount_threshold'
    | 'account_configuration_change'
    | 'missing_or_unexpected_field';
  field: string;
  operationIndex?: number;
  message: string;
}

export interface TransactionInspectionReport {
  originalXdr: string;
  networkPassphrase: string;
  transactionHash: string;
  sourceAccount: string;
  sequenceNumber: string;
  feeStroops: string;
  memoType: string;
  memoValue: string | null;
  operationCount: number;
  operations: OperationSummary[];
  warnings: ReviewWarning[];
  disclaimer: string;
}

const STROOPS_SCALE = 10_000_000n;

export function decimalAmountToStroops(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) {
    throw new Error(`Invalid Stellar decimal amount: "${amount}"`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  const paddedFrac = frac.padEnd(7, '0');
  return BigInt(whole) * STROOPS_SCALE + BigInt(paddedFrac);
}

function summarizeAsset(asset: Asset): AssetSummary {
  if (asset.isNative()) {
    return { code: 'XLM', issuer: null, isNative: true };
  }
  return {
    code: asset.getCode(),
    issuer: asset.getIssuer(),
    isNative: false,
  };
}

function formatMemoValue(transaction: Transaction): { memoType: string; memoValue: string | null } {
  const memo = transaction.memo;
  if (!memo || memo.type === 'none') {
    return { memoType: 'none', memoValue: null };
  }
  if (Buffer.isBuffer(memo.value)) {
    return { memoType: memo.type, memoValue: memo.value.toString('hex') };
  }
  return {
    memoType: memo.type,
    memoValue: memo.value !== undefined && memo.value !== null ? String(memo.value) : null,
  };
}

export function parseTransactionEnvelope(
  envelopeXdr: string,
  networkPassphrase: string = Networks.TESTNET,
): ParsedEnvelopeContext {
  if (typeof envelopeXdr !== 'string' || envelopeXdr.trim() === '') {
    throw new Error('Transaction envelope XDR must be a non-empty base64 string.');
  }
  if (typeof networkPassphrase !== 'string' || networkPassphrase.trim() === '') {
    throw new Error('A valid Stellar networkPassphrase is required.');
  }

  const trimmed = envelopeXdr.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error('Invalid base64 encoding for transaction envelope XDR.');
  }

  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(trimmed, networkPassphrase);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed transaction envelope XDR: ${message}`);
  }

  if (parsed instanceof FeeBumpTransaction) {
    throw new Error(
      'Unsupported envelope variant: FeeBumpTransaction is not supported by this operation inspector.',
    );
  }

  const { memoType, memoValue } = formatMemoValue(parsed);

  return {
    originalXdr: trimmed,
    networkPassphrase,
    transactionHash: parsed.hash().toString('hex'),
    sourceAccount: parsed.source,
    sequenceNumber: parsed.sequence,
    feeStroops: parsed.fee,
    memoType,
    memoValue,
    operationCount: parsed.operations.length,
    transaction: parsed,
  };
}

export function summarizeOperations(context: ParsedEnvelopeContext): OperationSummary[] {
  return context.transaction.operations.map((op, index): OperationSummary => {
    const effectiveSourceAccount = op.source || context.sourceAccount;
    const inheritsTransactionSource = !op.source || op.source === context.sourceAccount;

    switch (op.type) {
      case 'payment':
        return {
          index,
          type: op.type,
          effectiveSourceAccount,
          inheritsTransactionSource,
          supportedForDetailedSummary: true,
          destination: op.destination,
          asset: summarizeAsset(op.asset),
          amount: op.amount,
          details: {
            destination: op.destination,
            asset: summarizeAsset(op.asset),
            amount: op.amount,
          },
        };

      case 'createAccount':
        return {
          index,
          type: op.type,
          effectiveSourceAccount,
          inheritsTransactionSource,
          supportedForDetailedSummary: true,
          destination: op.destination,
          asset: { code: 'XLM', issuer: null, isNative: true },
          amount: op.startingBalance,
          details: {
            destination: op.destination,
            startingBalance: op.startingBalance,
          },
        };

      case 'changeTrust': {
        const line = op.line;
        const isAsset = line instanceof Asset;
        const assetSummary: AssetSummary | undefined = isAsset ? summarizeAsset(line) : undefined;
        return {
          index,
          type: op.type,
          effectiveSourceAccount,
          inheritsTransactionSource,
          supportedForDetailedSummary: true,
          asset: assetSummary,
          limit: op.limit,
          configChanges: {
            limit: op.limit,
          },
          details: {
            line: assetSummary ?? 'liquidity_pool',
            limit: op.limit,
          },
        };
      }

      case 'setOptions': {
        const configChanges: Record<string, unknown> = {};
        if (op.inflationDest !== undefined) configChanges.inflationDest = op.inflationDest;
        if (op.clearFlags !== undefined) configChanges.clearFlags = op.clearFlags;
        if (op.setFlags !== undefined) configChanges.setFlags = op.setFlags;
        if (op.masterWeight !== undefined) configChanges.masterWeight = op.masterWeight;
        if (op.lowThreshold !== undefined) configChanges.lowThreshold = op.lowThreshold;
        if (op.medThreshold !== undefined) configChanges.medThreshold = op.medThreshold;
        if (op.highThreshold !== undefined) configChanges.highThreshold = op.highThreshold;
        if (op.homeDomain !== undefined) configChanges.homeDomain = op.homeDomain;
        if (op.signer !== undefined) configChanges.signer = op.signer;
        return {
          index,
          type: op.type,
          effectiveSourceAccount,
          inheritsTransactionSource,
          supportedForDetailedSummary: true,
          configChanges,
          details: configChanges,
        };
      }

      case 'accountMerge':
        return {
          index,
          type: op.type,
          effectiveSourceAccount,
          inheritsTransactionSource,
          supportedForDetailedSummary: true,
          destination: op.destination,
          configChanges: { mergeInto: op.destination },
          details: { destination: op.destination },
        };

      case 'setTrustLineFlags':
        return {
          index,
          type: op.type,
          effectiveSourceAccount,
          inheritsTransactionSource,
          supportedForDetailedSummary: true,
          destination: op.trustor,
          asset: summarizeAsset(op.asset),
          configChanges: { flags: op.flags },
          details: {
            trustor: op.trustor,
            asset: summarizeAsset(op.asset),
            flags: op.flags,
          },
        };

      default:
        return {
          index,
          type: op.type,
          effectiveSourceAccount,
          inheritsTransactionSource,
          supportedForDetailedSummary: false,
          details: { rawType: op.type },
          note: `Operation type "${op.type}" is not supported by the detailed summary formatter; raw operation type preserved.`,
        };
    }
  });
}

export function evaluateReviewWarnings(
  context: ParsedEnvelopeContext,
  operations: OperationSummary[],
  options: InspectEnvelopeOptions = {},
): ReviewWarning[] {
  const warnings: ReviewWarning[] = [];
  const thresholdStroops =
    options.largeAmountThreshold !== undefined
      ? decimalAmountToStroops(options.largeAmountThreshold)
      : null;
  const expectedTypes = options.expectedOperationTypes
    ? new Set(options.expectedOperationTypes)
    : null;

  for (const op of operations) {
    if (!op.inheritsTransactionSource) {
      warnings.push({
        rule: 'distinct_operation_source',
        field: `operations[${op.index}].source`,
        operationIndex: op.index,
        message: `Operation ${op.index} (${op.type}) specifies source ${op.effectiveSourceAccount}, which differs from transaction source ${context.sourceAccount}.`,
      });
    }

    if (expectedTypes && !expectedTypes.has(op.type)) {
      warnings.push({
        rule: 'unexpected_operation_type',
        field: `operations[${op.index}].type`,
        operationIndex: op.index,
        message: `Operation ${op.index} has type "${op.type}", which is outside the expected operation types.`,
      });
    }

    if (op.configChanges && Object.keys(op.configChanges).length > 0) {
      warnings.push({
        rule: 'account_configuration_change',
        field: `operations[${op.index}].configChanges`,
        operationIndex: op.index,
        message: `Operation ${op.index} (${op.type}) modifies account or trustline configuration (${Object.keys(op.configChanges).join(', ')}).`,
      });
    }

    if (thresholdStroops !== null && op.amount !== undefined) {
      try {
        const opStroops = decimalAmountToStroops(op.amount);
        if (opStroops >= thresholdStroops) {
          warnings.push({
            rule: 'large_amount_threshold',
            field: `operations[${op.index}].amount`,
            operationIndex: op.index,
            message: `Operation ${op.index} amount ${op.amount} meets or exceeds configured review threshold ${options.largeAmountThreshold}.`,
          });
        }
      } catch {
        warnings.push({
          rule: 'missing_or_unexpected_field',
          field: `operations[${op.index}].amount`,
          operationIndex: op.index,
          message: `Operation ${op.index} has an unexpected amount format "${op.amount}".`,
        });
      }
    }

    if (op.type === 'payment' && (!op.destination || !op.asset)) {
      warnings.push({
        rule: 'missing_or_unexpected_field',
        field: `operations[${op.index}].destination`,
        operationIndex: op.index,
        message: `Operation ${op.index} (payment) is missing destination or asset information.`,
      });
    }
  }

  return warnings;
}

export function inspectTransactionEnvelope(
  envelopeXdr: string,
  options: InspectEnvelopeOptions = {},
): TransactionInspectionReport {
  const networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;
  const context = parseTransactionEnvelope(envelopeXdr, networkPassphrase);
  const operations = summarizeOperations(context);
  const warnings = evaluateReviewWarnings(context, operations, options);

  return {
    originalXdr: context.originalXdr,
    networkPassphrase: context.networkPassphrase,
    transactionHash: context.transactionHash,
    sourceAccount: context.sourceAccount,
    sequenceNumber: context.sequenceNumber,
    feeStroops: context.feeStroops,
    memoType: context.memoType,
    memoValue: context.memoValue,
    operationCount: context.operationCount,
    operations,
    warnings,
    disclaimer:
      'Inspection only: syntactic XDR parsing and rule-based warnings do not verify signatures, authorization, or transaction safety.',
  };
}

export function formatOperationInspectionReport(report: TransactionInspectionReport): string {
  const lines: string[] = [
    '=== Stellar Transaction Operation Inspection Report ===',
    `Transaction Hash: ${report.transactionHash}`,
    `Network Passphrase: ${report.networkPassphrase}`,
    `Source Account: ${report.sourceAccount}`,
    `Sequence Number: ${report.sequenceNumber}`,
    `Fee (stroops): ${report.feeStroops}`,
    `Memo: ${report.memoType}${report.memoValue !== null ? ` (${report.memoValue})` : ''}`,
    `Operations (${report.operationCount}):`,
  ];

  for (const op of report.operations) {
    const assetLabel = op.asset
      ? op.asset.isNative
        ? 'XLM'
        : `${op.asset.code}:${op.asset.issuer}`
      : '';
    lines.push(
      `  [${op.index}] ${op.type} | source=${op.effectiveSourceAccount}${
        op.inheritsTransactionSource ? ' (tx)' : ' (override)'
      }${op.destination ? ` | dest=${op.destination}` : ''}${
        op.amount ? ` | amount=${op.amount} ${assetLabel}` : assetLabel ? ` | asset=${assetLabel}` : ''
      }${op.limit !== undefined ? ` | limit=${op.limit}` : ''}${
        op.supportedForDetailedSummary ? '' : ' [UNSUPPORTED_DETAIL]'
      }`,
    );
    if (op.note) {
      lines.push(`      Note: ${op.note}`);
    }
  }

  lines.push('', 'Review Warnings:');
  if (report.warnings.length === 0) {
    lines.push('  (none)');
  } else {
    for (const w of report.warnings) {
      lines.push(`  - [${w.rule}] (${w.field}): ${w.message}`);
    }
  }

  lines.push('', `Disclaimer: ${report.disclaimer}`);
  return lines.join('\n');
}

export async function run(params: {
  xdr?: string;
  networkPassphrase?: string;
  largeAmountThreshold?: string;
  json?: boolean | string;
} = {}): Promise<void> {
  const sampleAccount = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
  const sampleDest = 'GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB';
  const sampleTx = new TransactionBuilder(new Account(sampleAccount, '99'), {
    fee: '100',
    networkPassphrase: params.networkPassphrase || Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: sampleDest,
        asset: Asset.native(),
        amount: '25.5000000',
      }),
    )
    .addMemo(Memo.text('sample-inspection'))
    .setTimeout(0)
    .build();

  const envelopeXdr = params.xdr || sampleTx.toXDR();
  const json = params.json === true || params.json === 'true';

  const report = inspectTransactionEnvelope(envelopeXdr, {
    networkPassphrase: params.networkPassphrase || Networks.TESTNET,
    largeAmountThreshold: params.largeAmountThreshold || '10.0000000',
  });

  console.log(json ? JSON.stringify(report, null, 2) : formatOperationInspectionReport(report));
}
