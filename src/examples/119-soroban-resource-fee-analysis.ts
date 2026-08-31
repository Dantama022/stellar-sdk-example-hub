import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from 'stellar-sdk-v16';
import chalk from 'chalk';

/**
 * ISSUE-119: Soroban Resource and Fee Analysis
 *
 * Soroban transactions use a multidimensional resource model. Contract
 * execution consumes resources such as CPU instructions, memory, ledger entry
 * access, and ledger I/O bytes.
 *
 * Simulation is the normal way to discover the resource limits and resource
 * fee required to prepare a Soroban transaction before it is signed and
 * submitted.
 *
 * This example demonstrates how to:
 *
 * 1. Build two Soroban contract invocations.
 * 2. Simulate both invocations with Soroban RPC.
 * 3. Extract CPU instruction consumption where exposed by RPC.
 * 4. Extract memory consumption where exposed by RPC.
 * 5. Inspect ledger read/write counts from the footprint.
 * 6. Inspect recommended ledger read/write byte limits.
 * 7. Inspect transaction instruction limits.
 * 8. Separate Soroban resource fees from the inclusion/base fee.
 * 9. Calculate the total estimated transaction fee.
 * 10. Show meaningful relative contribution/utilization percentages.
 * 11. Compare resource consumption between two invocations.
 * 12. Identify unusually expensive resource differences.
 * 13. Explain how simulation affects transaction preparation.
 * 14. Handle unavailable resource information gracefully.
 * 15. Handle simulation failures gracefully.
 *
 * The SDK's parsed simulation response provides transactionData and
 * minResourceFee. Some RPC versions additionally expose a raw `cost` object
 * containing cpuInsns and memBytes. Because stellar-sdk-v16@16.2.0 does not
 * expose that `cost` object on its parsed response type, this example performs
 * one additional dependency-free JSON-RPC simulation request solely to obtain
 * CPU/memory information where the RPC node supports it.
 *
 * Nothing is signed or submitted.
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
const BASE_FEE_STROOPS = 100n;
const BASE_FEE_STRING = BASE_FEE_STROOPS.toString();

const DEFAULT_METHOD_A = 'decimals';
const DEFAULT_METHOD_B = 'name';

export interface ResourceFeeAnalysisParams {
  rpcUrl?: string;
  networkPassphrase?: string;
  contractId?: string;
  methodA?: string;
  methodB?: string;
  balanceAddress?: string;
}

export interface RawSimulationCost {
  cpuInstructions?: bigint;
  memoryBytes?: bigint;
}

interface RawRpcSimulationResponse {
  jsonrpc?: string;
  id?: string | number;
  result?: {
    cost?: {
      cpuInsns?: string;
      memBytes?: string;
    };
    error?: string;
  };
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export interface ResourceReport {
  label: string;
  method: string;
  latestLedger: number;

  cpuInstructions?: bigint;
  memoryBytes?: bigint;

  instructionLimit: number;
  ledgerReadCount: number;
  ledgerWriteCount: number;
  ledgerReadBytes: number;
  ledgerWriteBytes: number;

  sorobanResourceFee: bigint;
  inclusionFee: bigint;
  totalEstimatedFee: bigint;

  rawCostAvailable: boolean;
}

export interface SimulationAnalysis {
  label: string;
  method: string;
  success: boolean;
  restoreRequired: boolean;
  latestLedger?: number;
  error?: string;
  report?: ResourceReport;
}

export interface PercentageBreakdown {
  first: number;
  second: number;
}

export interface ResourceComparisonRow {
  name: string;
  first?: bigint;
  second?: bigint;
  unit: string;
}

export interface ExpensiveResourceFinding {
  resource: string;
  message: string;
}

/**
 * Convert unknown thrown values into useful diagnostics.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Parse a non-negative integer returned by JSON-RPC.
 */
export function parseOptionalBigInt(
  value: string | number | bigint | undefined,
): bigint | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const parsed = BigInt(value);

    return parsed >= 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Format bytes using binary units.
 */
export function formatBytes(value: bigint | number): string {
  const bytes = typeof value === 'bigint' ? Number(value) : value;

  if (!Number.isFinite(bytes) || bytes < 0) {
    return String(value);
  }

  const units = ['B', 'KiB', 'MiB', 'GiB'];

  let amount = bytes;
  let unitIndex = 0;

  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }

  const decimals = amount >= 100 || unitIndex === 0 ? 0 : 2;

  return `${amount.toFixed(decimals)} ${units[unitIndex]}`;
}

/**
 * Render stroops and their approximate XLM equivalent.
 *
 * 1 XLM = 10,000,000 stroops.
 */
export function formatFee(stroops: bigint): string {
  const stroopsPerXlm = 10_000_000n;

  const whole = stroops / stroopsPerXlm;
  const fraction = (stroops % stroopsPerXlm).toString().padStart(7, '0').replace(/0+$/, '');

  const xlm = fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();

  return `${stroops.toString()} stroops (${xlm} XLM)`;
}

/**
 * Calculate a percentage while handling a zero denominator.
 */
export function calculatePercentage(value: bigint | number, total: bigint | number): number {
  const numericValue = Number(value);
  const numericTotal = Number(total);

  if (!Number.isFinite(numericValue) || !Number.isFinite(numericTotal) || numericTotal <= 0) {
    return 0;
  }

  return (numericValue / numericTotal) * 100;
}

/**
 * Split two comparable values into percentage shares.
 *
 * This is used only for values with matching units, such as ledger read bytes
 * versus ledger write bytes, or resource fee versus inclusion fee.
 */
export function calculateShare(
  first: bigint | number,
  second: bigint | number,
): PercentageBreakdown {
  const firstNumber = Number(first);
  const secondNumber = Number(second);
  const total = firstNumber + secondNumber;

  if (!Number.isFinite(total) || total <= 0) {
    return {
      first: 0,
      second: 0,
    };
  }

  return {
    first: (firstNumber / total) * 100,
    second: (secondNumber / total) * 100,
  };
}

/**
 * Build arguments for the default demonstration methods.
 *
 * decimals() has no arguments.
 * balance(address) accepts one Soroban address.
 *
 * Custom methods supplied through environment variables are invoked without
 * arguments. If that is incompatible with the selected contract, simulation
 * returns a useful contract/RPC error instead of the example crashing.
 */
export function buildMethodArguments(method: string, balanceAddress: string): xdr.ScVal[] {
  if (method === 'balance') {
    return [Address.fromString(balanceAddress).toScVal()];
  }

  return [];
}

/**
 * Build a single-operation Soroban invocation.
 *
 * No secret key is required because this example only simulates.
 */
export function buildInvocation(
  sourceAccountId: string,
  networkPassphrase: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Transaction {
  const sourceAccount = new Account(sourceAccountId, '0');
  const contract = new Contract(contractId);

  return new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE_STRING,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
}

/**
 * Fetch the raw RPC simulation cost.
 *
 * The parsed SDK response in stellar-sdk-v16@16.2.0 exposes transactionData,
 * minResourceFee and results, but not the optional RPC `cost` object. The
 * current Soroban RPC API may return:
 *
 *   cost.cpuInsns
 *   cost.memBytes
 *
 * This helper obtains those values without installing another dependency.
 *
 * If the RPC does not expose them, both properties simply remain undefined.
 */
export async function fetchRawSimulationCost(
  rpcUrl: string,
  transaction: Transaction,
): Promise<RawSimulationCost> {
  const transactionXdr = transaction.toEnvelope().toXDR('base64');

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `resource-analysis-${Date.now()}`,
      method: 'simulateTransaction',
      params: {
        transaction: transactionXdr,
        resourceConfig: {
          instructionLeeway: 0,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Raw RPC request returned HTTP ${response.status} ${response.statusText}.`);
  }

  const payload = (await response.json()) as RawRpcSimulationResponse;

  if (payload.error) {
    throw new Error(
      payload.error.message ??
        `Raw RPC returned JSON-RPC error ${payload.error.code ?? 'unknown'}.`,
    );
  }

  if (payload.result?.error) {
    throw new Error(payload.result.error);
  }

  return {
    cpuInstructions: parseOptionalBigInt(payload.result?.cost?.cpuInsns),
    memoryBytes: parseOptionalBigInt(payload.result?.cost?.memBytes),
  };
}

/**
 * Extract a complete resource and fee report from successful SDK simulation.
 */
export function extractResourceReport(
  label: string,
  method: string,
  simulation: rpc.Api.SimulateTransactionSuccessResponse,
  rawCost: RawSimulationCost,
  inclusionFee: bigint = BASE_FEE_STROOPS,
): ResourceReport {
  const sorobanData = simulation.transactionData.build();
  const resources = sorobanData.resources();
  const footprint = resources.footprint();

  const sorobanResourceFee = BigInt(simulation.minResourceFee);

  return {
    label,
    method,
    latestLedger: simulation.latestLedger,

    cpuInstructions: rawCost.cpuInstructions,
    memoryBytes: rawCost.memoryBytes,

    instructionLimit: resources.instructions(),
    ledgerReadCount: footprint.readOnly().length,
    ledgerWriteCount: footprint.readWrite().length,
    ledgerReadBytes: resources.diskReadBytes(),
    ledgerWriteBytes: resources.writeBytes(),

    sorobanResourceFee,
    inclusionFee,
    totalEstimatedFee: sorobanResourceFee + inclusionFee,

    rawCostAvailable: rawCost.cpuInstructions !== undefined || rawCost.memoryBytes !== undefined,
  };
}

/**
 * Simulate one transaction and produce a normalized resource report.
 */
async function simulateAndAnalyze(
  server: rpc.Server,
  rpcUrl: string,
  label: string,
  method: string,
  transaction: Transaction,
): Promise<SimulationAnalysis> {
  /*
   * CPU/memory collection is deliberately best-effort. Failure of the extra raw
   * request must not prevent normal SDK resource analysis.
   */
  const rawCostPromise = fetchRawSimulationCost(rpcUrl, transaction).catch(
    () =>
      ({
        cpuInstructions: undefined,
        memoryBytes: undefined,
      }) satisfies RawSimulationCost,
  );

  let simulation: rpc.Api.SimulateTransactionResponse;

  try {
    simulation = await server.simulateTransaction(transaction);
  } catch (error: unknown) {
    return {
      label,
      method,
      success: false,
      restoreRequired: false,
      error: `RPC simulation request failed: ${getErrorMessage(error)}`,
    };
  }

  const rawCost = await rawCostPromise;

  if (rpc.Api.isSimulationError(simulation)) {
    return {
      label,
      method,
      success: false,
      restoreRequired: false,
      latestLedger: simulation.latestLedger,
      error: simulation.error,
    };
  }

  if (rpc.Api.isSimulationRestore(simulation)) {
    return {
      label,
      method,
      success: false,
      restoreRequired: true,
      latestLedger: simulation.latestLedger,
      error:
        'Archived ledger state must be restored before this invocation can be prepared normally.',
    };
  }

  try {
    return {
      label,
      method,
      success: true,
      restoreRequired: false,
      latestLedger: simulation.latestLedger,
      report: extractResourceReport(label, method, simulation, rawCost, BASE_FEE_STROOPS),
    };
  } catch (error: unknown) {
    return {
      label,
      method,
      success: false,
      restoreRequired: false,
      latestLedger: simulation.latestLedger,
      error: `Simulation succeeded but resource data could not be decoded: ${getErrorMessage(
        error,
      )}`,
    };
  }
}

/**
 * Produce a signed numeric delta.
 */
export function formatSignedBigInt(value: bigint): string {
  if (value > 0n) {
    return `+${value.toString()}`;
  }

  return value.toString();
}

/**
 * Produce percentage change between two values.
 */
export function percentageChange(previous: bigint, current: bigint): number | undefined {
  if (previous === 0n) {
    return current === 0n ? 0 : undefined;
  }

  return (Number(current - previous) / Number(previous)) * 100;
}

/**
 * Compare two values and produce a readable delta.
 */
function formatComparisonDelta(first: bigint, second: bigint): string {
  const delta = second - first;
  const percentage = percentageChange(first, second);

  if (percentage === undefined) {
    return `${formatSignedBigInt(delta)} (new non-zero usage)`;
  }

  const sign = percentage > 0 ? '+' : '';

  return `${formatSignedBigInt(delta)} (${sign}${percentage.toFixed(1)}%)`;
}

/**
 * Print a resource field that may be unavailable.
 */
function printOptionalResource(
  label: string,
  value: bigint | undefined,
  formatter: (value: bigint) => string = (resource) => resource.toString(),
): void {
  if (value === undefined) {
    console.log(chalk.yellow(`    ${label.padEnd(27)}: unavailable`));
    return;
  }

  console.log(`    ${label.padEnd(27)}: ${formatter(value)}`);
}

/**
 * Print relative contribution information using comparable resource groups.
 *
 * We intentionally do NOT add CPU instructions, bytes and entry counts into a
 * single percentage because those values use different units. Instead:
 *
 * - CPU consumption is shown against its instruction budget.
 * - Ledger entry contribution splits read versus write entry counts.
 * - Ledger I/O contribution splits read versus write byte budgets.
 * - Fee contribution splits resource fee versus inclusion fee.
 * - Memory is displayed independently because memory is limited but is not
 *   directly charged as a Soroban resource fee.
 */
function printRelativeContributions(report: ResourceReport): void {
  console.log(chalk.cyan('\n    Relative resource contribution'));

  if (report.cpuInstructions !== undefined && report.instructionLimit > 0) {
    const cpuUtilization = calculatePercentage(report.cpuInstructions, report.instructionLimit);

    console.log(`      CPU budget utilization     : ${cpuUtilization.toFixed(2)}%`);
  } else {
    console.log(
      chalk.yellow('      CPU budget utilization     : unavailable (actual CPU cost not exposed)'),
    );
  }

  const entryShare = calculateShare(report.ledgerReadCount, report.ledgerWriteCount);

  console.log(
    `      Ledger entry access         : reads ${entryShare.first.toFixed(
      1,
    )}% / writes ${entryShare.second.toFixed(1)}%`,
  );

  const ioShare = calculateShare(report.ledgerReadBytes, report.ledgerWriteBytes);

  console.log(
    `      Ledger I/O byte budget      : reads ${ioShare.first.toFixed(
      1,
    )}% / writes ${ioShare.second.toFixed(1)}%`,
  );

  const feeShare = calculateShare(report.sorobanResourceFee, report.inclusionFee);

  console.log(
    `      Estimated fee composition   : resources ${feeShare.first.toFixed(
      2,
    )}% / inclusion ${feeShare.second.toFixed(2)}%`,
  );

  if (report.memoryBytes !== undefined) {
    console.log(
      `      Memory                      : ${formatBytes(
        report.memoryBytes,
      )} observed; memory is limited but not directly fee-charged`,
    );
  } else {
    console.log(
      chalk.yellow('      Memory                      : unavailable from this RPC response'),
    );
  }
}

/**
 * Print one complete resource and fee report.
 */
function printResourceReport(analysis: SimulationAnalysis): void {
  console.log(chalk.bold(`\n  ${analysis.label}: ${analysis.method}()`));

  if (!analysis.success || !analysis.report) {
    if (analysis.restoreRequired) {
      console.log(chalk.yellow('    Result                     : RESTORE REQUIRED'));
    } else {
      console.log(chalk.red('    Result                     : SIMULATION FAILED'));
    }

    if (analysis.latestLedger !== undefined) {
      console.log(`    Latest ledger              : ${analysis.latestLedger}`);
    }

    console.log(
      chalk.gray(
        `    Diagnostic                 : ${
          analysis.error ?? 'No diagnostic information returned.'
        }`,
      ),
    );

    return;
  }

  const report = analysis.report;

  console.log(chalk.green('    Result                     : SUCCESS'));
  console.log(`    Latest ledger              : ${report.latestLedger}`);

  console.log(chalk.cyan('\n    Execution consumption'));

  printOptionalResource('CPU instructions', report.cpuInstructions, (value) =>
    value.toLocaleString('en-US'),
  );

  printOptionalResource(
    'Memory usage',
    report.memoryBytes,
    (value) => `${value.toLocaleString('en-US')} bytes (${formatBytes(value)})`,
  );

  console.log(chalk.cyan('\n    Ledger access'));

  console.log(`    ${'Read-only ledger entries'.padEnd(27)}: ${report.ledgerReadCount}`);

  console.log(`    ${'Read-write ledger entries'.padEnd(27)}: ${report.ledgerWriteCount}`);

  console.log(chalk.cyan('\n    Transaction resource limits'));

  console.log(
    `    ${'Instruction limit'.padEnd(27)}: ${report.instructionLimit.toLocaleString('en-US')}`,
  );

  console.log(
    `    ${'Ledger read bytes'.padEnd(27)}: ${report.ledgerReadBytes.toLocaleString(
      'en-US',
    )} bytes (${formatBytes(report.ledgerReadBytes)})`,
  );

  console.log(
    `    ${'Ledger write bytes'.padEnd(
      27,
    )}: ${report.ledgerWriteBytes.toLocaleString('en-US')} bytes (${formatBytes(
      report.ledgerWriteBytes,
    )})`,
  );

  console.log(chalk.cyan('\n    Fee estimate'));

  console.log(`    ${'Soroban resource fee'.padEnd(27)}: ${formatFee(report.sorobanResourceFee)}`);

  console.log(`    ${'Inclusion/base fee'.padEnd(27)}: ${formatFee(report.inclusionFee)}`);

  console.log(
    chalk.bold(`    ${'Total estimated fee'.padEnd(27)}: ${formatFee(report.totalEstimatedFee)}`),
  );

  printRelativeContributions(report);

  if (!report.rawCostAvailable) {
    console.log(
      chalk.gray(
        '\n    Note: this RPC/SDK combination did not expose CPU or memory cost. Transaction resource limits and fee data remain available.',
      ),
    );
  }
}

/**
 * Return resource values suitable for invocation-to-invocation comparison.
 */
function buildComparisonRows(
  first: ResourceReport,
  second: ResourceReport,
): ResourceComparisonRow[] {
  return [
    {
      name: 'CPU instructions',
      first: first.cpuInstructions,
      second: second.cpuInstructions,
      unit: 'instructions',
    },
    {
      name: 'Memory',
      first: first.memoryBytes,
      second: second.memoryBytes,
      unit: 'bytes',
    },
    {
      name: 'Ledger read entries',
      first: BigInt(first.ledgerReadCount),
      second: BigInt(second.ledgerReadCount),
      unit: 'entries',
    },
    {
      name: 'Ledger write entries',
      first: BigInt(first.ledgerWriteCount),
      second: BigInt(second.ledgerWriteCount),
      unit: 'entries',
    },
    {
      name: 'Instruction limit',
      first: BigInt(first.instructionLimit),
      second: BigInt(second.instructionLimit),
      unit: 'instructions',
    },
    {
      name: 'Ledger read bytes',
      first: BigInt(first.ledgerReadBytes),
      second: BigInt(second.ledgerReadBytes),
      unit: 'bytes',
    },
    {
      name: 'Ledger write bytes',
      first: BigInt(first.ledgerWriteBytes),
      second: BigInt(second.ledgerWriteBytes),
      unit: 'bytes',
    },
    {
      name: 'Soroban resource fee',
      first: first.sorobanResourceFee,
      second: second.sorobanResourceFee,
      unit: 'stroops',
    },
    {
      name: 'Total estimated fee',
      first: first.totalEstimatedFee,
      second: second.totalEstimatedFee,
      unit: 'stroops',
    },
  ];
}

/**
 * Render a comparison value in a resource-appropriate format.
 */
function formatComparisonValue(value: bigint | undefined, unit: string): string {
  if (value === undefined) {
    return 'unavailable';
  }

  if (unit === 'bytes') {
    return `${value.toLocaleString('en-US')} (${formatBytes(value)})`;
  }

  if (unit === 'stroops') {
    return formatFee(value);
  }

  return `${value.toLocaleString('en-US')} ${unit}`;
}

/**
 * Detect large relative differences between the two contract invocations.
 *
 * "Unusually expensive" is intentionally comparison-based rather than relying
 * on hard-coded network limits that validators may change.
 *
 * A category is highlighted when one invocation consumes more than twice the
 * corresponding non-zero resource of the other invocation.
 */
export function identifyExpensiveResourceUsage(
  first: ResourceReport,
  second: ResourceReport,
): ExpensiveResourceFinding[] {
  const findings: ExpensiveResourceFinding[] = [];

  const rows = buildComparisonRows(first, second);

  rows.forEach((row) => {
    if (row.first === undefined || row.second === undefined) {
      return;
    }

    if (row.first > 0n && row.second > row.first * 2n) {
      findings.push({
        resource: row.name,
        message: `${second.method}() uses more than 2× the ${row.name.toLowerCase()} of ${first.method}().`,
      });

      return;
    }

    if (row.second > 0n && row.first > row.second * 2n) {
      findings.push({
        resource: row.name,
        message: `${first.method}() uses more than 2× the ${row.name.toLowerCase()} of ${second.method}().`,
      });
    }
  });

  /*
   * CPU has an explicit transaction instruction budget, so high utilization is
   * meaningful even without comparison to another invocation.
   */
  [
    {
      report: first,
      label: first.method,
    },
    {
      report: second,
      label: second.method,
    },
  ].forEach(({ report, label }) => {
    if (report.cpuInstructions !== undefined && report.instructionLimit > 0) {
      const utilization = calculatePercentage(report.cpuInstructions, report.instructionLimit);

      if (utilization >= 90) {
        findings.push({
          resource: 'CPU instruction budget',
          message: `${label}() consumed ${utilization.toFixed(
            1,
          )}% of its simulated instruction limit.`,
        });
      }
    }
  });

  return findings;
}

/**
 * Print invocation-to-invocation comparison.
 */
function printComparison(first: SimulationAnalysis, second: SimulationAnalysis): void {
  console.log(chalk.yellow('\nResource comparison'));

  if (!first.success || !first.report) {
    console.log(
      chalk.gray(
        `  Cannot compare resources because ${first.label} (${first.method}) did not produce a usable report.`,
      ),
    );

    return;
  }

  if (!second.success || !second.report) {
    console.log(
      chalk.gray(
        `  Cannot compare resources because ${second.label} (${second.method}) did not produce a usable report.`,
      ),
    );

    return;
  }

  const firstReport = first.report;
  const secondReport = second.report;

  console.log(`  First invocation : ${firstReport.method}()`);
  console.log(`  Second invocation: ${secondReport.method}()`);

  const rows = buildComparisonRows(firstReport, secondReport);

  rows.forEach((row) => {
    console.log(chalk.cyan(`\n  ${row.name}`));

    console.log(
      `    ${firstReport.method.padEnd(16)}: ${formatComparisonValue(row.first, row.unit)}`,
    );

    console.log(
      `    ${secondReport.method.padEnd(16)}: ${formatComparisonValue(row.second, row.unit)}`,
    );

    if (row.first !== undefined && row.second !== undefined) {
      console.log(`    Delta${''.padEnd(12)}: ${formatComparisonDelta(row.first, row.second)}`);
    } else {
      console.log(
        chalk.gray(
          `    Delta            : unavailable because one or both RPC responses omitted this resource`,
        ),
      );
    }
  });

  // -----------------------------------------------------------------------
  // Unusually expensive usage
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nUnusually expensive resource usage'));

  const findings = identifyExpensiveResourceUsage(first.report, second.report);

  if (findings.length === 0) {
    console.log(
      chalk.green(
        '  No unusually expensive resource category was identified by the comparison heuristic.',
      ),
    );

    console.log(
      chalk.gray(
        '  The heuristic flags >2× differences between comparable non-zero resources and CPU usage at >=90% of the simulated instruction budget.',
      ),
    );

    return;
  }

  findings.forEach((finding) => {
    console.log(chalk.yellow(`  ⚠ ${finding.resource}: ${finding.message}`));
  });

  console.log(
    chalk.gray(
      '\n  These warnings are comparison aids, not protocol failure thresholds. Network resource limits and fee rates can change.',
    ),
  );
}

/**
 * Run ISSUE-119.
 */
export async function run(params: ResourceFeeAnalysisParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl?.trim() || process.env.SOROBAN_RPC_URL?.trim() || DEFAULT_RPC_URL;

  const networkPassphrase =
    params.networkPassphrase?.trim() || process.env.NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;

  /*
   * The native XLM Stellar Asset Contract gives the example a deterministic
   * Testnet contract that supports standard token read methods.
   */
  const defaultContractId = Asset.native().contractId(networkPassphrase);

  const contractId =
    params.contractId?.trim() ||
    process.env.RESOURCE_CONTRACT_ID?.trim() ||
    process.env.CONTRACT_ID?.trim() ||
    defaultContractId;

  const methodA =
    params.methodA?.trim() || process.env.RESOURCE_METHOD_A?.trim() || DEFAULT_METHOD_A;

  const methodB =
    params.methodB?.trim() || process.env.RESOURCE_METHOD_B?.trim() || DEFAULT_METHOD_B;

  const balanceAddress =
    params.balanceAddress?.trim() ||
    process.env.RESOURCE_BALANCE_ADDRESS?.trim() ||
    Keypair.random().publicKey();

  console.log(chalk.bold('\nSoroban Resource and Fee Analysis Example'));

  console.log(
    chalk.gray(
      'Simulate two Soroban contract calls, inspect their resource consumption and fees, and compare their relative cost.',
    ),
  );

  console.log(chalk.yellow('\nConfiguration'));

  console.log(`  RPC endpoint    : ${rpcUrl}`);
  console.log(`  Contract        : ${contractId}`);
  console.log(`  Invocation A    : ${methodA}()`);
  console.log(`  Invocation B    : ${methodB}()`);
  console.log(`  Balance address : ${balanceAddress}`);
  console.log(`  Inclusion fee   : ${BASE_FEE_STROOPS.toString()} stroops`);

  // -----------------------------------------------------------------------
  // Step 1: Validate inputs
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 1: Validating inputs...'));

  if (!StrKey.isValidContract(contractId)) {
    console.error(
      chalk.red(`  Invalid contract ID "${contractId}". Expected a valid C... contract address.`),
    );

    return;
  }

  if (!StrKey.isValidEd25519PublicKey(balanceAddress) && !StrKey.isValidContract(balanceAddress)) {
    console.error(
      chalk.red(`  Invalid balance address "${balanceAddress}". Expected a G... or C... address.`),
    );

    return;
  }

  console.log(chalk.green('  Input validation passed.'));

  // -----------------------------------------------------------------------
  // Step 2: Connect to RPC
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 2: Connecting to Soroban RPC...'));

  const server = new rpc.Server(rpcUrl);

  try {
    const latestLedger = await server.getLatestLedger();

    console.log(chalk.green(`  Connected. Latest ledger sequence: ${latestLedger.sequence}`));
  } catch (error: unknown) {
    console.error(chalk.red(`  Unable to reach Soroban RPC: ${getErrorMessage(error)}`));

    console.log(
      chalk.gray('  Check SOROBAN_RPC_URL and confirm that it matches the selected network.'),
    );

    return;
  }

  // -----------------------------------------------------------------------
  // Step 3: Build two contract invocations
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 3: Building sample contract invocations...'));

  let firstTransaction: Transaction;
  let secondTransaction: Transaction;

  const simulationSource = Keypair.random().publicKey();

  try {
    firstTransaction = buildInvocation(
      simulationSource,
      networkPassphrase,
      contractId,
      methodA,
      buildMethodArguments(methodA, balanceAddress),
    );

    secondTransaction = buildInvocation(
      simulationSource,
      networkPassphrase,
      contractId,
      methodB,
      buildMethodArguments(methodB, balanceAddress),
    );
  } catch (error: unknown) {
    console.error(chalk.red(`  Could not build sample invocations: ${getErrorMessage(error)}`));

    return;
  }

  console.log(chalk.green('  Both transactions were constructed.'));
  console.log(`  Invocation A: ${methodA}()`);
  console.log(`  Invocation B: ${methodB}()`);
  console.log(chalk.gray('  Neither transaction is signed or submitted.'));

  // -----------------------------------------------------------------------
  // Step 4: Simulate first invocation
  // -----------------------------------------------------------------------

  console.log(chalk.yellow(`\nStep 4: Simulating ${methodA}()...`));

  const firstAnalysis = await simulateAndAnalyze(
    server,
    rpcUrl,
    'Invocation A',
    methodA,
    firstTransaction,
  );

  if (firstAnalysis.success) {
    console.log(chalk.green('  First simulation succeeded.'));
  } else {
    console.log(
      chalk.yellow(
        `  First simulation did not produce a resource report: ${
          firstAnalysis.error ?? 'unknown reason'
        }`,
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Step 5: Simulate second invocation
  // -----------------------------------------------------------------------

  console.log(chalk.yellow(`\nStep 5: Simulating ${methodB}()...`));

  const secondAnalysis = await simulateAndAnalyze(
    server,
    rpcUrl,
    'Invocation B',
    methodB,
    secondTransaction,
  );

  if (secondAnalysis.success) {
    console.log(chalk.green('  Second simulation succeeded.'));
  } else {
    console.log(
      chalk.yellow(
        `  Second simulation did not produce a resource report: ${
          secondAnalysis.error ?? 'unknown reason'
        }`,
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Step 6: Detailed reports
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 6: Detailed resource and fee reports'));

  printResourceReport(firstAnalysis);
  printResourceReport(secondAnalysis);

  // -----------------------------------------------------------------------
  // Step 7: Compare the invocations
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 7: Comparing contract invocations...'));

  printComparison(firstAnalysis, secondAnalysis);

  // -----------------------------------------------------------------------
  // Step 8: Explain fee structure
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 8: Understanding Soroban fees'));

  console.log(
    chalk.cyan(
      [
        '  • Soroban resource fee: pays for the smart-contract resources declared',
        '    in Soroban transaction data, including metered execution and ledger I/O.',
        '  • Inclusion/base fee: the normal Stellar transaction fee used for network',
        '    inclusion and prioritization.',
        '  • Estimated total fee = Soroban resource fee + inclusion/base fee.',
        '  • Memory consumption is metered and limited, but it is not directly priced',
        '    as an independent Soroban fee category.',
        '  • Some Soroban resource fees are refundable because final refundable',
        '    consumption is reconciled after execution.',
      ].join('\n'),
    ),
  );

  // -----------------------------------------------------------------------
  // Step 9: Explain simulation and preparation
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 9: How simulation affects transaction preparation'));

  console.log(
    chalk.cyan(
      [
        '  1. The application first builds an incomplete Soroban invocation.',
        '  2. simulateTransaction executes it against current ledger state without',
        '     committing any changes.',
        '  3. RPC returns recommended Soroban transaction data containing the ledger',
        '     footprint, instruction limit, ledger I/O limits, and resource fee.',
        '  4. Simulation also identifies required authorization entries and catches',
        '     contract failures before the transaction is submitted.',
        '  5. Transaction preparation applies the simulated resource data to the',
        '     transaction before authorization and signing.',
        '  6. The inclusion fee is then added on top of the resource fee.',
        '  7. If ledger state changes materially before submission, applications may',
        '     need to simulate again so the footprint and resource limits remain valid.',
      ].join('\n'),
    ),
  );

  console.log(
    chalk.gray(
      '\n  The SDK server.prepareTransaction() helper normally performs simulation and applies the returned Soroban transaction data automatically for transactions that will be submitted.',
    ),
  );

  // -----------------------------------------------------------------------
  // Step 10: Graceful availability note
  // -----------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 10: Resource information availability'));

  console.log(
    chalk.gray(
      [
        '  RPC implementations and protocol versions can expose different diagnostic',
        '  fields. This example treats CPU and memory cost as optional, while the',
        '  simulated Soroban transaction data remains the authoritative source for',
        '  transaction resource limits and the recommended resource fee.',
      ].join('\n'),
    ),
  );

  console.log(chalk.bold.green('\nSoroban resource and fee analysis complete.'));

  console.log(
    chalk.gray(
      'No transaction was signed or submitted. Both contract invocations were simulation-only.',
    ),
  );
}
