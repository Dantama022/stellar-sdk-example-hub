import { xdr } from '@stellar/stellar-sdk';

import {
  compareScVal,
  decodePayload,
  decodeScVal,
  decodeTopics,
  formatEventDecodingReport,
  formatNativeValue,
  getScValXdrType,
  renderDecodedValue,
} from '../src/utils/scval-decoder';

describe('scval-decoder', () => {
  it('reads ScVal discriminants and unsupported types', () => {
    const boolVal = xdr.ScVal.scvBool(true);
    expect(getScValXdrType(boolVal)).toBe('scvBool');

    const unsupported = decodeScVal(xdr.ScVal.scvLedgerKeyContractInstance());
    expect(unsupported.decoded).toBe(false);
    expect(unsupported.error).toContain('not supported');
  });

  it('formats native values for display', () => {
    expect(formatNativeValue(5n)).toBe('5');
    expect(formatNativeValue(Uint8Array.from([1]))).toBe('0x01');
    expect(formatNativeValue([1, 2n])).toEqual([1, '2']);
    expect(formatNativeValue(new Map([['k', 1]]))).toEqual({ k: 1 });
    expect(formatNativeValue({ a: 1 })).toEqual({ a: 1 });
    expect(formatNativeValue('plain')).toBe('plain');
  });

  it('decodes ScVals and undefined payloads', () => {
    const original = xdr.ScVal.scvU32(99);
    const decoded = decodeScVal(original);
    expect(decoded.decoded).toBe(true);
    expect(decoded.value).toBe(99);
    expect(decoded.xdrType).toBe('scvU32');

    const empty = decodePayload(undefined);
    expect(empty.decoded).toBe(true);
    expect(empty.value).toBeNull();
  });

  it('renders decoded values and compares raw output', () => {
    const scVal = xdr.ScVal.scvString('hello');
    const decoded = decodeScVal(scVal);
    expect(renderDecodedValue(decoded)).toBe('"hello"');

    const comparison = compareScVal(scVal);
    expect(comparison.decoded).toBe(true);
    expect(comparison.decodedDisplay).toContain('hello');
    expect(comparison.rawXdr.length).toBeGreaterThan(0);
  });

  it('decodes event topics and formats a report', () => {
    const topics = [xdr.ScVal.scvSymbol('transfer'), xdr.ScVal.scvU32(1)];
    const decodedTopics = decodeTopics(topics);
    expect(decodedTopics).toHaveLength(2);

    const report = formatEventDecodingReport({
      contractId: 'C123',
      ledger: 42,
      txHash: 'abc',
      topics,
      value: xdr.ScVal.scvU32(7),
    });
    expect(report).toContain('Contract ID     : C123');
    expect(report).toContain('Topics (indexed):');
    expect(report).toContain('Payload (data):');
  });

  it('handles decoder failures gracefully', () => {
    const broken = {
      switch: () => {
        throw new Error('boom');
      },
    } as unknown as xdr.ScVal;
    expect(getScValXdrType(broken)).toBe('unknown');
    expect(renderDecodedValue({ xdrType: 'x', rawXdr: '', value: null, decoded: false })).toContain(
      'undecodable',
    );
  });
});
