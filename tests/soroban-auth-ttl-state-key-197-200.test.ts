import { Address, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import {
  classifyExpiration,
  decodeLedgerKeyXdr,
  inspectContractState,
} from '../src/utils/soroban-state-inspection';
import {
  inspectAuthorizationEntries,
  inspectAuthorizationEntry,
} from '../src/examples/197-soroban-authorization-signature-inspection';
import { buildStateReport } from '../src/examples/199-soroban-state-report';
import { decodeLedgerKeys } from '../src/examples/200-decode-ledger-key';
const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
function contractDataKey(durability: xdr.ContractDataDurability): string {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(CONTRACT_ID).toScAddress(),
      key: xdr.ScVal.scvSymbol('counter'),
      durability,
    }),
  ).toXDR('base64');
}
describe('ISSUE-200 ledger-key decoder', () => {
  test('contract data/raw XDR', () => {
    const raw = contractDataKey(xdr.ContractDataDurability.persistent());
    const report = decodeLedgerKeyXdr(raw);
    expect(report.supported).toBe(true);
    expect(report.ledgerKeyType).toBe('contractData');
    expect(report.contractId).toBe(CONTRACT_ID);
    expect(report.durability).toBe('Persistent');
    expect(report.rawXdr).toBe(raw);
  });
  test('temporary and multiple', () => {
    const reports = decodeLedgerKeys([
      contractDataKey(xdr.ContractDataDurability.persistent()),
      contractDataKey(xdr.ContractDataDurability.temporary()),
    ]);
    expect(reports).toHaveLength(2);
    expect(reports[1].durability).toBe('Temporary');
  });
  test('bad input', () => {
    expect(decodeLedgerKeyXdr('@@@').error).toMatch(/base64/i);
    expect(decodeLedgerKeyXdr(Buffer.from('bad-xdr').toString('base64')).error).toMatch(
      /Malformed/i,
    );
  });
});
describe('ISSUE-198 TTL', () => {
  test('statuses', () => {
    expect(classifyExpiration(100, 500, 50).status).toBe('Active');
    expect(classifyExpiration(100, 120, 50).status).toBe('Near expiration');
    expect(classifyExpiration(100, 99, 50).status).toBe('Expired/unavailable');
    expect(classifyExpiration(100, undefined, 50).status).toBe('Unknown');
  });
  test('missing entry', async () => {
    const provider = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 100 }),
      getContractData: jest.fn().mockRejectedValue(new Error('entry not found')),
    };
    const entries = await inspectContractState(provider, CONTRACT_ID, [], 10);
    expect(entries[0].status).toBe('Expired/unavailable');
  });
});
describe('ISSUE-199 report', () => {
  test('summary/filter/limit', async () => {
    const value = nativeToScVal(7);
    const ledgerEntry = {
      val: { contractData: () => ({ val: () => value }), toXDR: () => Buffer.from('entry') },
      liveUntilLedgerSeq: 150,
    } as unknown as rpc.Api.LedgerEntryResult;
    const provider = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 100 }),
      getContractData: jest.fn().mockResolvedValue(ledgerEntry),
    };
    const report = await buildStateReport(
      {
        contractId: CONTRACT_ID,
        keys: ['symbol:a'],
        warningLedgers: 60,
        entryType: 'persistent-data',
        limit: 1,
      },
      provider as unknown as rpc.Server,
    );
    expect(report.summary.totalEntriesInspected).toBe(1);
    expect(report.summary.entriesWithTtl).toBe(1);
    expect(report.summary.nearExpiration).toBe(1);
    expect(report.entries).toHaveLength(1);
  });
});
describe('ISSUE-197 auth signature', () => {
  test('malformed', () => {
    const report = inspectAuthorizationEntry('not-xdr');
    expect(report.roundTripValid).toBe(false);
    expect(report.signatureState).toBe('structurally-invalid');
  });
  test('multiple', () => {
    expect(inspectAuthorizationEntries(['bad-one', 'bad-two'])).toHaveLength(2);
  });
  test('source-account credential', () => {
    const invocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(CONTRACT_ID).toScAddress(),
          functionName: 'hello',
          args: [],
        }),
      ),
      subInvocations: [],
    });
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: invocation,
    });
    const report = inspectAuthorizationEntry(entry.toXDR('base64'));
    expect(report.roundTripValid).toBe(true);
    expect(report.credentialType).toBe('sorobanCredentialsSourceAccount');
    expect(report.signatureState).toBe('not-applicable');
    expect(report.invocations[0].functionName).toBe('hello');
  });
});
