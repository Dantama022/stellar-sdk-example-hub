/**
 * 263-transaction-signature-threshold-analyzer: Stellar Transaction Signature Verification and Signer Threshold Analyzer
 *
 * OVERVIEW
 * --------
 * Read-only example that parses a Stellar transaction envelope, verifies its
 * attached signatures, and analyzes whether the verified signatures satisfy the
 * source account's signer thresholds.
 *
 * It never requests, logs, or stores secret keys. It never signs, submits, or
 * modifies transactions.
 *
 * KEY DISTINCTION
 * ---------------
 * Cryptographic signature verification (a signature was produced by the holder
 * of a given public key over the transaction hash) is different from complete
 * Stellar transaction authorization (thresholds, operation-level requirements,
 * sequence numbers, time bounds, and network validation rules). A cryptographically
 * valid signature does not by itself mean a transaction will be accepted.
 */

import {
  Account,
  FeeBumpTransaction,
  Horizon,
  Keypair,
  Networks,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export type SignatureVerificationResult = 'verified' | 'unmatched' | 'invalid';
export type ThresholdResult = 'MEETS' | 'BELOW' | 'INDETERMINATE';
export type CheckStatus = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface VerifiedSignature {
  hint: string;
  signature: string;
  result: SignatureVerificationResult;
  matchedKey: string | null;
  verified: boolean;
  note: string;
}

export interface SignerConfig {
  accountId: string;
  signers: Array<{ key: string; weight: number; type: string }>;
  thresholds: { low: number; medium: number; high: number };
  source: 'horizon' | 'offline-input' | 'missing';
  note: string;
}

export interface ThresholdAnalysis {
  accountId: string;
  threshold: { low: number; medium: number; high: number };
  evaluatedThreshold: 'low' | 'medium' | 'high';
  requiredWeight: number;
  collectedWeight: number;
  matchedSigners: Array<{ key: string; weight: number }>;
  result: ThresholdResult;
  status: CheckStatus;
  detail: string;
  operationLevelNotes: string[];
}

export interface VerificationReport {
  envelopeXdr: string;
  isFeeBump: boolean;
  sourceAccount: string | null;
  sequence: string;
  transactionHash: string | null;
  signatureCount: number;
  signatures: VerifiedSignature[];
  verifiedCount: number;
  unmatchedCount: number;
  invalidCount: number;
  signerConfig: SignerConfig;
  thresholdAnalysis: ThresholdAnalysis | null;
  notes: string[];
}

export interface RunParams {
  envelopeXdr?: string;
  signerKeys?: string; // comma-separated public keys
  signerWeights?: string; // comma-separated weights, aligned with signerKeys
  thresholds?: string; // JSON: { low, medium, high }
  accountId?: string; // when set, config is fetched from Horizon (online mode)
  horizonUrl?: string;
  json?: boolean | string;
  offline?: boolean | string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Cryptographic helpers (exported for unit testing)
// ──────────────────────────────────────────────────────────────────────────────

/** Verifies a single signature over the transaction hash with one public key. */
export function verifySignatureWithKey(
  transactionHash: Buffer,
  signature: Buffer,
  publicKey: string,
): { verified: boolean; error: string | null } {
  try {
    const keypair = Keypair.fromPublicKey(publicKey);
    const verified = keypair.verify(transactionHash, signature);
    return { verified, error: null };
  } catch (error) {
    return { verified: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Verifies every attached signature against a list of candidate public keys.
 * Signature hints are used only for display; a hint never proves identity.
 */
export function verifySignatures(
  transactionHash: Buffer,
  signatures: Array<{ hint: Buffer; signature: Buffer }>,
  candidateKeys: string[],
): VerifiedSignature[] {
  return signatures.map((sig) => {
    const hint = sig.hint.toString('hex');
    const signatureData = sig.signature;
    let best: VerifiedSignature = {
      hint,
      signature: signatureData.toString('hex'),
      result: 'unmatched',
      matchedKey: null,
      verified: false,
      note: 'No candidate public key verified this signature.',
    };

    for (const publicKey of candidateKeys) {
      const { verified, error } = verifySignatureWithKey(transactionHash, signatureData, publicKey);
      if (verified) {
        best = {
          hint,
          signature: signatureData.toString('hex'),
          result: 'verified',
          matchedKey: publicKey,
          verified: true,
          note: 'Cryptographically verified against a supplied signer public key.',
        };
        break;
      }
      if (error) {
        best.note = `Candidate key did not verify (${error}).`;
      }
    }

    if (!best.verified && best.matchedKey === null) {
      best.note =
        'No supplied signer public key verified this signature; the signer may not be among the candidates or the signature may be invalid.';
    }

    return best;
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Signer configuration resolution
// ──────────────────────────────────────────────────────────────────────────────

export interface SignerConfigInput {
  signers: Array<{ key: string; weight: number; type: string }>;
  thresholds: { low: number; medium: number; high: number };
}

/** Parses offline signer configuration supplied through CLI parameters. */
export function parseOfflineSignerConfig(
  signerKeys?: string,
  signerWeights?: string,
  thresholdsJson?: string,
): { config: SignerConfigInput | null; error: string | null } {
  const keys = (signerKeys ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (keys.length === 0) {
    return { config: null, error: 'No signer keys supplied for offline mode.' };
  }

  const weightsRaw = (signerWeights ?? '')
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  const weights = weightsRaw.length === 0 ? keys.map(() => 1) : weightsRaw.map((w) => Number(w));

  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    return { config: null, error: 'Signer weights must be non-negative numbers.' };
  }

  let thresholds: { low: number; medium: number; high: number };
  if (thresholdsJson) {
    try {
      const parsed = JSON.parse(thresholdsJson);
      thresholds = {
        low: Number(parsed.low ?? 0),
        medium: Number(parsed.medium ?? 0),
        high: Number(parsed.high ?? 0),
      };
    } catch {
      return {
        config: null,
        error: 'Thresholds must be valid JSON, e.g. {"low":1,"medium":2,"high":3}.',
      };
    }
  } else {
    thresholds = { low: 0, medium: 0, high: keys.length };
  }

  const signers = keys.map((key, index) => {
    let type = 'ed25519_public_key';
    try {
      Keypair.fromPublicKey(key);
    } catch {
      type = 'invalid';
    }
    return { key, weight: Math.max(0, weights[index] ?? 1), type };
  });

  return {
    config: { signers, thresholds },
    error: null,
  };
}

/** Fetches signer configuration from Horizon (online mode). */
export async function fetchSignerConfigFromHorizon(
  server: Horizon.Server,
  accountId: string,
): Promise<SignerConfig> {
  try {
    const account = await server.loadAccount(accountId);
    const signers = account.signers.map((s) => ({
      key: s.key,
      weight: s.weight,
      type: s.type,
    }));
    return {
      accountId,
      signers,
      thresholds: {
        low: account.thresholds.low_threshold,
        medium: account.thresholds.med_threshold,
        high: account.thresholds.high_threshold,
      },
      source: 'horizon',
      note: 'Signer configuration retrieved from Horizon.',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      accountId,
      signers: [],
      thresholds: { low: 0, medium: 0, high: 0 },
      source: 'missing',
      note: `Signer configuration unavailable: ${message}. Threshold results will be indeterminate.`,
    };
  }
}

export async function resolveSignerConfig(
  accountId: string,
  params: RunParams,
  server: Horizon.Server,
): Promise<SignerConfig> {
  if (params.offline === true || params.offline === 'true') {
    const { config, error } = parseOfflineSignerConfig(
      params.signerKeys,
      params.signerWeights,
      params.thresholds,
    );
    if (config === null) {
      return {
        accountId,
        signers: [],
        thresholds: { low: 0, medium: 0, high: 0 },
        source: 'missing',
        note: error ?? 'Offline signer configuration is missing.',
      };
    }
    return {
      accountId,
      signers: config.signers,
      thresholds: config.thresholds,
      source: 'offline-input',
      note: 'Signer configuration supplied through CLI parameters (offline mode).',
    };
  }

  return fetchSignerConfigFromHorizon(server, accountId);
}

// ──────────────────────────────────────────────────────────────────────────────
// Threshold analysis
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates whether verified signers satisfy the account threshold.
 * Stellar rule: the combined weight of distinct, cryptographically verified
 * signers must meet or exceed the applicable threshold. Signers with weight 0
 * (e.g. a locked master key) contribute nothing.
 */
export function analyzeThreshold(
  sourceAccount: string | null,
  verifiedSigners: VerifiedSignature[],
  config: SignerConfig,
  operationSourceAccounts: string[],
): ThresholdAnalysis | null {
  if (sourceAccount === null) {
    return {
      accountId: '(unknown)',
      threshold: config.thresholds,
      evaluatedThreshold: 'high',
      requiredWeight: config.thresholds.high,
      collectedWeight: 0,
      matchedSigners: [],
      result: 'INDETERMINATE',
      status: 'UNKNOWN',
      detail: 'The transaction source account could not be determined.',
      operationLevelNotes: [],
    };
  }

  // Deduplicate verified signers by public key; count each distinct signer once.
  const matchedMap = new Map<string, number>();
  for (const sig of verifiedSigners) {
    if (!sig.verified || !sig.matchedKey) continue;
    const configSigner = config.signers.find((s) => s.key === sig.matchedKey);
    if (!configSigner) continue;
    // A signer with weight 0 (locked) cannot contribute to authorization.
    if (configSigner.weight <= 0) continue;
    matchedMap.set(sig.matchedKey, configSigner.weight);
  }

  const matchedSigners = Array.from(matchedMap.entries()).map(([key, weight]) => ({ key, weight }));
  const collectedWeight = matchedSigners.reduce((sum, { weight }) => sum + weight, 0);

  // Stellar convention used by this example: transaction-level authorization is
  // referenced against the high threshold. Per-operation thresholds (low /
  // medium / high) apply to individual operations and cannot be fully evaluated
  // when operation source accounts or their configurations are unavailable.
  const evaluatedThreshold: 'low' | 'medium' | 'high' = 'high';
  const requiredWeight = config.thresholds[evaluatedThreshold];

  const operationLevelNotes: string[] = [];
  if (config.source === 'missing') {
    operationLevelNotes.push(
      'Signer configuration is unavailable; threshold satisfaction is indeterminate.',
    );
  }
  for (const opSource of operationSourceAccounts) {
    if (opSource !== sourceAccount && opSource !== '(unknown)') {
      operationLevelNotes.push(
        `Operation sourced by ${opSource}: its threshold context is not part of this analysis; treat as indeterminate.`,
      );
    }
  }

  let result: ThresholdResult;
  let status: CheckStatus;
  let detail: string;

  if (config.source === 'missing') {
    result = 'INDETERMINATE';
    status = 'UNKNOWN';
    detail = 'Signer configuration is missing, so threshold satisfaction cannot be determined.';
  } else if (collectedWeight >= requiredWeight) {
    result = 'MEETS';
    status = 'PASS';
    detail = `Collected weight ${collectedWeight} meets the ${evaluatedThreshold} threshold (required ${requiredWeight}).`;
  } else {
    result = 'BELOW';
    status = 'FAIL';
    detail = `Collected weight ${collectedWeight} is below the ${evaluatedThreshold} threshold (required ${requiredWeight}); missing weight ${Math.max(0, requiredWeight - collectedWeight)}.`;
  }

  return {
    accountId: sourceAccount,
    threshold: config.thresholds,
    evaluatedThreshold,
    requiredWeight,
    collectedWeight,
    matchedSigners,
    result,
    status,
    detail,
    operationLevelNotes,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Report assembly
// ──────────────────────────────────────────────────────────────────────────────

export function buildReport(
  envelopeXdr: string,
  isFeeBump: boolean,
  sourceAccount: string | null,
  sequence: string,
  transactionHash: string | null,
  signatures: VerifiedSignature[],
  config: SignerConfig,
  analysis: ThresholdAnalysis | null,
): VerificationReport {
  const verifiedCount = signatures.filter((s) => s.verified).length;
  const unmatchedCount = signatures.filter((s) => !s.verified && s.result === 'unmatched').length;
  const invalidCount = signatures.filter((s) => !s.verified && s.result === 'invalid').length;

  const notes: string[] = [
    'This is a local, read-only inspection. No transaction was signed or submitted, and no secret keys were requested.',
    'Cryptographic verification only proves that a signature was produced over the transaction hash',
    'by the holder of a matching public key; it does not by itself constitute Stellar authorization.',
    'Signature hints assist signer identification but do not independently prove signer identity.',
    'A verified signature must still be combined with enough weight to meet the applicable threshold.',
    'Missing account configuration produces an indeterminate result, never an assumed pass.',
  ];

  if (isFeeBump)
    notes.push('This is a fee-bump envelope; analysis below covers the inner transaction.');
  if (config.source === 'missing')
    notes.push('No signer configuration was available; threshold analysis is indeterminate.');

  return {
    envelopeXdr,
    isFeeBump,
    sourceAccount,
    sequence,
    transactionHash,
    signatureCount: signatures.length,
    signatures,
    verifiedCount,
    unmatchedCount,
    invalidCount,
    signerConfig: config,
    thresholdAnalysis: analysis,
    notes,
  };
}

export function formatReport(report: VerificationReport): string {
  const lines: string[] = [];
  const icon: Record<CheckStatus, string> = { PASS: '✓', FAIL: '✗', UNKNOWN: '?' };

  lines.push('══════════════════════════════════════════════════════════');
  lines.push('  Stellar Transaction Signature and Threshold Analysis Report');
  lines.push('══════════════════════════════════════════════════════════');
  lines.push(
    `  Envelope type:   ${report.isFeeBump ? 'Fee-bump (inner transaction analyzed)' : 'Transaction'}`,
  );
  lines.push(`  Source account:  ${report.sourceAccount ?? '(unavailable)'}`);
  lines.push(`  Sequence:        ${report.sequence}`);
  lines.push(`  Transaction hash: ${report.transactionHash ?? '(unavailable)'}`);
  lines.push(
    `  Signatures:      ${report.signatureCount} attached (${report.verifiedCount} verified, ${report.unmatchedCount} unmatched, ${report.invalidCount} invalid)`,
  );
  lines.push('');

  lines.push('  Signature details:');
  if (report.signatures.length === 0) {
    lines.push('    (no signatures attached to this envelope)');
  }
  for (const sig of report.signatures) {
    lines.push(
      `    [${sig.hint}] ${sig.result.toUpperCase()} ${sig.verified ? 'verified' : 'not verified'}`,
    );
    lines.push(`        Matched key: ${sig.matchedKey ?? '(none)'}`);
    lines.push(`        Signature: ${sig.signature.slice(0, 32)}...`);
    lines.push(`        Note: ${sig.note}`);
  }
  lines.push('');

  lines.push('  Signer configuration:');
  lines.push(`    Account:       ${report.signerConfig.accountId}`);
  lines.push(`    Source:        ${report.signerConfig.source}`);
  lines.push(`    Signers:       ${report.signerConfig.signers.length}`);
  for (const signer of report.signerConfig.signers) {
    lines.push(`        - ${signer.key} weight=${signer.weight} type=${signer.type}`);
  }
  lines.push(
    `    Thresholds:    low=${report.signerConfig.thresholds.low} medium=${report.signerConfig.thresholds.medium} high=${report.signerConfig.thresholds.high}`,
  );
  lines.push(`    Note:          ${report.signerConfig.note}`);
  lines.push('');

  lines.push('  Threshold analysis:');
  if (report.thresholdAnalysis === null) {
    lines.push('    (not available — source account could not be determined)');
  } else {
    const a = report.thresholdAnalysis;
    const resultIcon: Record<ThresholdResult, string> = {
      MEETS: '✓',
      BELOW: '✗',
      INDETERMINATE: '?',
    };
    lines.push(
      `    Evaluated threshold: ${a.evaluatedThreshold} (required weight ${a.requiredWeight})`,
    );
    lines.push(`    Collected weight:    ${a.collectedWeight}`);
    lines.push(`    Result:              ${resultIcon[a.result]} ${a.result}`);
    lines.push(`    Status:              ${icon[a.status]} ${a.status}`);
    lines.push(`    Detail:              ${a.detail}`);
    lines.push(`    Matched signers:     ${a.matchedSigners.length}`);
    for (const m of a.matchedSigners) lines.push(`        - ${m.key} weight=${m.weight}`);
    for (const note of a.operationLevelNotes) lines.push(`        - ${note}`);
  }
  lines.push('');

  lines.push('  Notes:');
  for (const note of report.notes) lines.push(`  - ${note}`);

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Transaction construction (offline sample — unsigned, never submitted)
// ──────────────────────────────────────────────────────────────────────────────

function buildSampleTransaction(): { envelopeXdr: string; sourceAccount: string } {
  const keypair = Keypair.random();
  const account = new Account(keypair.publicKey(), '1');
  const builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  });
  // The sample is intentionally left UNSIGNED: this example only inspects.
  // setTimebounds(0, 0) means no time-based expiry (maxTime = 0 = never expires).
  // It also satisfies the builder's requirement that time bounds be declared.
  builder.setTimebounds(0, 0);
  const tx = builder.build();
  return { envelopeXdr: tx.toEnvelope().toXDR('base64'), sourceAccount: keypair.publicKey() };
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

export async function run(params: RunParams = {}): Promise<void> {
  const outputJson =
    params.json === true || params.json === 'true' || process.env.OUTPUT_JSON === 'true';
  const horizonUrl = params.horizonUrl || DEFAULT_HORIZON_URL;
  const networkPassphrase = Networks.TESTNET;

  console.log('Starting Transaction Signature and Threshold Analyzer...');
  console.log(`Network passphrase: ${networkPassphrase}`);

  let envelopeXdr = params.envelopeXdr;

  if (!envelopeXdr) {
    console.log('\nNo envelope supplied — building an unsigned local sample for inspection...');
    const sample = buildSampleTransaction();
    envelopeXdr = sample.envelopeXdr;
    console.log(`Sample source account: ${sample.sourceAccount}`);
    console.log('Note: the sample envelope has no attached signatures.');
  }

  // ── Parse envelope ──
  let sourceAccount: string | null = null;
  let sequence = '0';
  let transactionHash: string | null = null;
  let isFeeBump = false;
  const rawSignatures: Array<{ hint: Buffer; signature: Buffer }> = [];

  try {
    const parsed = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
    if (parsed instanceof FeeBumpTransaction) {
      isFeeBump = true;
      const inner = parsed.innerTransaction;
      sourceAccount = inner.source;
      sequence = inner.sequence;
      transactionHash = inner.hash().toString('hex');
      rawSignatures.push(
        ...inner.signatures.map((sig) => ({ hint: sig.hint(), signature: sig.signature() })),
      );
    } else {
      sourceAccount = parsed.source;
      sequence = parsed.sequence;
      transactionHash = parsed.hash().toString('hex');
      rawSignatures.push(
        ...parsed.signatures.map((sig) => ({ hint: sig.hint(), signature: sig.signature() })),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nFailed to parse transaction envelope: ${message}`);
    console.error('Ensure the input is base64-encoded transaction XDR for the selected network.');
    process.exitCode = 1;
    return;
  }

  // ── Candidate public keys for verification ──
  let candidateKeys: string[] = [];
  if (params.signerKeys) {
    candidateKeys = params.signerKeys
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
  } else {
    // Default candidates for the unsigned sample: none match, demonstrating the
    // unmatched path. Supply --signer-keys to verify real envelopes.
    candidateKeys = [
      DEFAULT_ACCOUNT_ID,
      'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLYF3436GTYOWD4S',
    ];
  }

  // ── Verify signatures ──
  const hashBuffer = transactionHash ? Buffer.from(transactionHash, 'hex') : Buffer.alloc(0);
  const signatures =
    hashBuffer.length > 0 ? verifySignatures(hashBuffer, rawSignatures, candidateKeys) : [];

  // ── Resolve signer configuration ──
  const server = new Horizon.Server(horizonUrl);
  const analysisAccountId = params.accountId ?? sourceAccount ?? DEFAULT_ACCOUNT_ID;
  const config = await resolveSignerConfig(analysisAccountId, params, server);

  // ── Identify operation source accounts for context notes ──
  // Note: enumerating per-operation source accounts requires re-parsing XDR
  // operations; this example notes the limitation instead of approximating it.
  const operationSourceAccounts: string[] = [];

  const analysis = analyzeThreshold(sourceAccount, signatures, config, operationSourceAccounts);

  const report = buildReport(
    envelopeXdr,
    isFeeBump,
    sourceAccount,
    sequence,
    transactionHash,
    signatures,
    config,
    analysis,
  );

  if (outputJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  console.log(
    '\nTransaction signature and threshold analysis completed. Read-only inspection only.',
  );
}
