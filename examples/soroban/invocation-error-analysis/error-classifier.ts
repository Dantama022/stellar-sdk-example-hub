/**
 * Stage identification and error classification.
 *
 * Classification is separate from recovery guidance (recovery-guidance.ts):
 * this module only decides *what happened* and how sure it is. Structured
 * signals (RPC status, transaction result codes, host error type + code) are
 * trusted over free-form message text, and anything uncertain is reported as
 * low confidence or `unknown` rather than guessed.
 */

import { rpc } from '@stellar/stellar-sdk';
import type { Diagnostics } from './diagnostics';
import type { Category, Confidence, InvocationFailure, Stage, SubmissionStatus } from './types';

export interface Classification {
  stage: Stage;
  stageSource: 'provided' | 'inferred' | 'undetermined';
  category: Category;
  /** Documented code behind the classification, when there is one. */
  code?: string;
  confidence: Confidence;
  submissionStatus: SubmissionStatus;
  /** Human-readable reasons, most important first. */
  signals: string[];
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_NETWORK']);
const NETWORK_TEXT = /network error|socket hang up|timeout|timed out|connect (refused|timeout)|getaddrinfo|fetch failed|ECONN|ENOTFOUND|rate limit|too many requests/i;

/** Transaction result code -> classification. Codes are the XDR TransactionResultCode names. */
const TX_CODE_CATEGORY: Record<string, Category> = {
  txBadAuth: 'authorization',
  txBadAuthExtra: 'authorization',
  txInsufficientFee: 'fee-or-configuration',
  txInsufficientBalance: 'fee-or-configuration',
  txNoAccount: 'fee-or-configuration',
  txBadSeq: 'fee-or-configuration',
  txTooEarly: 'fee-or-configuration',
  txTooLate: 'fee-or-configuration',
  txMissingOperation: 'fee-or-configuration',
  txMalformed: 'fee-or-configuration',
  txSorobanInvalid: 'fee-or-configuration',
  txBadSponsorship: 'fee-or-configuration',
  txBadMinSeqAgeOrGap: 'fee-or-configuration',
  txNotSupported: 'transaction-rejected',
  txInternalError: 'transaction-rejected',
};

/** InvokeHostFunction / footprint operation result codes. */
const OP_CODE_CATEGORY: Record<string, Category> = {
  invokeHostFunctionTrapped: 'contract-execution',
  invokeHostFunctionResourceLimitExceeded: 'resource-limit',
  invokeHostFunctionInsufficientRefundableFee: 'fee-or-configuration',
  invokeHostFunctionEntryArchived: 'fee-or-configuration',
  invokeHostFunctionMalformed: 'invalid-input',
  extendFootprintTtlResourceLimitExceeded: 'resource-limit',
  extendFootprintTtlInsufficientRefundableFee: 'fee-or-configuration',
  extendFootprintTtlMalformed: 'invalid-input',
  restoreFootprintResourceLimitExceeded: 'resource-limit',
  restoreFootprintInsufficientRefundableFee: 'fee-or-configuration',
  restoreFootprintMalformed: 'invalid-input',
  opBadAuth: 'authorization',
  opNoAccount: 'fee-or-configuration',
  opNotSupported: 'transaction-rejected',
};

function isResponseLike(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Decide the stage. A provided stage always wins: only the caller knows which
 * step it was running. Otherwise infer from the response shape; when nothing
 * is conclusive the stage is `unknown` rather than a guess.
 */
export function identifyStage(failure: InvocationFailure, d: Diagnostics): { stage: Stage; source: Classification['stageSource'] } {
  if (failure.stage && failure.stage !== 'unknown') return { stage: failure.stage, source: 'provided' };
  const res = failure.response;
  if (isResponseLike(res)) {
    if (rpc.Api.isSimulationError(res as never)) return { stage: 'simulation', source: 'inferred' };
    if (typeof res.status === 'string' && ['ERROR', 'PENDING', 'DUPLICATE', 'TRY_AGAIN_LATER'].includes(res.status) && typeof res.hash === 'string') {
      return { stage: 'submission', source: 'inferred' };
    }
    if (res.status === 'FAILED') return { stage: 'execution', source: 'inferred' };
    if (res.status === 'NOT_FOUND') return { stage: 'status-retrieval', source: 'inferred' };
  }
  if (d.hostError && !failure.response) return { stage: 'simulation', source: 'inferred' };
  return { stage: 'unknown', source: 'undetermined' };
}

function submissionFor(stage: Stage, category: Category, d: Diagnostics): SubmissionStatus {
  switch (stage) {
    case 'input-validation':
    case 'transaction-construction':
    case 'simulation':
    case 'resource-estimation':
    case 'authorization':
      return 'not-applicable';
    case 'execution':
      return 'included';
    case 'submission':
      if (category === 'transaction-pending') return 'pending';
      if (category === 'network-connectivity') return 'unknown'; // the request may have reached the node
      if (d.rpcStatus === 'ERROR' || d.rpcStatus === 'TRY_AGAIN_LATER') return 'not-submitted';
      return d.transactionHash ? 'unknown' : 'not-submitted';
    case 'status-retrieval':
      return 'unknown';
    default:
      return d.transactionHash ? 'unknown' : 'not-applicable';
  }
}

function fromTransactionCodes(d: Diagnostics): { category: Category; code: string; signals: string[] } | undefined {
  const tx = d.transactionResultCode?.split('/').pop();
  // A failed transaction carries the interesting detail in its operation results.
  for (const op of d.operationResultCodes) {
    const category = OP_CODE_CATEGORY[op];
    if (category) return { category, code: op, signals: [`operation result ${op}`] };
  }
  if (tx && TX_CODE_CATEGORY[tx]) return { category: TX_CODE_CATEGORY[tx], code: tx, signals: [`transaction result ${tx}`] };
  return undefined;
}

function fromHostError(d: Diagnostics): { category: Category; code: string; confidence: Confidence; signals: string[] } | undefined {
  const h = d.hostError;
  if (!h) return undefined;
  const code = `Error(${h.type}, ${h.code})`;
  const signals = [`host error ${code}`];
  switch (h.type) {
    case 'Contract':
      return { category: 'contract-execution', code, confidence: 'high', signals };
    case 'Budget':
      return { category: 'resource-limit', code, confidence: 'high', signals };
    case 'Auth':
      return { category: 'authorization', code, confidence: 'high', signals };
    case 'Storage':
      // A missing storage entry usually means the contract (or its data) does not exist, but not always.
      if (h.code === 'MissingValue') {
        return { category: 'contract-not-found', code, confidence: 'low', signals: [...signals, 'missing storage entry: contract or data may not exist'] };
      }
      return { category: 'contract-execution', code, confidence: 'medium', signals };
    case 'WasmVm':
      if (/non-existent contract function|function .* not found/i.test(d.message)) {
        return { category: 'invalid-input', code, confidence: 'medium', signals: [...signals, 'function name not found in the contract'] };
      }
      return { category: 'contract-execution', code, confidence: 'medium', signals };
    default:
      return { category: 'contract-execution', code, confidence: 'low', signals };
  }
}

/** Classify a failure. `d` comes from extractDiagnostics. */
export function classifyError(failure: InvocationFailure, d: Diagnostics): Classification {
  const { stage, source } = identifyStage(failure, d);
  const done = (category: Category, confidence: Confidence, signals: string[], code?: string): Classification => ({
    stage,
    stageSource: source,
    category,
    code,
    confidence,
    submissionStatus: submissionFor(stage, category, d),
    signals,
  });

  // 1. RPC send/get status: documented, structured.
  if (d.rpcStatus === 'PENDING' || d.rpcStatus === 'DUPLICATE') {
    return done('transaction-pending', 'high', [`sendTransaction status ${d.rpcStatus}: outcome is not final`], d.rpcStatus);
  }
  if (d.rpcStatus === 'NOT_FOUND') {
    return done('transaction-pending', 'high', ['getTransaction NOT_FOUND: not yet in a ledger, or expired/unknown; this is not a failure by itself'], 'NOT_FOUND');
  }
  if (d.rpcStatus === 'TRY_AGAIN_LATER') {
    return done('transaction-rejected', 'high', ['sendTransaction TRY_AGAIN_LATER: the node did not accept the transaction (queue full or fee too low for current load)'], 'TRY_AGAIN_LATER');
  }

  // 2. Transaction / operation result codes.
  const codes = fromTransactionCodes(d);
  if (codes) {
    // Operation-level host failures often come with a host error too; keep the more specific code.
    return done(codes.category, 'high', codes.signals, codes.code);
  }
  if (d.rpcStatus === 'ERROR' || d.rpcStatus === 'FAILED') {
    const hosted = fromHostError(d);
    if (hosted) return done(hosted.category, hosted.confidence, hosted.signals, hosted.code);
    return done('transaction-rejected', 'low', [`RPC status ${d.rpcStatus} without a readable result code`]);
  }

  // 3. Host error notation from simulation.
  const hosted = fromHostError(d);
  if (hosted) return done(hosted.category, hosted.confidence, hosted.signals, hosted.code);

  // 4. Connectivity.
  if (d.errorCode && NETWORK_CODES.has(d.errorCode)) {
    return done('network-connectivity', 'high', [`network error code ${d.errorCode}`], d.errorCode);
  }
  if (d.httpStatus && [429, 502, 503, 504].includes(d.httpStatus)) {
    return done('network-connectivity', 'high', [`HTTP ${d.httpStatus} from the RPC endpoint`], String(d.httpStatus));
  }
  if (d.httpStatus === 404) {
    return done('contract-not-found', 'low', ['HTTP 404 from the RPC endpoint: wrong endpoint path or missing resource']);
  }

  // 5. Free-form text, lowest confidence.
  const text = d.message;
  if (/contract not found|no such contract|contract.*does not exist/i.test(text)) {
    return done('contract-not-found', 'medium', ['message says the contract does not exist']);
  }
  if (/exceeded|resource limit|budget|cpu instructions|memory limit|footprint/i.test(text) && /limit|exceed/i.test(text)) {
    return done('resource-limit', 'low', ['message mentions an exceeded limit']);
  }
  if (/insufficient (fee|balance)|bad_seq|bad sequence|tx_too_late|expired|fee/i.test(text) && /insufficient|bad|expire|too late|too low/i.test(text)) {
    return done('fee-or-configuration', 'low', ['message mentions a fee or transaction setting']);
  }
  if (/unauthori[sz]ed|require_auth|not authorized|invalid signature|bad auth/i.test(text)) {
    return done('authorization', 'low', ['message mentions authorization']);
  }
  if (/invalid (address|contract id|argument|input|amount)|checksum|version byte|malformed|expected .* to be/i.test(text)) {
    return done('invalid-input', 'low', ['message mentions invalid input']);
  }
  if (NETWORK_TEXT.test(text)) {
    return done('network-connectivity', 'low', ['message mentions a network problem']);
  }

  // Input validation errors raised by the caller before anything was sent.
  if (stage === 'input-validation') return done('invalid-input', 'medium', ['failed during input validation']);

  return done('unknown', 'none', ['no known code or pattern matched; the original error is preserved for inspection']);
}
