import { rpc, StrKey } from '@stellar/stellar-sdk';
import chalk from 'chalk';
import { specFromWasm, parseContractSpec } from '../utils/spec-parser';
import type { ParsedFunction, ParsedContractSpec } from '../utils/spec-parser';

/**
 * Example 262: Soroban Contract Function Interface Compatibility Auditor
 *
 * Fetches a deployed contract's on-chain WASM, extracts its exported function
 * signatures from the embedded `contractspecv0` custom section, compares
 * those signatures against a caller-supplied expected interface, and emits a
 * human-readable compatibility report.
 *
 * The example is read-only: it never builds or submits a transaction.
 *
 * Key concepts demonstrated
 * ─────────────────────────
 * • Retrieving WASM bytes via `rpc.Server.getContractWasmByContractId`.
 * • Parsing the `contractspecv0` metadata section with `contract.Spec`.
 * • Extracting function names, parameter names/types, and return types.
 * • Comparing an actual spec against an expected interface definition.
 * • Categorising results as: exact-match | type-mismatch | arity-mismatch |
 *   missing | extra | optional-absent.
 * • Producing a structured `CompatibilityReport` and a formatted text report.
 */

// ─── Network defaults ───────────────────────────────────────────────────────

export type NetworkName = 'testnet' | 'mainnet';

const NETWORK_CONFIG: Record<NetworkName, { rpcUrl: string; passphrase: string }> = {
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
  },
  mainnet: {
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    passphrase: 'Public Global Stellar Network ; September 2015',
  },
};

/** Default contract — the Stellar Testnet token contract used as a live demo target. */
const DEFAULT_CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

// ─── Expected-interface types ─────────────────────────────────────────────

export interface ExpectedParameter {
  name: string;
  /** Exact type string expected, e.g. "address", "u128", "Option<u64>". */
  type: string;
}

export interface ExpectedFunction {
  name: string;
  parameters: ExpectedParameter[];
  /** Expected return type(s).  Empty array means void. */
  returnTypes: string[];
  /** If true, the function may be absent without being reported as missing. */
  optional?: boolean;
}

/** An expected interface definition supplied by the caller or loaded from config. */
export interface ExpectedInterface {
  functions: ExpectedFunction[];
}

// ─── Comparison result types ──────────────────────────────────────────────

export type MatchStatus =
  | 'exact-match'
  | 'arity-mismatch'
  | 'type-mismatch'
  | 'missing'
  | 'optional-absent'
  | 'extra';

export interface FunctionAuditResult {
  name: string;
  status: MatchStatus;
  /** Human-readable explanation of any discrepancy. */
  details: string;
  /** Actual signature found in the contract, if the function exists. */
  actualSignature?: string;
  /** Expected signature as defined in the interface. */
  expectedSignature?: string;
}

export interface CompatibilityReport {
  contractId: string;
  network: string;
  isCompatible: boolean;
  summary: {
    total: number;
    exactMatches: number;
    typeMismatches: number;
    arityMismatches: number;
    missing: number;
    optionalAbsent: number;
    extra: number;
  };
  results: FunctionAuditResult[];
  /** All functions present in the contract but not listed in the expected interface. */
  undeclaredFunctions: string[];
}

// ─── Address validation ───────────────────────────────────────────────────

export function validateContractAddress(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Contract address is required. Provide a Stellar contract ID starting with "C".');
  }
  if (!StrKey.isValidContract(trimmed)) {
    throw new Error(
      `"${trimmed}" is not a valid Stellar contract address. ` +
        'A contract address is 56 characters long and starts with "C".',
    );
  }
  return trimmed;
}

// ─── Signature helpers ─────────────────────────────────────────────────────

export function formatSignature(fn: ParsedFunction): string {
  const params = fn.inputs.map((p) => `${p.name}: ${p.type}`).join(', ');
  const returns = fn.outputs.length ? fn.outputs.join(', ') : 'void';
  return `${fn.name}(${params}) -> ${returns}`;
}

export function formatExpectedSignature(fn: ExpectedFunction): string {
  const params = fn.parameters.map((p) => `${p.name}: ${p.type}`).join(', ');
  const returns = fn.returnTypes.length ? fn.returnTypes.join(', ') : 'void';
  return `${fn.name}(${params}) -> ${returns}`;
}

// ─── Core comparison ──────────────────────────────────────────────────────

/**
 * Compares a single expected function against the parsed contract spec.
 * Returns a `FunctionAuditResult` describing the match quality.
 */
export function auditFunction(
  expected: ExpectedFunction,
  actualMap: Map<string, ParsedFunction>,
): FunctionAuditResult {
  const actual = actualMap.get(expected.name);
  const expectedSig = formatExpectedSignature(expected);

  if (!actual) {
    return {
      name: expected.name,
      status: expected.optional ? 'optional-absent' : 'missing',
      details: expected.optional
        ? `Optional function "${expected.name}" is not present in this contract.`
        : `Required function "${expected.name}" is not exported by this contract.`,
      expectedSignature: expectedSig,
    };
  }

  const actualSig = formatSignature(actual);

  // Arity check
  if (actual.inputs.length !== expected.parameters.length) {
    return {
      name: expected.name,
      status: 'arity-mismatch',
      details:
        `Parameter count mismatch: expected ${expected.parameters.length}, ` +
        `found ${actual.inputs.length}.`,
      actualSignature: actualSig,
      expectedSignature: expectedSig,
    };
  }

  // Per-parameter type check
  const typeMismatches: string[] = [];
  for (let i = 0; i < expected.parameters.length; i++) {
    const ep = expected.parameters[i];
    const ap = actual.inputs[i];
    if (ep.type !== ap.type) {
      typeMismatches.push(
        `parameter "${ap.name}" (position ${i + 1}): expected "${ep.type}", found "${ap.type}"`,
      );
    }
  }

  // Return-type check
  const actualReturns = actual.outputs.length ? actual.outputs.join(', ') : 'void';
  const expectedReturns = expected.returnTypes.length ? expected.returnTypes.join(', ') : 'void';
  if (actualReturns !== expectedReturns) {
    typeMismatches.push(`return type: expected "${expectedReturns}", found "${actualReturns}"`);
  }

  if (typeMismatches.length > 0) {
    return {
      name: expected.name,
      status: 'type-mismatch',
      details: `Type mismatch in: ${typeMismatches.join('; ')}.`,
      actualSignature: actualSig,
      expectedSignature: expectedSig,
    };
  }

  return {
    name: expected.name,
    status: 'exact-match',
    details: 'Signature matches exactly.',
    actualSignature: actualSig,
    expectedSignature: expectedSig,
  };
}

/**
 * Audits every function in `expectedInterface` against `parsedSpec`
 * and builds a `CompatibilityReport`.
 */
export function auditCompatibility(
  contractId: string,
  network: string,
  parsedSpec: ParsedContractSpec,
  expectedInterface: ExpectedInterface,
): CompatibilityReport {
  const actualMap = new Map(parsedSpec.functions.map((f) => [f.name, f]));
  const expectedNames = new Set(expectedInterface.functions.map((f) => f.name));

  const results: FunctionAuditResult[] = expectedInterface.functions.map((fn) =>
    auditFunction(fn, actualMap),
  );

  const undeclaredFunctions = parsedSpec.functions
    .filter((f) => !expectedNames.has(f.name))
    .map((f) => f.name);

  const summary = {
    total: results.length,
    exactMatches: results.filter((r) => r.status === 'exact-match').length,
    typeMismatches: results.filter((r) => r.status === 'type-mismatch').length,
    arityMismatches: results.filter((r) => r.status === 'arity-mismatch').length,
    missing: results.filter((r) => r.status === 'missing').length,
    optionalAbsent: results.filter((r) => r.status === 'optional-absent').length,
    extra: undeclaredFunctions.length,
  };

  const isCompatible = summary.missing === 0 && summary.typeMismatches === 0 && summary.arityMismatches === 0;

  return {
    contractId,
    network,
    isCompatible,
    summary,
    results,
    undeclaredFunctions,
  };
}

// ─── Report formatting ────────────────────────────────────────────────────

const STATUS_LABEL: Record<MatchStatus, string> = {
  'exact-match': '✓  MATCH',
  'type-mismatch': '✗  TYPE MISMATCH',
  'arity-mismatch': '✗  ARITY MISMATCH',
  'missing': '✗  MISSING',
  'optional-absent': '–  OPTIONAL ABSENT',
  'extra': '→  EXTRA',
};

export function formatCompatibilityReport(report: CompatibilityReport): string {
  const lines: string[] = [];

  lines.push('══════════════════════════════════════════════════════════');
  lines.push('  Soroban Contract Function Interface Compatibility Audit');
  lines.push('══════════════════════════════════════════════════════════');
  lines.push(`  Contract : ${report.contractId}`);
  lines.push(`  Network  : ${report.network}`);
  lines.push(
    `  Verdict  : ${report.isCompatible ? '✓ COMPATIBLE' : '✗ INCOMPATIBLE'}`,
  );
  lines.push('');
  lines.push('  Summary');
  lines.push(`    Expected functions checked : ${report.summary.total}`);
  lines.push(`    Exact matches              : ${report.summary.exactMatches}`);
  lines.push(`    Type mismatches            : ${report.summary.typeMismatches}`);
  lines.push(`    Arity mismatches           : ${report.summary.arityMismatches}`);
  lines.push(`    Missing (required)         : ${report.summary.missing}`);
  lines.push(`    Optional-absent            : ${report.summary.optionalAbsent}`);
  lines.push(`    Undeclared (extra)         : ${report.summary.extra}`);
  lines.push('');
  lines.push('  Function Results');
  lines.push('  ─────────────────────────────────────────────────────────');

  for (const r of report.results) {
    lines.push(`  ${STATUS_LABEL[r.status]}  ${r.name}`);
    if (r.expectedSignature) {
      lines.push(`      expected : ${r.expectedSignature}`);
    }
    if (r.actualSignature && r.actualSignature !== r.expectedSignature) {
      lines.push(`      actual   : ${r.actualSignature}`);
    }
    if (r.status !== 'exact-match') {
      lines.push(`      note     : ${r.details}`);
    }
  }

  if (report.undeclaredFunctions.length > 0) {
    lines.push('');
    lines.push('  Undeclared functions present in contract (not in expected interface)');
    for (const name of report.undeclaredFunctions) {
      lines.push(`    → ${name}`);
    }
  }

  lines.push('══════════════════════════════════════════════════════════');
  return lines.join('\n');
}

// ─── Built-in demo interface ──────────────────────────────────────────────

/**
 * Returns a sample expected interface suitable for the default Testnet token
 * contract (CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC).
 *
 * It intentionally contains one intentional type mismatch (`balance` expects
 * `u64` but the real contract returns `i128`) and one optional function so
 * the report demonstrates every status category.
 */
export function getDefaultExpectedInterface(): ExpectedInterface {
  return {
    functions: [
      {
        name: 'transfer',
        parameters: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'i128' },
        ],
        returnTypes: [],
      },
      {
        name: 'balance',
        parameters: [{ name: 'id', type: 'address' }],
        // Intentional mismatch: real contract returns i128, not u64
        returnTypes: ['u64'],
      },
      {
        name: 'allowance',
        parameters: [
          { name: 'from', type: 'address' },
          { name: 'spender', type: 'address' },
        ],
        returnTypes: ['i128'],
      },
      {
        name: 'approve',
        parameters: [
          { name: 'from', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'amount', type: 'i128' },
          { name: 'expiration_ledger', type: 'u32' },
        ],
        returnTypes: [],
      },
      {
        name: 'transfer_from',
        parameters: [
          { name: 'spender', type: 'address' },
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'i128' },
        ],
        returnTypes: [],
      },
      {
        name: 'burn',
        parameters: [
          { name: 'from', type: 'address' },
          { name: 'amount', type: 'i128' },
        ],
        returnTypes: [],
      },
      {
        name: 'decimals',
        parameters: [],
        returnTypes: ['u32'],
      },
      {
        name: 'name',
        parameters: [],
        returnTypes: ['string'],
      },
      {
        name: 'symbol',
        parameters: [],
        returnTypes: ['string'],
      },
      // Optional: may or may not be present in every token implementation
      {
        name: 'total_supply',
        parameters: [],
        returnTypes: ['i128'],
        optional: true,
      },
    ],
  };
}

// ─── WASM / spec retrieval ────────────────────────────────────────────────

/**
 * Fetches a contract's WASM bytes from the Soroban RPC and parses its spec.
 *
 * The relationship between WASM and the interface spec:
 * ─────────────────────────────────────────────────────
 * When a Soroban contract is compiled with `soroban-sdk`, the Rust macro
 * `contractimpl` auto-generates an XDR-encoded metadata blob and embeds it
 * into a custom WASM section named `contractspecv0`.  That blob describes
 * every exported function, its parameters, return values, and any
 * user-defined types (structs, enums, unions).  The JS SDK's `contract.Spec`
 * class reads this section and surfaces the information through typed helpers.
 *
 * Contracts compiled without `soroban-sdk`, or stripped of custom sections,
 * will not have this metadata and cannot be introspected at runtime.
 */
async function fetchAndParseSpec(
  contractId: string,
  server: rpc.Server,
): Promise<ParsedContractSpec | null> {
  const wasm = await server.getContractWasmByContractId(contractId);
  const spec = specFromWasm(wasm);
  if (!spec) return null;
  return parseContractSpec(spec);
}

// ─── Entry point ──────────────────────────────────────────────────────────

export interface AuditorParams {
  contractId?: string;
  network?: NetworkName;
  rpcUrl?: string;
  expectedInterface?: ExpectedInterface;
  jsonOutput?: boolean;
}

export async function run(params: AuditorParams = {}): Promise<void> {
  const network: NetworkName =
    (params.network as NetworkName) ||
    (process.env.STELLAR_NETWORK as NetworkName) ||
    'testnet';

  const networkCfg = NETWORK_CONFIG[network] ?? NETWORK_CONFIG.testnet;
  const rpcUrl = params.rpcUrl || process.env.SOROBAN_RPC_URL || networkCfg.rpcUrl;

  const contractInput =
    params.contractId?.trim() ||
    process.env.CONTRACT_ID?.trim() ||
    process.argv[3]?.trim() ||
    DEFAULT_CONTRACT_ID;

  console.log(chalk.bold('\nSoroban Contract Function Interface Compatibility Auditor'));
  console.log(chalk.blue(`Network : ${network}`));
  console.log(chalk.blue(`RPC     : ${rpcUrl}`));

  // ── 1. Validate address ─────────────────────────────────────────────────
  let contractId: string;
  try {
    contractId = validateContractAddress(contractInput);
  } catch (err: any) {
    console.error(chalk.red(`Address error: ${err?.message ?? err}`));
    return;
  }
  console.log(chalk.blue(`Contract: ${contractId}`));

  // ── 2. Fetch WASM and parse spec ─────────────────────────────────────────
  const server = new rpc.Server(rpcUrl);

  let parsedSpec: ParsedContractSpec | null;
  try {
    console.log(chalk.yellow('\nFetching contract WASM…'));
    parsedSpec = await fetchAndParseSpec(contractId, server);
  } catch (err: any) {
    console.error(
      chalk.red(`\nFailed to retrieve contract WASM: ${err?.message ?? err}`),
    );
    console.log(
      chalk.cyan(
        'Check that the contract is deployed on this network and that the RPC endpoint is reachable.',
      ),
    );
    return;
  }

  if (!parsedSpec) {
    console.log(chalk.yellow('\nNo contractspecv0 metadata found in this WASM.'));
    console.log(
      chalk.gray(
        'Contracts compiled without soroban-sdk, or with custom sections stripped, ' +
          'do not embed interface metadata and cannot be audited at runtime. ' +
          'Use the contract source or Stellar CLI as a fallback.',
      ),
    );
    return;
  }

  console.log(
    chalk.green(
      `Spec retrieved — ${parsedSpec.functions.length} function(s), ` +
        `${parsedSpec.structs.length} struct(s), ` +
        `${parsedSpec.enums.length} enum(s).`,
    ),
  );

  // ── 3. Print extracted function signatures ───────────────────────────────
  console.log(chalk.bold('\nExported functions'));
  for (const fn of parsedSpec.functions) {
    const params2 = fn.inputs.map((p) => `${p.name}: ${p.type}`).join(', ');
    const returns = fn.outputs.length ? fn.outputs.join(', ') : 'void';
    const doc = fn.documentation ? chalk.gray(`  // ${fn.documentation}`) : '';
    console.log(`  ${chalk.cyan(fn.name)}(${params2}) -> ${returns}${doc}`);
  }

  if (parsedSpec.structs.length) {
    console.log(chalk.bold('\nUser-defined structs'));
    for (const s of parsedSpec.structs) {
      console.log(`  ${chalk.cyan(s.name)} { ${s.fields.map((f) => `${f.name}: ${f.type}`).join(', ')} }`);
    }
  }

  if (parsedSpec.enums.length) {
    console.log(chalk.bold('\nUser-defined enums'));
    for (const e of parsedSpec.enums) {
      console.log(`  ${chalk.cyan(e.name)} { ${e.cases.map((c) => c.name).join(', ')} }`);
    }
  }

  // ── 4. Load expected interface ───────────────────────────────────────────
  const expectedInterface = params.expectedInterface ?? getDefaultExpectedInterface();

  if (!params.expectedInterface) {
    console.log(
      chalk.yellow(
        '\nNo expected interface supplied — using the built-in demo interface.' +
          '\nPass `expectedInterface` to audit against your own definition.',
      ),
    );
  }

  // ── 5. Run audit ─────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nRunning compatibility audit…'));
  const report = auditCompatibility(contractId, network, parsedSpec, expectedInterface);

  // ── 6. Output ─────────────────────────────────────────────────────────────
  if (params.jsonOutput || process.env.JSON_OUTPUT === 'true') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const text = formatCompatibilityReport(report);

    // Colour the verdict line
    const coloured = text
      .replace(/✓ COMPATIBLE/g, chalk.green('✓ COMPATIBLE'))
      .replace(/✗ INCOMPATIBLE/g, chalk.red('✗ INCOMPATIBLE'))
      .replace(/✓  MATCH/g, chalk.green('✓  MATCH'))
      .replace(/✗  TYPE MISMATCH/g, chalk.red('✗  TYPE MISMATCH'))
      .replace(/✗  ARITY MISMATCH/g, chalk.red('✗  ARITY MISMATCH'))
      .replace(/✗  MISSING/g, chalk.red('✗  MISSING'))
      .replace(/–  OPTIONAL ABSENT/g, chalk.gray('–  OPTIONAL ABSENT'))
      .replace(/→  EXTRA/g, chalk.blue('→  EXTRA'));

    console.log('\n' + coloured);
  }

  console.log(
    chalk.cyan(
      '\nTip: supply `expectedInterface` with your required function definitions to audit ' +
        'any third-party Soroban contract before integrating it into your application.',
    ),
  );
  console.log(chalk.green('\nAudit complete.'));
}
