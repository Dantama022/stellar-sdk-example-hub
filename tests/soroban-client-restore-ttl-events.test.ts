import { readFileSync } from 'fs';
import path from 'path';

import { Address, contract, Keypair, StrKey, xdr } from '@stellar/stellar-sdk';

import * as ex76 from '../src/examples/76-generated-client-example';
import * as ex77 from '../src/examples/77-transaction-restoration';
import * as ex78 from '../src/examples/78-contract-ttl-extension';
import * as ex79 from '../src/examples/79-transaction-event-decoding';
import { examples } from '../src/runner/catalog';

const NATIVE_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const readme = () => readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

describe('ISSUE-076: generated Soroban client usage', () => {
  it('declares a spec whose functions a client exposes by name', () => {
    const spec = new contract.Spec(ex76.tokenSpecEntries());
    const client = new contract.Client(spec, {
      contractId: NATIVE_SAC,
      networkPassphrase: 'Test SDF Network ; September 2015',
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });

    expect(ex76.listClientMethods(client)).toEqual(['balance', 'decimals', 'name', 'symbol']);
    expect(typeof (client as unknown as Record<string, unknown>).balance).toBe('function');
  });

  it('formats decoded results with their JavaScript type', () => {
    expect(ex76.formatTypedResult(7)).toBe('7 (number)');
    expect(ex76.formatTypedResult(100n)).toBe('100 (bigint)');
    expect(ex76.formatTypedResult(undefined)).toBe('undefined (void return)');
    expect(ex76.formatTypedResult({ amount: 5n })).toContain('"amount":"5"');
  });

  it('explains initialization and invocation failures', () => {
    expect(ex76.explainClientFailure('contract missing metadata section')).toMatch(
      /no readable spec/i,
    );
    expect(ex76.explainClientFailure('client.foo is not a function')).toMatch(
      /not part of the spec/i,
    );
    expect(ex76.explainClientFailure('something else entirely')).toMatch(/verify the contract id/i);
  });
});

describe('ISSUE-077: Soroban transaction restoration', () => {
  const simulationSuccess = { transactionData: {}, minResourceFee: '100' } as any;

  it('reports no restoration for a clean simulation', () => {
    const verdict = ex77.assessRestorationNeed(simulationSuccess);
    expect(verdict.required).toBe(false);
    expect(verdict.reason).toMatch(/no restore preamble/i);
  });

  it('detects restoration from a restore preamble', () => {
    const withPreamble = {
      ...simulationSuccess,
      restorePreamble: { minResourceFee: '4242', transactionData: {} },
    } as any;

    const verdict = ex77.assessRestorationNeed(withPreamble);
    expect(verdict.required).toBe(true);
    expect(verdict.minResourceFee).toBe('4242');
  });

  it('detects restoration from an archived-state simulation error', () => {
    const archived = { error: 'entry has been archived' } as any;
    expect(ex77.assessRestorationNeed(archived).required).toBe(true);

    const unrelated = { error: 'invalid function name' } as any;
    const verdict = ex77.assessRestorationNeed(unrelated);
    expect(verdict.required).toBe(false);
    expect(verdict.reason).toMatch(/unrelated reason/i);
  });

  it('explains restoration failures', () => {
    expect(ex77.explainRestorationFailure('tx_bad_seq')).toMatch(/sequence number/i);
    expect(ex77.explainRestorationFailure('insufficient balance')).toMatch(/restore fee/i);
    expect(ex77.explainRestorationFailure('malformed footprint')).toMatch(/restorePreamble/);
  });
});

describe('ISSUE-078: Soroban contract TTL extension', () => {
  it('validates contract IDs before any network call', () => {
    expect(ex78.isValidContractId(NATIVE_SAC)).toBe(true);
    expect(ex78.isValidContractId('not-a-contract')).toBe(false);
    expect(ex78.isValidContractId(Keypair.random().publicKey())).toBe(false);
  });

  it('builds the instance ledger key for a contract', () => {
    const key = ex78.instanceLedgerKey(NATIVE_SAC);
    expect(key.switch().name).toBe('contractData');
    expect(StrKey.encodeContract(key.contractData().contract().contractId())).toBe(NATIVE_SAC);
  });

  it('returns no code key for a built-in (non-WASM) executable', () => {
    const instance = new xdr.ScContractInstance({
      executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
      storage: null,
    });
    const entry = {
      val: xdr.LedgerEntryData.contractData(
        new xdr.ContractDataEntry({
          // The generated .d.ts models ExtensionPoint's zero arm as a static member,
          // while at runtime it is constructed as new ExtensionPoint(0) — see
          // tests/transaction-preflight.test.ts for the same bridge.
          ext: new (xdr.ExtensionPoint as any)(0),
          contract: new Address(NATIVE_SAC).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
          val: xdr.ScVal.scvContractInstance(instance),
        }),
      ),
    } as any;

    expect(ex78.codeLedgerKeyFromInstance(entry)).toBeNull();
  });

  it('summarizes remaining lifetime relative to the current ledger', () => {
    expect(ex78.summarizeTtl(1_500, 1_000)).toEqual({
      liveUntilLedgerSeq: 1_500,
      ledgersRemaining: 500,
    });
    expect(ex78.summarizeTtl(undefined, 1_000)).toEqual({});
  });

  it('describes ledger spans as approximate durations', () => {
    expect(ex78.describeLedgerSpan(0)).toBe('already archived');
    expect(ex78.describeLedgerSpan(-5)).toBe('already archived');
    expect(ex78.describeLedgerSpan(120)).toMatch(/minutes/);
    expect(ex78.describeLedgerSpan(2_000)).toMatch(/hours/);
    expect(ex78.describeLedgerSpan(100_000)).toMatch(/days/);
  });

  it('explains extension failures', () => {
    expect(ex78.explainTtlFailure('entry not found')).toMatch(/restoreFootprint/);
    expect(ex78.explainTtlFailure('extendTo exceeds max')).toMatch(/network maximum/i);
    expect(ex78.explainTtlFailure('malformed footprint')).toMatch(/read-only footprint/i);
  });
});

describe('ISSUE-079: Soroban transaction event decoding', () => {
  it('decodes a contract event from transaction metadata', () => {
    const rawEvent = new xdr.ContractEvent({
      // The generated .d.ts models ExtensionPoint's zero arm as a static member,
      // while at runtime it is constructed as new ExtensionPoint(0) — see
      // tests/transaction-preflight.test.ts for the same bridge.
      ext: new (xdr.ExtensionPoint as any)(0),
      contractId: StrKey.decodeContract(NATIVE_SAC),
      type: xdr.ContractEventType.contract(),
      // ContractEventBody's only arm is named "0", which the generated .d.ts
      // exposes as a static member but which is constructed positionally at
      // runtime — the same .d.ts/runtime mismatch as ExtensionPoint above.
      body: new (xdr.ContractEventBody as any)(
        0,
        new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol('transfer')],
          data: xdr.ScVal.scvU32(42),
        }),
      ),
    });

    const decoded = ex79.decodeContractEvent(rawEvent);
    expect(decoded).toEqual({
      contractId: NATIVE_SAC,
      type: 'contract',
      topics: ['transfer'],
      data: 42,
    });
  });

  it('decodes an event returned by the RPC event index', () => {
    const decoded = ex79.decodeEventResponse({
      type: 'contract',
      topic: [xdr.ScVal.scvSymbol('transfer')],
      value: xdr.ScVal.scvU32(7),
    } as any);

    expect(decoded.topics).toEqual(['transfer']);
    expect(decoded.data).toBe(7);
    expect(decoded.contractId).toBe('unknown');
  });

  it('throws on metadata this SDK build cannot parse, so callers can fall back', () => {
    expect(() => ex79.decodeEventsFromMeta('not-valid-xdr')).toThrow();
  });

  it('formats decoded values, including bigints and buffers', () => {
    expect(ex79.formatDecodedValue(5n)).toBe('5');
    expect(ex79.formatDecodedValue(Buffer.from([0xab]))).toBe('0xab');
    expect(ex79.formatDecodedValue({ amount: 9n })).toContain('"amount":"9"');
    expect(ex79.formatDecodedValue(undefined)).toBe('undefined');
  });
});

describe('runner and documentation registration', () => {
  const names = [
    '76-generated-client-example',
    '77-transaction-restoration',
    '78-contract-ttl-extension',
    '79-transaction-event-decoding',
  ];

  it.each(names)('registers %s in the interactive runner', (name) => {
    expect(examples[name]).toBeDefined();
    expect(examples[name].name).toBe(name);
    expect(typeof examples[name].run).toBe('function');
    expect(examples[name].description.length).toBeGreaterThan(20);
  });

  it.each(names)('documents %s in the README', (name) => {
    expect(readme()).toContain(name);
  });

  it.each(names)('excludes %s from automated validation (needs live network)', (name) => {
    const config = JSON.parse(
      readFileSync(
        path.join(__dirname, '..', 'src', 'validation', 'validation.config.json'),
        'utf8',
      ),
    );
    const excluded = config.exclusions.some((entry: { match: string }) => entry.match === name);
    expect(excluded).toBe(true);
  });
});
