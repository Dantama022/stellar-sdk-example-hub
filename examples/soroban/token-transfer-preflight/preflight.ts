/**
 * Step 5: preflight validation.
 *
 * Runs every safety check against the FINAL transaction (assembled and envelope-signed) and
 * returns a structured report. It never throws and never submits: the caller must refuse to
 * submit unless `report.ok` is true.
 */
import { Address, BASE_FEE, Keypair, StrKey, Transaction, scValToNative } from '@stellar/stellar-sdk';
import { AuthRequirement } from './authorization';
import { SimulationSummary } from './simulation';
import { TransferConfig } from './transfer';
import { PreflightCheck, PreflightReport } from './types';

export interface PreflightInput {
  config: TransferConfig;
  /** Passphrase reported by the RPC endpoint we are about to talk to. */
  rpcPassphrase?: string;
  latestLedger?: number;
  /** The transaction that would be submitted. Absent when an earlier stage failed. */
  transaction?: Transaction;
  simulation?: SimulationSummary;
  /** Why simulation failed, when it did. */
  simulationError?: string;
  authRequirements?: AuthRequirement[];
  /** Upper bound on the total fee (stroops) you are willing to pay. */
  maxFeeStroops: bigint;
}

const check = (id: string, description: string, passed: boolean, detail: string): PreflightCheck => ({
  id,
  description,
  passed,
  detail,
});

/** Decode what the transaction ACTUALLY invokes, independent of the config used to build it. */
function decodeInvocation(tx: Transaction):
  | { token: string; fn: string; from: string; to: string; amount: bigint }
  | { error: string } {
  if (tx.operations.length !== 1 || tx.operations[0].type !== 'invokeHostFunction') {
    return { error: 'transaction must contain exactly one invokeHostFunction operation' };
  }
  const func = (tx.operations[0] as { func: import('@stellar/stellar-sdk').xdr.HostFunction }).func;
  if (func.switch().name !== 'hostFunctionTypeInvokeContract') {
    return { error: 'host function is not a contract invocation' };
  }
  const call = func.invokeContract();
  const args = call.args();
  if (args.length !== 3) return { error: `expected 3 arguments, found ${args.length}` };
  try {
    return {
      token: Address.fromScAddress(call.contractAddress()).toString(),
      fn: call.functionName().toString(),
      from: Address.fromScVal(args[0]).toString(),
      to: Address.fromScVal(args[1]).toString(),
      amount: scValToNative(args[2]) as bigint,
    };
  } catch (e) {
    return { error: `arguments could not be decoded: ${(e as Error).message}` };
  }
}

export function runPreflight(input: PreflightInput): PreflightReport {
  const { config: cfg, transaction: tx, simulation: sim } = input;
  const checks: PreflightCheck[] = [];

  // 1. Network
  const networkOk =
    input.rpcPassphrase === cfg.networkPassphrase &&
    (tx === undefined || tx.networkPassphrase === cfg.networkPassphrase);
  checks.push(
    check(
      'network',
      'Transaction and RPC target the selected network',
      networkOk,
      networkOk
        ? `Both use the ${cfg.network} passphrase`
        : `Expected "${cfg.networkPassphrase}"; RPC reports "${input.rpcPassphrase ?? 'unknown'}"` +
            (tx ? `, transaction uses "${tx.networkPassphrase}"` : '')
    )
  );

  // 2-4. Addresses
  const senderOk = StrKey.isValidEd25519PublicKey(cfg.sender) || StrKey.isValidContract(cfg.sender);
  checks.push(check('sender', 'Sender address is valid', senderOk, cfg.sender));
  const recipientOk =
    StrKey.isValidEd25519PublicKey(cfg.recipient) || StrKey.isValidContract(cfg.recipient);
  checks.push(check('recipient', 'Recipient address is valid', recipientOk, cfg.recipient));
  const tokenOk = StrKey.isValidContract(cfg.token);
  checks.push(check('token', 'Token contract address is valid', tokenOk, cfg.token));

  // 5. Amount and encoding: compare the decoded transaction with the request
  if (!tx) {
    checks.push(check('amount', 'Transfer amount is positive and encoded as requested', false, 'no transaction was built'));
  } else {
    const decoded = decodeInvocation(tx);
    if ('error' in decoded) {
      checks.push(check('amount', 'Transfer amount is positive and encoded as requested', false, decoded.error));
    } else {
      const ok =
        cfg.amount > 0n &&
        decoded.amount === cfg.amount &&
        decoded.token === cfg.token &&
        decoded.fn === 'transfer' &&
        decoded.from === cfg.sender &&
        decoded.to === cfg.recipient;
      checks.push(
        check(
          'amount',
          'Transfer amount is positive and encoded as requested',
          ok,
          ok
            ? `transfer(${decoded.from}, ${decoded.to}, ${decoded.amount}) on ${decoded.token}`
            : `transaction encodes ${decoded.fn}(${decoded.from}, ${decoded.to}, ${decoded.amount}) on ${decoded.token}, which differs from the request`
        )
      );
    }
  }

  // 6. Simulation
  checks.push(
    check(
      'simulation',
      'Simulation completed successfully',
      sim !== undefined,
      sim ? `min resource fee ${sim.minResourceFee} stroops` : (input.simulationError ?? 'not run')
    )
  );

  // 7. Authorization
  const reqs = input.authRequirements;
  if (!reqs) {
    checks.push(check('authorization', 'Required authorization has been provided', false, 'authorization was not inspected'));
  } else {
    const problems: string[] = [];
    for (const r of reqs) {
      const who = r.address ?? 'source account';
      if (!r.matchesTransfer) problems.push(`${who}: entry ${r.problem ?? 'does not match the transfer'}`);
      if (r.subInvocations > 0) problems.push(`${who}: entry authorizes ${r.subInvocations} nested call(s)`);
      if (r.kind === 'address' && !r.signed) problems.push(`${who}: authorization is unsigned`);
      if (
        r.kind === 'address' &&
        r.expiresAtLedger !== undefined &&
        input.latestLedger !== undefined &&
        r.expiresAtLedger <= input.latestLedger
      ) {
        problems.push(`${who}: authorization expired at ledger ${r.expiresAtLedger}`);
      }
    }
    // `from.require_auth()` must be satisfied by one of the entries.
    const covered = reqs.some(
      (r) =>
        r.matchesTransfer &&
        (r.kind === 'address' ? r.address === cfg.sender && r.signed : cfg.source === cfg.sender)
    );
    if (!covered) {
      problems.push(`no entry authorizes the sender ${cfg.sender}`);
    }
    checks.push(
      check(
        'authorization',
        'Required authorization has been provided',
        problems.length === 0,
        problems.length === 0
          ? `${reqs.length} entr${reqs.length === 1 ? 'y' : 'ies'} verified`
          : problems.join('; ')
      )
    );
  }

  // 8. Envelope signature (separate from authorization-entry signatures)
  if (!tx) {
    checks.push(check('envelope-signature', 'Transaction envelope is signed by the source account', false, 'no transaction was built'));
  } else {
    let valid = false;
    try {
      valid =
        tx.signatures.length > 0 &&
        tx.signatures.some((s) => Keypair.fromPublicKey(cfg.source).verify(tx.hash(), s.signature()));
    } catch {
      valid = false;
    }
    checks.push(
      check(
        'envelope-signature',
        'Transaction envelope is signed by the source account',
        valid,
        valid ? `valid signature from ${cfg.source}` : `no valid signature from ${cfg.source}`
      )
    );
  }

  // 9. Resources and fee
  if (!tx || !sim) {
    checks.push(check('resources-and-fee', 'Resources and fee are configured within limits', false, 'requires a built transaction and a successful simulation'));
  } else {
    const fee = BigInt(tx.fee);
    const required = BigInt(BASE_FEE) + sim.minResourceFee;
    const hasSorobanData = tx.toEnvelope().v1().tx().ext().switch() === 1;
    const problems: string[] = [];
    if (!hasSorobanData) problems.push('transaction has no Soroban resource data');
    if (fee < required) problems.push(`fee ${fee} is below the required ${required}`);
    if (fee > input.maxFeeStroops) problems.push(`fee ${fee} exceeds your limit of ${input.maxFeeStroops}`);
    if (sim.resources.instructions <= 0) problems.push('simulation reported no CPU instructions');
    checks.push(
      check(
        'resources-and-fee',
        'Resources and fee are configured within limits',
        problems.length === 0,
        problems.length === 0
          ? `fee ${fee} stroops (limit ${input.maxFeeStroops}); ${sim.resources.instructions} instructions, ${sim.resources.readBytes} B read, ${sim.resources.writeBytes} B write`
          : problems.join('; ')
      )
    );
  }

  return { ok: checks.every((c) => c.passed), checks };
}

export function formatReport(report: PreflightReport): string {
  const lines = report.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'}  ${c.description}\n      ${c.detail}`);
  return [...lines, report.ok ? 'Preflight: OK' : 'Preflight: FAILED - not submitting'].join('\n');
}
