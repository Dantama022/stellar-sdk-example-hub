import {
  Account,
  Contract,
  Networks,
  rpc,
  TransactionBuilder,
  contract,
  xdr,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

// ---------------------------------------------------------------------------
// Network configuration types
// ---------------------------------------------------------------------------

export interface NetworkConfig {
  /** Human-readable label for this environment (e.g. "testnet", "mainnet"). */
  name: string;
  /** Soroban RPC endpoint URL. */
  rpcUrl: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /** Contract address to inspect on this network. */
  contractAddress: string;
}

export type NetworkPassphraseValidationStatus =
  | 'valid'
  | 'mismatch'
  | 'unreachable'
  | 'inconclusive';

export type ContractAvailabilityStatus =
  | 'available'
  | 'not_found'
  | 'rpc_error'
  | 'invalid_address';

export type SimulationStatus = 'success' | 'error' | 'rpc_error' | 'skipped';

// ---------------------------------------------------------------------------
// Per-network result types
// ---------------------------------------------------------------------------

export interface NetworkPassphraseCheckResult {
  networkName: string;
  status: NetworkPassphraseValidationStatus;
  detectedPassphrase: string | null;
  configuredPassphrase: string;
  error: string | null;
}

export interface ContractAvailabilityResult {
  networkName: string;
  contractAddress: string;
  status: ContractAvailabilityStatus;
  currentLedger: number | null;
  liveUntilLedger: number | null;
  codeHash: string | null;
  error: string | null;
}

export interface FunctionSignature {
  name: string;
  inputs: Array<{ name: string; type: string }>;
  outputs: string[];
}

export interface InterfaceCheckResult {
  networkName: string;
  contractAddress: string;
  available: boolean;
  functions: FunctionSignature[];
  error: string | null;
}

export interface SimulationResult {
  networkName: string;
  contractAddress: string;
  functionName: string;
  status: SimulationStatus;
  returnValue: string | null;
  cpuInstructions: number | null;
  memoryBytes: number | null;
  minResourceFee: string | null;
  error: string | null;
  diagnostics: string[];
}

// ---------------------------------------------------------------------------
// Comparison + report types
// ---------------------------------------------------------------------------

export type CompatibilityLevel = 'compatible' | 'partial' | 'incompatible' | 'inconclusive';

export interface CompatibilityReport {
  generatedAt: string;
  networks: Array<{
    name: string;
    rpcUrl: string;
    passphraseStatus: NetworkPassphraseValidationStatus;
    contractAddress: string;
    contractAvailability: ContractAvailabilityStatus;
  }>;
  interfaceComparison: {
    status: CompatibilityLevel;
    missingFunctions: Array<{ networkName: string; functionName: string }>;
    incompatibleSignatures: Array<{
      functionName: string;
      details: string;
    }>;
    details: string;
  };
  simulationComparison: {
    functionName: string | null;
    results: SimulationResult[];
    returnValueMatch: boolean | null;
    resourceDifferences: Array<{
      metric: string;
      values: Record<string, string | number | null>;
    }>;
    details: string;
  };
  differences: string[];
  warnings: string[];
  overallCompatibility: CompatibilityLevel;
}

// ---------------------------------------------------------------------------
// Validation helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Throw if a URL is not http(s) or is otherwise malformed. */
export function validateRpcUrl(url: string): string {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid RPC URL: "${trimmed}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid RPC URL: "${trimmed}" must use http or https, got "${parsed.protocol}".`,
    );
  }
  return trimmed;
}

/** Return true when the value looks like a Stellar contract address. */
export function isValidContractAddress(address: string): boolean {
  if (typeof address !== 'string') return false;
  return /^C[A-Z2-7]{55}$/.test(address.trim());
}

/** Throw on obviously invalid network configuration. */
export function validateNetworkConfig(config: NetworkConfig): void {
  if (!config.name || !config.name.trim()) {
    throw new Error('Network config is missing a name.');
  }
  validateRpcUrl(config.rpcUrl);
  if (!config.networkPassphrase || !config.networkPassphrase.trim()) {
    throw new Error(`Network "${config.name}": networkPassphrase must not be empty.`);
  }
  if (!isValidContractAddress(config.contractAddress)) {
    throw new Error(
      `Network "${config.name}": contractAddress "${config.contractAddress}" is not a valid contract address.`,
    );
  }
}

/** Normalize an error value to a plain message string. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Step 1 — Passphrase validation
// ---------------------------------------------------------------------------

/**
 * Connect to each network and compare the passphrase returned by
 * `getNetwork()` against what the caller configured.
 *
 * Uses the injected factory so tests can supply a mock server.
 */
export async function checkNetworkPassphrases(
  configs: NetworkConfig[],
  makeServer: (url: string) => Pick<rpc.Server, 'getNetwork'>,
): Promise<NetworkPassphraseCheckResult[]> {
  return Promise.all(
    configs.map(async (cfg) => {
      try {
        const server = makeServer(cfg.rpcUrl);
        const networkInfo = await server.getNetwork();
        const detected = networkInfo.passphrase ?? null;
        const status: NetworkPassphraseValidationStatus =
          detected === cfg.networkPassphrase ? 'valid' : 'mismatch';
        return {
          networkName: cfg.name,
          status,
          detectedPassphrase: detected,
          configuredPassphrase: cfg.networkPassphrase,
          error: null,
        };
      } catch (err) {
        return {
          networkName: cfg.name,
          status: 'unreachable' as NetworkPassphraseValidationStatus,
          detectedPassphrase: null,
          configuredPassphrase: cfg.networkPassphrase,
          error: errorMessage(err),
        };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Contract availability
// ---------------------------------------------------------------------------

function buildInstanceKey(contractAddress: string): xdr.LedgerKey {
  const contractObj = new Contract(contractAddress);
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractObj.address().toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

export async function checkContractAvailability(
  configs: NetworkConfig[],
  makeServer: (url: string) => Pick<rpc.Server, 'getLatestLedger' | 'getLedgerEntries'>,
): Promise<ContractAvailabilityResult[]> {
  return Promise.all(
    configs.map(async (cfg) => {
      if (!isValidContractAddress(cfg.contractAddress)) {
        return {
          networkName: cfg.name,
          contractAddress: cfg.contractAddress,
          status: 'invalid_address' as ContractAvailabilityStatus,
          currentLedger: null,
          liveUntilLedger: null,
          codeHash: null,
          error: `"${cfg.contractAddress}" is not a valid contract address.`,
        };
      }

      try {
        const server = makeServer(cfg.rpcUrl);
        const latestLedger = await server.getLatestLedger();
        const key = buildInstanceKey(cfg.contractAddress);
        const response = await server.getLedgerEntries(key);

        if (!response.entries || response.entries.length === 0) {
          return {
            networkName: cfg.name,
            contractAddress: cfg.contractAddress,
            status: 'not_found' as ContractAvailabilityStatus,
            currentLedger: latestLedger.sequence,
            liveUntilLedger: null,
            codeHash: null,
            error: null,
          };
        }

        const entry = response.entries[0];
        const liveUntilLedger =
          (entry as unknown as { liveUntilLedgerSeq?: number }).liveUntilLedgerSeq ?? null;

        // Extract code hash when present
        let codeHash: string | null = null;
        try {
          const ledgerEntry = entry.val as unknown as xdr.LedgerEntry;
          const data = (ledgerEntry as any).data?.().contractData?.() ?? (ledgerEntry as any).contractData?.();
          if (data) {
            const val = data.val();
            if (val.switch() === xdr.ScValType.scvContractInstance()) {
              const exec = val.instance().executable();
              if (exec.switch() === xdr.ContractExecutableType.contractExecutableWasm()) {
                codeHash = exec.wasmHash().toString('hex');
              }
            }
          }
        } catch {
          // non-fatal
        }

        return {
          networkName: cfg.name,
          contractAddress: cfg.contractAddress,
          status: 'available' as ContractAvailabilityStatus,
          currentLedger: latestLedger.sequence,
          liveUntilLedger: typeof liveUntilLedger === 'number' ? liveUntilLedger : null,
          codeHash,
          error: null,
        };
      } catch (err) {
        return {
          networkName: cfg.name,
          contractAddress: cfg.contractAddress,
          status: 'rpc_error' as ContractAvailabilityStatus,
          currentLedger: null,
          liveUntilLedger: null,
          codeHash: null,
          error: errorMessage(err),
        };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Interface inspection
// ---------------------------------------------------------------------------

function resolveTypeName(typeDef: xdr.ScSpecTypeDef): string {
  const t = typeDef.switch();
  const name = t.name as string;
  const typeMap: Record<string, string> = {
    scSpecTypeVoid: 'void',
    scSpecTypeBool: 'bool',
    scSpecTypeU32: 'u32',
    scSpecTypeI32: 'i32',
    scSpecTypeU64: 'u64',
    scSpecTypeI64: 'i64',
    scSpecTypeU128: 'u128',
    scSpecTypeI128: 'i128',
    scSpecTypeU256: 'u256',
    scSpecTypeI256: 'i256',
    scSpecTypeBytes: 'bytes',
    scSpecTypeString: 'string',
    scSpecTypeSymbol: 'symbol',
    scSpecTypeAddress: 'address',
  };
  if (name in typeMap) return typeMap[name];
  try {
    if (name === 'scSpecTypeVec') return `vec<${resolveTypeName(typeDef.vec().elementType())}>`;
    if (name === 'scSpecTypeMap')
      return `map<${resolveTypeName(typeDef.map().keyType())},${resolveTypeName(typeDef.map().valueType())}>`;
    if (name === 'scSpecTypeOption') return `option<${resolveTypeName(typeDef.option().valueType())}>`;
    if (name === 'scSpecTypeTuple')
      return `tuple<${typeDef
        .tuple()
        .valueTypes()
        .map((vt: xdr.ScSpecTypeDef) => resolveTypeName(vt))
        .join(',')}>`;
    if (name === 'scSpecTypeUdt') return typeDef.udt().name().toString();
  } catch {
    // fall through
  }
  return name;
}

export async function inspectContractInterface(
  configs: NetworkConfig[],
  makeServer: (url: string) => Pick<rpc.Server, 'getContractWasmByContractId'>,
): Promise<InterfaceCheckResult[]> {
  return Promise.all(
    configs.map(async (cfg) => {
      if (!isValidContractAddress(cfg.contractAddress)) {
        return {
          networkName: cfg.name,
          contractAddress: cfg.contractAddress,
          available: false,
          functions: [],
          error: `"${cfg.contractAddress}" is not a valid contract address.`,
        };
      }

      try {
        const server = makeServer(cfg.rpcUrl);
        const wasm = await server.getContractWasmByContractId(cfg.contractAddress);

        // Extract the contractspecv0 custom section from the WASM bytes and
        // parse each XDR ScSpecEntry from it.
        const wasmBytes = wasm instanceof Uint8Array ? wasm : Buffer.from(wasm as Buffer);
        const wasmModule = new WebAssembly.Module(new Uint8Array(wasmBytes));
        const sections = WebAssembly.Module.customSections(wasmModule, 'contractspecv0');

        if (!sections.length) {
          return {
            networkName: cfg.name,
            contractAddress: cfg.contractAddress,
            available: true,
            functions: [],
            error: 'No contractspecv0 section found in WASM — spec unavailable.',
          };
        }

        // Build ScSpecEntry list from the raw section bytes
        const specEntries: xdr.ScSpecEntry[] = [];
        for (const section of sections) {
          const bytes = Buffer.from(section);
          let offset = 0;
          while (offset < bytes.length) {
            try {
              const entry = xdr.ScSpecEntry.fromXDR(bytes.slice(offset));
              specEntries.push(entry);
              offset += entry.toXDR().length;
            } catch {
              break;
            }
          }
        }

        const spec = new contract.Spec(specEntries);
        const fns: FunctionSignature[] = spec.funcs().map((fn: xdr.ScSpecFunctionV0) => ({
          name: fn.name().toString(),
          inputs: fn.inputs().map((inp: xdr.ScSpecFunctionInputV0) => ({
            name: inp.name().toString(),
            type: resolveTypeName(inp.type()),
          })),
          outputs: fn.outputs().map((o: xdr.ScSpecTypeDef) => resolveTypeName(o)),
        }));

        return {
          networkName: cfg.name,
          contractAddress: cfg.contractAddress,
          available: true,
          functions: fns,
          error: null,
        };
      } catch (err) {
        return {
          networkName: cfg.name,
          contractAddress: cfg.contractAddress,
          available: false,
          functions: [],
          error: errorMessage(err),
        };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Read-only simulation
// ---------------------------------------------------------------------------

/** Dummy placeholder account used only as transaction source for simulation. */
const PLACEHOLDER_SOURCE = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export async function simulateAcrossNetworks(
  configs: NetworkConfig[],
  functionName: string,
  args: xdr.ScVal[],
  makeServer: (url: string) => Pick<rpc.Server, 'simulateTransaction'>,
): Promise<SimulationResult[]> {
  return Promise.all(
    configs.map(async (cfg) => {
      if (!isValidContractAddress(cfg.contractAddress)) {
        return {
          networkName: cfg.name,
          contractAddress: cfg.contractAddress,
          functionName,
          status: 'skipped' as SimulationStatus,
          returnValue: null,
          cpuInstructions: null,
          memoryBytes: null,
          minResourceFee: null,
          error: `"${cfg.contractAddress}" is not a valid contract address.`,
          diagnostics: [],
        };
      }

      try {
        const server = makeServer(cfg.rpcUrl);
        const source = new Account(PLACEHOLDER_SOURCE, '0');
        const contract = new Contract(cfg.contractAddress);

        const tx = new TransactionBuilder(source, {
          fee: '100',
          networkPassphrase: cfg.networkPassphrase,
        })
          .addOperation(contract.call(functionName, ...args))
          .setTimeout(0)
          .build();

        const sim = await server.simulateTransaction(tx);

        if (rpc.Api.isSimulationError(sim)) {
          return {
            networkName: cfg.name,
            contractAddress: cfg.contractAddress,
            functionName,
            status: 'error' as SimulationStatus,
            returnValue: null,
            cpuInstructions: null,
            memoryBytes: null,
            minResourceFee: null,
            error: sim.error,
            diagnostics: (sim.events ?? []).map((e) => JSON.stringify(e)),
          };
        }

        if (!rpc.Api.isSimulationSuccess(sim)) {
          return {
            networkName: cfg.name,
            contractAddress: cfg.contractAddress,
            functionName,
            status: 'error' as SimulationStatus,
            returnValue: null,
            cpuInstructions: null,
            memoryBytes: null,
            minResourceFee: null,
            error: 'Unexpected simulation response type (restore preamble or unknown).',
            diagnostics: [],
          };
        }

        const returnVal = sim.result?.retval;
        const returnValueStr = returnVal ? returnVal.toXDR('base64') : null;

        const minResourceFee = sim.minResourceFee ?? null;

        // Extract CPU and memory from the transaction data footprint where available.
        // The SDK v13 SimulateTransactionSuccessResponse doesn't expose a cost summary
        // directly; `minResourceFee` is the most reliable per-network resource metric.
        let cpuInstructions: number | null = null;
        let memoryBytes: number | null = null;
        try {
          const txData = sim.transactionData;
          if (txData) {
            const resources = txData.build().resources();
            cpuInstructions = resources.instructions();
            memoryBytes = resources.readBytes() + resources.writeBytes();
          }
        } catch {
          // non-fatal
        }

        return {
          networkName: cfg.name,
          contractAddress: cfg.contractAddress,
          functionName,
          status: 'success' as SimulationStatus,
          returnValue: returnValueStr,
          cpuInstructions,
          memoryBytes,
          minResourceFee: minResourceFee?.toString() ?? null,
          error: null,
          diagnostics: (sim.events ?? []).map((e) => JSON.stringify(e)),
        };
      } catch (err) {
        return {
          networkName: cfg.name,
          contractAddress: cfg.contractAddress,
          functionName,
          status: 'rpc_error' as SimulationStatus,
          returnValue: null,
          cpuInstructions: null,
          memoryBytes: null,
          minResourceFee: null,
          error: errorMessage(err),
          diagnostics: [],
        };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Step 5 — Comparison
// ---------------------------------------------------------------------------

export interface InterfaceComparisonResult {
  status: CompatibilityLevel;
  missingFunctions: Array<{ networkName: string; functionName: string }>;
  incompatibleSignatures: Array<{ functionName: string; details: string }>;
  details: string;
}

export function compareInterfaces(results: InterfaceCheckResult[]): InterfaceComparisonResult {
  const available = results.filter((r) => r.available);
  if (available.length === 0) {
    return {
      status: 'inconclusive',
      missingFunctions: [],
      incompatibleSignatures: [],
      details: 'No interface data could be retrieved from any network.',
    };
  }
  if (available.length === 1) {
    return {
      status: 'inconclusive',
      missingFunctions: [],
      incompatibleSignatures: [],
      details: `Interface data is available for only one network (${available[0].networkName}). Cannot compare.`,
    };
  }

  // Collect union of all function names
  const allFunctionNames = new Set<string>();
  for (const r of available) {
    for (const f of r.functions) allFunctionNames.add(f.name);
  }

  const missingFunctions: InterfaceComparisonResult['missingFunctions'] = [];
  const incompatibleSignatures: InterfaceComparisonResult['incompatibleSignatures'] = [];

  for (const fnName of allFunctionNames) {
    const perNetwork = available.map((r) => ({
      networkName: r.networkName,
      fn: r.functions.find((f) => f.name === fnName) ?? null,
    }));

    for (const pn of perNetwork) {
      if (!pn.fn) {
        missingFunctions.push({ networkName: pn.networkName, functionName: fnName });
      }
    }

    // Compare signatures among networks that have the function
    const withFn = perNetwork.filter((pn) => pn.fn !== null);
    if (withFn.length >= 2) {
      const baseline = withFn[0].fn!;
      for (const pn of withFn.slice(1)) {
        const target = pn.fn!;
        // Compare input count
        if (baseline.inputs.length !== target.inputs.length) {
          incompatibleSignatures.push({
            functionName: fnName,
            details: `"${withFn[0].networkName}" has ${baseline.inputs.length} input(s) but "${pn.networkName}" has ${target.inputs.length}.`,
          });
          continue;
        }
        // Compare each input type
        for (let i = 0; i < baseline.inputs.length; i++) {
          if (baseline.inputs[i].type !== target.inputs[i].type) {
            incompatibleSignatures.push({
              functionName: fnName,
              details: `Input "${baseline.inputs[i].name}" differs: "${withFn[0].networkName}" is "${baseline.inputs[i].type}", "${pn.networkName}" is "${target.inputs[i].type}".`,
            });
          }
        }
        // Compare output types
        const baselineOutputs = baseline.outputs.join(',');
        const targetOutputs = target.outputs.join(',');
        if (baselineOutputs !== targetOutputs) {
          incompatibleSignatures.push({
            functionName: fnName,
            details: `Return type of "${fnName}" differs: "${withFn[0].networkName}" returns [${baselineOutputs}], "${pn.networkName}" returns [${targetOutputs}].`,
          });
        }
      }
    }
  }

  let status: CompatibilityLevel;
  if (missingFunctions.length === 0 && incompatibleSignatures.length === 0) {
    status = 'compatible';
  } else if (missingFunctions.length > 0 && incompatibleSignatures.length === 0) {
    status = 'partial';
  } else {
    status = 'incompatible';
  }

  const details =
    status === 'compatible'
      ? `All ${allFunctionNames.size} function(s) match across ${available.length} network(s).`
      : `Found ${missingFunctions.length} missing function(s) and ${incompatibleSignatures.length} signature incompatibilit(ies).`;

  return { status, missingFunctions, incompatibleSignatures, details };
}

export interface SimulationComparisonResult {
  returnValueMatch: boolean | null;
  resourceDifferences: Array<{ metric: string; values: Record<string, string | number | null> }>;
  details: string;
}

export function compareSimulationResults(results: SimulationResult[]): SimulationComparisonResult {
  const successful = results.filter((r) => r.status === 'success');
  if (successful.length < 2) {
    return {
      returnValueMatch: null,
      resourceDifferences: [],
      details:
        successful.length === 0
          ? 'No successful simulation results to compare.'
          : `Only one network ("${successful[0].networkName}") succeeded. Cannot compare.`,
    };
  }

  const baseline = successful[0];
  let returnValueMatch = true;
  for (const r of successful.slice(1)) {
    if (r.returnValue !== baseline.returnValue) {
      returnValueMatch = false;
    }
  }

  const resourceDifferences: SimulationComparisonResult['resourceDifferences'] = [];
  const cpuValues: Record<string, number | null> = {};
  const memValues: Record<string, number | null> = {};
  const feeValues: Record<string, string | null> = {};

  for (const r of successful) {
    cpuValues[r.networkName] = r.cpuInstructions;
    memValues[r.networkName] = r.memoryBytes;
    feeValues[r.networkName] = r.minResourceFee;
  }

  const cpuSet = new Set(Object.values(cpuValues));
  if (cpuSet.size > 1) {
    resourceDifferences.push({ metric: 'cpuInstructions', values: cpuValues });
  }
  const memSet = new Set(Object.values(memValues));
  if (memSet.size > 1) {
    resourceDifferences.push({ metric: 'memoryBytes', values: memValues });
  }
  const feeSet = new Set(Object.values(feeValues));
  if (feeSet.size > 1) {
    resourceDifferences.push({ metric: 'minResourceFee', values: feeValues });
  }

  return {
    returnValueMatch,
    resourceDifferences,
    details: `${successful.length} network(s) succeeded. Return values ${returnValueMatch ? 'match' : 'differ'}. ${resourceDifferences.length} resource metric(s) differ.`,
  };
}

// ---------------------------------------------------------------------------
// Step 6 — Report generation
// ---------------------------------------------------------------------------

export function buildCompatibilityReport(params: {
  configs: NetworkConfig[];
  passphraseChecks: NetworkPassphraseCheckResult[];
  availabilityResults: ContractAvailabilityResult[];
  interfaceResults: InterfaceCheckResult[];
  interfaceComparison: InterfaceComparisonResult;
  simulationResults: SimulationResult[];
  simulationComparison: SimulationComparisonResult;
  functionName: string | null;
}): CompatibilityReport {
  const {
    configs,
    passphraseChecks,
    availabilityResults,
    interfaceComparison,
    simulationResults,
    simulationComparison,
    functionName,
  } = params;

  const differences: string[] = [];
  const warnings: string[] = [];

  // Passphrase issues
  for (const check of passphraseChecks) {
    if (check.status === 'mismatch') {
      differences.push(
        `Network "${check.networkName}": passphrase mismatch — configured "${check.configuredPassphrase}", endpoint reports "${check.detectedPassphrase}".`,
      );
    }
    if (check.status === 'unreachable') {
      warnings.push(`Network "${check.networkName}" RPC is unreachable: ${check.error}`);
    }
  }

  // Availability differences
  const availableNetworks = availabilityResults.filter((r) => r.status === 'available').map((r) => r.networkName);
  const unavailableNetworks = availabilityResults.filter((r) => r.status !== 'available').map((r) => r.networkName);
  if (availableNetworks.length > 0 && unavailableNetworks.length > 0) {
    differences.push(
      `Contract available on [${availableNetworks.join(', ')}] but not on [${unavailableNetworks.join(', ')}].`,
    );
  }

  // Interface differences
  for (const m of interfaceComparison.missingFunctions) {
    differences.push(`Function "${m.functionName}" is missing on network "${m.networkName}".`);
  }
  for (const s of interfaceComparison.incompatibleSignatures) {
    differences.push(`Incompatible signature for "${s.functionName}": ${s.details}`);
  }

  // Simulation differences
  if (simulationComparison.returnValueMatch === false) {
    differences.push('Simulation return values differ across networks.');
  }
  for (const rd of simulationComparison.resourceDifferences) {
    warnings.push(
      `Resource metric "${rd.metric}" differs: ${JSON.stringify(rd.values)}`,
    );
  }

  // Warnings for inconclusive interface data
  const unavailableInterface = params.interfaceResults.filter((r) => !r.available);
  for (const r of unavailableInterface) {
    warnings.push(
      `Interface data unavailable for "${r.networkName}": ${r.error ?? 'unknown error'}`,
    );
  }

  // Determine overall compatibility
  let overallCompatibility: CompatibilityLevel;
  const anyPassphraseMismatch = passphraseChecks.some((c) => c.status === 'mismatch');
  if (anyPassphraseMismatch || interfaceComparison.status === 'incompatible') {
    overallCompatibility = 'incompatible';
  } else if (differences.length > 0) {
    overallCompatibility = 'partial';
  } else if (
    interfaceComparison.status === 'inconclusive' ||
    simulationComparison.returnValueMatch === null
  ) {
    overallCompatibility = 'inconclusive';
  } else {
    overallCompatibility = 'compatible';
  }

  return {
    generatedAt: new Date().toISOString(),
    networks: configs.map((cfg) => {
      const passCheck = passphraseChecks.find((c) => c.networkName === cfg.name);
      const avail = availabilityResults.find((r) => r.networkName === cfg.name);
      return {
        name: cfg.name,
        rpcUrl: cfg.rpcUrl,
        passphraseStatus: passCheck?.status ?? 'inconclusive',
        contractAddress: cfg.contractAddress,
        contractAvailability: avail?.status ?? 'rpc_error',
      };
    }),
    interfaceComparison: {
      status: interfaceComparison.status,
      missingFunctions: interfaceComparison.missingFunctions,
      incompatibleSignatures: interfaceComparison.incompatibleSignatures,
      details: interfaceComparison.details,
    },
    simulationComparison: {
      functionName,
      results: simulationResults,
      returnValueMatch: simulationComparison.returnValueMatch,
      resourceDifferences: simulationComparison.resourceDifferences,
      details: simulationComparison.details,
    },
    differences,
    warnings,
    overallCompatibility,
  };
}

// ---------------------------------------------------------------------------
// Orchestration / run
// ---------------------------------------------------------------------------

export interface CrossNetworkCompatibilityParams {
  networks?: NetworkConfig[];
  functionName?: string;
  functionArgs?: xdr.ScVal[];
}

const DEFAULT_TESTNET_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const DEFAULT_FUNCTION_NAME = 'hello';

function defaultNetworks(): NetworkConfig[] {
  return [
    {
      name: 'testnet',
      rpcUrl: process.env.TESTNET_RPC_URL ?? 'https://soroban-testnet.stellar.org',
      networkPassphrase: Networks.TESTNET,
      contractAddress: process.env.TESTNET_CONTRACT_ADDRESS ?? DEFAULT_TESTNET_CONTRACT,
    },
    {
      name: 'testnet-alt',
      rpcUrl: process.env.TESTNET_ALT_RPC_URL ?? 'https://soroban-testnet.stellar.org',
      networkPassphrase: Networks.TESTNET,
      contractAddress: process.env.TESTNET_ALT_CONTRACT_ADDRESS ?? DEFAULT_TESTNET_CONTRACT,
    },
  ];
}

export async function run(params: CrossNetworkCompatibilityParams = {}): Promise<void> {
  const configs = params.networks ?? defaultNetworks();
  const functionName = params.functionName ?? process.env.CONTRACT_FUNCTION ?? DEFAULT_FUNCTION_NAME;
  const functionArgs = params.functionArgs ?? [];

  console.log(chalk.bold('\nSoroban Cross-Network Compatibility Checker'));
  console.log(chalk.gray('Read-only inspection and simulation across multiple Stellar networks.\n'));

  // Validate all configs up front
  for (const cfg of configs) {
    try {
      validateNetworkConfig(cfg);
    } catch (err) {
      console.error(chalk.red(`Configuration error: ${errorMessage(err)}`));
      return;
    }
  }

  const makeRpcServer = (url: string) => new rpc.Server(url);

  // ── Step 1: Passphrase validation ──────────────────────────────────────────
  console.log(chalk.yellow('Step 1: Validating network passphrases...'));
  const passphraseChecks = await checkNetworkPassphrases(configs, makeRpcServer);
  for (const check of passphraseChecks) {
    const icon = check.status === 'valid' ? '✓' : check.status === 'mismatch' ? '✗' : '?';
    const color =
      check.status === 'valid' ? chalk.green : check.status === 'mismatch' ? chalk.red : chalk.yellow;
    console.log(color(`  [${icon}] ${check.networkName}: ${check.status}`));
    if (check.status === 'mismatch') {
      console.log(chalk.red(`      Expected: ${check.configuredPassphrase}`));
      console.log(chalk.red(`      Detected: ${check.detectedPassphrase}`));
    }
    if (check.error) {
      console.log(chalk.gray(`      Error: ${check.error}`));
    }
  }

  // ── Step 2: Contract availability ──────────────────────────────────────────
  console.log(chalk.yellow('\nStep 2: Checking contract availability...'));
  const availabilityResults = await checkContractAvailability(configs, makeRpcServer);
  for (const result of availabilityResults) {
    const icon = result.status === 'available' ? '✓' : '✗';
    const color = result.status === 'available' ? chalk.green : chalk.red;
    console.log(color(`  [${icon}] ${result.networkName} (${result.contractAddress}): ${result.status}`));
    if (result.codeHash) {
      console.log(chalk.gray(`      Code hash: ${result.codeHash.slice(0, 16)}...`));
    }
    if (result.error) {
      console.log(chalk.gray(`      ${result.error}`));
    }
  }

  // ── Step 3: Interface inspection ───────────────────────────────────────────
  console.log(chalk.yellow('\nStep 3: Inspecting contract interfaces...'));
  const interfaceResults = await inspectContractInterface(configs, makeRpcServer as any);
  for (const result of interfaceResults) {
    if (result.available) {
      console.log(
        chalk.green(
          `  [✓] ${result.networkName}: ${result.functions.length} function(s) found.`,
        ),
      );
      for (const fn of result.functions) {
        const inputs = fn.inputs.map((i) => `${i.name}: ${i.type}`).join(', ');
        console.log(chalk.gray(`      ${fn.name}(${inputs}) → [${fn.outputs.join(', ')}]`));
      }
    } else {
      console.log(chalk.yellow(`  [?] ${result.networkName}: spec unavailable — ${result.error}`));
    }
  }

  const interfaceComparison = compareInterfaces(interfaceResults);
  console.log(chalk.cyan(`\n  Interface comparison: ${interfaceComparison.status}`));
  console.log(chalk.gray(`  ${interfaceComparison.details}`));

  // ── Step 4: Simulation ─────────────────────────────────────────────────────
  console.log(chalk.yellow(`\nStep 4: Simulating "${functionName}" across networks...`));
  const simulationResults = await simulateAcrossNetworks(
    configs,
    functionName,
    functionArgs,
    makeRpcServer as any,
  );
  for (const result of simulationResults) {
    const icon = result.status === 'success' ? '✓' : result.status === 'skipped' ? '-' : '✗';
    const color =
      result.status === 'success'
        ? chalk.green
        : result.status === 'skipped'
          ? chalk.gray
          : chalk.red;
    console.log(color(`  [${icon}] ${result.networkName}: ${result.status}`));
    if (result.returnValue) {
      console.log(chalk.gray(`      Return value (base64 XDR): ${result.returnValue.slice(0, 40)}...`));
    }
    if (result.cpuInstructions !== null) {
      console.log(chalk.gray(`      CPU: ${result.cpuInstructions.toLocaleString()} instructions`));
    }
    if (result.error) {
      console.log(chalk.gray(`      Error: ${result.error}`));
    }
  }

  const simulationComparison = compareSimulationResults(simulationResults);
  console.log(chalk.cyan(`\n  Simulation comparison: ${simulationComparison.details}`));

  // ── Step 5: Report ─────────────────────────────────────────────────────────
  const report = buildCompatibilityReport({
    configs,
    passphraseChecks,
    availabilityResults,
    interfaceResults,
    interfaceComparison,
    simulationResults,
    simulationComparison,
    functionName,
  });

  console.log(chalk.bold('\n──── Compatibility Report ────'));
  console.log(chalk.cyan(`Generated: ${report.generatedAt}`));
  console.log(
    (report.overallCompatibility === 'compatible' ? chalk.green : report.overallCompatibility === 'incompatible' ? chalk.red : chalk.yellow)(
      `Overall compatibility: ${report.overallCompatibility.toUpperCase()}`,
    ),
  );

  if (report.differences.length > 0) {
    console.log(chalk.red('\nDifferences detected:'));
    for (const d of report.differences) {
      console.log(chalk.red(`  • ${d}`));
    }
  }

  if (report.warnings.length > 0) {
    console.log(chalk.yellow('\nWarnings / inconclusive:'));
    for (const w of report.warnings) {
      console.log(chalk.yellow(`  ⚠ ${w}`));
    }
  }

  if (report.differences.length === 0 && report.warnings.length === 0) {
    console.log(chalk.green('\nNo differences or warnings detected.'));
  }

  console.log('');
}
