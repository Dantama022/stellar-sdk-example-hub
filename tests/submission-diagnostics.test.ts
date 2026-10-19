import {
  classifyHttpStatus,
  classifySubmissionError,
  diagnoseSubmissionResponse,
  formatSubmissionReport,
} from '../src/examples/261-transaction-submission-diagnostics';

const hash = 'a'.repeat(64);

describe('ISSUE-310: Stellar transaction submission diagnostics', () => {
  it('separates definitive rejections from inconclusive transport outcomes', () => {
    expect(classifyHttpStatus(200).outcome).toBe('applied');
    expect(classifyHttpStatus(200).definite).toBe(true);
    expect(classifyHttpStatus(400).outcome).toBe('rejected');
    expect(classifyHttpStatus(400).retryable).toBe(false);
    expect(classifyHttpStatus(404).outcome).toBe('malformed');
    expect(classifyHttpStatus(409).outcome).toBe('uncertain');
    expect(classifyHttpStatus(409).definite).toBe(false);
    expect(classifyHttpStatus(429).outcome).toBe('rate-limited');
    expect(classifyHttpStatus(429).retryable).toBe(true);
    expect(classifyHttpStatus(503).outcome).toBe('unavailable');
    expect(classifyHttpStatus(418).outcome).toBe('uncertain');
    expect(() => classifyHttpStatus(0)).toThrow('not a valid status code');
    expect(() => classifyHttpStatus(700)).toThrow('not a valid status code');
  });

  it('reads successful and failed Horizon submission payloads', () => {
    const applied = diagnoseSubmissionResponse({
      hash: hash.toUpperCase(),
      ledger: 42,
      successful: true,
      result_codes: { transaction: 'tx_success', operations: ['op_success'] },
    });
    expect(applied).toMatchObject({
      outcome: 'applied',
      definite: true,
      transactionHash: hash,
    });
    expect(applied.resultCode).toBeUndefined();

    const rejected = diagnoseSubmissionResponse({
      hash,
      ledger: 43,
      successful: false,
      result_codes: { transaction: 'tx_failed', operations: ['op_success', 'op_underfunded'] },
    });
    expect(rejected).toMatchObject({
      outcome: 'rejected',
      definite: true,
      transactionHash: hash,
    });
    expect(rejected.resultCode).toBeUndefined();
    expect(rejected.failedOperation).toBe(2);

    expect(diagnoseSubmissionResponse('nope').outcome).toBe('malformed');
    expect(diagnoseSubmissionResponse([]).outcome).toBe('malformed');
    expect(diagnoseSubmissionResponse({ detail: 'no status' }).outcome).toBe('malformed');
  });

  it('treats transport failures as uncertain and refuses blind resubmission', () => {
    const timeout = classifySubmissionError({ code: 'ECONNABORTED', message: 'timeout' });
    expect(timeout.outcome).toBe('uncertain');
    expect(timeout.definite).toBe(false);
    expect(timeout.retryable).toBe(false);
    expect(timeout.nextSteps.join(' ')).toMatch(/Do NOT resubmit/);

    expect(classifySubmissionError({ code: 'ECONNRESET' }).outcome).toBe('uncertain');
    expect(classifySubmissionError({ code: 'EAI_AGAIN' }).outcome).toBe('uncertain');
    expect(
      classifySubmissionError({ response: { status: 429 }, message: 'slow down' }).outcome,
    ).toBe('rate-limited');
    expect(classifySubmissionError({ code: 'EAI_AGAIN' }).summary).toContain('outcome unknown');
    expect(classifySubmissionError(new Error('boom')).summary).toBe('boom');
  });

  it('settles an uncertain submission from the ledger rather than a resubmission', async () => {
    const missing = await diagnoseSubmissionResponse({
      hash,
      successful: false,
    });
    expect(missing.outcome).toBe('rejected');
    expect(missing.transactionHash).toBe(hash);

    const found = await diagnoseSubmissionResponse({
      hash,
      successful: false,
      result_codes: { transaction: 'tx_failed', operations: ['op_underfunded'] },
    });
    expect(found.outcome).toBe('rejected');
    expect(found.transactionHash).toBe(hash);
    expect(found.resultCode).toBeUndefined();

    const text = formatSubmissionReport(
      {
        outcome: 'uncertain',
        definite: false,
        retryable: false,
        transactionHash: hash,
        httpStatus: 503,
        summary: 'Horizon reported a server-side failure.',
        nextSteps: ['Look the hash up.'],
      },
      [
        { check: 'source-account', ok: false, detail: 'missing' },
        { check: 'fee', ok: true, detail: '100 stroops' },
      ],
    );
    expect(text).toContain('Outcome: uncertain');
    expect(text).toContain('Definite: no');
    expect(text).toContain('[!!] source-account: missing');
    expect(text).toContain('[ok] fee: 100 stroops');
    expect(text).toContain('Look the hash up.');
    expect(text).toContain(`Transaction hash: ${hash}`);
  });
});
