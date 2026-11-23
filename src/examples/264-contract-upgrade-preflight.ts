/**
 * 264 — Soroban contract upgrade authorization and WASM replacement preflight (issue #600).
 *
 * Audits a proposed contract upgrade before anyone signs it:
 *   1. inspect the deployed contract (instance entry → current WASM hash and spec),
 *   2. validate the replacement WASM (readable, valid module, SHA-256, contract spec),
 *   3. find the contract's own upgrade entry point from its spec,
 *   4. build the upgrade invocation,
 *   5. simulate it and read who must authorize it,
 * and reports readiness. It never submits a transaction and never logs
 * authorization payloads or secret keys.
 *
 * Nothing about upgrades is universal: there is no standard `upgrade` function
 * name or admin storage key. The entry point is taken from the contract's spec
 * (or a name you supply, verified against the spec), and the authorizer is
 * taken from the simulation's auth entries. Anything that could not be
 * verified is reported as such.
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import dotenv from 'dotenv';
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  rpc,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { resolveTypeName, specFromWasm } from '../utils/spec-parser';
import { resolveNetworkConfiguration } from './60-network-configuration';

// ── Types ────────────────────────────────────────────────────────────────────

export type Severity = 'high' | 'medium' | 'info';

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
}

/** The RPC calls the preflight needs; `rpc.Server` satisfies this. */
export interface PreflightRpc {
  getNetwork(): Promise<{ passphrase: string }>;
  getLedgerEntries(
    ...keys: xdr.LedgerKey[]
  ): Promise<{ entries: Array<{ val: xdr.LedgerEntryData }> }>;
  getContractWasmByHash(hash: Buffer): Promise<Buffer>;
  getAccount(accountId: string): Promise<Account>;
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
}

export interface PreflightOptions {
  contractId: string;
  replacementWasmPath: string;
  /** Network the operator intends to upgrade on. */
  networkPassphrase: string;
  /** Account that would submit the upgrade (used as the simulation source). */
  sourceAccount: string;
  /** Contract-specific upgrade function; verified against the deployed contract's spec. */
  upgradeFunction?: string;
  /** Admin you expect to authorize upgrades (from the contract's source or docs). */
  expectedAdmin?: string;
  /** Hex SHA-256 the replacement artifact must have (e.g. from a release). */
  expectedReplacementHash?: string;
  /** Values for upgrade-function inputs other than the 32-byte WASM hash. */
  extraArgs?: Record<string, xdr.ScVal>;
}

export interface PreflightReport {
  contractId: string;
  network: { passphrase: string; rpcPassphrase: string | null; matches: boolean };
  currentWasmHash: string | null;
  currentSpecAvailable: boolean;
  replacement: {
    path: string;
    sha256: string | null;
    validWasm: boolean;
    specAvailable: boolean;
    installedOnLedger: boolean | null;
  };
  entryPoint: {
    name: string | null;
    source: 'verified-in-spec' | 'inferred-from-spec' | 'unverified' | 'not-found';
  };
  authorization: {
    mechanism: string;
    observedAuthorizers: string[];
    expectedAdmin: string | null;
    verified: boolean;
  };
  simulation: {
    attempted: boolean;
    succeeded: boolean;
    error?: string;
    minResourceFee?: string;
    instructions?: number;
    readBytes?: number;
    writeBytes?: number;
    restoreRequired?: boolean;
  };
  findings: Finding[];
  readiness: 'ready' | 'ready-with-warnings' | 'blocked';
}

// ── 1. Contract inspection ───────────────────────────────────────────────────

function instanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

function codeKey(hash: Buffer): xdr.LedgerKey {
  return xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash }));
}

/** Current WASM hash from the contract instance, or a reason it is unavailable. */
export async function inspectContract(
  server: PreflightRpc,
  contractId: string,
): Promise<{ wasmHash: Buffer } | { error: string; code: string }> {
  const { entries } = await server.getLedgerEntries(instanceKey(contractId));
  if (!entries.length)
    return {
      code: 'contract-unavailable',
      error: 'No contract instance found (wrong id, network, or archived)',
    };
  const executable = entries[0].val.contractData().val().instance().executable();
  if (executable.switch().name !== 'contractExecutableWasm') {
    return {
      code: 'not-wasm-contract',
      error: 'Contract is a built-in Stellar Asset Contract and has no replaceable WASM',
    };
  }
  return { wasmHash: executable.wasmHash() };
}

// ── 2. Replacement WASM validation ───────────────────────────────────────────

const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

export async function validateReplacementWasm(
  path: string,
  expectedHash?: string,
): Promise<{ bytes?: Buffer; sha256: string | null; valid: boolean; findings: Finding[] }> {
  const findings: Finding[] = [];
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    findings.push({
      severity: 'high',
      code: 'wasm-unreadable',
      message: `Cannot read ${path} (${code ?? 'error'})`,
    });
    return { sha256: null, valid: false, findings };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const valid =
    bytes.subarray(0, 8).equals(WASM_MAGIC) && WebAssembly.validate(new Uint8Array(bytes));
  if (!valid)
    findings.push({
      severity: 'high',
      code: 'invalid-wasm',
      message: 'Replacement is not a valid WebAssembly (v1) module',
    });
  if (expectedHash && expectedHash.toLowerCase() !== sha256) {
    findings.push({
      severity: 'high',
      code: 'hash-mismatch',
      message: `Replacement SHA-256 ${sha256} does not match the expected ${expectedHash}`,
    });
  }
  return { bytes, sha256, valid, findings };
}

// ── 3. Upgrade entry point ───────────────────────────────────────────────────

const HASH_TYPE = 'BytesN<32>';

type SpecLike = { funcs(): xdr.ScSpecFunctionV0[] };

function inputs(fn: xdr.ScSpecFunctionV0): Array<{ name: string; type: string }> {
  return fn
    .inputs()
    .map((input) => ({ name: input.name().toString(), type: resolveTypeName(input.type()) }));
}

/**
 * The upgrade entry point is contract-specific. With a name, check the spec has
 * it and that it takes a 32-byte hash. Without one, infer it only when exactly
 * one function takes a BytesN<32> argument.
 */
export function findUpgradeEntryPoint(
  spec: SpecLike | null,
  requested?: string,
): {
  fn?: xdr.ScSpecFunctionV0;
  name: string | null;
  source: PreflightReport['entryPoint']['source'];
  finding?: Finding;
} {
  if (!spec) {
    return requested
      ? {
          name: requested,
          source: 'unverified',
          finding: {
            severity: 'medium',
            code: 'entry-point-unverified',
            message: `Deployed contract has no readable spec; "${requested}" could not be verified`,
          },
        }
      : {
          name: null,
          source: 'not-found',
          finding: {
            severity: 'high',
            code: 'missing-entry-point',
            message: 'No contract spec and no upgrade function given',
          },
        };
  }
  const funcs = spec.funcs();
  if (requested) {
    const fn = funcs.find((f) => f.name().toString() === requested);
    if (!fn)
      return {
        name: requested,
        source: 'not-found',
        finding: {
          severity: 'high',
          code: 'missing-entry-point',
          message: `Contract has no function "${requested}"`,
        },
      };
    if (!inputs(fn).some((i) => i.type === HASH_TYPE)) {
      return {
        name: requested,
        source: 'not-found',
        finding: {
          severity: 'high',
          code: 'missing-entry-point',
          message: `"${requested}" takes no ${HASH_TYPE} WASM hash argument`,
        },
      };
    }
    return { fn, name: requested, source: 'verified-in-spec' };
  }
  const candidates = funcs.filter((f) => inputs(f).some((i) => i.type === HASH_TYPE));
  if (candidates.length === 1) {
    const name = candidates[0].name().toString();
    return {
      fn: candidates[0],
      name,
      source: 'inferred-from-spec',
      finding: {
        severity: 'medium',
        code: 'entry-point-inferred',
        message: `Assuming "${name}" is the upgrade function (only function taking a ${HASH_TYPE}); confirm in the contract source`,
      },
    };
  }
  return {
    name: null,
    source: 'not-found',
    finding: candidates.length
      ? {
          severity: 'high',
          code: 'ambiguous-entry-point',
          message: `Several functions take a ${HASH_TYPE} (${candidates.map((c) => c.name().toString()).join(', ')}); pass upgradeFunction`,
        }
      : {
          severity: 'high',
          code: 'missing-entry-point',
          message: 'Contract exposes no function taking a WASM hash; it may not be upgradable',
        },
  };
}

// ── 4. Transaction construction ──────────────────────────────────────────────

export function buildUpgradeInvocation(
  options: Pick<PreflightOptions, 'contractId' | 'networkPassphrase' | 'extraArgs'>,
  source: Account,
  entry: { name: string; fn?: xdr.ScSpecFunctionV0 },
  newWasmHash: Buffer,
): Transaction {
  const args = entry.fn
    ? inputs(entry.fn).map((input) => {
        if (input.type === HASH_TYPE) return xdr.ScVal.scvBytes(newWasmHash);
        const value = options.extraArgs?.[input.name];
        if (!value)
          throw new Error(
            `Upgrade function needs a value for "${input.name}" (${input.type}); pass it in extraArgs`,
          );
        return value;
      })
    : [xdr.ScVal.scvBytes(newWasmHash)];
  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: options.networkPassphrase,
  })
    .addOperation(new Contract(options.contractId).call(entry.name, ...args))
    .setTimeout(300)
    .build();
}

// ── 5. Simulation and authorization ──────────────────────────────────────────

/** Addresses that must authorize, read from simulated auth entries (never their payloads). */
export function authorizersFromSimulation(
  auth: xdr.SorobanAuthorizationEntry[],
  txSource: string,
): string[] {
  return auth.map((entry) => {
    const credentials = entry.credentials();
    return credentials.switch().name === 'sorobanCredentialsSourceAccount'
      ? txSource
      : Address.fromScAddress(credentials.address().address()).toString();
  });
}

// ── Orchestration ────────────────────────────────────────────────────────────

export async function runUpgradePreflight(
  server: PreflightRpc,
  options: PreflightOptions,
): Promise<PreflightReport> {
  const findings: Finding[] = [];
  const report: Omit<PreflightReport, 'readiness'> = {
    contractId: options.contractId,
    network: { passphrase: options.networkPassphrase, rpcPassphrase: null, matches: false },
    currentWasmHash: null,
    currentSpecAvailable: false,
    replacement: {
      path: options.replacementWasmPath,
      sha256: null,
      validWasm: false,
      specAvailable: false,
      installedOnLedger: null,
    },
    entryPoint: { name: options.upgradeFunction ?? null, source: 'not-found' },
    authorization: {
      mechanism: 'unknown (not simulated)',
      observedAuthorizers: [],
      expectedAdmin: options.expectedAdmin ?? null,
      verified: false,
    },
    simulation: { attempted: false, succeeded: false },
    findings,
  };
  const done = () => finalize(report);

  if (!StrKey.isValidContract(options.contractId)) {
    findings.push({
      severity: 'high',
      code: 'invalid-contract-id',
      message: 'contractId is not a valid C... address',
    });
    return done();
  }
  if (!StrKey.isValidEd25519PublicKey(options.sourceAccount)) {
    findings.push({
      severity: 'high',
      code: 'invalid-source',
      message: 'sourceAccount is not a valid G... account',
    });
    return done();
  }

  // Network
  try {
    report.network.rpcPassphrase = (await server.getNetwork()).passphrase;
  } catch (error) {
    findings.push({
      severity: 'high',
      code: 'rpc-unavailable',
      message: `Cannot reach Soroban RPC: ${(error as Error).message}`,
    });
    return done();
  }
  report.network.matches = report.network.rpcPassphrase === options.networkPassphrase;
  if (!report.network.matches) {
    findings.push({
      severity: 'high',
      code: 'network-mismatch',
      message: `RPC serves "${report.network.rpcPassphrase}", not "${options.networkPassphrase}"`,
    });
    return done();
  }

  // 1. Deployed contract
  let currentSpec: SpecLike | null = null;
  try {
    const inspected = await inspectContract(server, options.contractId);
    if ('error' in inspected) {
      findings.push({ severity: 'high', code: inspected.code, message: inspected.error });
      return done();
    }
    report.currentWasmHash = inspected.wasmHash.toString('hex');
    try {
      currentSpec = specFromWasm(await server.getContractWasmByHash(inspected.wasmHash));
    } catch {
      currentSpec = null;
    }
    report.currentSpecAvailable = currentSpec !== null;
    if (!currentSpec)
      findings.push({
        severity: 'medium',
        code: 'incomplete-metadata',
        message:
          'Deployed WASM or its contract spec is unavailable; entry point and arguments cannot be verified',
      });
  } catch (error) {
    findings.push({
      severity: 'high',
      code: 'rpc-unavailable',
      message: `Contract inspection failed: ${(error as Error).message}`,
    });
    return done();
  }

  // 2. Replacement WASM
  const replacement = await validateReplacementWasm(
    options.replacementWasmPath,
    options.expectedReplacementHash,
  );
  findings.push(...replacement.findings);
  report.replacement.sha256 = replacement.sha256;
  report.replacement.validWasm = replacement.valid;
  if (!replacement.valid || !replacement.bytes || !replacement.sha256) return done();
  const replacementSpec = specFromWasm(replacement.bytes);
  report.replacement.specAvailable = replacementSpec !== null;
  if (!replacementSpec)
    findings.push({
      severity: 'medium',
      code: 'replacement-no-spec',
      message: 'Replacement WASM has no contractspecv0 section',
    });
  if (replacement.sha256 === report.currentWasmHash) {
    findings.push({
      severity: 'medium',
      code: 'same-wasm',
      message: 'Replacement is identical to the deployed WASM; the upgrade is a no-op',
    });
  }
  const newHash = Buffer.from(replacement.sha256, 'hex');
  try {
    report.replacement.installedOnLedger =
      (await server.getLedgerEntries(codeKey(newHash))).entries.length > 0;
    if (!report.replacement.installedOnLedger) {
      findings.push({
        severity: 'high',
        code: 'wasm-not-installed',
        message:
          'Replacement WASM is not installed on-ledger; upload it (uploadContractWasm) before the upgrade can succeed',
      });
    }
  } catch {
    findings.push({
      severity: 'medium',
      code: 'install-check-failed',
      message: 'Could not check whether the replacement WASM is installed',
    });
  }

  // 3. Entry point (source of truth: the code that is deployed now)
  const entry = findUpgradeEntryPoint(currentSpec, options.upgradeFunction);
  report.entryPoint = { name: entry.name, source: entry.source };
  if (entry.finding) findings.push(entry.finding);
  if (!entry.name || entry.source === 'not-found') return done();
  if (replacementSpec && !replacementSpec.funcs().some((f) => f.name().toString() === entry.name)) {
    findings.push({
      severity: 'medium',
      code: 'upgrade-removed',
      message: `Replacement no longer exposes "${entry.name}"; the contract would become non-upgradable`,
    });
  }

  // 4–5. Build and simulate (never submitted)
  let tx: Transaction;
  try {
    tx = buildUpgradeInvocation(
      options,
      await server.getAccount(options.sourceAccount),
      { name: entry.name, fn: entry.fn },
      newHash,
    );
  } catch (error) {
    findings.push({ severity: 'high', code: 'build-failed', message: (error as Error).message });
    return done();
  }
  report.simulation.attempted = true;
  let sim: rpc.Api.SimulateTransactionResponse;
  try {
    sim = await server.simulateTransaction(tx);
  } catch (error) {
    report.simulation.error = (error as Error).message;
    findings.push({
      severity: 'high',
      code: 'rpc-unavailable',
      message: `Simulation request failed: ${report.simulation.error}`,
    });
    return done();
  }

  if (rpc.Api.isSimulationError(sim)) {
    report.simulation.error = sim.error;
    const authFailure = /Error\(Auth|InvalidAction|require_auth|not authorized|unauthorized/i.test(
      sim.error,
    );
    report.authorization.mechanism = authFailure
      ? 'authorization check failed in simulation'
      : 'unknown (simulation failed)';
    findings.push(
      authFailure
        ? {
            severity: 'high',
            code: 'authorization-failed',
            message: `Simulation failed authorization: ${sim.error.split('\n')[0]}`,
          }
        : {
            severity: 'high',
            code: 'simulation-failed',
            message: `Simulation failed: ${sim.error.split('\n')[0]} (${sim.events?.length ?? 0} diagnostic event(s))`,
          },
    );
    return done();
  }

  report.simulation.succeeded = true;
  report.simulation.minResourceFee = sim.minResourceFee;
  try {
    const resources = sim.transactionData.build().resources();
    report.simulation.instructions = resources.instructions();
    report.simulation.readBytes = resources.readBytes();
    report.simulation.writeBytes = resources.writeBytes();
  } catch {
    // resource details are informational only
  }
  if (rpc.Api.isSimulationRestore(sim)) {
    report.simulation.restoreRequired = true;
    findings.push({
      severity: 'medium',
      code: 'restore-required',
      message: 'Archived entries must be restored before the upgrade can be submitted',
    });
  }

  const authorizers = [
    ...new Set(authorizersFromSimulation(sim.result?.auth ?? [], options.sourceAccount)),
  ];
  report.authorization.observedAuthorizers = authorizers;
  if (!authorizers.length) {
    report.authorization.mechanism = 'none observed';
    findings.push({
      severity: 'high',
      code: 'no-authorization',
      message: 'Simulation required no authorization: anyone may be able to replace this contract',
    });
  } else {
    report.authorization.mechanism = `require_auth by ${authorizers.join(', ')} (observed in simulation)`;
    report.authorization.verified = true;
  }
  if (options.expectedAdmin && authorizers.length && !authorizers.includes(options.expectedAdmin)) {
    report.authorization.verified = false;
    findings.push({
      severity: 'high',
      code: 'unexpected-authorizer',
      message: `Upgrade is authorized by ${authorizers.join(', ')}, not the expected admin ${options.expectedAdmin}`,
    });
  }
  for (const address of authorizers) {
    if (address !== options.sourceAccount) {
      findings.push({
        severity: 'info',
        code: 'separate-signer',
        message: `${address} must sign an authorization entry in addition to the source account`,
      });
    }
  }
  findings.push({
    severity: 'info',
    code: 'simulation-not-guarantee',
    message:
      'A successful simulation does not guarantee execution: state, fees and authorization can change before submission',
  });
  return done();
}

function finalize(report: Omit<PreflightReport, 'readiness'>): PreflightReport {
  const blocked =
    report.findings.some((f) => f.severity === 'high') || !report.simulation.succeeded;
  const readiness = blocked
    ? 'blocked'
    : report.findings.some((f) => f.severity === 'medium')
      ? 'ready-with-warnings'
      : 'ready';
  return { ...report, readiness };
}

// ── Reporting ────────────────────────────────────────────────────────────────

export function formatReport(r: PreflightReport): string {
  const lines = [
    `Upgrade preflight: ${r.readiness.toUpperCase()}`,
    `  Contract:           ${r.contractId}`,
    `  Network:            ${r.network.passphrase} (${r.network.matches ? 'RPC matches' : `RPC: ${r.network.rpcPassphrase ?? 'unreachable'}`})`,
    `  Current WASM:       ${r.currentWasmHash ?? 'unavailable'}${r.currentSpecAvailable ? '' : ' (no spec)'}`,
    `  Replacement WASM:   ${r.replacement.sha256 ?? 'unreadable'} (${r.replacement.validWasm ? 'valid' : 'INVALID'}, ${r.replacement.installedOnLedger === null ? 'install status unknown' : r.replacement.installedOnLedger ? 'installed' : 'NOT installed'})`,
    `  Entry point:        ${r.entryPoint.name ?? 'none'} [${r.entryPoint.source}]`,
    `  Authorization:      ${r.authorization.mechanism}${r.authorization.expectedAdmin ? `; expected admin ${r.authorization.expectedAdmin}` : ''}`,
    `  Simulation:         ${r.simulation.attempted ? (r.simulation.succeeded ? 'succeeded' : `failed: ${r.simulation.error?.split('\n')[0]}`) : 'not run'}`,
  ];
  if (r.simulation.succeeded) {
    lines.push(
      `  Resources:          fee ${r.simulation.minResourceFee} stroops, ${r.simulation.instructions ?? '?'} instructions, ${r.simulation.readBytes ?? '?'} B read, ${r.simulation.writeBytes ?? '?'} B written`,
    );
  }
  lines.push('  Findings:');
  if (!r.findings.length) lines.push('    (none)');
  for (const f of r.findings)
    lines.push(`    [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
  lines.push('  No transaction was submitted.');
  return lines.join('\n');
}

// ── Runner entry point ───────────────────────────────────────────────────────

export async function run(
  params: {
    contractId?: string;
    wasmPath?: string;
    sourceAccount?: string;
    upgradeFunction?: string;
  } = {},
): Promise<void> {
  const config = resolveNetworkConfiguration();
  const server = new rpc.Server(config.sorobanRpcUrl, {
    allowHttp: config.sorobanRpcUrl.startsWith('http://'),
  });
  const report = await runUpgradePreflight(server, {
    contractId: params.contractId || process.env.CONTRACT_ID || '',
    replacementWasmPath: params.wasmPath || process.env.REPLACEMENT_WASM || '',
    sourceAccount: params.sourceAccount || process.env.SOURCE_ACCOUNT || '',
    networkPassphrase: config.networkPassphrase,
    upgradeFunction: params.upgradeFunction || process.env.UPGRADE_FUNCTION || undefined,
    expectedAdmin: process.env.EXPECTED_ADMIN || undefined,
    expectedReplacementHash: process.env.EXPECTED_WASM_SHA256 || undefined,
  });
  console.log(process.env.JSON === '1' ? JSON.stringify(report, null, 2) : formatReport(report));
  if (report.readiness === 'blocked') process.exitCode = 1;
}

if (require.main === module) {
  dotenv.config();
  run().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
