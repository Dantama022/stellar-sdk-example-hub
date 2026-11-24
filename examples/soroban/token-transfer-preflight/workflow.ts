/**
 * Orchestrates the stages in order, keeping them separate:
 *
 *   validate -> build -> simulate -> authorize entries -> (re-simulate) -> assemble
 *            -> sign envelope -> preflight -> submit (only if preflight passed)
 *
 * Stage failures never abort silently: they are captured, the preflight report is produced from
 * whatever exists, and nothing is submitted.
 */
import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { AuthRequirement, AuthSigner, inspectAuthEntries, signAuthEntries } from './authorization';
import { PreflightInput, runPreflight } from './preflight';
import { TransferRpcClient, rpcCall } from './rpc';
import {
  SimulationSummary,
  assembleSimulatedTransaction,
  simulateTransfer,
} from './simulation';
import { SubmitOptions, submitTransaction } from './submit';
import {
  TransferConfig,
  TransferRequest,
  buildTransferTransaction,
  validateTransferRequest,
} from './transfer';
import { PreflightReport, SubmissionResult, TransferError, TransferErrorCode } from './types';

export interface WorkflowDeps {
  client: TransferRpcClient;
  /** Signs Soroban authorization entries for the sender. Not needed when sender == source. */
  authSigner?: AuthSigner;
  /** Signs the transaction envelope as the source account. */
  envelopeSigner?: Keypair;
  /** Total fee ceiling in stroops. Default 10_000_000 (1 XLM). */
  maxFeeStroops?: bigint;
  /** How many ledgers a signed authorization stays valid (~5 s per ledger). Default 100. */
  authValidityLedgers?: number;
  submit?: SubmitOptions;
}

export interface TransferOutcome {
  config: TransferConfig;
  report: PreflightReport;
  /** Final transaction as base64 XDR, when one was built. */
  transactionXdr?: string;
  /** Set when submission was attempted. Absent for dry runs and failed preflights. */
  submission?: SubmissionResult;
  /** The first stage failure, if any. */
  error?: { code: TransferErrorCode; message: string };
  authRequirements?: AuthRequirement[];
}

/**
 * Run the full workflow. `submit: false` stops after the preflight report (a dry run).
 * Throws only for invalid input; every later failure is reported in the outcome.
 */
export async function executeTransfer(
  request: TransferRequest,
  deps: WorkflowDeps,
  options: { submit: boolean }
): Promise<TransferOutcome> {
  const config = validateTransferRequest(request);
  const { client } = deps;

  const input: PreflightInput = {
    config,
    maxFeeStroops: deps.maxFeeStroops ?? 10_000_000n,
  };
  let error: TransferOutcome['error'];
  let final: Transaction | undefined;

  try {
    // Network: confirm the endpoint is the network the caller selected, before any other call.
    input.rpcPassphrase = (await rpcCall(() => deps.client.getNetwork())).passphrase;
    if (input.rpcPassphrase !== config.networkPassphrase) {
      throw new TransferError(
        'PREFLIGHT_FAILED',
        `RPC endpoint is on a different network than "${config.network}".`
      );
    }
    input.latestLedger = (await rpcCall(() => client.getLatestLedger())).sequence;
    const sequence = await rpcCall(() => client.getSequence(config.source));

    // Build (unsigned) and simulate.
    const raw = buildTransferTransaction(config, sequence);
    let simulation: SimulationSummary;
    try {
      simulation = await simulateTransfer(client, raw);
    } catch (e) {
      input.simulationError = (e as Error).message;
      throw e;
    }

    // Authorization: inspect, then sign only what belongs to the sender and matches the transfer.
    const signedEntries = await signAuthEntries(
      simulation.authEntries,
      config,
      deps.authSigner,
      input.latestLedger + (deps.authValidityLedgers ?? 100)
    );
    input.authRequirements = inspectAuthEntries(signedEntries, config);

    // Signed address credentials make the call more expensive than the recording-mode simulation
    // measured, so simulate again with the signed entries attached. This also rejects bad signatures.
    const hasAddressAuth = input.authRequirements.some((r) => r.kind === 'address');
    let prepared = raw;
    if (hasAddressAuth) {
      prepared = buildTransferTransaction(config, sequence, signedEntries);
      try {
        simulation = await simulateTransfer(client, prepared);
      } catch (e) {
        input.simulationError = (e as Error).message;
        throw e;
      }
    }
    input.simulation = simulation;

    // Assemble (footprint + resource fee), then sign the ENVELOPE. A different signature
    // from the authorization signatures above.
    final = assembleSimulatedTransaction(prepared, simulation);
    if (deps.envelopeSigner) final.sign(deps.envelopeSigner);
    input.transaction = final;
  } catch (e) {
    if (!(e instanceof TransferError)) throw e;
    error = { code: e.code, message: e.message };
  }

  const report = runPreflight(input);
  const outcome: TransferOutcome = {
    config,
    report,
    transactionXdr: final?.toXDR(),
    error,
    authRequirements: input.authRequirements,
  };

  if (!report.ok || error || !options.submit || !final) return outcome;
  outcome.submission = await submitTransaction(client, final, report, deps.submit);
  return outcome;
}
