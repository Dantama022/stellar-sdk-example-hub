import * as ex354 from '../src/examples/354-transaction-monitoring-finality';
import * as ex355 from '../src/examples/355-sep2-federation-resolution';
import * as ex356 from '../src/examples/356-sep41-token-inspector';
import * as ex357 from '../src/examples/357-home-domain-audit';
import { examples } from '../src/runner/catalog';

describe('Examples Exports for ISSUE-354, ISSUE-355, ISSUE-356, ISSUE-357', () => {
  it('should export a run function for all new examples', () => {
    for (const mod of [ex354, ex355, ex356, ex357]) {
      expect(typeof mod.run).toBe('function');
    }
  });

  it('should register the new examples in the catalog', () => {
    for (const key of [
      '354-transaction-monitoring-finality',
      '355-sep2-federation-resolution',
      '356-sep41-token-inspector',
      '357-home-domain-audit',
    ]) {
      expect(examples[key]).toBeDefined();
      expect(examples[key].name).toBe(key);
      expect(typeof examples[key].run).toBe('function');
    }
  });
});

describe('ISSUE-354: Transaction Monitoring with Finality Tracking', () => {
  it('validates transaction hash format', () => {
    expect(() => ex354.validateTransactionHash('abc')).toThrow('64 hexadecimal characters');
    expect(() => ex354.validateTransactionHash('a'.repeat(64))).not.toThrow();
    expect(ex354.validateTransactionHash('A'.repeat(64))).toBe('a'.repeat(64));
  });

  it('parses transaction records correctly', () => {
    const record = {
      hash: 'a'.repeat(64),
      successful: true,
      ledger: 12345,
      created_at: '2024-01-01T00:00:00Z',
      operation_count: 2,
      fee_charged: '100',
      result_code: 'tx_success',
    };
    const result = ex354.parseTransactionRecord('a'.repeat(64), record, 1, 1000, 3, 12347);
    expect(result.status).toBe('final');
    expect(result.ledgerSequence).toBe(12345);
    expect(result.confirmations).toBe(3);
    expect(result.finalityLedger).toBe(12347);
  });

  it('handles pending transactions', () => {
    const record = {
      hash: 'a'.repeat(64),
      successful: false,
      ledger: null,
      created_at: null,
      operation_count: 0,
      fee_charged: null,
      result_code: null,
    };
    const result = ex354.parseTransactionRecord('a'.repeat(64), record, 1, 1000, 3, 12347);
    expect(result.status).toBe('pending');
  });
});

describe('ISSUE-355: SEP-2 Federation Resolution', () => {
  it('parses stellar address format', () => {
    const result = ex355.parseStellarAddress('user*example.com');
    expect(result).toEqual({ username: 'user', domain: 'example.com' });

    const result2 = ex355.parseStellarAddress('user@example.com');
    expect(result2).toEqual({ username: 'user', domain: 'example.com' });

    expect(ex355.parseStellarAddress('invalid')).toBeNull();
  });

  it('validates account ID', () => {
    const valid = ex355.validateAccountId('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
    expect(valid.valid).toBe(true);
    expect(valid.accountId).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');

    const invalid = ex355.validateAccountId('invalid');
    expect(invalid.valid).toBe(false);
    expect(invalid.error).toContain('Ed25519');
  });
});

describe('ISSUE-356: SEP-41 Token Inspector', () => {
  it('validates contract ID', () => {
    expect(ex356.isValidContractId('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toBe(true);
    expect(ex356.isValidContractId('invalid')).toBe(false);
  });

  it('defines SEP-41 required methods', () => {
    expect(ex356.SEP41_REQUIRED_METHODS).toContain('name');
    expect(ex356.SEP41_REQUIRED_METHODS).toContain('symbol');
    expect(ex356.SEP41_REQUIRED_METHODS).toContain('decimals');
    expect(ex356.SEP41_REQUIRED_METHODS).toContain('balance');
    expect(ex356.SEP41_REQUIRED_METHODS).toContain('transfer');
    expect(ex356.SEP41_REQUIRED_METHODS).toContain('transfer_from');
    expect(ex356.SEP41_REQUIRED_METHODS).toContain('approve');
    expect(ex356.SEP41_REQUIRED_METHODS).toContain('burn');
    expect(ex356.SEP41_REQUIRED_METHODS).toContain('burn_from');
    expect(ex356.SEP41_REQUIRED_METHODS).toContain('allowance');
  });
});

describe('ISSUE-357: Home Domain Audit', () => {
  it('validates account ID', () => {
    const valid = ex357.validateAccountId('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
    expect(valid.valid).toBe(true);

    const invalid = ex357.validateAccountId('invalid');
    expect(invalid.valid).toBe(false);
    expect(invalid.error).toContain('Ed25519');
  });

  it('parses boolean parameters', () => {
    expect(ex357.parseBoolean('true')).toBe(true);
    expect(ex357.parseBoolean('false')).toBe(false);
    expect(ex357.parseBoolean(true)).toBe(true);
    expect(ex357.parseBoolean(false)).toBe(false);
    expect(ex357.parseBoolean(1)).toBe(true);
    expect(ex357.parseBoolean(0)).toBe(false);
    expect(ex357.parseBoolean(undefined)).toBe(false);
  });
});

describe('README documentation for ISSUE-354 through ISSUE-357', () => {
  const fs = require('fs');
  const readme = fs.readFileSync('README.md', 'utf8');

  it('documents all four new examples', () => {
    for (const name of [
      '354-transaction-monitoring-finality',
      '355-sep2-federation-resolution',
      '356-sep41-token-inspector',
      '357-home-domain-audit',
    ]) {
      expect(readme).toContain(name);
    }
  });
});