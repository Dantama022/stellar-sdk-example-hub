import {
  Address,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  xdr,
  rpc,
  scValToNative,
  nativeToScVal,
} from 'stellar-sdk-v16';
import chalk from 'chalk';

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
const BASE_FEE = '100';

/**
 * ISSUE-356: Soroban SEP-41 Token Contract Interface and Compatibility Inspector
 *
 * This example demonstrates inspecting a Soroban token contract for compliance
 * with the SEP-41 token standard interface. SEP-41 defines a standard interface
 * for fungible tokens on Soroban, extending the basic token interface with:
 * - Standard metadata: name, symbol, decimals
 * - Balance and allowance queries
 * - Transfer operations: transfer, transfer_from
 * - Approval operations: approve
 * - Burn operations: burn, burn_from
 * - Events: transfer, mint, burn, approve
 *
 * This example:
 * 1. Inspects the contract specification (if available)
 * 2. Probes standard SEP-41 methods via simulation
 * 3. Validates method signatures and return types
 * 4. Checks event emission compliance
 * 5. Reports compatibility with the SEP-41 standard
 */

const SEP41_REQUIRED_METHODS = [
  'name',
  'symbol',
  'decimals',
  'balance',
  'allowance',
  'transfer',
  'transfer_from',
  'approve',
  'burn',
  'burn_from',
] as const;

const SEP41_OPTIONAL_METHODS = [
  'total_supply',
  'mint',
] as const;

const SEP41_EVENTS = [
  'transfer',
  'mint',
  'burn',
  'approve',
] as const;

export interface Sep41TokenInspectorParams {
  contractId?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  json?: boolean | string;
}

export interface MethodInspectionResult {
  name: string;
  available: boolean;
  returnsExpectedType: boolean;
  returnType: string | null;
  error: string | null;
}

export interface EventInspectionResult {
  name: string;
  emitted: boolean;
  topicsCount: number | null;
  error: string | null;
}

export interface Sep41CompatibilityReport {
  contractId: string;
  networkPassphrase: string;
  specAvailable: boolean;
  discoveredMethods: string[];
  methodResults: MethodInspectionResult[];
  eventResults: EventInspectionResult[];
  requiredMethodsPresent: number;
  requiredMethodsTotal: number;
  optionalMethodsPresent: number;
  optionalMethodsTotal: number;
  eventsPresent: number;
  eventsTotal: number;
  compliant: boolean;
  complianceScore: number;
  issues: string[];
}

function wantsJson(params: Sep41TokenInspectorParams): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json')
  );
}

export function isValidContractId(contractId: string): boolean {
  return StrKey.isValidContract(contractId.trim());
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function buildContractInvocation(
  sourceAccountId: string,
  networkPassphrase: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): rpc.Api.SimulateTransactionRequest {
  const sourceAccount = new rpc.Account(sourceAccountId, '0');
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  return { transaction: tx.toXDR() };
}

async function simulateMethod(
  server: rpc.Server,
  sourceAccountId: string,
  networkPassphrase: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<{ ok: boolean; value?: xdr.ScVal; error?: string; events?: xdr.DiagnosticEvent[] }> {
  try {
    const request = buildContractInvocation(sourceAccountId, networkPassphrase, contractId, method, args);
    const simulation = await server.simulateTransaction(request);

    if (rpc.Api.isSimulationError(simulation)) {
      return { ok: false, error: simulation.error };
    }

    return {
      ok: true,
      value: simulation.result?.retval,
      events: simulation.events ?? [],
    };
  } catch (error) {
    return { ok: false, error: `RPC error: ${getErrorMessage(error)}` };
  }
}

function decodeScValSafe(value: xdr.ScVal | undefined): { type: string; value: unknown } {
  if (!value) return { type: 'void', value: null };
  const type = value.switch().name;
  try {
    return { type, value: scValToNative(value) };
  } catch {
    return { type, value: value.toXDR('base64') };
  }
}

function formatNativeValue(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  if (value === undefined) return '(undefined)';
  if (value === null) return '(null)';
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  } catch {
    return String(value);
  }
}

async function inspectTokenMethods(
  server: rpc.Server,
  rpcUrl: string,
  networkPassphrase: string,
  contractId: string,
): Promise<string[] | null> {
  try {
    const wasm = await server.getContractWasmByContractId(contractId);
    const client = await rpc.Contract.Client.fromWasm(wasm, {
      contractId,
      networkPassphrase,
      rpcUrl,
    });
    return client.spec
      .funcs()
      .map((fn) => fn.name().toString())
      .filter((name) => !name.startsWith('__'))
      .sort();
  } catch {
    return null;
  }
}

async function probeMethod(
  server: rpc.Server,
  sourceAccountId: string,
  networkPassphrase: string,
  contractId: string,
  methodName: string,
  args: xdr.ScVal[] = [],
  expectedReturnType?: string,
): Promise<MethodInspectionResult> {
  const result = await simulateMethod(server, sourceAccountId, networkPassphrase, contractId, methodName, args);

  if (!result.ok) {
    return {
      name: methodName,
      available: false,
      returnsExpectedType: false,
      returnType: null,
      error: result.error ?? 'Unknown error',
    };
  }

  const decoded = result.value ? decodeScValSafe(result.value) : { type: 'void', value: null };
  const returnsExpected = expectedReturnType ? decoded.type === expectedReturnType : true;

  return {
    name: methodName,
    available: true,
    returnsExpectedType: returnsExpected,
    returnType: decoded.type,
    error: returnsExpected ? null : `Expected return type ${expectedReturnType}, got ${decoded.type}`,
  };
}

async function probeEvents(
  server: rpc.Server,
  sourceAccountId: string,
  networkPassphrase: string,
  contractId: string,
): Promise<EventInspectionResult[]> {
  const results: EventInspectionResult[] = [];

  // We need to simulate a transfer to see events
  // Use a dummy account for the from address
  const dummyFrom = Keypair.random().publicKey();
  const dummyTo = Keypair.random().publicKey();

  const transferResult = await simulateMethod(
    server,
    sourceAccountId,
    networkPassphrase,
    contractId,
    'transfer',
    [Address.fromString(dummyFrom).toScVal(), Address.fromString(dummyTo).toScVal(), nativeToScVal(100n, { type: 'i128' })],
  );

  const events = transferResult.events ?? [];

  for (const eventName of SEP41_EVENTS) {
    const matchingEvents = events.filter((e) => {
      try {
        const topics = e.event().body().v0().topics();
        if (topics.length === 0) return false;
        const firstTopic = scValToNative(topics[0]);
        return typeof firstTopic === 'string' && firstTopic === eventName;
      } catch {
        return false;
      }
    });

    if (matchingEvents.length > 0) {
      const firstEvent = matchingEvents[0];
      const topicsCount = firstEvent.event().body().v0().topics().length;
      results.push({
        name: eventName,
        emitted: true,
        topicsCount,
        error: null,
      });
    } else {
      results.push({
        name: eventName,
        emitted: false,
        topicsCount: null,
        error: 'Event not emitted in test simulation',
      });
    }
  }

  return results;
}

export async function run(params: Sep41TokenInspectorParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl?.trim() || process.env.SOROBAN_RPC_URL?.trim() || DEFAULT_RPC_URL;
  const networkPassphrase = params.networkPassphrase?.trim() || process.env.NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;
  const json = wantsJson(params);

  const defaultContractId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'; // Native SAC on Testnet
  const contractId = params.contractId?.trim() || process.env.TOKEN_CONTRACT_ID?.trim() || defaultContractId;

  if (!json) {
    console.log(chalk.bold('\nSEP-41 Token Contract Interface and Compatibility Inspector'));
    console.log(chalk.gray(`RPC: ${rpcUrl}`));
    console.log(chalk.gray(`Network: ${networkPassphrase}`));
    console.log(chalk.gray(`Contract: ${contractId}\n`));
  }

  if (!isValidContractId(contractId)) {
    const error = `Invalid contract ID: ${contractId}`;
    if (json) {
      console.log(JSON.stringify({ error }));
    } else {
      console.error(chalk.red(error));
    }
    return;
  }

  const server = new rpc.Server(rpcUrl);

  // Test connectivity
  try {
    const latestLedger = await server.getLatestLedger();
    if (!json) console.log(chalk.green(`Connected. Latest ledger: ${latestLedger.sequence}`));
  } catch (error) {
    const errorMsg = `Unable to reach Soroban RPC: ${getErrorMessage(error)}`;
    if (json) {
      console.log(JSON.stringify({ error: errorMsg }));
    } else {
      console.error(chalk.red(errorMsg));
    }
    return;
  }

  // Inspect contract spec
  const discoveredMethods = await inspectTokenMethods(server, rpcUrl, networkPassphrase, contractId);
  const specAvailable = discoveredMethods !== null && discoveredMethods.length > 0;

  if (!json) {
    if (specAvailable) {
      console.log(chalk.green(`\nContract spec available with ${discoveredMethods!.length} methods:`));
      discoveredMethods!.forEach((m) => console.log(`  - ${m}`));
    } else {
      console.log(chalk.yellow('\nContract spec not available (common for native SAC). Probing methods via simulation.'));
    }
  }

  // Use a dummy source account for simulation
  const simulationSource = Keypair.random().publicKey();

  // Probe required methods
  const methodResults: MethodInspectionResult[] = [];

  // name() -> string
  methodResults.push(await probeMethod(server, simulationSource, networkPassphrase, contractId, 'name', [], 'scvString'));

  // symbol() -> string
  methodResults.push(await probeMethod(server, simulationSource, networkPassphrase, contractId, 'symbol', [], 'scvString'));

  // decimals() -> u32
  methodResults.push(await probeMethod(server, simulationSource, networkPassphrase, contractId, 'decimals', [], 'scvU32'));

  // balance(address) -> i128
  methodResults.push(
    await probeMethod(
      server,
      simulationSource,
      networkPassphrase,
      contractId,
      'balance',
      [Address.fromString(simulationSource).toScVal()],
      'scvI128',
    ),
  );

  // allowance(address, address) -> i128
  const dummySpender = Keypair.random().publicKey();
  methodResults.push(
    await probeMethod(
      server,
      simulationSource,
      networkPassphrase,
      contractId,
      'allowance',
      [Address.fromString(simulationSource).toScVal(), Address.fromString(dummySpender).toScVal()],
      'scvI128',
    ),
  );

  // transfer(address, address, i128) -> void (but we check it exists)
  methodResults.push(
    await probeMethod(
      server,
      simulationSource,
      networkPassphrase,
      contractId,
      'transfer',
      [
        Address.fromString(simulationSource).toScVal(),
        Address.fromString(dummySpender).toScVal(),
        nativeToScVal(100n, { type: 'i128' }),
      ],
      'scvVoid',
    ),
  );

  // transfer_from(address, address, address, i128) -> void
  methodResults.push(
    await probeMethod(
      server,
      simulationSource,
      networkPassphrase,
      contractId,
      'transfer_from',
      [
        Address.fromString(simulationSource).toScVal(),
        Address.fromString(dummySpender).toScVal(),
        Address.fromString(Keypair.random().publicKey()).toScVal(),
        nativeToScVal(100n, { type: 'i128' }),
      ],
      'scvVoid',
    ),
  );

  // approve(address, address, i128, u64) -> void
  methodResults.push(
    await probeMethod(
      server,
      simulationSource,
      networkPassphrase,
      contractId,
      'approve',
      [
        Address.fromString(simulationSource).toScVal(),
        Address.fromString(dummySpender).toScVal(),
        nativeToScVal(100n, { type: 'i128' }),
        nativeToScVal(1000000n, { type: 'u64' }),
      ],
      'scvVoid',
    ),
  );

  // burn(address, i128) -> void
  methodResults.push(
    await probeMethod(
      server,
      simulationSource,
      networkPassphrase,
      contractId,
      'burn',
      [Address.fromString(simulationSource).toScVal(), nativeToScVal(100n, { type: 'i128' })],
      'scvVoid',
    ),
  );

  // burn_from(address, address, i128) -> void
  methodResults.push(
    await probeMethod(
      server,
      simulationSource,
      networkPassphrase,
      contractId,
      'burn_from',
      [
        Address.fromString(simulationSource).toScVal(),
        Address.fromString(dummySpender).toScVal(),
        nativeToScVal(100n, { type: 'i128' }),
      ],
      'scvVoid',
    ),
  );

  // Probe optional methods
  const totalSupplyResult = await probeMethod(
    server,
    simulationSource,
    networkPassphrase,
    contractId,
    'total_supply',
    [],
    'scvI128',
  );
  methodResults.push(totalSupplyResult);

  const mintResult = await probeMethod(
    server,
    simulationSource,
    networkPassphrase,
    contractId,
    'mint',
    [Address.fromString(simulationSource).toScVal(), nativeToScVal(100n, { type: 'i128' })],
    'scvVoid',
  );
  methodResults.push(mintResult);

  // Probe events
  const eventResults = await probeEvents(server, simulationSource, networkPassphrase, contractId);

  // Calculate compliance
  const requiredPresent = methodResults
    .filter((m) => SEP41_REQUIRED_METHODS.includes(m.name as (typeof SEP41_REQUIRED_METHODS)[number]))
    .filter((m) => m.available).length;
  const requiredTotal = SEP41_REQUIRED_METHODS.length;

  const optionalPresent = methodResults
    .filter((m) => SEP41_OPTIONAL_METHODS.includes(m.name as (typeof SEP41_OPTIONAL_METHODS)[number]))
    .filter((m) => m.available).length;
  const optionalTotal = SEP41_OPTIONAL_METHODS.length;

  const eventsPresent = eventResults.filter((e) => e.emitted).length;
  const eventsTotal = SEP41_EVENTS.length;

  const issues: string[] = [];

  for (const method of methodResults) {
    if (SEP41_REQUIRED_METHODS.includes(method.name as (typeof SEP41_REQUIRED_METHODS)[number])) {
      if (!method.available) {
        issues.push(`Missing required method: ${method.name}`);
      } else if (!method.returnsExpectedType) {
        issues.push(`Method ${method.name} has unexpected return type: ${method.returnType}`);
      }
    }
  }

  for (const event of eventResults) {
    if (!event.emitted) {
      issues.push(`Event ${event.name} not observed (may be emitted only on successful execution)`);
    }
  }

  const complianceScore = Math.round(
    ((requiredPresent / requiredTotal) * 0.7 +
      (optionalPresent / optionalTotal) * 0.15 +
      (eventsPresent / eventsTotal) * 0.15) *
      100,
  );

  const compliant = requiredPresent === requiredTotal && issues.length === 0;

  const report: Sep41CompatibilityReport = {
    contractId,
    networkPassphrase,
    specAvailable,
    discoveredMethods: discoveredMethods ?? [],
    methodResults,
    eventResults,
    requiredMethodsPresent: requiredPresent,
    requiredMethodsTotal: requiredTotal,
    optionalMethodsPresent: optionalPresent,
    optionalMethodsTotal: optionalTotal,
    eventsPresent,
    eventsTotal,
    compliant,
    complianceScore,
    issues,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Print report
  console.log(chalk.bold('\n=== SEP-41 Method Compliance ==='));
  for (const method of methodResults) {
    const isRequired = SEP41_REQUIRED_METHODS.includes(method.name as (typeof SEP41_REQUIRED_METHODS)[number]);
    const isOptional = SEP41_OPTIONAL_METHODS.includes(method.name as (typeof SEP41_OPTIONAL_METHODS)[number]);
    const badge = isRequired ? chalk.bold('REQUIRED') : isOptional ? chalk.cyan('OPTIONAL') : '';

    if (method.available) {
      const typeMatch = method.returnsExpectedType ? chalk.green('✓') : chalk.yellow('⚠');
      console.log(`  ${typeMatch} ${method.name.padEnd(15)} ${badge}  returns: ${method.returnType}`);
      if (!method.returnsExpectedType) {
        console.log(chalk.gray(`       Expected different return type`));
      }
    } else {
      const marker = isRequired ? chalk.red('✗') : chalk.gray('○');
      console.log(`  ${marker} ${method.name.padEnd(15)} ${badge}  ${method.error}`);
    }
  }

  console.log(chalk.bold('\n=== SEP-41 Event Compliance ==='));
  for (const event of eventResults) {
    if (event.emitted) {
      console.log(`  ${chalk.green('✓')} ${event.name.padEnd(10)} emitted (${event.topicsCount} topics)`);
    } else {
      console.log(`  ${chalk.yellow('⚠')} ${event.name.padEnd(10)} not observed in test simulation`);
    }
  }

  console.log(chalk.bold('\n=== Compliance Summary ==='));
  console.log(`Required methods:   ${requiredPresent} / ${requiredTotal}`);
  console.log(`Optional methods:   ${optionalPresent} / ${optionalTotal}`);
  console.log(`Events observed:    ${eventsPresent} / ${eventsTotal}`);
  console.log(`Compliance score:   ${complianceScore}%`);

  if (compliant) {
    console.log(chalk.green('\n✓ Contract appears compliant with SEP-41 standard'));
  } else {
    console.log(chalk.yellow('\n⚠ Contract has compliance issues:'));
    issues.forEach((issue) => console.log(chalk.yellow(`  - ${issue}`)));
  }

  if (!json) {
    console.log(chalk.gray('\nNote: Event emission is only observable on successful transaction execution.'));
    console.log(chalk.gray('This example uses simulation which may not emit events for failed calls.'));
  }
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}