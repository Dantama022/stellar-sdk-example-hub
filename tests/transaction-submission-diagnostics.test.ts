import {
  buildSubmissionDiagnostics,
  formatSubmissionDiagnostics,
  isValidTransactionHash,
  lookupObservationForUnknownHash,
  normalizeTransactionHash,
  observationFromHorizonRecord,
  OUTCOME_SAMPLES,
} from '../src/examples/262-transaction-submission-diagnostics';
import { examples } from '../src/runner/catalog';

const HASH = '8f2a4d0c1b9e7a6f5d4c3b2a1908f7e6d5c4b3a2190807f6e5d4c3b2a1908f7e';

describe('262-transaction-submission-diagnostics', () => {
  it('classifies local validation failures as fixable without broadcast risk', () => {
    const report = buildSubmissionDiagnostics({
      stage: 'local_validation',
      errorDetail: 'Envelope XDR failed to parse',
    });

    expect(report.stage).toBe('local_validation');
    expect(report.terminal).toBe(false);
    expect(report.disposition).toBe('fix_and_rebuild');
    expect(report.recoverySteps.join(' ')).toContain('nothing was ever broadcast');
  });

  it('classifies network submission rejections as non-terminal and hash-lookup resolvable', () => {
    const report = buildSubmissionDiagnostics({
      stage: 'network_submission',
      errorDetail: 'HTTP 400: tx_insufficient_fee',
    });

    expect(report.stage).toBe('network_submission');
    expect(report.terminal).toBe(false);
    expect(report.hash).toBeNull();
    expect(report.recoverySteps.join(' ')).toContain('transaction hash');
  });

  it('treats transport timeouts without a response as ambiguous, not rejected', () => {
    const rejected = buildSubmissionDiagnostics({
      stage: 'network_submission',
      errorDetail: 'HTTP 400: malformed transaction',
    });
    const timedOut = buildSubmissionDiagnostics({
      stage: 'network_submission',
      errorDetail: 'submission socket timed out after 30 s',
    });

    expect(rejected.disposition).toBe('lookup_by_hash');
    expect(timedOut.disposition).toBe('wait_and_lookup');
    const ambiguous = buildSubmissionDiagnostics({
      stage: 'ambiguous_outcome',
      hash: HASH,
    });
    expect(ambiguous.recoverySteps.join(' ')).toContain('Do not blindly resubmit');
    expect(ambiguous.safetyNotes.join(' ')).toContain('may still be pending');
  });

  it('extracts fee information, ledger sequence, and operation results from a confirmed success', () => {
    const report = buildSubmissionDiagnostics({
      stage: 'confirmed_ledger',
      hash: HASH,
      successful: true,
      ledger: 51234567,
      createdAt: '2026-10-22T14:03:12Z',
      maxFee: '100000',
      feeCharged: '300',
      resultCode: 'tx_success',
      operationCodes: ['op_success', 'op_success'],
    });

    expect(report.terminal).toBe(true);
    expect(report.disposition).toBe('nothing_to_do');
    expect(report.fee).toMatchObject({ requestedMaxFee: '100000', feeCharged: '300' });
    expect(report.ledgerSequence).toBe(51234567);
    expect(report.operationResults).toHaveLength(2);
    expect(report.operationResults.every((op) => !op.failed)).toBe(true);
  });

  it('points recovery at the failing operation for a confirmed failure', () => {
    const report = buildSubmissionDiagnostics({
      stage: 'confirmed_ledger',
      hash: HASH,
      successful: false,
      ledger: 51234568,
      maxFee: '100000',
      feeCharged: '300',
      resultCode: 'tx_failed',
      operationCodes: ['op_success', 'op_no_destination'],
    });

    const failing = report.operationResults.find((op) => op.failed);
    expect(failing?.index).toBe(1);
    expect(failing?.code).toBe('op_no_destination');
    expect(report.recoverySteps.join(' ')).toContain('create_account');
    expect(formatSubmissionDiagnostics(report)).toContain('[1] FAILED op_no_destination');
  });

  it('maps a Horizon transaction record into the confirmed observation shape', () => {
    const observation = observationFromHorizonRecord({
      hash: HASH,
      successful: true,
      ledger: 100,
      created_at: '2026-10-22T14:00:00Z',
      fee_charged: '300',
      max_fee: '100000',
      extras: {
        result_codes: { transaction: 'tx_success', operations: ['op_success'] },
      },
    });
    const report = buildSubmissionDiagnostics(observation);

    expect(observation.stage).toBe('confirmed_ledger');
    expect(observation.source).toBe('horizon_lookup');
    expect(report.resultCode).toBe('tx_success');
    expect(report.fee?.feeCharged).toBe('300');
  });

  it('handles an unknown hash lookup as an unresolved network outcome', () => {
    const report = buildSubmissionDiagnostics(lookupObservationForUnknownHash('https://horizon-testnet.stellar.org'));

    expect(report.stage).toBe('network_submission');
    expect(report.terminal).toBe(false);
    expect(report.recoverySteps.join(' ')).toContain('wait-and-lookup');
  });

  it('demonstrates all five modelled outcomes without network access or secrets', () => {
    const stages = OUTCOME_SAMPLES.map((sample) => buildSubmissionDiagnostics(sample.observation).stage);
    expect(stages).toEqual([
      'local_validation',
      'network_submission',
      'confirmed_ledger',
      'confirmed_ledger',
      'ambiguous_outcome',
    ]);
    expect(JSON.stringify(OUTCOME_SAMPLES)).not.toMatch(/S[A-Z2-7]{55}/);
  });

  it('validates hash shape locally before any network request', () => {
    expect(isValidTransactionHash(HASH)).toBe(true);
    expect(isValidTransactionHash('not-a-hash')).toBe(false);
    expect(() => normalizeTransactionHash('zzz')).toThrow(/64-character hexadecimal/);
    expect(() => normalizeTransactionHash('   ')).toThrow(/required/);
  });

  it('is registered as a runnable example', () => {
    expect(examples['262-transaction-submission-diagnostics']).toBeDefined();
    expect(typeof examples['262-transaction-submission-diagnostics'].run).toBe('function');
  });
});
