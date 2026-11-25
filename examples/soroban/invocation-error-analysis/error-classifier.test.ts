import { Address, Keypair, NetworkError, rpc, xdr } from '@stellar/stellar-sdk';

// The SDK's .d.ts declares these XDR extension constructors with no parameters, but they take the union arm.
const ext = <T>(ctor: unknown): T => new (ctor as new (arm: number) => T)(0);
import { analyzeInvocationError, parseHostError, redactSensitive, redactString } from './index';

const CONTRACT = 'CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA';
const HASH = 'ab'.repeat(32);
const context = { contractAddress: CONTRACT, functionName: 'claim' };

// ---- Representative RPC response fixtures --------------------------------

const simError = (error: string) => ({ id: '1', latestLedger: 123, events: [], error, _parsed: true });

function txResult(code: 'txFailed' | 'txBadSeq' | 'txInsufficientFee' | 'txBadAuth' | 'txTooLate', inner?: xdr.InvokeHostFunctionResult): xdr.TransactionResult {
  const result =
    code === 'txFailed'
      ? xdr.TransactionResultResult.txFailed([xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(inner as xdr.InvokeHostFunctionResult))])
      : code === 'txBadSeq'
        ? xdr.TransactionResultResult.txBadSeq()
        : code === 'txInsufficientFee'
          ? xdr.TransactionResultResult.txInsufficientFee()
          : code === 'txBadAuth'
            ? xdr.TransactionResultResult.txBadAuth()
            : xdr.TransactionResultResult.txTooLate();
  return new xdr.TransactionResult({ feeCharged: new xdr.Int64(100n), result, ext: ext<xdr.TransactionResultExt>(xdr.TransactionResultExt) });
}

const sendResponse = (status: string, errorResult?: xdr.TransactionResult) => ({
  status,
  hash: HASH,
  latestLedger: 100,
  latestLedgerCloseTime: 1_700_000_000,
  errorResult,
});

describe('input validation errors', () => {
  it('classifies a caller-reported input error', () => {
    const a = analyzeInvocationError({ stage: 'input-validation', error: new Error('invalid address: GBAD'), context });
    expect(a.report).toMatchObject({ stage: 'input-validation', category: 'invalid-input', submissionStatus: 'not-applicable' });
    expect(a.report.recommendations.join(' ')).toMatch(/Correct the argument/);
  });

  it('falls back to low confidence when only the message hints at bad input', () => {
    const a = analyzeInvocationError({ error: new Error('Invalid contract id: checksum mismatch') });
    expect(a.report.category).toBe('invalid-input');
    expect(a.report.confidence).toBe('low');
    expect(a.report.warnings.join(' ')).toMatch(/Low-confidence/);
  });
});

describe('simulation errors', () => {
  it('classifies a contract error code and extracts it', () => {
    const a = analyzeInvocationError({ response: simError('HostError: Error(Contract, #12)\nEvent log (newest first): ...'), context });
    expect(a.report).toMatchObject({
      stage: 'simulation',
      stageSource: 'inferred',
      category: 'contract-execution',
      confidence: 'high',
      errorCode: 'Error(Contract, #12)',
    });
    expect(a.report.diagnostics.contractErrorCode).toBe(12);
    expect(a.report.diagnostics.hostError).toEqual({ type: 'Contract', code: '#12' });
    expect(a.report.recommendations[0]).toMatch(/Contract error #12/);
    expect(a.report.retrySafety).toBe('not-recommended');
  });

  it('classifies a missing contract', () => {
    const a = analyzeInvocationError({ stage: 'simulation', error: new Error('contract not found: ' + CONTRACT), context });
    expect(a.report.category).toBe('contract-not-found');
    expect(a.report.confidence).toBe('medium');
    const storage = analyzeInvocationError({ response: simError('HostError: Error(Storage, MissingValue) trying to get non-existing value for contract instance') });
    expect(storage.report.category).toBe('contract-not-found');
    expect(storage.report.confidence).toBe('low');
  });

  it('treats a non-existent function as invalid input', () => {
    const a = analyzeInvocationError({ response: simError('HostError: Error(WasmVm, InvalidAction) trying to invoke non-existent contract function: nope') });
    expect(a.report.category).toBe('invalid-input');
  });

  it('classifies other VM failures as contract execution failures', () => {
    const a = analyzeInvocationError({ response: simError('HostError: Error(WasmVm, InvalidAction)\nVM call trapped: UnreachableCodeReached') });
    expect(a.report.category).toBe('contract-execution');
    expect(a.report.confidence).toBe('medium');
  });
});

describe('authorization failures', () => {
  it('maps host Auth errors to authorization', () => {
    const a = analyzeInvocationError({ response: simError('HostError: Error(Auth, InvalidAction) require_auth failed') });
    expect(a.report).toMatchObject({ category: 'authorization', confidence: 'high', stage: 'simulation' });
    expect(a.report.recommendations.join(' ')).toMatch(/require_auth/);
  });

  it('maps a txBadAuth result at submission to authorization', () => {
    const a = analyzeInvocationError({ response: sendResponse('ERROR', txResult('txBadAuth')) });
    expect(a.report).toMatchObject({ stage: 'submission', category: 'authorization', errorCode: 'txBadAuth', submissionStatus: 'not-submitted' });
  });
});

describe('resource and fee errors', () => {
  it('maps Budget errors to resource-limit', () => {
    const a = analyzeInvocationError({ stage: 'resource-estimation', response: simError('HostError: Error(Budget, ExceededLimit) cpu instructions exceeded') });
    expect(a.report).toMatchObject({ stage: 'resource-estimation', category: 'resource-limit', confidence: 'high' });
    expect(a.report.recommendations.join(' ')).toMatch(/Re-simulate/);
  });

  it('maps an on-chain resource-limit result to resource-limit', () => {
    const a = analyzeInvocationError({ response: { status: 'FAILED', txHash: HASH, resultXdr: txResult('txFailed', xdr.InvokeHostFunctionResult.invokeHostFunctionResourceLimitExceeded()) } });
    expect(a.report).toMatchObject({ category: 'resource-limit', errorCode: 'invokeHostFunctionResourceLimitExceeded', stage: 'execution' });
  });

  it.each(['txInsufficientFee', 'txBadSeq', 'txTooLate'] as const)('maps %s to a fee/transaction configuration problem', (code) => {
    const a = analyzeInvocationError({ response: sendResponse('ERROR', txResult(code)) });
    expect(a.report).toMatchObject({ category: 'fee-or-configuration', errorCode: code, confidence: 'high' });
    expect(a.report.retrySafety).toBe('after-fix');
  });

  it('maps an insufficient refundable fee result to fee-or-configuration', () => {
    const a = analyzeInvocationError({ response: { status: 'FAILED', txHash: HASH, resultXdr: txResult('txFailed', xdr.InvokeHostFunctionResult.invokeHostFunctionInsufficientRefundableFee()) } });
    expect(a.report.category).toBe('fee-or-configuration');
  });
});

describe('connectivity failures', () => {
  it.each(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'])('classifies %s from a read as network connectivity', (code) => {
    const a = analyzeInvocationError({ stage: 'simulation', error: Object.assign(new Error(`connect ${code}`), { code }) });
    expect(a.report).toMatchObject({ category: 'network-connectivity', confidence: 'high', errorCode: code, retrySafety: 'after-backoff' });
  });

  it('classifies HTTP 429/503 as connectivity using the SDK NetworkError and axios shapes', () => {
    const sdk = analyzeInvocationError({ error: new NetworkError('Service Unavailable', { status: 503, data: {} }) });
    expect(sdk.report).toMatchObject({ category: 'network-connectivity', confidence: 'high', errorCode: '503' });
    const axiosLike = analyzeInvocationError({ error: Object.assign(new Error('Request failed with status code 429'), { response: { status: 429, data: {} } }) });
    expect(axiosLike.report).toMatchObject({ category: 'network-connectivity', confidence: 'high', errorCode: '429' });
  });

  it('treats a connection failure during submission as an unresolved outcome, not a failure', () => {
    const a = analyzeInvocationError({ stage: 'submission', error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), transactionHash: HASH });
    expect(a.report.submissionStatus).toBe('unknown');
    expect(a.report.retrySafety).toBe('check-status-first');
    expect(a.report.warnings.join(' ')).toMatch(new RegExp(`Check status for ${HASH}`));
    expect(a.report.recommendations.join(' ')).toMatch(/Do not retry the submission itself yet/);
    expect(a.report.recommendations.join(' ')).not.toMatch(/Retry reads with/);
  });
});

describe('submission and status results', () => {
  it('classifies a rejected submission with its result code', () => {
    const a = analyzeInvocationError({ response: sendResponse('ERROR', txResult('txInsufficientFee')), context });
    expect(a.report).toMatchObject({ stage: 'submission', transactionHash: HASH, submissionStatus: 'not-submitted' });
    expect(a.report.diagnostics.transactionResultCode).toBe('txInsufficientFee');
  });

  it('classifies TRY_AGAIN_LATER as not accepted', () => {
    const a = analyzeInvocationError({ response: sendResponse('TRY_AGAIN_LATER') });
    expect(a.report).toMatchObject({ category: 'transaction-rejected', errorCode: 'TRY_AGAIN_LATER', submissionStatus: 'not-submitted' });
  });

  it('does not treat PENDING, DUPLICATE or NOT_FOUND as definite failures', () => {
    for (const status of ['PENDING', 'DUPLICATE']) {
      const a = analyzeInvocationError({ response: sendResponse(status) });
      expect(a.report).toMatchObject({ category: 'transaction-pending', confidence: 'high', retrySafety: 'check-status-first', submissionStatus: 'pending' });
      expect(a.report.recommendations.join(' ')).toMatch(/Do not treat this as a failure/);
    }
    const notFound = analyzeInvocationError({ response: { status: rpc.Api.GetTransactionStatus.NOT_FOUND, txHash: HASH, latestLedger: 5 } });
    expect(notFound.report).toMatchObject({ stage: 'status-retrieval', category: 'transaction-pending', submissionStatus: 'unknown', retrySafety: 'check-status-first' });
  });

  it('classifies an on-chain execution failure (trapped contract)', () => {
    const a = analyzeInvocationError({ response: { status: 'FAILED', txHash: HASH, latestLedger: 9, resultXdr: txResult('txFailed', xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped()) }, context });
    expect(a.report).toMatchObject({ stage: 'execution', category: 'contract-execution', errorCode: 'invokeHostFunctionTrapped', submissionStatus: 'included' });
    expect(a.report.diagnostics.operationResultCodes).toEqual(['opInner', 'invokeHostFunctionTrapped']);
    expect(a.report.warnings.join(' ')).toMatch(/new transaction/);
  });

  it('reads base64 result XDR as returned by a raw RPC response', () => {
    const a = analyzeInvocationError({ response: { status: 'ERROR', hash: HASH, errorResultXdr: txResult('txBadSeq').toXDR('base64') } });
    expect(a.report.errorCode).toBe('txBadSeq');
  });
});

describe('diagnostic events', () => {
  const diagnosticEvent = new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: ext<xdr.ExtensionPoint>(xdr.ExtensionPoint),
      contractId: Address.fromString(CONTRACT).toBuffer(),
      type: xdr.ContractEventType.diagnostic(),
      body: new (xdr.ContractEventBody as unknown as new (arm: number, v: xdr.ContractEventV0) => xdr.ContractEventBody)(
        0,
        new xdr.ContractEventV0({ topics: [xdr.ScVal.scvSymbol('error')], data: xdr.ScVal.scvString('insufficient balance') }),
      ),
    }),
  });

  it('summarises events given as XDR objects or base64, and skips unreadable ones', () => {
    const a = analyzeInvocationError({
      response: { ...simError('HostError: Error(Contract, #1)'), events: [diagnosticEvent, diagnosticEvent.toXDR('base64'), 'not-xdr', null] },
    });
    const events = a.report.diagnostics.diagnosticEvents;
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'diagnostic', contractId: CONTRACT, topics: ['error'], data: 'insufficient balance' });
  });

  it('redacts secrets that appear inside event data', () => {
    const secretEvent = new xdr.DiagnosticEvent({
      inSuccessfulContractCall: false,
      event: new xdr.ContractEvent({
        ext: ext<xdr.ExtensionPoint>(xdr.ExtensionPoint),
        contractId: null,
        type: xdr.ContractEventType.diagnostic(),
        body: new (xdr.ContractEventBody as unknown as new (arm: number, v: xdr.ContractEventV0) => xdr.ContractEventBody)(
          0,
          new xdr.ContractEventV0({ topics: [], data: xdr.ScVal.scvString(Keypair.random().secret()) }),
        ),
      }),
    });
    const a = analyzeInvocationError({ response: { ...simError('Error(Contract, #1)'), events: [secretEvent] } });
    expect(a.report.diagnostics.diagnosticEvents[0].data).toBe('[REDACTED]');
  });
});

describe('unknown errors and missing metadata', () => {
  it('keeps unknown errors inspectable and low-key', () => {
    const original = new Error('something odd happened');
    const a = analyzeInvocationError({ error: original, context });
    expect(a.report).toMatchObject({ category: 'unknown', confidence: 'none', stage: 'unknown', stageSource: 'undetermined' });
    expect(a.original.error).toBe(original);
    expect(a.report.originalMessage).toBe('something odd happened');
    expect(a.report.recommendations.join(' ')).toMatch(/did not match a known pattern/);
  });

  it('handles missing diagnostic metadata and odd error values without throwing', () => {
    for (const error of [undefined, null, 42, 'plain string', {}, { weird: true }]) {
      const a = analyzeInvocationError({ error });
      expect(a.report.category).toBe('unknown');
      expect(a.report.diagnostics.metadataAvailable).toBe(false);
      expect(a.report.warnings.join(' ')).toMatch(/No structured diagnostic metadata/);
    }
  });

  it('never retries or submits: the report says so', () => {
    expect(analyzeInvocationError({ error: new Error('x') }).report.automaticRetry).toBe(false);
  });
});

describe('sensitive data redaction', () => {
  const secret = Keypair.random().secret();

  it('redacts secret keys, bearer tokens and URL credentials from messages', () => {
    const a = analyzeInvocationError({
      error: new Error(`signing failed for ${secret} via https://rpc.example/?api_key=abc123&x=1 with Authorization: Bearer sk_live_abcdef123456`),
    });
    expect(a.report.originalMessage).not.toContain(secret);
    expect(a.report.originalMessage).not.toContain('abc123');
    expect(a.report.originalMessage).not.toContain('sk_live_abcdef123456');
    expect(a.report.originalMessage).toContain('[REDACTED]');
    expect(JSON.stringify(a.report)).not.toContain(secret);
  });

  it('redacts sensitive keys in nested objects and long XDR blobs without mutating input', () => {
    const input = { ok: 1, secretKey: secret, nested: { authorization: 'x', signature: 'y', list: [{ password: 'p', fine: 'f' }] }, blob: 'A'.repeat(300) };
    const out = redactSensitive(input) as Record<string, any>;
    expect(out.secretKey).toBe('[REDACTED]');
    expect(out.nested.authorization).toBe('[REDACTED]');
    expect(out.nested.signature).toBe('[REDACTED]');
    expect(out.nested.list[0]).toEqual({ password: '[REDACTED]', fine: 'f' });
    expect(out.blob).toBe('[REDACTED-XDR]');
    expect(input.secretKey).toBe(secret);
    expect(redactString('plain text')).toBe('plain text');
  });

  it('keeps public identifiers such as contract addresses and transaction hashes', () => {
    const a = analyzeInvocationError({ response: sendResponse('PENDING'), context });
    expect(a.report.contractAddress).toBe(CONTRACT);
    expect(a.report.transactionHash).toBe(HASH);
  });
});

describe('recovery guidance', () => {
  it('is category specific and separate from classification', () => {
    const byCategory = {
      authorization: analyzeInvocationError({ response: simError('Error(Auth, InvalidAction)') }),
      'resource-limit': analyzeInvocationError({ response: simError('Error(Budget, ExceededLimit)') }),
      'contract-execution': analyzeInvocationError({ response: simError('Error(Contract, #5)') }),
    };
    const texts = Object.values(byCategory).map((a) => a.guidance.recommendations.join(' '));
    expect(new Set(texts).size).toBe(3);
    expect(byCategory.authorization.guidance.retrySafety).toBe('after-fix');
    expect(byCategory['contract-execution'].guidance.retrySafety).toBe('not-recommended');
  });

  it('parses host error notation', () => {
    expect(parseHostError('x Error(Budget, ExceededLimit) y')).toEqual({ type: 'Budget', code: 'ExceededLimit' });
    expect(parseHostError('no error here')).toBeUndefined();
  });
});
