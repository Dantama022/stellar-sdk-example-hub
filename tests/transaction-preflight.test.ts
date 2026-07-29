import { readFileSync } from 'fs';
import path from 'path';

import { xdr } from '@stellar/stellar-sdk';

import * as preflight from '../src/examples/81-transaction-preflight';
import { examples } from '../src/runner/catalog';

describe('ISSUE-108 / ISSUE-081: Soroban Transaction Preflight', () => {
  /**
   * Builds a real `xdr.SorobanTransactionData` from actual XDR builder
   * classes, so footprint extraction is exercised against genuine XDR rather
   * than a pre-decoded stand-in.
   */
  const buildTransactionData = (options: {
    instructions: number;
    readBytes: number;
    writeBytes: number;
    readOnlyCount: number;
    readWriteCount: number;
  }): xdr.SorobanTransactionData => {
    const makeLedgerKey = () =>
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: xdr.ScAddress.scAddressTypeContract(Buffer.alloc(32)),
          key: xdr.ScVal.scvSymbol('state'),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      );

    const footprint = new xdr.LedgerFootprint({
      readOnly: Array.from({ length: options.readOnlyCount }, () => makeLedgerKey()),
      readWrite: Array.from({ length: options.readWriteCount }, () => makeLedgerKey()),
    });

    const resources = new xdr.SorobanResources({
      footprint,
      instructions: options.instructions,
      readBytes: options.readBytes,
      writeBytes: options.writeBytes,
    });

    return new xdr.SorobanTransactionData({
      resources,
      resourceFee: xdr.Int64.fromString('0'),
      // The generated .d.ts models ExtensionPoint's zero arm as a static
      // method named `0`, but the runtime union is actually constructed via
      // `new ExtensionPoint(0)` — cast through `any` to bridge that mismatch.
      ext: new (xdr.ExtensionPoint as any)(0),
    });
  };

  describe('extractFootprintSummary', () => {
    it('decodes instructions, read/write bytes, and footprint entry counts', () => {
      const transactionData = buildTransactionData({
        instructions: 123456,
        readBytes: 2048,
        writeBytes: 512,
        readOnlyCount: 2,
        readWriteCount: 1,
      });

      const summary = preflight.extractFootprintSummary(transactionData);

      expect(summary).toEqual({
        instructions: 123456,
        readBytes: 2048,
        writeBytes: 512,
        readOnlyEntryCount: 2,
        readWriteEntryCount: 1,
      });
    });

    it('handles an empty footprint (no read-only or read-write entries)', () => {
      const transactionData = buildTransactionData({
        instructions: 0,
        readBytes: 0,
        writeBytes: 0,
        readOnlyCount: 0,
        readWriteCount: 0,
      });

      const summary = preflight.extractFootprintSummary(transactionData);

      expect(summary.readOnlyEntryCount).toBe(0);
      expect(summary.readWriteEntryCount).toBe(0);
    });
  });

  describe('summarizeAuthEntries', () => {
    it('returns a zeroed summary for undefined auth entries', () => {
      expect(preflight.summarizeAuthEntries(undefined)).toEqual({ count: 0, entries: [] });
    });

    it('returns a zeroed summary for an empty array', () => {
      expect(preflight.summarizeAuthEntries([])).toEqual({ count: 0, entries: [] });
    });

    it('labels each entry by index for a populated array', () => {
      const result = preflight.summarizeAuthEntries([{}, {}]);

      expect(result.count).toBe(2);
      expect(result.entries).toEqual([
        '[0] SorobanAuthorizationEntry',
        '[1] SorobanAuthorizationEntry',
      ]);
    });
  });

  describe('formatResourceFee', () => {
    it('formats a numeric fee', () => {
      expect(preflight.formatResourceFee(12345)).toBe('12345 stroops');
    });

    it('formats a string fee', () => {
      expect(preflight.formatResourceFee('98765')).toContain('stroops');
      expect(preflight.formatResourceFee('98765')).toBe('98765 stroops');
    });
  });

  describe('describePreflightFailure', () => {
    it('never throws and always returns a non-empty guidance string', () => {
      const samples = [
        'missing authorization entry for invocation',
        'UnexpectedType: argument 2 expected Symbol, got I64',
        'contract not found on this network',
        'entry has expired, TTL extension required',
        'something totally unrecognized happened',
        '',
      ];

      samples.forEach((sample) => {
        expect(() => preflight.describePreflightFailure(sample)).not.toThrow();
        const result = preflight.describePreflightFailure(sample);
        expect(result.guidance).toEqual(expect.any(String));
        expect(result.guidance.length).toBeGreaterThan(0);
      });
    });

    it('preserves the original message', () => {
      const result = preflight.describePreflightFailure('some raw simulation error');
      expect(result.message).toBe('some raw simulation error');
    });

    it('gives auth-specific guidance for missing authorization errors', () => {
      const result = preflight.describePreflightFailure('missing required authorization entry');
      expect(result.guidance.toLowerCase()).toContain('auth');
    });

    it('gives argument-specific guidance for argument type errors', () => {
      const result = preflight.describePreflightFailure('invalid argument type provided');
      expect(result.guidance.toLowerCase()).toContain('argument');
    });
  });

  describe('explainPreflightVsSimulation', () => {
    it('mentions both preflight and simulation', () => {
      const explanation = preflight.explainPreflightVsSimulation();
      expect(explanation.toLowerCase()).toContain('preflight');
      expect(explanation.toLowerCase()).toContain('simulation');
    });

    it('explains that preflight precedes signing/submission and simulation is a dry run', () => {
      const explanation = preflight.explainPreflightVsSimulation();
      expect(explanation).toContain('sign');
      expect(explanation).toContain('submit');
      expect(explanation.toLowerCase()).toContain('dry run');
    });
  });

  describe('runner and documentation registration', () => {
    it('registers the example in the runner catalog', () => {
      const entry = examples['81-transaction-preflight'];

      expect(entry).toBeDefined();
      expect(typeof entry.run).toBe('function');
    });

    it('documents the example in the README', () => {
      const readme = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

      expect(readme).toContain('`81-transaction-preflight`');
      expect(readme).toContain('npm run run-example 81-transaction-preflight');
    });
  });
});
