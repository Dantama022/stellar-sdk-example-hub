/*
 * stellar-sdk-v16 currently pulls an ESM-only transitive dependency that the
 * repository's CommonJS Jest configuration does not transform.
 *
 * Mock the SDK runtime so we can test our pure helpers directly while also
 * inspecting SDK-dependent example behavior from source, which matches the
 * repository's existing Soroban test style.
 */
jest.mock('stellar-sdk-v16', () => ({}));

import * as fs from 'fs';

import {
  formatTokenAmount,
  isInsufficientBalanceError,
} from '../src/examples/116-soroban-token-contract';

import { compareFootprints, formatDelta } from '../src/examples/118-ledger-footprint-analysis';

import type { FootprintSummary } from '../src/examples/118-ledger-footprint-analysis';

import {
  calculatePercentage,
  calculateShare,
  formatFee,
  identifyExpensiveResourceUsage,
  parseOptionalBigInt,
} from '../src/examples/119-soroban-resource-fee-analysis';

import type { ResourceReport } from '../src/examples/119-soroban-resource-fee-analysis';

import { examples } from '../src/runner/catalog';

const exampleNames = [
  '116-soroban-token-contract',
  '117-soroban-auth-tree',
  '118-ledger-footprint-analysis',
  '119-soroban-resource-fee-analysis',
];

function readExample(name: string): string {
  return fs.readFileSync(`src/examples/${name}.ts`, 'utf8');
}

function emptyFootprintSummary(): FootprintSummary {
  return {
    readOnlyCount: 0,
    readWriteCount: 0,
    totalCount: 0,
    contractEntryCount: 0,
    persistentEntryCount: 0,
    temporaryEntryCount: 0,
    instanceEntryCount: 0,
    contractCodeCount: 0,
    entries: [],
  };
}

function createResourceReport(overrides: Partial<ResourceReport> = {}): ResourceReport {
  return {
    label: 'Invocation',
    method: 'test',
    latestLedger: 1,
    cpuInstructions: 100n,
    memoryBytes: 1024n,
    instructionLimit: 1000,
    ledgerReadCount: 1,
    ledgerWriteCount: 0,
    ledgerReadBytes: 100,
    ledgerWriteBytes: 0,
    sorobanResourceFee: 1000n,
    inclusionFee: 100n,
    totalEstimatedFee: 1100n,
    rawCostAvailable: true,
    ...overrides,
  };
}

describe('ISSUE-116: Soroban token contract interaction', () => {
  const source = readExample('116-soroban-token-contract');

  it('connects to Soroban RPC and simulates transactions', () => {
    expect(source).toContain("from 'stellar-sdk-v16'");
    expect(source).toContain('new rpc.Server');
    expect(source).toContain('simulateTransaction');
  });

  it('validates token contract IDs', () => {
    expect(source).toContain('tokenContractId?: string');
    expect(source).toContain('StrKey.isValidContract');
    expect(source).toContain('Invalid token contract ID');
  });

  it('retrieves token metadata', () => {
    expect(source).toContain("'name'");
    expect(source).toContain("'symbol'");
    expect(source).toContain("'decimals'");
  });

  it('retrieves and formats balances', () => {
    expect(source).toContain("'balance'");

    expect(formatTokenAmount(12_345_678n, 7)).toBe('1.2345678');
    expect(formatTokenAmount(10_000_000n, 7)).toBe('1');
    expect(formatTokenAmount(5n, 0)).toBe('5');
  });

  it('supports allowance and optional total supply', () => {
    expect(source).toContain("'allowance'");
    expect(source).toContain("'total_supply'");
    expect(source).toContain('total_supply is not available');
  });

  it('constructs and simulates a transfer', () => {
    expect(source).toContain('buildTokenTransfer');
    expect(source).toContain("'transfer'");
    expect(source).toContain("nativeToScVal(amount, { type: 'i128' })");
    expect(source).toContain('server.simulateTransaction(transfer.transaction)');
  });

  it('decodes returned ScVal values', () => {
    expect(source).toContain('scValToNative');
    expect(source).toContain('decodeScVal');
    expect(source).toContain("toXDR('base64')");
  });

  it('identifies insufficient-balance scenarios', () => {
    expect(isInsufficientBalanceError('contract failed: insufficient balance')).toBe(true);

    expect(isInsufficientBalanceError('BalanceError: amount exceeds balance')).toBe(true);

    expect(isInsufficientBalanceError('RPC timeout')).toBe(false);
  });

  it('handles invalid contracts and simulation failures', () => {
    expect(source).toContain('Invalid token contract ID');
    expect(source).toContain('rpc.Api.isSimulationError');
    expect(source).toContain('Simulation request failed');
  });

  it('explains Stellar assets and Soroban token contracts', () => {
    expect(source).toContain('Stellar Asset Contract');
    expect(source).toContain('classic Stellar asset');
  });
});

describe('ISSUE-117: Soroban authorization tree visualization', () => {
  const source = readExample('117-soroban-auth-tree');

  it('builds an authorized contract invocation', () => {
    expect(source).toContain('buildAuthorizedInvocation');
    expect(source).toContain("'approve'");
  });

  it('simulates and extracts authorization entries', () => {
    expect(source).toContain('simulateTransaction');
    expect(source).toContain('simulation.result?.auth ?? []');
  });

  it('parses root and nested invocation trees', () => {
    expect(source).toContain('rootInvocation()');
    expect(source).toContain('subInvocations()');
    expect(source).toContain('flattenAuthorizationTree');
    expect(source).toContain("'root'");
    expect(source).toContain("'nested'");
  });

  it('handles deeply nested trees iteratively', () => {
    expect(source).toContain('const stack');
    expect(source).toContain('while (stack.length > 0)');
    expect(source).toContain('stack.push');
  });

  it('decodes contract IDs, functions and arguments', () => {
    expect(source).toContain('contractFn()');
    expect(source).toContain('contractAddress()');
    expect(source).toContain('functionName().toString()');
    expect(source).toContain('contractFunction.args()');
    expect(source).toContain('formatScVal');
  });

  it('associates entries with required signers and signature status', () => {
    expect(source).toContain('getAuthorizationSigner');
    expect(source).toContain('Authorized addr');
    expect(source).toContain('Signature status');
    expect(source).toContain('signatureExpirationLedger');
  });

  it('supports multiple and empty authorization results', () => {
    expect(source).toContain('authorizationEntries.forEach');
    expect(source).toContain('authorizationEntries.length === 0');
  });

  it('handles simulation failures', () => {
    expect(source).toContain('rpc.Api.isSimulationError');
    expect(source).toContain('printSimulationDiagnostics');
  });
});

describe('ISSUE-118: Soroban ledger footprint analysis', () => {
  const source = readExample('118-ledger-footprint-analysis');

  it('simulates and extracts the footprint', () => {
    expect(source).toContain('simulateTransaction');
    expect(source).toContain('simulation.transactionData.build()');
    expect(source).toContain('resources().footprint()');
  });

  it('extracts read-only and read-write entries', () => {
    expect(source).toContain('footprint.readOnly()');
    expect(source).toContain('footprint.readWrite()');
    expect(source).toContain("'read-only'");
    expect(source).toContain("'read-write'");
  });

  it('decodes ledger keys and retains raw XDR', () => {
    expect(source).toContain('describeLedgerKey');
    expect(source).toContain("key.toXDR('base64')");
    expect(source).toContain('Raw XDR');
  });

  it('identifies storage entry types', () => {
    expect(source).toContain("'persistent'");
    expect(source).toContain("'temporary'");
    expect(source).toContain("'instance'");
    expect(source).toContain('scvLedgerKeyContractInstance');
  });

  it('summarizes footprint size', () => {
    expect(source).toContain('Total entries');
    expect(source).toContain('Read-only entries');
    expect(source).toContain('Read-write entries');
    expect(source).toContain('Contract entries');
  });

  it('compares two footprints correctly', () => {
    const first = emptyFootprintSummary();

    first.readOnlyCount = 2;
    first.totalCount = 2;
    first.entries = [
      {
        access: 'read-only',
        ledgerType: 'contractData',
        description: 'first',
        rawXdr: 'FIRST',
        isContractEntry: true,
        storageType: 'persistent',
      },
      {
        access: 'read-only',
        ledgerType: 'contractData',
        description: 'shared',
        rawXdr: 'SHARED',
        isContractEntry: true,
        storageType: 'instance',
      },
    ];

    const second = emptyFootprintSummary();

    second.readOnlyCount = 2;
    second.readWriteCount = 1;
    second.totalCount = 3;
    second.entries = [
      {
        access: 'read-only',
        ledgerType: 'contractData',
        description: 'shared',
        rawXdr: 'SHARED',
        isContractEntry: true,
        storageType: 'instance',
      },
      {
        access: 'read-only',
        ledgerType: 'contractData',
        description: 'second',
        rawXdr: 'SECOND',
        isContractEntry: true,
        storageType: 'persistent',
      },
      {
        access: 'read-write',
        ledgerType: 'contractData',
        description: 'write',
        rawXdr: 'WRITE',
        isContractEntry: true,
        storageType: 'temporary',
      },
    ];

    const comparison = compareFootprints(first, second);

    expect(comparison.firstTotal).toBe(2);
    expect(comparison.secondTotal).toBe(3);
    expect(comparison.totalDelta).toBe(1);
    expect(comparison.commonEntries).toBe(1);
    expect(comparison.onlyInFirst).toBe(1);
    expect(comparison.onlyInSecond).toBe(2);
  });

  it('formats comparison deltas', () => {
    expect(formatDelta(3)).toBe('+3');
    expect(formatDelta(0)).toBe('0');
    expect(formatDelta(-3)).toBe('-3');
  });

  it('handles empty footprints and simulation failures', () => {
    expect(source).toContain('summary.totalCount === 0');
    expect(source).toContain('empty ledger footprint');
    expect(source).toContain('rpc.Api.isSimulationError');
    expect(source).toContain('RPC simulation request failed');
  });
});

describe('ISSUE-119: Soroban resource and fee analysis', () => {
  const source = readExample('119-soroban-resource-fee-analysis');

  it('simulates two contract invocations', () => {
    expect(source).toContain('simulateTransaction');
    expect(source).toContain('firstTransaction');
    expect(source).toContain('secondTransaction');
  });

  it('parses CPU instruction consumption where available', () => {
    expect(source).toContain('fetchRawSimulationCost');
    expect(source).toContain('cpuInsns');

    expect(parseOptionalBigInt('12345')).toBe(12345n);
    expect(parseOptionalBigInt('-1')).toBeUndefined();
    expect(parseOptionalBigInt(undefined)).toBeUndefined();
  });

  it('parses memory usage where available', () => {
    expect(source).toContain('memBytes');
    expect(source).toContain('Memory usage');
  });

  it('extracts ledger counts and I/O limits', () => {
    expect(source).toContain('footprint.readOnly().length');
    expect(source).toContain('footprint.readWrite().length');
    expect(source).toContain('resources.diskReadBytes()');
    expect(source).toContain('resources.writeBytes()');
  });

  it('extracts the transaction instruction limit', () => {
    expect(source).toContain('resources.instructions()');
    expect(source).toContain('Instruction limit');
  });

  it('calculates relative contribution percentages', () => {
    expect(calculatePercentage(50, 100)).toBe(50);

    const share = calculateShare(3, 1);

    expect(share.first).toBe(75);
    expect(share.second).toBe(25);
  });

  it('separates resource and inclusion fees', () => {
    expect(source).toContain('simulation.minResourceFee');
    expect(source).toContain('Soroban resource fee');
    expect(source).toContain('Inclusion/base fee');
  });

  it('calculates total estimated fee', () => {
    expect(source).toContain('totalEstimatedFee: sorobanResourceFee + inclusionFee');

    expect(formatFee(100n)).toBe('100 stroops (0.00001 XLM)');
    expect(formatFee(10_000_000n)).toBe('10000000 stroops (1 XLM)');
  });

  it('compares resource usage', () => {
    expect(source).toContain('buildComparisonRows');
    expect(source).toContain('Resource comparison');
  });

  it('identifies unusually expensive resource usage', () => {
    const first = createResourceReport({
      method: 'small',
      cpuInstructions: 100n,
      sorobanResourceFee: 1000n,
      totalEstimatedFee: 1100n,
    });

    const second = createResourceReport({
      method: 'large',
      cpuInstructions: 301n,
      sorobanResourceFee: 3001n,
      totalEstimatedFee: 3101n,
    });

    const findings = identifyExpensiveResourceUsage(first, second);

    expect(findings.length).toBeGreaterThan(0);

    expect(findings.some((finding) => finding.message.includes('large() uses more than 2×'))).toBe(
      true,
    );
  });

  it('handles unavailable resource information', () => {
    expect(source).toContain('rawCostAvailable');
    expect(source).toContain('unavailable');
  });

  it('handles simulation failures and restore-required responses', () => {
    expect(source).toContain('rpc.Api.isSimulationError');
    expect(source).toContain('rpc.Api.isSimulationRestore');
    expect(source).toContain('RPC simulation request failed');
  });

  it('explains simulation and transaction preparation', () => {
    expect(source).toContain('How simulation affects transaction preparation');
    expect(source).toContain('server.prepareTransaction()');
  });
});

describe('runner registration for ISSUE-116 through ISSUE-119', () => {
  it('registers all four examples', () => {
    for (const name of exampleNames) {
      expect(examples[name]).toBeDefined();
      expect(examples[name].name).toBe(name);
      expect(typeof examples[name].run).toBe('function');
    }
  });
});

describe('README documentation for ISSUE-116 through ISSUE-119', () => {
  const readme = fs.readFileSync('README.md', 'utf8');

  it('documents all four examples', () => {
    for (const name of exampleNames) {
      expect(readme).toContain(name);
    }
  });
});
