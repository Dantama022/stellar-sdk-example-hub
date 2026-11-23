import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

export interface Sep10ValidationOptions {
  expectedServerSigningKey: string;
  networkPassphrase?: string;
  expectedHomeDomain?: string;
  nowEpochSeconds?: number;
  allowAdditionalSignatures?: boolean;
}

export interface Sep10OperationInspection {
  index: number;
  type: string;
  sourceAccount: string | null;
  dataName?: string;
  validForSep10: boolean;
  issue?: string;
}

export interface Sep10ValidationReport {
  valid: boolean;
  originalXdr: string;
  networkPassphrase: string;
  expectedServerSigningKey: string;
  transactionSourceAccount: string | null;
  sequenceNumber: string | null;
  timeBounds: {
    minTime: string | null;
    maxTime: string | null;
    isValidWindow: boolean;
    isExpired: boolean;
    isNotYetValid: boolean;
  };
  signatureCheck: {
    totalSignatures: number;
    serverSignaturePresent: boolean;
    serverSignatureValid: boolean;
    unexpectedSignatureCount: number;
  };
  operations: Sep10OperationInspection[];
  failedChecks: string[];
  warnings: string[];
  disclaimer: string;
}

export function validateSep10Challenge(
  challengeXdr: string,
  options: Sep10ValidationOptions,
): Sep10ValidationReport {
  const networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;
  const nowSeconds = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const failedChecks: string[] = [];
  const warnings: string[] = [];

  if (!StrKey.isValidEd25519PublicKey(options.expectedServerSigningKey)) {
    throw new Error(`Invalid expectedServerSigningKey: "${options.expectedServerSigningKey}"`);
  }
  if (typeof challengeXdr !== 'string' || challengeXdr.trim() === '') {
    throw new Error('Challenge transaction XDR must be a non-empty base64 string.');
  }
  if (typeof networkPassphrase !== 'string' || networkPassphrase.trim() === '') {
    throw new Error('A valid Stellar networkPassphrase is required.');
  }

  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(challengeXdr.trim(), networkPassphrase);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed SEP-10 challenge XDR: ${message}`);
  }

  if (parsed instanceof FeeBumpTransaction) {
    throw new Error('SEP-10 challenge must be a classic Transaction, not a FeeBumpTransaction.');
  }

  const txSource = parsed.source;
  if (txSource !== options.expectedServerSigningKey) {
    failedChecks.push(
      `Transaction source account (${txSource}) does not match expected server signing key (${options.expectedServerSigningKey}).`,
    );
  }

  if (parsed.sequence !== '0') {
    failedChecks.push(`SEP-10 challenge sequence number must be "0", got "${parsed.sequence}".`);
  }

  // Time bounds inspection
  const minTimeStr = parsed.timeBounds?.minTime ?? null;
  const maxTimeStr = parsed.timeBounds?.maxTime ?? null;
  let isValidWindow = false;
  let isExpired = false;
  let isNotYetValid = false;

  if (!parsed.timeBounds || minTimeStr === null || maxTimeStr === null) {
    failedChecks.push('SEP-10 challenge is missing required timeBounds.');
  } else {
    const minTime = Number(minTimeStr);
    const maxTime = Number(maxTimeStr);
    if (!Number.isFinite(minTime) || !Number.isFinite(maxTime) || minTime <= 0 || maxTime <= minTime) {
      failedChecks.push(
        `Invalid SEP-10 timeBounds (minTime=${minTimeStr}, maxTime=${maxTimeStr}); minTime must be > 0 and maxTime > minTime.`,
      );
    } else {
      isValidWindow = true;
      if (nowSeconds > maxTime) {
        isExpired = true;
        failedChecks.push(`SEP-10 challenge expired at ${maxTime} (current time ${nowSeconds}).`);
      } else if (nowSeconds < minTime) {
        isNotYetValid = true;
        failedChecks.push(`SEP-10 challenge is not yet valid until ${minTime} (current time ${nowSeconds}).`);
      }
    }
  }

  // Operations inspection
  const operations: Sep10OperationInspection[] = [];
  if (parsed.operations.length === 0) {
    failedChecks.push('SEP-10 challenge must contain at least one manageData operation.');
  } else {
    parsed.operations.forEach((op, index) => {
      if (op.type !== 'manageData') {
        const issue = `Unexpected operation type "${op.type}" at index ${index}; SEP-10 challenges allow only manageData operations.`;
        failedChecks.push(issue);
        operations.push({
          index,
          type: op.type,
          sourceAccount: op.source ?? null,
          validForSep10: false,
          issue,
        });
        return;
      }

      const opSource = op.source ?? null;
      if (index === 0) {
        if (!opSource) {
          const issue = 'First manageData operation must specify the client source account.';
          failedChecks.push(issue);
          operations.push({
            index,
            type: op.type,
            sourceAccount: null,
            dataName: op.name,
            validForSep10: false,
            issue,
          });
          return;
        }
        if (options.expectedHomeDomain && !op.name.startsWith(options.expectedHomeDomain)) {
          warnings.push(
            `First manageData key "${op.name}" does not start with expected home domain "${options.expectedHomeDomain}".`,
          );
        }
      }

      operations.push({
        index,
        type: op.type,
        sourceAccount: opSource,
        dataName: op.name,
        validForSep10: true,
      });
    });
  }

  // Signature verification against expectedServerSigningKey using network-specific hash
  const txHash = parsed.hash();
  const serverKeypair = Keypair.fromPublicKey(options.expectedServerSigningKey);
  const signatures = parsed.signatures;
  let serverSignatureValid = false;
  let matchingHintCount = 0;

  for (const sig of signatures) {
    const matchesServerHint = Buffer.compare(sig.hint(), serverKeypair.signatureHint()) === 0;
    if (matchesServerHint) {
      matchingHintCount += 1;
      if (serverKeypair.verify(txHash, sig.signature())) {
        serverSignatureValid = true;
      }
    }
  }

  const serverSignaturePresent = matchingHintCount > 0;
  if (!serverSignaturePresent) {
    failedChecks.push('Challenge transaction is missing the expected server signature.');
  } else if (!serverSignatureValid) {
    failedChecks.push(
      'Server signature verification failed against the expected server signing key and network passphrase.',
    );
  }

  const unexpectedSignatureCount = serverSignatureValid
    ? Math.max(0, signatures.length - 1)
    : signatures.length;
  if (unexpectedSignatureCount > 0 && !options.allowAdditionalSignatures) {
    failedChecks.push(
      `Found ${unexpectedSignatureCount} unexpected additional signature(s) on the unauthenticated challenge.`,
    );
  }

  if (failedChecks.length === 0) {
    warnings.push(
      'Challenge passed structural and server-signature checks; this validator does not sign or submit the transaction.',
    );
  }

  return {
    valid: failedChecks.length === 0,
    originalXdr: challengeXdr.trim(),
    networkPassphrase,
    expectedServerSigningKey: options.expectedServerSigningKey,
    transactionSourceAccount: txSource,
    sequenceNumber: parsed.sequence,
    timeBounds: {
      minTime: minTimeStr,
      maxTime: maxTimeStr,
      isValidWindow,
      isExpired,
      isNotYetValid,
    },
    signatureCheck: {
      totalSignatures: signatures.length,
      serverSignaturePresent,
      serverSignatureValid,
      unexpectedSignatureCount,
    },
    operations,
    failedChecks,
    warnings,
    disclaimer:
      'Validation only: never trust a server signing key supplied solely inside the challenge; compare against an independently trusted key.',
  };
}

export function formatSep10ValidationReport(report: Sep10ValidationReport): string {
  const lines = [
    '=== Stellar SEP-10 Challenge Security Validation Report ===',
    `Valid: ${report.valid}`,
    `Network Passphrase: ${report.networkPassphrase}`,
    `Expected Server Key: ${report.expectedServerSigningKey}`,
    `Transaction Source: ${report.transactionSourceAccount ?? 'none'}`,
    `Sequence Number: ${report.sequenceNumber ?? 'none'}`,
    `Time Bounds: min=${report.timeBounds.minTime ?? 'none'}, max=${report.timeBounds.maxTime ?? 'none'}`,
    `Server Signature: present=${report.signatureCheck.serverSignaturePresent}, valid=${report.signatureCheck.serverSignatureValid}`,
    `Operations inspected: ${report.operations.length}`,
  ];

  if (report.failedChecks.length > 0) {
    lines.push('', 'Failed Checks:');
    for (const f of report.failedChecks) lines.push(`  - ${f}`);
  }
  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const w of report.warnings) lines.push(`  - ${w}`);
  }
  lines.push('', `Disclaimer: ${report.disclaimer}`);
  return lines.join('\n');
}

export async function run(params: {
  challengeXdr?: string;
  expectedServerSigningKey?: string;
  networkPassphrase?: string;
  json?: boolean | string;
} = {}): Promise<void> {
  const serverKp = Keypair.random();
  const clientKp = Keypair.random();
  const now = Math.floor(Date.now() / 1000);

  let xdr = params.challengeXdr;
  let serverKey = params.expectedServerSigningKey;
  if (!xdr || !serverKey) {
    const tx = new TransactionBuilder(new Account(serverKp.publicKey(), '-1'), {
      fee: '100',
      networkPassphrase: params.networkPassphrase || Networks.TESTNET,
      timebounds: { minTime: now - 60, maxTime: now + 300 },
    })
      .addOperation(
        Operation.manageData({
          name: 'example.com auth',
          value: Buffer.from('nonce-123456'),
          source: clientKp.publicKey(),
        }),
      )
      .build();
    tx.sign(serverKp);
    xdr = tx.toXDR();
    serverKey = serverKp.publicKey();
  }

  const report = validateSep10Challenge(xdr, {
    expectedServerSigningKey: serverKey,
    networkPassphrase: params.networkPassphrase || Networks.TESTNET,
    nowEpochSeconds: now,
  });

  const json = params.json === true || params.json === 'true';
  console.log(json ? JSON.stringify(report, null, 2) : formatSep10ValidationReport(report));
}
