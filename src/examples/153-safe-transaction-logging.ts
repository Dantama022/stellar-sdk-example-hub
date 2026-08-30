import { TransactionBuilder, Keypair, Networks, xdr, Account } from '@stellar/stellar-sdk';

/**
 * Example 153: Safe Transaction Logging
 *
 * Developers frequently log Stellar transaction data while debugging transaction construction
 * and submission problems. However, careless logging can expose secret keys, private signing
 * material, or unnecessarily sensitive information.
 *
 * This example demonstrates how to safely inspect and log Stellar transaction envelopes
 * while explicitly separating public transaction information from secret signing material.
 * It provides a reusable structured logging pattern for Stellar applications.
 */

interface SafeTransactionSummary {
  transactionHash: string;
  envelopeType: string;
  sourceAccount: string;
  fee: string;
  sequence: string;
  memo: {
    type: string;
    description?: string;
  };
  timeBounds: {
    minTime: number;
    maxTime: number;
    description: string;
  };
  operations: Array<{
    index: number;
    type: string;
    summary: string;
  }>;
  signatures: {
    count: number;
    signers: string[];
  };
  network: string;
}

interface RiskyTransactionData {
  secretKeys?: string[];
  privateData?: string[];
  warnings: string[];
}

function extractSafeTransactionSummary(
  txEnvelope: string,
  networkPassphrase: string,
): {
  summary: SafeTransactionSummary;
  risks: RiskyTransactionData;
} {
  try {
    // Decode the transaction envelope
    const envelope = xdr.TransactionEnvelope.fromXDR(txEnvelope, 'base64');
    const envelopeType = envelope.switch().name;

    let tx: xdr.Transaction;
    let signatures: xdr.DecoratedSignature[] = [];

    if (envelope.isVariant('txTypeV1')) {
      const v1 = envelope.v1();
      if (!v1) throw new Error('Invalid transaction envelope');
      tx = v1.tx();
      signatures = v1.signatures();
    } else {
      throw new Error(`Unsupported envelope type: ${envelopeType}`);
    }

    // Extract source account
    const sourceAccountBuffer = tx.sourceAccount().accountId().ed25519();
    const sourceAccountPublicKey = Keypair.fromPublicKey(
      Buffer.concat([Buffer.from([0]), sourceAccountBuffer])
        .toString('base64')
        .slice(1),
    ).publicKey();

    // Calculate transaction hash
    const transactionHash = tx.hash().toString('base64');

    // Extract basic info
    const fee = tx.fee().toString();
    const sequence = tx.seqNum().toString();

    // Extract memo safely
    const memoInfo = extractSafeMemoInfo(tx.memo());

    // Extract time bounds
    const timeBoundsObj = tx.timeBounds();
    const minTime = timeBoundsObj?.minTime().toNumber() || 0;
    const maxTime = timeBoundsObj?.maxTime().toNumber() || 0;
    const timeBoundsDescription = describeTimeBounds(minTime, maxTime);

    // Extract operations safely
    const operations = tx.operations().map((op, index) => ({
      index,
      type: op.body().switch().name,
      summary: summarizeOperation(op),
    }));

    // Extract signer information safely (public keys only)
    const signers = signatures.map((sig) => {
      const hint = sig.hint().toString('hex');
      return `Signer hint: ${hint}`;
    });

    // Identify risks
    const risks: RiskyTransactionData = {
      warnings: [],
    };

    // Check for potential sensitive information patterns
    if (memoInfo.type === 'TEXT' && memoInfo.value) {
      if (containsSensitivePatterns(memoInfo.value)) {
        risks.warnings.push('⚠ Memo may contain sensitive information (PII, URLs, etc.)');
      }
    }

    if (signatures.length === 0) {
      risks.warnings.push('⚠ Transaction is not signed yet');
    }

    const summary: SafeTransactionSummary = {
      transactionHash,
      envelopeType,
      sourceAccount: sourceAccountPublicKey,
      fee,
      sequence,
      memo: {
        type: memoInfo.type,
        description:
          memoInfo.type === 'TEXT'
            ? '(text memo present)'
            : memoInfo.type === 'NONE'
              ? 'None'
              : 'Present',
      },
      timeBounds: {
        minTime,
        maxTime,
        description: timeBoundsDescription,
      },
      operations: operations.slice(0, 5), // Limit to first 5 for logging
      signatures: {
        count: signatures.length,
        signers,
      },
      network: networkPassphrase,
    };

    return { summary, risks };
  } catch (error) {
    throw new Error(
      `Failed to extract transaction summary: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function extractSafeMemoInfo(memo: xdr.Memo): { type: string; value?: string } {
  const memoType = memo.switch().name;

  switch (memoType) {
    case 'memoTypeNone':
      return { type: 'NONE' };
    case 'memoTypeId':
      return { type: 'ID', value: '(numeric ID)' };
    case 'memoTypeHash':
      return { type: 'HASH', value: '(hash value)' };
    case 'memoTypeReturn':
      return { type: 'RETURN', value: '(return hash)' };
    case 'memoTypeText': {
      // For text memos, we'll return the actual value but flag it for risk
      const textValue = memo.text()?.toString() || '';
      return { type: 'TEXT', value: textValue };
    }
    default:
      return { type: 'UNKNOWN' };
  }
}

function summarizeOperation(op: xdr.Operation): string {
  const body = op.body();
  const opType = body.switch().name;

  switch (opType) {
    case 'createAccountOp': {
      const createAccountOp = body.createAccountOp();
      const destBuffer = createAccountOp?.destination().accountId().ed25519();
      const _destKey = destBuffer
        ? Keypair.fromPublicKey(
            Buffer.concat([Buffer.from([0]), destBuffer])
              .toString('base64')
              .slice(1),
          ).publicKey()
        : 'Unknown';
      const amount = createAccountOp?.startingBalance().toString() || '0';
      return `Create account with ${amount} XLM starting balance`;
    }
    case 'paymentOp': {
      const paymentOp = body.paymentOp();
      const destBuffer = paymentOp?.destination().accountId().ed25519();
      const _destKey = destBuffer
        ? Keypair.fromPublicKey(
            Buffer.concat([Buffer.from([0]), destBuffer])
              .toString('base64')
              .slice(1),
          ).publicKey()
        : 'Unknown';
      const amount = paymentOp?.amount().toString() || '0';
      return `Payment of ${amount} XLM`;
    }
    case 'manageBuyOfferOp': {
      const manageBuyOfferOp = body.manageBuyOfferOp();
      const amount = manageBuyOfferOp?.buyingAmount().toString() || '0';
      return `Manage buy offer for ${amount}`;
    }
    case 'manageSellOfferOp': {
      const manageSellOfferOp = body.manageSellOfferOp();
      const amount = manageSellOfferOp?.amount().toString() || '0';
      return `Manage sell offer for ${amount}`;
    }
    case 'setOptionsOp':
      return 'Set account options';
    case 'changeTrustOp':
      return 'Change trust line';
    case 'allowTrustOp':
      return 'Allow trust';
    case 'accountMergeOp':
      return 'Account merge';
    case 'inflationOp':
      return 'Inflation';
    case 'manageDataOp':
      return 'Manage data entry';
    case 'bumpSequenceOp':
      return 'Bump sequence number';
    case 'createClaimableBalanceOp':
      return 'Create claimable balance';
    case 'claimClaimableBalanceOp':
      return 'Claim claimable balance';
    case 'beginSponsoringFutureReservesOp':
      return 'Begin sponsoring future reserves';
    case 'endSponsoringFutureReservesOp':
      return 'End sponsoring future reserves';
    case 'revokeClaimableBalanceOp':
      return 'Revoke claimable balance';
    case 'clawbackOp':
      return 'Clawback';
    case 'clawbackClaimableBalanceOp':
      return 'Clawback claimable balance';
    case 'setTrustLineFlagsOp':
      return 'Set trust line flags';
    case 'liquidityPoolDepositOp':
      return 'Liquidity pool deposit';
    case 'liquidityPoolWithdrawOp':
      return 'Liquidity pool withdrawal';
    case 'invokeHostFunctionOp':
      return 'Invoke host function (Soroban)';
    case 'extendFootprintTtlOp':
      return 'Extend footprint TTL (Soroban)';
    case 'restoreFootprintOp':
      return 'Restore footprint (Soroban)';
    default:
      return `Unknown operation: ${opType}`;
  }
}

function describeTimeBounds(minTime: number, maxTime: number): string {
  if (minTime === 0 && maxTime === 0) {
    return 'No time bounds (valid indefinitely)';
  }

  const now = Math.floor(Date.now() / 1000);
  const descriptions: string[] = [];

  if (minTime > 0) {
    const minDate = new Date(minTime * 1000);
    if (minTime > now) {
      descriptions.push(`Valid from ${minDate.toISOString()} (future)`);
    } else {
      descriptions.push(`Valid from ${minDate.toISOString()}`);
    }
  }

  if (maxTime > 0) {
    const maxDate = new Date(maxTime * 1000);
    if (maxTime < now) {
      descriptions.push(`Expired since ${maxDate.toISOString()}`);
    } else {
      descriptions.push(`Valid until ${maxDate.toISOString()}`);
    }
  }

  return descriptions.length > 0 ? descriptions.join('; ') : 'No specific time bounds';
}

function containsSensitivePatterns(text: string): boolean {
  const sensitivePatterns = [
    /https?:\/\//i, // URLs
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i, // Email addresses
    /\b\d{3}-\d{2}-\d{4}\b/, // SSN pattern
    /\b\d{13,19}\b/, // Credit card pattern
  ];

  return sensitivePatterns.some((pattern) => pattern.test(text));
}

function logSafeTransactionSummary(
  summary: SafeTransactionSummary,
  risks: RiskyTransactionData,
): void {
  console.log('\n=== Safe Transaction Summary ===\n');

  console.log('Public Transaction Information:');
  console.log(`  Transaction Hash: ${summary.transactionHash}`);
  console.log(`  Envelope Type: ${summary.envelopeType}`);
  console.log(`  Source Account: ${summary.sourceAccount}`);
  console.log(`  Fee: ${summary.fee} stroops`);
  console.log(`  Sequence Number: ${summary.sequence}`);
  console.log(`  Network: ${summary.network}`);

  console.log('\nMemo:');
  console.log(`  Type: ${summary.memo.type}`);
  if (summary.memo.description) {
    console.log(`  Note: ${summary.memo.description}`);
  }

  console.log('\nTime Bounds:');
  console.log(`  Description: ${summary.timeBounds.description}`);
  console.log(
    `  Min Time: ${summary.timeBounds.minTime} (${new Date(summary.timeBounds.minTime * 1000).toISOString()})`,
  );
  console.log(
    `  Max Time: ${summary.timeBounds.maxTime} (${new Date(summary.timeBounds.maxTime * 1000).toISOString()})`,
  );

  console.log('\nOperations:');
  summary.operations.forEach((op) => {
    console.log(`  [${op.index}] ${op.type}: ${op.summary}`);
  });

  console.log('\nSignatures:');
  console.log(`  Total Signatures: ${summary.signatures.count}`);
  if (summary.signatures.signers.length > 0) {
    summary.signatures.signers.forEach((signer) => {
      console.log(`    - ${signer}`);
    });
  } else {
    console.log('    No signatures (transaction unsigned)');
  }

  if (risks.warnings.length > 0) {
    console.log('\n⚠️  Security Warnings:');
    risks.warnings.forEach((warning) => {
      console.log(`  ${warning}`);
    });
  }
}

export async function run(): Promise<void> {
  console.log('\n=== Safe Transaction Logging Example ===\n');

  // Create a sample transaction
  const keypair = Keypair.random();
  const destinationKeypair = Keypair.random();

  console.log('Creating a sample transaction...');
  const sourceAccount = new Account(keypair.publicKey(), '100');
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation({
      destination: destinationKeypair.publicKey(),
      amount: '25.50',
      asset: { code: 'native', issuer: '' },
      type: 'payment',
    })
    .addMemo({ type: 'text', value: 'Payment for services rendered' })
    .setDefaultTimeout(300)
    .build();

  console.log('Signing transaction...');
  tx.sign(keypair);

  const txEnvelopeXdr = tx.toEnvelope().toXDR('base64');

  console.log('Extracting safe transaction summary...\n');
  const { summary, risks } = extractSafeTransactionSummary(txEnvelopeXdr, Networks.TESTNET);

  // Log the safe summary
  logSafeTransactionSummary(summary, risks);

  console.log('\n--- Information NOT Logged ---');
  console.log('The following sensitive information is explicitly NOT logged:');
  console.log('  ✓ Secret keys');
  console.log('  ✓ Private signing material');
  console.log('  ✓ Signature data (only hint visible for audit trails)');
  console.log('  ✓ Detailed destination addresses (summarized as operations)');

  console.log('\n=== Example Complete ===\n');
}
