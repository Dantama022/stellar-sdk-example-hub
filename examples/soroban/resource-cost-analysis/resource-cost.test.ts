import { Keypair, Networks, SorobanDataBuilder, StrKey, Transaction, rpc, xdr } from '@stellar/stellar-sdk';
import {
  CostAnalysisError,
  CostRpcClient,
  InvocationConfig,
  addMarketContext,
  analyzeInvocation,
  analyzeResources,
  buildInvocationTransaction,
  buildReport,
  classifyFailure,
  estimateFee,
  formatReport,
  interpretSimulation,
  parseCli,
  parseNetworkLimits,
  reportToJson,
  stroopsToXlm,
  validateInvocation,
} from './index';

const TESTNET = Networks.TESTNET;
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));
const SOURCE = Keypair.random().publicKey();

const config = (over: Partial<InvocationConfig> = {}): InvocationConfig => ({
  network: 'testnet',
  contractId: CONTRACT,
  functionName: 'transfer',
  sourceAccount: SOURCE,
  args: [
    { type: 'address', value: SOURCE },
    { type: 'i128', value: '123456789012345678901234567890' }, // beyond 2^53
  ],
  ...over,
});

// ---- Fixtures -----------------------------------------------------------------------------

const accountKey = () => xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.random().xdrPublicKey() }));

function sorobanData(o: { cpu?: number; read?: number; write?: number; ro?: number; rw?: number; fee?: string } = {}) {
  const ro = Array.from({ length: o.ro ?? 2 }, accountKey);
  const rw = Array.from({ length: o.rw ?? 1 }, accountKey);
  return new SorobanDataBuilder()
    .setResources(o.cpu ?? 1_000_000, o.read ?? 2_000, o.write ?? 500)
    .setFootprint(ro, rw)
    .setResourceFee(o.fee ?? '50000');
}

function successSim(o: Parameters<typeof sorobanData>[0] & { minResourceFee?: string } = {}) {
  return {
    id: '1',
    _parsed: true,
    latestLedger: 1000,
    events: [] as xdr.DiagnosticEvent[],
    transactionData: sorobanData(o),
    minResourceFee: o.minResourceFee ?? '50000',
    result: { auth: [] as xdr.SorobanAuthorizationEntry[], retval: xdr.ScVal.scvVoid() },
  } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
}

const errorSim = (error: string) =>
  ({ id: '1', _parsed: true, latestLedger: 1000, events: [], error }) as unknown as rpc.Api.SimulateTransactionErrorResponse;

const hyper = (n: bigint) => xdr.Int64.fromString(n.toString());

function limitEntries(o: { cpu?: bigint; read?: number; write?: number; readEntries?: number; writeEntries?: number } = {}) {
  const compute = new xdr.ConfigSettingContractComputeV0({
    ledgerMaxInstructions: hyper(10_000_000_000n),
    txMaxInstructions: hyper(o.cpu ?? 100_000_000n),
    feeRatePerInstructionsIncrement: hyper(25n),
    txMemoryLimit: 41943040,
  });
  const cost = new xdr.ConfigSettingContractLedgerCostV0({
    ledgerMaxReadLedgerEntries: 200,
    ledgerMaxReadBytes: 500000,
    ledgerMaxWriteLedgerEntries: 125,
    ledgerMaxWriteBytes: 143360,
    txMaxReadLedgerEntries: o.readEntries ?? 100,
    txMaxReadBytes: o.read ?? 200_000,
    txMaxWriteLedgerEntries: o.writeEntries ?? 50,
    txMaxWriteBytes: o.write ?? 132_096,
    feeReadLedgerEntry: hyper(1n),
    feeWriteLedgerEntry: hyper(1n),
    feeRead1Kb: hyper(1n),
    bucketListTargetSizeBytes: hyper(1n),
    writeFee1KbBucketListLow: hyper(1n),
    writeFee1KbBucketListHigh: hyper(1n),
    bucketListWriteFeeGrowthFactor: 1,
  });
  const bandwidth = new xdr.ConfigSettingContractBandwidthV0({ ledgerMaxTxsSizeBytes: 100000, txMaxSizeBytes: 132096, feeTxSize1Kb: hyper(1n) });
  return [
    xdr.LedgerEntryData.configSetting(xdr.ConfigSettingEntry.configSettingContractComputeV0(compute)),
    xdr.LedgerEntryData.configSetting(xdr.ConfigSettingEntry.configSettingContractLedgerCostV0(cost)),
    xdr.LedgerEntryData.configSetting(xdr.ConfigSettingEntry.configSettingContractBandwidthV0(bandwidth)),
  ].map((val) => ({ key: accountKey(), val }));
}

function mockClient(over: Partial<CostRpcClient> = {}): jest.Mocked<CostRpcClient> {
  return {
    getNetwork: jest.fn().mockResolvedValue({ passphrase: TESTNET }),
    getSequence: jest.fn().mockResolvedValue('100'),
    simulateTransaction: jest.fn().mockResolvedValue(successSim()),
    getLedgerEntries: jest.fn().mockResolvedValue({ entries: limitEntries(), latestLedger: 1000 }),
    getFeeStats: jest.fn().mockResolvedValue({
      sorobanInclusionFee: { p50: '100', p99: '500', ledgerCount: 10 },
      inclusionFee: { p50: '100', p99: '500', ledgerCount: 10 },
      latestLedger: 1000,
    }),
    ...over,
  } as jest.Mocked<CostRpcClient>;
}

const buildTx = (inclusionFee?: string): Transaction => buildInvocationTransaction(validateInvocation(config({ inclusionFee })), '100');

// ---- Tests --------------------------------------------------------------------------------

describe('invocation configuration', () => {
  it('validates a good config and keeps large integers exact', () => {
    const inv = validateInvocation(config());
    expect(inv.networkPassphrase).toBe(TESTNET);
    expect(inv.rpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(inv.args).toHaveLength(2);
    expect(inv.args[1].switch().name).toBe('scvI128');
    const tx = buildInvocationTransaction(inv, '100');
    expect(tx.operations[0].type).toBe('invokeHostFunction');
    expect(tx.networkPassphrase).toBe(TESTNET);
  });

  it('rejects an invalid contract address', () => {
    expect(() => validateInvocation(config({ contractId: 'GNOTACONTRACT' }))).toThrow(
      expect.objectContaining({ code: 'INVALID_CONTRACT_ADDRESS' })
    );
  });

  it('rejects bad function names, arguments, source and mainnet without an RPC URL', () => {
    expect(() => validateInvocation(config({ functionName: 'bad name!' }))).toThrow(expect.objectContaining({ code: 'INVALID_FUNCTION_NAME' }));
    expect(() => validateInvocation(config({ args: [{ type: 'u32', value: '-1' }] }))).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }));
    expect(() => validateInvocation(config({ args: [{ type: 'u32', value: '1.5' }] }))).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }));
    expect(() => validateInvocation(config({ args: [{ type: 'address', value: 'nope' }] }))).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }));
    expect(() => validateInvocation(config({ sourceAccount: 'x' }))).toThrow(expect.objectContaining({ code: 'INVALID_SOURCE_ACCOUNT' }));
    expect(() => validateInvocation(config({ network: 'mainnet' }))).toThrow(expect.objectContaining({ code: 'INVALID_RPC_URL' }));
  });
});

describe('simulation interpretation', () => {
  it('extracts resources, footprint, fee and diagnostics from a successful simulation', () => {
    const out = interpretSimulation(successSim({ cpu: 12_345_678, read: 4096, write: 1024, ro: 3, rw: 2, minResourceFee: '77777' }));
    expect(out.status).toBe('success');
    expect(out.resources).toMatchObject({
      instructions: 12_345_678n,
      readBytes: 4096n,
      writeBytes: 1024n,
      readOnlyEntries: 3,
      readWriteEntries: 2,
      readEntries: 5,
      writeEntries: 2,
    });
    expect(out.minResourceFee).toBe(77777n);
    expect(out.diagnostics).toMatchObject({ eventCount: 0, failedCallEvents: 0 });
  });

  it('reports a failed simulation without resources, and classifies the failure', () => {
    const out = interpretSimulation(errorSim('HostError: Error(WasmVm, MissingValue)\n trying to invoke non-existent contract function'));
    expect(out.status).toBe('failed');
    expect(out.failure?.kind).toBe('missing_function');
    expect(out.resources).toBeUndefined();
    expect(out.minResourceFee).toBeUndefined();
    expect(classifyFailure('HostError: Error(Value, UnexpectedType)')).toBe('invalid_arguments');
    expect(classifyFailure('Error(Budget, ExceededLimit)')).toBe('out_of_resources');
    expect(classifyFailure('something odd')).toBe('other');
  });

  it('flags missing resource information instead of inventing numbers', () => {
    const noFee = { ...successSim(), minResourceFee: undefined };
    expect(interpretSimulation(noFee).status).toBe('missing_resource_info');
    const noData = { ...successSim(), transactionData: {} };
    const out = interpretSimulation(noData);
    expect(out.status).toBe('missing_resource_info');
    expect(out.resources).toBeUndefined();
  });

  it('flags unexpected response shapes', () => {
    expect(interpretSimulation(null).status).toBe('unexpected_response');
    expect(interpretSimulation('oops').status).toBe('unexpected_response');
    expect(interpretSimulation({ latestLedger: 5 }).status).toBe('unexpected_response');
  });

  it('does not treat a restore-required simulation as an estimate', () => {
    const restore = { ...successSim(), restorePreamble: { minResourceFee: '1', transactionData: sorobanData() } };
    expect(interpretSimulation(restore).status).toBe('restore_required');
  });
});

describe('resource analysis', () => {
  const resources = (cpu: bigint, read = 1000n, write = 100n) => ({
    instructions: cpu,
    readBytes: read,
    writeBytes: write,
    readOnlyEntries: 2,
    readWriteEntries: 1,
    readEntries: 3,
    writeEntries: 1,
    dataResourceFee: 0n,
  });

  it('parses limits from config-setting entries', () => {
    const limits = parseNetworkLimits(limitEntries({ cpu: 123n }), 9);
    expect(limits).toMatchObject({ txMaxInstructions: 123n, txMaxReadBytes: 200000n, txMaxWriteLedgerEntries: 50n, ledgerSeq: 9 });
  });

  it('reports ok when well under limits', () => {
    const a = analyzeResources(resources(1_000_000n), parseNetworkLimits(limitEntries()), 0.8);
    expect(a.lines.every((l) => l.status === 'ok')).toBe(true);
    expect(a.warnings).toEqual([]);
  });

  it('warns near a limit and marks exceeded over it, keeping precision for huge values', () => {
    const limits = parseNetworkLimits(limitEntries({ cpu: 100_000_000n }));
    const near = analyzeResources(resources(85_000_000n), limits, 0.8);
    expect(near.lines[0]).toMatchObject({ status: 'warning', percent: 85 });
    expect(near.warnings[0]).toMatch(/85%/);

    const over = analyzeResources(resources(100_000_001n), limits, 0.8);
    expect(over.lines[0].status).toBe('exceeded');
    expect(over.warnings[0]).toMatch(/exceeds/);

    const huge = analyzeResources(resources(2n ** 62n + 1n), parseNetworkLimits(limitEntries({ cpu: 2n ** 62n })), 0.8);
    expect(huge.lines[0].status).toBe('exceeded');
  });

  it('marks usage unknown when limits are unavailable', () => {
    const a = analyzeResources(resources(1n), undefined, 0.8);
    expect(a.limitsAvailable).toBe(false);
    expect(a.lines.every((l) => l.status === 'unknown')).toBe(true);
    expect(a.warnings[0]).toMatch(/could not be read/);
  });
});

describe('fee estimation', () => {
  it('estimates inclusion + resource fee and matches the SDK-assembled transaction', () => {
    const out = interpretSimulation(successSim({ minResourceFee: '50000' }));
    const fee = estimateFee(buildTx('100'), out);
    expect(fee).toMatchObject({ status: 'estimated', inclusionFee: 100n, resourceFee: 50000n, maxFee: 50100n });
  });

  it('does not produce an estimate for a failed simulation', () => {
    const fee = estimateFee(buildTx(), interpretSimulation(errorSim('boom')));
    expect(fee.status).toBe('not_available');
    expect(fee.maxFee).toBeUndefined();
  });

  it('reports failure when the fee cannot be assembled or overflows', () => {
    const tooBig = interpretSimulation(successSim({ minResourceFee: '5000000000' }));
    expect(estimateFee(buildTx(), tooBig).status).toBe('failed');

    const broken = interpretSimulation(successSim());
    broken.raw = { transactionData: 'garbage' }; // assembleTransaction will throw
    const fee = estimateFee(buildTx(), broken);
    expect(fee.status).toBe('failed');
    expect(fee.error).toMatch(/Fee estimation failed/);
  });

  it('adds market context, and tolerates getFeeStats failing', async () => {
    const base = estimateFee(buildTx('100'), interpretSimulation(successSim()));
    const withCtx = await addMarketContext(mockClient(), base);
    expect(withCtx.marketInclusionFee?.p99).toBe('500');
    expect(withCtx.warnings.join()).toMatch(/below the recent p99/);

    const failing = await addMarketContext(mockClient({ getFeeStats: jest.fn().mockRejectedValue(new Error('down')) }), base);
    expect(failing.status).toBe('estimated');
    expect(failing.warnings.join()).toMatch(/Could not read fee statistics/);
  });

  it('formats stroops as XLM without floating point', () => {
    expect(stroopsToXlm(50100n)).toBe('0.0050100');
    expect(stroopsToXlm(123456789012345678n)).toBe('12345678901.2345678');
  });
});

describe('end-to-end report', () => {
  it('produces a structured, serializable, read-only report', async () => {
    const client = mockClient();
    const report = await analyzeInvocation(config({ inclusionFee: '1000' }), client);
    expect(report).toMatchObject({
      readOnly: true,
      contractId: CONTRACT,
      functionName: 'transfer',
      network: { name: 'testnet', passphrase: TESTNET },
      simulation: { status: 'success' },
      fee: { status: 'estimated', maxFee: 51000n },
    });
  });

  it('assesses ok when nothing warns', async () => {
    const report = await analyzeInvocation(config({ inclusionFee: '1000' }), mockClient());
    expect(report.warnings).toEqual([]);
    expect(report.assessment).toBe('ok');
    expect(report.analysis?.lines).toHaveLength(5);
    const json = JSON.parse(reportToJson(report));
    expect(json.resources.instructions).toBe('1000000');
    expect(json.fee.maxFee).toBe('51000');
    const text = formatReport(report);
    expect(text).toMatch(/ESTIMATE/);
    expect(text).toMatch(/Assessment: OK/);
    expect(text).toMatch(/nothing was signed or submitted/);
  });

  it('flags resource-limit violations as do_not_submit', async () => {
    const client = mockClient({ simulateTransaction: jest.fn().mockResolvedValue(successSim({ cpu: 200_000_000 })) });
    const report = await analyzeInvocation(config(), client);
    expect(report.assessment).toBe('do_not_submit');
    expect(report.warnings.join()).toMatch(/CPU instructions.*exceeds/);
  });

  it('a failed simulation yields do_not_submit with no estimate', async () => {
    const client = mockClient({ simulateTransaction: jest.fn().mockResolvedValue(errorSim('Error(Value, UnexpectedType)')) });
    const report = await analyzeInvocation(config(), client);
    expect(report.simulation).toMatchObject({ status: 'failed', failureKind: 'invalid_arguments' });
    expect(report.assessment).toBe('do_not_submit');
    expect(report.fee.status).toBe('not_available');
    expect(report.resources).toBeUndefined();
    expect(client.getLedgerEntries).not.toHaveBeenCalled();
  });

  it('an unexpected response is inconclusive', async () => {
    const client = mockClient({ simulateTransaction: jest.fn().mockResolvedValue({ weird: true }) });
    const report = await analyzeInvocation(config(), client);
    expect(report.simulation.status).toBe('unexpected_response');
    expect(report.assessment).toBe('inconclusive');
  });

  it('is still useful, with a warning, when network limits cannot be read', async () => {
    const client = mockClient({ getLedgerEntries: jest.fn().mockRejectedValue(new Error('no limits')) });
    const report = await analyzeInvocation(config({ inclusionFee: '1000' }), client);
    expect(report.assessment).toBe('caution');
    expect(report.warnings.join()).toMatch(/Could not read network limits/);
    expect(report.analysis?.lines.every((l) => l.status === 'unknown')).toBe(true);
  });

  it('throws RPC_UNAVAILABLE on endpoint failure at each stage', async () => {
    const down = new Error('ECONNREFUSED');
    await expect(analyzeInvocation(config(), mockClient({ getNetwork: jest.fn().mockRejectedValue(down) }))).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });
    await expect(analyzeInvocation(config(), mockClient({ getSequence: jest.fn().mockRejectedValue(down) }))).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });
    await expect(analyzeInvocation(config(), mockClient({ simulateTransaction: jest.fn().mockRejectedValue(down) }))).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });
  });

  it('refuses a network mismatch', async () => {
    const client = mockClient({ getNetwork: jest.fn().mockResolvedValue({ passphrase: Networks.PUBLIC }) });
    await expect(analyzeInvocation(config(), client)).rejects.toMatchObject({ code: 'NETWORK_MISMATCH' });
  });

  it('never exposes a way to submit', () => {
    expect(Object.keys(mockClient())).not.toContain('sendTransaction');
  });

  it('buildReport omits resources for non-success outcomes', () => {
    const inv = validateInvocation(config());
    const out = interpretSimulation(null);
    const report = buildReport(inv, out, undefined, undefined, estimateFee(buildTx(), out));
    expect(report.resources).toBeUndefined();
    expect(report.assessment).toBe('inconclusive');
  });
});

describe('CLI parsing', () => {
  it('parses flags and typed args', () => {
    const { config: c, json } = parseCli(['--network', 'testnet', '--contract', CONTRACT, '--function', 'add', '--source', SOURCE, '--arg', 'u32:1', '--arg', 'symbol:a:b', '--json']);
    expect(json).toBe(true);
    expect(c.args).toEqual([
      { type: 'u32', value: '1' },
      { type: 'symbol', value: 'a:b' },
    ]);
    expect(() => parseCli(['--arg', 'novalue'])).toThrow(CostAnalysisError);
  });
});
