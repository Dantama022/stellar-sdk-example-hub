import { TransactionBuilder, Keypair, Networks, xdr, Account } from '@stellar/stellar-sdk';

/**
 * Example 154: Replay Protection Analysis
 *
 * Signed Stellar transactions should not be treated as universally reusable messages.
 * Transaction sequence numbers, network-specific signing payloads, and optional time bounds
 * provide important protections against unintended replay.
 *
 * This example inspects a signed transaction and explains which transaction properties
 * constrain where and when it can be accepted, helping developers understand the replay
 * protection properties of Stellar transactions.
 */

interface ReplayProtectionAnalysis {
  sourceAccount: string;
  sequence: string;
  network: string;
  networkHash: string;
  timeBounds: {
    minTime: number;
    maxTime: number;
    hasLowerBound: boolean;
    hasUpperBound: boolean;
    description: string;
  };
  protectionLevel: 'WEAK' | 'MODERATE' | 'STRONG';
  protectionDetails: {
    sequenceProtection: string;
    networkProtection: string;
    temporalProtection: string;
    overallRisk: string;
  };
}

function analyzeReplayProtection(
  txEnvelopeXdr: string,
  networkPassphrase: string,
): ReplayProtectionAnalysis {
  try {
    // Decode the transaction envelope
    const envelope = xdr.TransactionEnvelope.fromXDR(txEnvelopeXdr, 'base64');

    let tx: xdr.Transaction;

    if (envelope.isVariant('txTypeV1')) {
      const v1 = envelope.v1();
      if (!v1) throw new Error('Invalid transaction envelope');
      tx = v1.tx();
    } else {
      throw new Error('Unsupported envelope type');
    }

    // Extract source account
    const sourceAccountBuffer = tx.sourceAccount().accountId().ed25519();
    const sourceAccountPublicKey = Keypair.fromPublicKey(
      Buffer.concat([Buffer.from([0]), sourceAccountBuffer])
        .toString('base64')
        .slice(1),
    ).publicKey();

    // Extract sequence number
    const sequence = tx.seqNum().toString();

    // Extract time bounds
    const timeBoundsObj = tx.timeBounds();
    const minTime = timeBoundsObj?.minTime().toNumber() || 0;
    const maxTime = timeBoundsObj?.maxTime().toNumber() || 0;
    const hasLowerBound = minTime > 0;
    const hasUpperBound = maxTime > 0;

    // Calculate network hash (network passphrase hash)
    const networkHash = xdr.EnvelopeType.txTypeV1().toString();

    // Determine protection level
    let protectionLevel: 'WEAK' | 'MODERATE' | 'STRONG' = 'WEAK';
    let sequenceProtection = '';
    let networkProtection = '';
    let temporalProtection = '';

    // Sequence Number Protection
    if (sequence === '0') {
      sequenceProtection = 'WEAK: Sequence is 0 (typically only valid for new accounts)';
    } else {
      sequenceProtection = `GOOD: Sequence ${sequence} prevents reuse on same account without intervening transactions`;
      protectionLevel = protectionLevel === 'WEAK' ? 'MODERATE' : protectionLevel;
    }

    // Network Protection
    networkProtection = `Network passphrase "${networkPassphrase}" binds transaction to specific network`;
    networkProtection +=
      '\n    - Transaction cannot be replayed on networks with different passphrases';
    networkProtection +=
      '\n    - Provides strong isolation between Public/Test/Development networks';
    protectionLevel = 'MODERATE';

    // Temporal Protection
    if (!hasLowerBound && !hasUpperBound) {
      temporalProtection = 'WEAK: No time bounds - transaction is valid indefinitely once accepted';
      temporalProtection += '\n    - Higher risk of accidental replay if account state is reset';
    } else if (hasLowerBound && hasUpperBound) {
      const now = Math.floor(Date.now() / 1000);
      const minDate = new Date(minTime * 1000);
      const maxDate = new Date(maxTime * 1000);

      temporalProtection = 'STRONG: Tight time window constraints';
      temporalProtection += `\n    - Valid from ${minDate.toISOString()}`;
      temporalProtection += `\n    - Expires at ${maxDate.toISOString()}`;
      temporalProtection += `\n    - Window duration: ${maxTime - minTime} seconds`;

      if (now < minTime) {
        temporalProtection += `\n    - Currently INVALID (will be valid in ${minTime - now}s)`;
      } else if (now > maxTime) {
        temporalProtection += `\n    - Currently EXPIRED (expired ${now - maxTime}s ago)`;
      } else {
        temporalProtection += `\n    - Currently VALID (${maxTime - now}s remaining)`;
      }

      protectionLevel = 'STRONG';
    } else if (hasUpperBound) {
      const now = Math.floor(Date.now() / 1000);
      const maxDate = new Date(maxTime * 1000);

      temporalProtection = 'MODERATE: Upper time bound only';
      temporalProtection += `\n    - Expires at ${maxDate.toISOString()}`;

      if (now > maxTime) {
        temporalProtection += `\n    - Currently EXPIRED (expired ${now - maxTime}s ago)`;
      } else {
        temporalProtection += `\n    - Currently VALID (${maxTime - now}s remaining)`;
      }

      protectionLevel = 'MODERATE';
    } else if (hasLowerBound) {
      const now = Math.floor(Date.now() / 1000);
      const minDate = new Date(minTime * 1000);

      temporalProtection = 'WEAK: Lower time bound only';
      temporalProtection += `\n    - Valid from ${minDate.toISOString()}`;

      if (now < minTime) {
        temporalProtection += `\n    - Currently INVALID (will be valid in ${minTime - now}s)`;
      } else {
        temporalProtection += `\n    - Currently VALID`;
      }
    }

    // Determine overall risk
    const overallRisk = determineOverallRisk(
      sequence,
      hasLowerBound,
      hasUpperBound,
      minTime,
      maxTime,
    );

    const timeBoundsDescription = describeTimeBounds(minTime, maxTime);

    return {
      sourceAccount: sourceAccountPublicKey,
      sequence,
      network: networkPassphrase,
      networkHash,
      timeBounds: {
        minTime,
        maxTime,
        hasLowerBound,
        hasUpperBound,
        description: timeBoundsDescription,
      },
      protectionLevel,
      protectionDetails: {
        sequenceProtection,
        networkProtection,
        temporalProtection,
        overallRisk,
      },
    };
  } catch (error) {
    throw new Error(
      `Failed to analyze replay protection: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function describeTimeBounds(minTime: number, maxTime: number): string {
  if (minTime === 0 && maxTime === 0) {
    return 'No time bounds (indefinite validity)';
  }

  if (minTime > 0 && maxTime > 0) {
    return `Time window: ${new Date(minTime * 1000).toISOString()} to ${new Date(maxTime * 1000).toISOString()}`;
  }

  if (maxTime > 0) {
    return `Expires: ${new Date(maxTime * 1000).toISOString()}`;
  }

  if (minTime > 0) {
    return `Valid from: ${new Date(minTime * 1000).toISOString()}`;
  }

  return 'Unknown time bounds';
}

function determineOverallRisk(
  sequence: string,
  hasLowerBound: boolean,
  hasUpperBound: boolean,
  minTime: number,
  maxTime: number,
): string {
  const risks: string[] = [];

  // Check sequence
  if (sequence === '0') {
    risks.push('Sequence 0 provides minimal replay protection');
  }

  // Check time bounds
  if (!hasLowerBound && !hasUpperBound) {
    risks.push('No time bounds - infinite validity window');
  }

  const now = Math.floor(Date.now() / 1000);
  if (hasUpperBound && now > maxTime) {
    risks.push('Transaction is already expired');
  }

  if (hasLowerBound && now < minTime) {
    risks.push('Transaction is not yet valid');
  }

  if (risks.length === 0) {
    return 'LOW RISK: Transaction has strong replay protection';
  }

  if (risks.length === 1) {
    return `MODERATE RISK: ${risks[0]}`;
  }

  return `HIGH RISK: Multiple protection weaknesses detected:\n    - ${risks.join('\n    - ')}`;
}

export async function run(): Promise<void> {
  console.log('\n=== Replay Protection Analysis Example ===\n');

  // Example 1: Transaction with no time bounds
  console.log('--- Example 1: No Time Bounds ---');
  const keypair1 = Keypair.random();
  const dest1 = Keypair.random();

  const sourceAccount1 = new Account(keypair1.publicKey(), '100');
  const tx1 = new TransactionBuilder(sourceAccount1, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation({
      destination: dest1.publicKey(),
      amount: '10',
      asset: { code: 'native', issuer: '' },
      type: 'payment',
    })
    .setTimeout(0) // No time limit
    .build();

  tx1.sign(keypair1);
  const envelope1 = tx1.toEnvelope().toXDR('base64');

  const analysis1 = analyzeReplayProtection(envelope1, Networks.TESTNET);
  printReplayProtectionAnalysis(analysis1);

  // Example 2: Transaction with tight time bounds
  console.log('\n--- Example 2: Tight Time Bounds (300 seconds) ---');
  const keypair2 = Keypair.random();
  const dest2 = Keypair.random();

  const sourceAccount2 = new Account(keypair2.publicKey(), '100');
  const tx2 = new TransactionBuilder(sourceAccount2, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation({
      destination: dest2.publicKey(),
      amount: '10',
      asset: { code: 'native', issuer: '' },
      type: 'payment',
    })
    .setTimeout(300) // 300 seconds (5 minutes)
    .build();

  tx2.sign(keypair2);
  const envelope2 = tx2.toEnvelope().toXDR('base64');

  const analysis2 = analyzeReplayProtection(envelope2, Networks.TESTNET);
  printReplayProtectionAnalysis(analysis2);

  // Example 3: Transaction on different network
  console.log('\n--- Example 3: Same Transaction on Public Network ---');
  const keypair3 = Keypair.random();
  const dest3 = Keypair.random();

  const sourceAccount3 = new Account(keypair3.publicKey(), '100');
  const tx3 = new TransactionBuilder(sourceAccount3, {
    fee: '100',
    networkPassphrase: Networks.PUBLIC_NETWORK,
  })
    .addOperation({
      destination: dest3.publicKey(),
      amount: '10',
      asset: { code: 'native', issuer: '' },
      type: 'payment',
    })
    .setTimeout(300)
    .build();

  tx3.sign(keypair3);
  const envelope3 = tx3.toEnvelope().toXDR('base64');

  const analysis3 = analyzeReplayProtection(envelope3, Networks.PUBLIC_NETWORK);
  printReplayProtectionAnalysis(analysis3);

  console.log('\n=== Replay Protection Key Takeaways ===\n');
  console.log('1. SEQUENCE NUMBERS: Prevent replay on the same account');
  console.log('   - Each valid sequence can only be used once per account');
  console.log('   - Does not protect against replay across different accounts');
  console.log('');
  console.log('2. NETWORK PASSPHRASE: Binds transaction to specific network');
  console.log('   - Test Network transactions cannot be submitted to Public Network');
  console.log('   - Provides strong isolation between environments');
  console.log('');
  console.log('3. TIME BOUNDS: Limit temporal validity window');
  console.log('   - Upper bound prevents indefinite validity');
  console.log('   - Lower bound enables scheduled transactions');
  console.log('   - Recommended: Always set reasonable time bounds');
  console.log('');
  console.log('4. COMBINED PROTECTION: Use all three mechanisms');
  console.log('   - Sequence + Time bounds = Comprehensive replay protection');
  console.log('   - Network passphrase provides defense-in-depth');
  console.log('');

  console.log('=== Example Complete ===\n');
}

function printReplayProtectionAnalysis(analysis: ReplayProtectionAnalysis): void {
  console.log(`Source Account: ${analysis.sourceAccount}`);
  console.log(`Sequence Number: ${analysis.sequence}`);
  console.log(`Network: ${analysis.network}`);
  console.log(`Protection Level: ${analysis.protectionLevel}`);

  console.log('\nReplay Protection Analysis:');
  console.log(`\n${analysis.protectionDetails.sequenceProtection}`);
  console.log(`\n${analysis.protectionDetails.networkProtection}`);
  console.log(`\n${analysis.protectionDetails.temporalProtection}`);

  console.log(`\nTime Bounds Summary: ${analysis.timeBounds.description}`);
  console.log(`Has Lower Bound: ${analysis.timeBounds.hasLowerBound}`);
  console.log(`Has Upper Bound: ${analysis.timeBounds.hasUpperBound}`);

  console.log(`\nOverall Risk Assessment:`);
  console.log(`${analysis.protectionDetails.overallRisk}`);
}
