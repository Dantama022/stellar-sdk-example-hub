/**
 * 265 — Soroban authorization footprint and credential expiration auditor (issue #601).
 *
 * Simulates a contract invocation (or takes authorization entries you already
 * have), decodes every SorobanAuthorizationEntry with the SDK, and reports:
 *   - credential type and the address that must authorize,
 *   - the authorized invocation tree (contract + function, nested calls),
 *   - differences from an expected footprint (contracts, functions, paths),
 *   - expiration, only where the credential type carries it.
 *
 * Checks here are structural. The auditor never signs or submits, never
 * verifies signatures (that needs the signer's key and the network-bound
 * payload), and never prints argument values or signature bytes.
 *
 * Expiration models differ by credential type:
 *   - Address credentials carry `signatureExpirationLedger` (0 = not set yet,
 *     the signer chooses it when signing).
 *   - Source-account credentials carry no expiry: they are covered by the
 *     transaction signature, so validity follows the transaction's time bounds
 *     and sequence number, which this auditor reports as "not available locally".
 */
import dotenv from 'dotenv';
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  nativeToScVal,
  rpc,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { resolveNetworkConfiguration } from './60-network-configuration';

// ── Types ────────────────────────────────────────────────────────────────────

export type Severity = 'fail' | 'warn' | 'info';

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  entry?: number;
}

export interface InvocationNode {
  kind: 'contract-call' | 'create-contract';
  contract?: string;
  function?: string;
  argCount?: number;
  children: InvocationNode[];
}

export interface AuthEntrySummary {
  index: number;
  credentialType: 'source-account' | 'address';
  /** Address that must authorize (the transaction source for source-account credentials). */
  authorizer: string;
  authorizerKind: 'account' | 'contract';
  signature: 'not-applicable' | 'absent' | 'present-unverified';
  expiration:
    | { model: 'transaction-bound' }
    | {
        model: 'ledger';
        expirationLedger: number;
        status: 'unset' | 'expired' | 'expiring-soon' | 'valid';
        ledgersRemaining?: number;
      };
  invocation: InvocationNode;
  paths: string[];
}

export interface AuditRules {
  /** Contracts allowed to appear anywhere in authorization trees. */
  expectedContracts?: string[];
  /** Function names allowed anywhere in authorization trees. */
  expectedFunctions?: string[];
  /** Exact root-to-leaf paths allowed, e.g. ["C...:swap > C...:transfer"]. */
  expectedPaths?: string[];
  /** Warn when fewer than this many ledgers remain before expiration (default 100, ~8 minutes). */
  expirationWarningLedgers?: number;
  /** Treat unexpected authorization requirements as failures instead of warnings. */
  strict?: boolean;
}

export interface AuthorizationAuditReport {
  network: string;
  sourceAccount: string;
  contractId: string;
  currentLedger: number | null;
  entryCount: number;
  credentialTypes: string[];
  entries: AuthEntrySummary[];
  invocationPaths: string[];
  unexpected: string[];
  findings: Finding[];
  status: 'pass' | 'pass-with-warnings' | 'fail';
}

export interface AuditContext {
  network: string;
  sourceAccount: string;
  contractId: string;
  currentLedger: number | null;
}

// ── 1. Prepare and simulate ──────────────────────────────────────────────────

/** The RPC calls needed to prepare the transaction; `rpc.Server` satisfies this. */
export interface AuthRpc {
  getAccount(accountId: string): Promise<Account>;
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
}

export interface InvocationConfig {
  sourceAccount: string;
  contractId: string;
  method: string;
  args?: xdr.ScVal[];
  networkPassphrase: string;
}

export async function simulateForAuthorization(
  server: AuthRpc,
  config: InvocationConfig,
): Promise<{ auth: xdr.SorobanAuthorizationEntry[]; latestLedger: number } | { error: string }> {
  const account = await server.getAccount(config.sourceAccount);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(new Contract(config.contractId).call(config.method, ...(config.args ?? [])))
    .setTimeout(300)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return { error: sim.error.split('\n')[0] };
  return { auth: sim.result?.auth ?? [], latestLedger: sim.latestLedger };
}

// ── 2. Inspect entry structure ───────────────────────────────────────────────

function addressString(scAddress: xdr.ScAddress): string {
  return Address.fromScAddress(scAddress).toString();
}

export function invocationTree(invocation: xdr.SorobanAuthorizedInvocation): InvocationNode {
  const fn = invocation.function();
  const children = invocation.subInvocations().map(invocationTree);
  if (fn.switch().name === 'sorobanAuthorizedFunctionTypeContractFn') {
    const call = fn.contractFn();
    return {
      kind: 'contract-call',
      contract: addressString(call.contractAddress()),
      function: call.functionName().toString(),
      argCount: call.args().length,
      children,
    };
  }
  return { kind: 'create-contract', children };
}

function nodeLabel(node: InvocationNode): string {
  return node.kind === 'contract-call' ? `${node.contract}:${node.function}` : 'create-contract';
}

/** Every root-to-leaf path as "C...:fn > C...:fn". */
export function invocationPaths(node: InvocationNode, prefix = ''): string[] {
  const label = prefix ? `${prefix} > ${nodeLabel(node)}` : nodeLabel(node);
  return node.children.length
    ? node.children.flatMap((child) => invocationPaths(child, label))
    : [label];
}

function walk(node: InvocationNode, visit: (n: InvocationNode) => void): void {
  visit(node);
  node.children.forEach((child) => walk(child, visit));
}

export function summarizeEntry(
  entry: xdr.SorobanAuthorizationEntry,
  index: number,
  context: AuditContext,
  warningLedgers: number,
): AuthEntrySummary {
  const credentials = entry.credentials();
  const invocation = invocationTree(entry.rootInvocation());
  const paths = invocationPaths(invocation);
  if (credentials.switch().name === 'sorobanCredentialsSourceAccount') {
    return {
      index,
      credentialType: 'source-account',
      authorizer: context.sourceAccount,
      authorizerKind: 'account',
      signature: 'not-applicable',
      expiration: { model: 'transaction-bound' },
      invocation,
      paths,
    };
  }
  const address = credentials.address();
  const authorizer = addressString(address.address());
  const expirationLedger = address.signatureExpirationLedger();
  let status: 'unset' | 'expired' | 'expiring-soon' | 'valid' = 'unset';
  let ledgersRemaining: number | undefined;
  if (expirationLedger !== 0 && context.currentLedger !== null) {
    ledgersRemaining = expirationLedger - context.currentLedger;
    status =
      ledgersRemaining <= 0
        ? 'expired'
        : ledgersRemaining < warningLedgers
          ? 'expiring-soon'
          : 'valid';
  }
  return {
    index,
    credentialType: 'address',
    authorizer,
    authorizerKind: StrKey.isValidContract(authorizer) ? 'contract' : 'account',
    signature: address.signature().switch().name === 'scvVoid' ? 'absent' : 'present-unverified',
    expiration: {
      model: 'ledger',
      expirationLedger,
      status,
      ...(ledgersRemaining !== undefined ? { ledgersRemaining } : {}),
    },
    invocation,
    paths,
  };
}

/** Decode base64 entries (e.g. from a prepared transaction), reporting malformed ones. */
export function decodeAuthEntries(base64: string[]): {
  entries: xdr.SorobanAuthorizationEntry[];
  findings: Finding[];
} {
  const entries: xdr.SorobanAuthorizationEntry[] = [];
  const findings: Finding[] = [];
  base64.forEach((value, index) => {
    try {
      entries.push(xdr.SorobanAuthorizationEntry.fromXDR(value, 'base64'));
    } catch {
      findings.push({
        severity: 'fail',
        code: 'malformed-auth-xdr',
        message: `Authorization entry ${index} is not a valid SorobanAuthorizationEntry`,
        entry: index,
      });
    }
  });
  return { entries, findings };
}

// ── 3–4. Footprint and expiration analysis ───────────────────────────────────

export function auditAuthorizationEntries(
  entries: xdr.SorobanAuthorizationEntry[],
  context: AuditContext,
  rules: AuditRules = {},
  initialFindings: Finding[] = [],
): AuthorizationAuditReport {
  const warningLedgers = rules.expirationWarningLedgers ?? 100;
  const mismatch: Severity = rules.strict ? 'fail' : 'warn';
  const findings = [...initialFindings];
  const summaries = entries.map((entry, i) => summarizeEntry(entry, i, context, warningLedgers));
  const unexpected = new Set<string>();

  if (!summaries.length) {
    findings.push({
      severity: 'info',
      code: 'no-authorization',
      message: 'The invocation requires no authorization entries',
    });
  }
  const hasRules = Boolean(
    rules.expectedContracts || rules.expectedFunctions || rules.expectedPaths,
  );
  if (!hasRules) {
    findings.push({
      severity: rules.strict ? 'fail' : 'info',
      code: 'no-expected-footprint',
      message: 'No expected contracts, functions or paths configured; footprint comparison skipped',
    });
  }

  const seenRoots = new Map<string, number>();
  for (const s of summaries) {
    // Repeated identical requirement for the same authorizer.
    const rootKey = `${s.authorizer}|${s.paths.join('|')}`;
    if (seenRoots.has(rootKey)) {
      findings.push({
        severity: 'warn',
        code: 'repeated-authorization',
        message: `Entry ${s.index} repeats entry ${seenRoots.get(rootKey)} for ${s.authorizer}`,
        entry: s.index,
      });
    } else {
      seenRoots.set(rootKey, s.index);
    }

    walk(s.invocation, (node) => {
      if (node.kind === 'create-contract') {
        findings.push({
          severity: mismatch,
          code: 'create-contract-auth',
          message: `Entry ${s.index} authorizes contract creation`,
          entry: s.index,
        });
        return;
      }
      if (rules.expectedContracts && !rules.expectedContracts.includes(node.contract!)) {
        unexpected.add(nodeLabel(node));
        findings.push({
          severity: mismatch,
          code: 'unexpected-contract',
          message: `Entry ${s.index} authorizes calls to unexpected contract ${node.contract}`,
          entry: s.index,
        });
      }
      if (rules.expectedFunctions && !rules.expectedFunctions.includes(node.function!)) {
        unexpected.add(nodeLabel(node));
        findings.push({
          severity: mismatch,
          code: 'unexpected-function',
          message: `Entry ${s.index} authorizes unexpected function ${node.function} on ${node.contract}`,
          entry: s.index,
        });
      }
    });
    if (rules.expectedPaths) {
      for (const p of s.paths) {
        if (!rules.expectedPaths.includes(p)) {
          unexpected.add(p);
          findings.push({
            severity: mismatch,
            code: 'unexpected-path',
            message: `Entry ${s.index} has an unexpected invocation path: ${p}`,
            entry: s.index,
          });
        }
      }
    }

    // Expiration (only where the credential carries it)
    if (s.expiration.model === 'transaction-bound') {
      findings.push({
        severity: 'info',
        code: 'expiration-unavailable',
        message: `Entry ${s.index} uses source-account credentials: validity follows the transaction's time bounds and sequence, not an entry field`,
        entry: s.index,
      });
    } else if (s.expiration.status === 'unset') {
      findings.push({
        severity: 'info',
        code: s.expiration.expirationLedger === 0 ? 'expiration-unset' : 'expiration-unknown',
        message:
          s.expiration.expirationLedger === 0
            ? `Entry ${s.index}: ${s.authorizer} has not signed yet; the expiration ledger is chosen at signing`
            : `Entry ${s.index}: current ledger unknown, cannot evaluate expiration ledger ${s.expiration.expirationLedger}`,
        entry: s.index,
      });
    } else if (s.expiration.status === 'expired') {
      findings.push({
        severity: 'fail',
        code: 'expired-authorization',
        message: `Entry ${s.index}: signature expired at ledger ${s.expiration.expirationLedger}`,
        entry: s.index,
      });
    } else if (s.expiration.status === 'expiring-soon') {
      findings.push({
        severity: 'warn',
        code: 'expiring-authorization',
        message: `Entry ${s.index}: signature expires in ${s.expiration.ledgersRemaining} ledger(s)`,
        entry: s.index,
      });
    }

    // What cannot be established locally
    if (s.signature === 'present-unverified') {
      findings.push({
        severity: 'info',
        code: 'signature-unverified',
        message: `Entry ${s.index}: a signature is present but not cryptographically verified here`,
        entry: s.index,
      });
    }
    if (s.authorizerKind === 'contract') {
      findings.push({
        severity: 'info',
        code: 'contract-credential',
        message: `Entry ${s.index}: ${s.authorizer} is a contract; its __check_auth logic decides validity and cannot be evaluated locally`,
        entry: s.index,
      });
    }
  }

  const status = findings.some((f) => f.severity === 'fail')
    ? 'fail'
    : findings.some((f) => f.severity === 'warn')
      ? 'pass-with-warnings'
      : 'pass';
  return {
    ...context,
    entryCount: summaries.length,
    credentialTypes: [
      ...new Set(
        summaries.map((s) =>
          s.credentialType === 'address' ? `address:${s.authorizerKind}` : 'source-account',
        ),
      ),
    ],
    entries: summaries,
    invocationPaths: [...new Set(summaries.flatMap((s) => s.paths))],
    unexpected: [...unexpected],
    findings,
    status,
  };
}

/** Simulate, then audit. A failed simulation becomes a failed audit. */
export async function runAuthorizationAudit(
  server: AuthRpc,
  config: InvocationConfig,
  rules: AuditRules = {},
): Promise<AuthorizationAuditReport> {
  const context: AuditContext = {
    network: config.networkPassphrase,
    sourceAccount: config.sourceAccount,
    contractId: config.contractId,
    currentLedger: null,
  };
  if (!StrKey.isValidContract(config.contractId)) {
    return auditAuthorizationEntries([], context, rules, [
      {
        severity: 'fail',
        code: 'invalid-contract-id',
        message: 'contractId is not a valid C... address',
      },
    ]);
  }
  let simulated;
  try {
    simulated = await simulateForAuthorization(server, config);
  } catch (error) {
    simulated = { error: (error as Error).message };
  }
  if ('error' in simulated) {
    const report = auditAuthorizationEntries([], context, rules, [
      {
        severity: 'fail',
        code: 'simulation-failed',
        message: `Simulation failed: ${simulated.error}`,
      },
    ]);
    return { ...report, findings: report.findings.filter((f) => f.code !== 'no-authorization') };
  }
  return auditAuthorizationEntries(
    simulated.auth,
    { ...context, currentLedger: simulated.latestLedger },
    rules,
  );
}

// ── 5. Reporting ─────────────────────────────────────────────────────────────

export function formatReport(r: AuthorizationAuditReport): string {
  const lines = [
    `Authorization audit: ${r.status.toUpperCase()}`,
    `  Network:          ${r.network}`,
    `  Source account:   ${r.sourceAccount}`,
    `  Contract:         ${r.contractId}`,
    `  Current ledger:   ${r.currentLedger ?? 'unknown'}`,
    `  Auth entries:     ${r.entryCount}`,
    `  Credential types: ${r.credentialTypes.join(', ') || 'none'}`,
  ];
  for (const e of r.entries) {
    const exp =
      e.expiration.model === 'transaction-bound'
        ? 'transaction-bound'
        : `ledger ${e.expiration.expirationLedger} (${e.expiration.status})`;
    lines.push(
      `  [${e.index}] ${e.credentialType} by ${e.authorizer} (${e.authorizerKind}); signature ${e.signature}; expiration ${exp}`,
    );
    for (const p of e.paths) lines.push(`      ${p}`);
  }
  lines.push(`  Unexpected:       ${r.unexpected.join(', ') || 'none'}`, '  Findings:');
  for (const f of r.findings)
    lines.push(`    [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
  lines.push('  Structural checks only: nothing was signed, verified or submitted.');
  return lines.join('\n');
}

// ── Runner entry point ───────────────────────────────────────────────────────

const list = (value?: string) =>
  value
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

export async function run(
  params: { contractId?: string; method?: string; sourceAccount?: string; args?: string } = {},
): Promise<void> {
  const config = resolveNetworkConfiguration();
  const server = new rpc.Server(config.sorobanRpcUrl, {
    allowHttp: config.sorobanRpcUrl.startsWith('http://'),
  });
  const rawArgs = params.args ?? process.env.ARGS_JSON;
  const report = await runAuthorizationAudit(
    server,
    {
      sourceAccount: params.sourceAccount || process.env.SOURCE_ACCOUNT || '',
      contractId: params.contractId || process.env.CONTRACT_ID || '',
      method: params.method || process.env.METHOD || '',
      // ARGS_JSON: JSON array of native values, converted with nativeToScVal.
      args: rawArgs ? (JSON.parse(rawArgs) as unknown[]).map((v) => nativeToScVal(v)) : [],
      networkPassphrase: config.networkPassphrase,
    },
    {
      expectedContracts: list(process.env.EXPECTED_CONTRACTS),
      expectedFunctions: list(process.env.EXPECTED_FUNCTIONS),
      expectedPaths: list(process.env.EXPECTED_PATHS),
      expirationWarningLedgers: process.env.EXPIRY_WARNING_LEDGERS
        ? Number(process.env.EXPIRY_WARNING_LEDGERS)
        : undefined,
      strict: process.env.STRICT === '1',
    },
  );
  console.log(process.env.JSON === '1' ? JSON.stringify(report, null, 2) : formatReport(report));
  if (report.status === 'fail') process.exitCode = 1;
}

if (require.main === module) {
  dotenv.config();
  run().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
