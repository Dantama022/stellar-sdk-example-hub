/**
 * Tests for ISSUE-432: Soroban Cross-Network Compatibility Checker
 *
 * All RPC interaction is replaced with deterministic mocks.
 * No live network calls are made.
 */

import { xdr } from '@stellar/stellar-sdk';

import {
  validateRpcUrl,
  isValidContractAddress,
  validateNetworkConfig,
  checkNetworkPassphrases,
  checkContractAvailability,
  inspectContractInterface,
  simulateAcrossNetworks,
  compareInterfaces,
  compareSimulationResults,
  buildCompatibilityReport,
  NetworkConfig,
  ContractAvailabilityResult,
  InterfaceCheckResult,
  SimulationResult,
  NetworkPassphraseCheckResult,
} from '../src/examples/262-cross-network-compatibility';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
const VALID_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const VALID_CONTRACT_2 = 'CDVSGPL3HFBGJ6ZEYQUAVE3OH3XE2ZE5ZT2GWPA3LKOYVD4UBPQJ2VHB';

function makeConfig(
  overrides: Partial<NetworkConfig> = {},
  base: Partial<NetworkConfig> = {},
): NetworkConfig {
  return {
    name: 'testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: TESTNET_PASSPHRASE,
    contractAddress: VALID_CONTRACT,
    ...base,
    ...overrides,
  };
}

/** Build a minimal fake ContractInstance ledger entry */
function makeFakeInstanceEntry(liveUntilLedgerSeq = 2000): any {
  const hashBytes = Buffer.alloc(32, 0xab);
  const executable = xdr.ContractExecutable.contractExecutableWasm(hashBytes);
  const instance = new xdr.ScContractInstance({ executable, storage: null });
  const scVal = xdr.ScVal.scvContractInstance(instance);
  const contractDataEntry = new xdr.ContractDataEntry({
    ext: new (xdr.ExtensionPoint as any)(0) as xdr.ExtensionPoint,
    contract: xdr.ScAddress.scAddressTypeContract(Buffer.alloc(32)),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: scVal,
  });
  const ledgerEntry = new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 900,
    data: xdr.LedgerEntryData.contractData(contractDataEntry),
    ext: new (xdr.LedgerEntryExt as any)(0) as xdr.LedgerEntryExt,
  });
  return { val: ledgerEntry, lastModifiedLedgerSeq: 900, liveUntilLedgerSeq };
}

// ---------------------------------------------------------------------------
// validateRpcUrl
// ---------------------------------------------------------------------------

describe('validateRpcUrl', () => {
  it('accepts an https URL', () => {
    expect(validateRpcUrl('https://soroban-testnet.stellar.org')).toBe(
      'https://soroban-testnet.stellar.org',
    );
  });

  it('accepts an http URL', () => {
    expect(validateRpcUrl('http://localhost:8000')).toBe('http://localhost:8000');
  });

  it('trims surrounding whitespace', () => {
    expect(validateRpcUrl('  https://example.com  ')).toBe('https://example.com');
  });

  it('rejects a plain string that is not a URL', () => {
    expect(() => validateRpcUrl('not a url')).toThrow(/invalid rpc url/i);
  });

  it('rejects an ftp URL', () => {
    expect(() => validateRpcUrl('ftp://example.com')).toThrow(/http|https/i);
  });

  it('rejects an empty string', () => {
    expect(() => validateRpcUrl('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// isValidContractAddress
// ---------------------------------------------------------------------------

describe('isValidContractAddress', () => {
  it('accepts a valid 56-char C-address', () => {
    expect(isValidContractAddress(VALID_CONTRACT)).toBe(true);
  });

  it('rejects a G-address (account ID)', () => {
    expect(isValidContractAddress('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7')).toBe(
      false,
    );
  });

  it('rejects a short string', () => {
    expect(isValidContractAddress('CSHORT')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidContractAddress('')).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidContractAddress(null as any)).toBe(false);
  });

  it('rejects lowercase', () => {
    expect(isValidContractAddress(VALID_CONTRACT.toLowerCase())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateNetworkConfig
// ---------------------------------------------------------------------------

describe('validateNetworkConfig', () => {
  it('passes for a valid configuration', () => {
    expect(() => validateNetworkConfig(makeConfig())).not.toThrow();
  });

  it('rejects a missing name', () => {
    expect(() => validateNetworkConfig(makeConfig({ name: '' }))).toThrow(/missing a name/i);
  });

  it('rejects an invalid RPC URL', () => {
    expect(() => validateNetworkConfig(makeConfig({ rpcUrl: 'bad-url' }))).toThrow(/invalid rpc url/i);
  });

  it('rejects an empty network passphrase', () => {
    expect(() =>
      validateNetworkConfig(makeConfig({ networkPassphrase: '' })),
    ).toThrow(/networkPassphrase/i);
  });

  it('rejects an invalid contract address', () => {
    expect(() =>
      validateNetworkConfig(makeConfig({ contractAddress: 'NOT_A_CONTRACT' })),
    ).toThrow(/contractAddress/i);
  });
});

// ---------------------------------------------------------------------------
// checkNetworkPassphrases
// ---------------------------------------------------------------------------

describe('checkNetworkPassphrases', () => {
  it('marks status as valid when the endpoint returns the configured passphrase', async () => {
    const cfg = makeConfig();
    const makeServer = (_url: string) => ({
      getNetwork: async () => ({ passphrase: TESTNET_PASSPHRASE }),
    });
    const results = await checkNetworkPassphrases([cfg], makeServer as any);
    expect(results[0].status).toBe('valid');
    expect(results[0].detectedPassphrase).toBe(TESTNET_PASSPHRASE);
    expect(results[0].error).toBeNull();
  });

  it('marks status as mismatch when passphrases differ', async () => {
    const cfg = makeConfig({ networkPassphrase: TESTNET_PASSPHRASE });
    const makeServer = (_url: string) => ({
      getNetwork: async () => ({ passphrase: MAINNET_PASSPHRASE }),
    });
    const results = await checkNetworkPassphrases([cfg], makeServer as any);
    expect(results[0].status).toBe('mismatch');
    expect(results[0].detectedPassphrase).toBe(MAINNET_PASSPHRASE);
  });

  it('marks status as unreachable on network error', async () => {
    const cfg = makeConfig();
    const makeServer = (_url: string) => ({
      getNetwork: async () => {
        throw new Error('connection refused');
      },
    });
    const results = await checkNetworkPassphrases([cfg], makeServer as any);
    expect(results[0].status).toBe('unreachable');
    expect(results[0].error).toMatch(/connection refused/i);
  });

  it('checks multiple networks independently', async () => {
    const cfgs = [
      makeConfig({ name: 'a', networkPassphrase: TESTNET_PASSPHRASE }),
      makeConfig({ name: 'b', networkPassphrase: MAINNET_PASSPHRASE }),
    ];
    let callCount = 0;
    const makeServer = (_url: string) => ({
      getNetwork: async () => {
        callCount++;
        if (callCount === 1) return { passphrase: TESTNET_PASSPHRASE };
        return { passphrase: MAINNET_PASSPHRASE };
      },
    });
    const results = await checkNetworkPassphrases(cfgs, makeServer as any);
    expect(results[0].status).toBe('valid');
    expect(results[1].status).toBe('valid');
  });
});

// ---------------------------------------------------------------------------
// checkContractAvailability
// ---------------------------------------------------------------------------

describe('checkContractAvailability', () => {
  it('reports available when the entry is returned', async () => {
    const cfg = makeConfig();
    const makeServer = (_url: string) => ({
      getLatestLedger: async () => ({ sequence: 1000 }),
      getLedgerEntries: async () => ({ entries: [makeFakeInstanceEntry(2000)] }),
    });
    const results = await checkContractAvailability([cfg], makeServer as any);
    expect(results[0].status).toBe('available');
    expect(results[0].currentLedger).toBe(1000);
    expect(results[0].liveUntilLedger).toBe(2000);
    expect(results[0].codeHash).not.toBeNull();
  });

  it('reports not_found when the entry list is empty', async () => {
    const cfg = makeConfig();
    const makeServer = (_url: string) => ({
      getLatestLedger: async () => ({ sequence: 1000 }),
      getLedgerEntries: async () => ({ entries: [] }),
    });
    const results = await checkContractAvailability([cfg], makeServer as any);
    expect(results[0].status).toBe('not_found');
  });

  it('reports rpc_error on network failure', async () => {
    const cfg = makeConfig();
    const makeServer = (_url: string) => ({
      getLatestLedger: async () => {
        throw new Error('timeout');
      },
      getLedgerEntries: async () => ({ entries: [] }),
    });
    const results = await checkContractAvailability([cfg], makeServer as any);
    expect(results[0].status).toBe('rpc_error');
    expect(results[0].error).toMatch(/timeout/i);
  });

  it('reports invalid_address for a bad contract address', async () => {
    const cfg = makeConfig({ contractAddress: 'NOT_A_CONTRACT_ADDRESS_1234' as any });
    const makeServer = (_url: string) => ({
      getLatestLedger: async () => ({ sequence: 1000 }),
      getLedgerEntries: async () => ({ entries: [] }),
    });
    const results = await checkContractAvailability([cfg], makeServer as any);
    expect(results[0].status).toBe('invalid_address');
  });

  it('handles one network failing without stopping others', async () => {
    const cfgs = [makeConfig({ name: 'good' }), makeConfig({ name: 'bad' })];
    let callCount = 0;
    const makeServer = (_url: string) => ({
      getLatestLedger: async () => {
        callCount++;
        if (callCount > 1) throw new Error('unreachable');
        return { sequence: 1000 };
      },
      getLedgerEntries: async () => ({ entries: [makeFakeInstanceEntry()] }),
    });
    const results = await checkContractAvailability(cfgs, makeServer as any);
    expect(results[0].status).toBe('available');
    expect(results[1].status).toBe('rpc_error');
  });
});

// ---------------------------------------------------------------------------
// inspectContractInterface
// ---------------------------------------------------------------------------

describe('inspectContractInterface', () => {
  it('returns an error result for an invalid contract address', async () => {
    const cfg = makeConfig({ contractAddress: 'INVALID' as any });
    const makeServer = (_url: string) => ({
      getContractWasmByContractId: async () => Buffer.alloc(0),
    });
    const results = await inspectContractInterface([cfg], makeServer as any);
    expect(results[0].available).toBe(false);
    expect(results[0].error).toMatch(/valid contract address/i);
  });

  it('returns unavailable with error when getContractWasmByContractId throws', async () => {
    const cfg = makeConfig();
    const makeServer = (_url: string) => ({
      getContractWasmByContractId: async () => {
        throw new Error('spec retrieval failure');
      },
    });
    const results = await inspectContractInterface([cfg], makeServer as any);
    expect(results[0].available).toBe(false);
    expect(results[0].error).toMatch(/spec retrieval failure/i);
  });
});

// ---------------------------------------------------------------------------
// simulateAcrossNetworks
// ---------------------------------------------------------------------------

describe('simulateAcrossNetworks', () => {
  const mockSuccessResponse: any = {
    id: '1',
    latestLedger: 1000,
    latestLedgerCloseTime: '1234567890',
    result: { retval: xdr.ScVal.scvVoid(), auth: [] },
    cost: { cpuInsns: '100000', memBytes: '50000' },
    minResourceFee: '200',
    events: [],
    transactionData: '',
  };

  it('returns success when simulation succeeds', async () => {
    const cfg = makeConfig();
    const makeServer = (_url: string) => ({
      simulateTransaction: async () => mockSuccessResponse,
    });
    const results = await simulateAcrossNetworks([cfg], 'decimals', [], makeServer as any);
    expect(results[0].status).toBe('success');
    // cpuInstructions and memoryBytes are extracted from transactionData which the mock
    // does not populate — they remain null; minResourceFee is read from the top-level field.
    expect(results[0].minResourceFee).toBe('200');
    expect(results[0].error).toBeNull();
  });

  it('returns error when simulation returns an error response', async () => {
    const cfg = makeConfig();
    const makeServer = (_url: string) => ({
      simulateTransaction: async () => ({
        id: '1',
        latestLedger: 1000,
        error: 'contract trap: unreachable',
        events: [],
      }),
    });
    const results = await simulateAcrossNetworks([cfg], 'boom', [], makeServer as any);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toMatch(/trap|unreachable/i);
  });

  it('returns rpc_error when the network call throws', async () => {
    const cfg = makeConfig();
    const makeServer = (_url: string) => ({
      simulateTransaction: async () => {
        throw new Error('RPC timeout on simulation');
      },
    });
    const results = await simulateAcrossNetworks([cfg], 'decimals', [], makeServer as any);
    expect(results[0].status).toBe('rpc_error');
    expect(results[0].error).toMatch(/timeout/i);
  });

  it('skips networks with invalid contract addresses', async () => {
    const cfg = makeConfig({ contractAddress: 'BAD' as any });
    const makeServer = (_url: string) => ({
      simulateTransaction: async () => mockSuccessResponse,
    });
    const results = await simulateAcrossNetworks([cfg], 'decimals', [], makeServer as any);
    expect(results[0].status).toBe('skipped');
  });

  it('reports different results from two networks independently', async () => {
    const cfgs = [makeConfig({ name: 'net-a' }), makeConfig({ name: 'net-b' })];
    let calls = 0;
    const makeServer = (_url: string) => ({
      simulateTransaction: async () => {
        calls++;
        if (calls === 1) return mockSuccessResponse;
        return { id: '2', latestLedger: 1000, error: 'contract not found', events: [] };
      },
    });
    const results = await simulateAcrossNetworks(cfgs, 'decimals', [], makeServer as any);
    expect(results[0].status).toBe('success');
    expect(results[1].status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// compareInterfaces
// ---------------------------------------------------------------------------

describe('compareInterfaces', () => {
  function makeInterface(
    networkName: string,
    functions: Array<{ name: string; inputs?: any[]; outputs?: string[] }>,
    available = true,
  ): InterfaceCheckResult {
    return {
      networkName,
      contractAddress: VALID_CONTRACT,
      available,
      functions: functions.map((f) => ({
        name: f.name,
        inputs: f.inputs ?? [],
        outputs: f.outputs ?? ['u32'],
      })),
      error: available ? null : 'spec unavailable',
    };
  }

  it('returns compatible when all networks expose identical functions', () => {
    const results = [
      makeInterface('a', [{ name: 'decimals', outputs: ['u32'] }]),
      makeInterface('b', [{ name: 'decimals', outputs: ['u32'] }]),
    ];
    const comparison = compareInterfaces(results);
    expect(comparison.status).toBe('compatible');
    expect(comparison.missingFunctions).toHaveLength(0);
    expect(comparison.incompatibleSignatures).toHaveLength(0);
  });

  it('detects a function missing on one network', () => {
    const results = [
      makeInterface('a', [{ name: 'decimals' }, { name: 'name' }]),
      makeInterface('b', [{ name: 'decimals' }]),
    ];
    const comparison = compareInterfaces(results);
    expect(comparison.status).toBe('partial');
    expect(comparison.missingFunctions).toEqual(
      expect.arrayContaining([{ networkName: 'b', functionName: 'name' }]),
    );
  });

  it('detects incompatible signatures (output type differs)', () => {
    const results = [
      makeInterface('a', [{ name: 'decimals', outputs: ['u32'] }]),
      makeInterface('b', [{ name: 'decimals', outputs: ['u64'] }]),
    ];
    const comparison = compareInterfaces(results);
    expect(comparison.status).toBe('incompatible');
    expect(comparison.incompatibleSignatures.length).toBeGreaterThan(0);
    expect(comparison.incompatibleSignatures[0].functionName).toBe('decimals');
  });

  it('returns inconclusive when no interface data is available', () => {
    const results = [
      makeInterface('a', [], false),
      makeInterface('b', [], false),
    ];
    const comparison = compareInterfaces(results);
    expect(comparison.status).toBe('inconclusive');
  });

  it('returns inconclusive when only one network has data', () => {
    const results = [
      makeInterface('a', [{ name: 'decimals' }]),
      makeInterface('b', [], false),
    ];
    const comparison = compareInterfaces(results);
    // Only one available network — cannot compare
    expect(comparison.status).toBe('inconclusive');
  });
});

// ---------------------------------------------------------------------------
// compareSimulationResults
// ---------------------------------------------------------------------------

describe('compareSimulationResults', () => {
  function makeSimResult(
    networkName: string,
    status: SimulationResult['status'],
    returnValue: string | null = null,
    cpuInstructions: number | null = null,
  ): SimulationResult {
    return {
      networkName,
      contractAddress: VALID_CONTRACT,
      functionName: 'decimals',
      status,
      returnValue,
      cpuInstructions,
      memoryBytes: null,
      minResourceFee: null,
      error: status === 'success' ? null : 'err',
      diagnostics: [],
    };
  }

  it('returns null returnValueMatch when no successes', () => {
    const results = [makeSimResult('a', 'error'), makeSimResult('b', 'rpc_error')];
    const comparison = compareSimulationResults(results);
    expect(comparison.returnValueMatch).toBeNull();
  });

  it('returns null returnValueMatch when only one succeeds', () => {
    const results = [makeSimResult('a', 'success', 'AAAA'), makeSimResult('b', 'error')];
    const comparison = compareSimulationResults(results);
    expect(comparison.returnValueMatch).toBeNull();
  });

  it('returns true when return values match', () => {
    const results = [
      makeSimResult('a', 'success', 'AAAA', 100),
      makeSimResult('b', 'success', 'AAAA', 100),
    ];
    const comparison = compareSimulationResults(results);
    expect(comparison.returnValueMatch).toBe(true);
  });

  it('returns false when return values differ', () => {
    const results = [
      makeSimResult('a', 'success', 'AAAA'),
      makeSimResult('b', 'success', 'BBBB'),
    ];
    const comparison = compareSimulationResults(results);
    expect(comparison.returnValueMatch).toBe(false);
  });

  it('reports resource differences when cpu counts differ', () => {
    const results = [
      makeSimResult('a', 'success', 'AAAA', 100000),
      makeSimResult('b', 'success', 'AAAA', 200000),
    ];
    const comparison = compareSimulationResults(results);
    expect(comparison.resourceDifferences.some((d) => d.metric === 'cpuInstructions')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildCompatibilityReport
// ---------------------------------------------------------------------------

describe('buildCompatibilityReport', () => {
  const baseConfigs: NetworkConfig[] = [
    makeConfig({ name: 'testnet', contractAddress: VALID_CONTRACT }),
    makeConfig({ name: 'testnet-alt', contractAddress: VALID_CONTRACT_2 }),
  ];

  function makePassphraseCheck(networkName: string, status: NetworkPassphraseCheckResult['status']): NetworkPassphraseCheckResult {
    return {
      networkName,
      status,
      detectedPassphrase: status === 'valid' ? TESTNET_PASSPHRASE : null,
      configuredPassphrase: TESTNET_PASSPHRASE,
      error: status === 'unreachable' ? 'timeout' : null,
    };
  }

  function makeAvailability(networkName: string, status: ContractAvailabilityResult['status']): ContractAvailabilityResult {
    return {
      networkName,
      contractAddress: VALID_CONTRACT,
      status,
      currentLedger: 1000,
      liveUntilLedger: 2000,
      codeHash: null,
      error: null,
    };
  }

  it('generates a report with all required fields', () => {
    const report = buildCompatibilityReport({
      configs: baseConfigs,
      passphraseChecks: [
        makePassphraseCheck('testnet', 'valid'),
        makePassphraseCheck('testnet-alt', 'valid'),
      ],
      availabilityResults: [
        makeAvailability('testnet', 'available'),
        makeAvailability('testnet-alt', 'available'),
      ],
      interfaceResults: [
        { networkName: 'testnet', contractAddress: VALID_CONTRACT, available: false, functions: [], error: 'spec error' },
        { networkName: 'testnet-alt', contractAddress: VALID_CONTRACT_2, available: false, functions: [], error: 'spec error' },
      ],
      interfaceComparison: { status: 'inconclusive', missingFunctions: [], incompatibleSignatures: [], details: 'inconclusive' },
      simulationResults: [],
      simulationComparison: { returnValueMatch: null, resourceDifferences: [], details: 'no results' },
      functionName: 'decimals',
    });

    expect(report.generatedAt).toBeDefined();
    expect(report.networks).toHaveLength(2);
    expect(report.overallCompatibility).toBeDefined();
    expect(report.differences).toBeInstanceOf(Array);
    expect(report.warnings).toBeInstanceOf(Array);
  });

  it('marks overall as incompatible when a passphrase mismatch is detected', () => {
    const report = buildCompatibilityReport({
      configs: baseConfigs,
      passphraseChecks: [
        makePassphraseCheck('testnet', 'valid'),
        makePassphraseCheck('testnet-alt', 'mismatch'),
      ],
      availabilityResults: [
        makeAvailability('testnet', 'available'),
        makeAvailability('testnet-alt', 'available'),
      ],
      interfaceResults: [],
      interfaceComparison: { status: 'inconclusive', missingFunctions: [], incompatibleSignatures: [], details: '' },
      simulationResults: [],
      simulationComparison: { returnValueMatch: null, resourceDifferences: [], details: '' },
      functionName: null,
    });

    expect(report.overallCompatibility).toBe('incompatible');
    expect(report.differences.some((d) => /mismatch/i.test(d))).toBe(true);
  });

  it('records a difference when a contract is available on some networks but not all', () => {
    const report = buildCompatibilityReport({
      configs: baseConfigs,
      passphraseChecks: [
        makePassphraseCheck('testnet', 'valid'),
        makePassphraseCheck('testnet-alt', 'valid'),
      ],
      availabilityResults: [
        makeAvailability('testnet', 'available'),
        makeAvailability('testnet-alt', 'not_found'),
      ],
      interfaceResults: [],
      interfaceComparison: { status: 'inconclusive', missingFunctions: [], incompatibleSignatures: [], details: '' },
      simulationResults: [],
      simulationComparison: { returnValueMatch: null, resourceDifferences: [], details: '' },
      functionName: null,
    });

    expect(report.differences.length).toBeGreaterThan(0);
    expect(report.differences.some((d) => /available|not_found/i.test(d))).toBe(true);
  });

  it('marks overall as partial when interface differences are present', () => {
    const report = buildCompatibilityReport({
      configs: baseConfigs,
      passphraseChecks: [
        makePassphraseCheck('testnet', 'valid'),
        makePassphraseCheck('testnet-alt', 'valid'),
      ],
      availabilityResults: [
        makeAvailability('testnet', 'available'),
        makeAvailability('testnet-alt', 'available'),
      ],
      interfaceResults: [
        { networkName: 'testnet', contractAddress: VALID_CONTRACT, available: true, functions: [{ name: 'decimals', inputs: [], outputs: ['u32'] }], error: null },
        { networkName: 'testnet-alt', contractAddress: VALID_CONTRACT_2, available: true, functions: [], error: null },
      ],
      interfaceComparison: {
        status: 'partial',
        missingFunctions: [{ networkName: 'testnet-alt', functionName: 'decimals' }],
        incompatibleSignatures: [],
        details: '1 missing function',
      },
      simulationResults: [],
      simulationComparison: { returnValueMatch: null, resourceDifferences: [], details: '' },
      functionName: 'decimals',
    });

    expect(report.overallCompatibility).toBe('partial');
    expect(report.differences.some((d) => /decimals/i.test(d))).toBe(true);
  });

  it('marks overall as compatible when everything matches and simulations agree', () => {
    const matchingReturn = 'AAAA==';
    const simResults: SimulationResult[] = [
      {
        networkName: 'testnet',
        contractAddress: VALID_CONTRACT,
        functionName: 'decimals',
        status: 'success',
        returnValue: matchingReturn,
        cpuInstructions: 1000,
        memoryBytes: 500,
        minResourceFee: '100',
        error: null,
        diagnostics: [],
      },
      {
        networkName: 'testnet-alt',
        contractAddress: VALID_CONTRACT_2,
        functionName: 'decimals',
        status: 'success',
        returnValue: matchingReturn,
        cpuInstructions: 1000,
        memoryBytes: 500,
        minResourceFee: '100',
        error: null,
        diagnostics: [],
      },
    ];

    const report = buildCompatibilityReport({
      configs: baseConfigs,
      passphraseChecks: [
        makePassphraseCheck('testnet', 'valid'),
        makePassphraseCheck('testnet-alt', 'valid'),
      ],
      availabilityResults: [
        makeAvailability('testnet', 'available'),
        makeAvailability('testnet-alt', 'available'),
      ],
      interfaceResults: [
        { networkName: 'testnet', contractAddress: VALID_CONTRACT, available: true, functions: [{ name: 'decimals', inputs: [], outputs: ['u32'] }], error: null },
        { networkName: 'testnet-alt', contractAddress: VALID_CONTRACT_2, available: true, functions: [{ name: 'decimals', inputs: [], outputs: ['u32'] }], error: null },
      ],
      interfaceComparison: {
        status: 'compatible',
        missingFunctions: [],
        incompatibleSignatures: [],
        details: 'All functions match.',
      },
      simulationResults: simResults,
      simulationComparison: {
        returnValueMatch: true,
        resourceDifferences: [],
        details: '2 networks succeeded. Return values match.',
      },
      functionName: 'decimals',
    });

    expect(report.overallCompatibility).toBe('compatible');
    expect(report.differences).toHaveLength(0);
  });
});
