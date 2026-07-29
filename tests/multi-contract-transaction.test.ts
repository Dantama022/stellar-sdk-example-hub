import { readFileSync } from 'fs';
import path from 'path';

import { Account, Networks, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

import * as ex83 from '../src/examples/83-multi-contract-transaction';
import { examples } from '../src/runner/catalog';

describe('ISSUE-083: Multi-Contract Transaction Composition', () => {
  const orchestratorContractId = 'CAZSKFP35JH65M3ORDPHKDH3SPYBZIYU2N2ZEY63E24NFIZCG4XNLVQD';
  const contractA = 'CD3VK47OKVWW3QPWAICPJ6CGBTRIXKDWE4QWAR6LQ7UW667F3Q7KOTQL';
  const contractB = 'CAZSKFP35JH65M3ORDPHKDH3SPYBZIYU2N2ZEY63E24NFIZCG4XNLVQD';
  const sourcePublicKey = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

  describe('buildOrchestratorOperation', () => {
    it('builds a single invokeHostFunction operation from two downstream contract IDs', () => {
      const op = ex83.buildOrchestratorOperation(
        orchestratorContractId,
        [contractA, contractB],
        'orchestrate',
      );

      expect(op).toBeInstanceOf(xdr.Operation);
      expect(op.body().switch().name).toBe('invokeHostFunction');

      const invocation = op.body().invokeHostFunctionOp().hostFunction().invokeContract();
      expect(invocation.functionName().toString()).toBe('orchestrate');
      // contractAddress + two downstream contract addresses supplied as args
      expect(invocation.args()).toHaveLength(2);
    });

    it('produces a transaction with exactly one operation when added to a TransactionBuilder', () => {
      const op = ex83.buildOrchestratorOperation(
        orchestratorContractId,
        [contractA, contractB],
        'orchestrate',
      );

      const account = new Account(sourcePublicKey, '0');
      const tx = new TransactionBuilder(account, {
        fee: '1000000',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(op)
        .setTimeout(30)
        .build();

      expect(tx.operations).toHaveLength(1);
      expect(tx.operations[0].type).toBe('invokeHostFunction');
    });

    it('throws on an invalid contract ID rather than silently succeeding', () => {
      expect(() =>
        ex83.buildOrchestratorOperation('not-a-real-contract', [contractA], 'orchestrate'),
      ).toThrow();
    });
  });

  describe('summarizeInvocationResults', () => {
    it('returns zeroed totals for an empty array', () => {
      expect(ex83.summarizeInvocationResults([])).toEqual({ total: 0, succeeded: 0, failed: 0 });
    });

    it('counts all-success results', () => {
      const results = [
        { contractId: contractA, success: true },
        { contractId: contractB, success: true },
      ];
      expect(ex83.summarizeInvocationResults(results)).toEqual({
        total: 2,
        succeeded: 2,
        failed: 0,
      });
    });

    it('counts all-failure results', () => {
      const results = [
        { contractId: contractA, success: false, error: 'boom' },
        { contractId: contractB, success: false, error: 'boom' },
      ];
      expect(ex83.summarizeInvocationResults(results)).toEqual({
        total: 2,
        succeeded: 0,
        failed: 2,
      });
    });

    it('counts a mix of success and failure', () => {
      const results = [
        { contractId: orchestratorContractId, success: true, value: 42 },
        { contractId: contractA, success: false, error: 'downstream reverted' },
        { contractId: contractB, success: false, error: 'downstream reverted' },
      ];
      expect(ex83.summarizeInvocationResults(results)).toEqual({
        total: 3,
        succeeded: 1,
        failed: 2,
      });
    });
  });

  describe('explainAtomicity', () => {
    it('explains that a revert rolls back the entire transaction atomically', () => {
      const explanation = ex83.explainAtomicity();

      expect(explanation.toLowerCase()).toContain('atomic');
      expect(explanation.toLowerCase()).toMatch(/revert|rollback|rolled back/);
    });

    it('explains that execution order follows the orchestrator code path, not argument order', () => {
      const explanation = ex83.explainAtomicity().toLowerCase();

      expect(explanation).toContain('execution order');
      expect(explanation).toContain('orchestrator');
    });
  });

  describe('describeExecutionOrder', () => {
    it('returns an ordered list covering the orchestrator and both downstream steps', () => {
      const steps = ex83.describeExecutionOrder([contractA, contractB]);

      expect(steps).toHaveLength(4);
      steps.forEach((step) => {
        expect(typeof step).toBe('string');
        expect(step.length).toBeGreaterThan(0);
      });

      expect(steps[0]).toContain('Orchestrator invoked');
      expect(steps[1]).toContain(contractA);
      expect(steps[2]).toContain(contractB);
    });

    it('handles a single downstream contract', () => {
      const steps = ex83.describeExecutionOrder([contractA]);
      expect(steps).toHaveLength(3);
    });

    it('handles no downstream contracts', () => {
      const steps = ex83.describeExecutionOrder([]);
      expect(steps).toHaveLength(2);
    });
  });

  describe('explainInvocationFailure', () => {
    it('never throws and always returns non-empty guidance', () => {
      const messages = [
        'Invalid contract ID: CABC123',
        'unknown method: orchestrate',
        'auth failure: missing signature',
        'HostError: Error(Contract, #1) trapped',
        'entry has expired, extend TTL',
        '',
        'some completely unrecognized error string',
      ];

      messages.forEach((msg) => {
        expect(() => ex83.explainInvocationFailure(msg)).not.toThrow();
        const result = ex83.explainInvocationFailure(msg);
        expect(typeof result.guidance).toBe('string');
        expect(result.guidance.length).toBeGreaterThan(0);
      });
    });

    it('gives contract-ID guidance for invalid contract errors', () => {
      const result = ex83.explainInvocationFailure('Invalid contract ID: CFOO');
      expect(result.guidance.toLowerCase()).toContain('contract');
    });

    it('gives auth guidance for authorization failures', () => {
      const result = ex83.explainInvocationFailure('Unauthorized: missing auth entry');
      expect(result.guidance.toLowerCase()).toContain('auth');
    });

    it('gives atomicity-aware guidance for a reverted/trapped invocation', () => {
      const result = ex83.explainInvocationFailure('HostError: contract trapped during call');
      expect(result.guidance.toLowerCase()).toMatch(/atomic|roll|entire transaction/);
    });

    it('falls back to sensible default guidance for unrecognized messages', () => {
      const result = ex83.explainInvocationFailure('a completely novel error nobody has seen');
      expect(result.guidance.length).toBeGreaterThan(0);
    });
  });

  describe('runner and documentation registration', () => {
    it('registers the example in the runner catalog', () => {
      const entry = examples['83-multi-contract-transaction'];

      expect(entry).toBeDefined();
      expect(typeof entry.run).toBe('function');
      expect(entry.name).toBe('83-multi-contract-transaction');
    });

    it('documents the example and how to run it in the README', () => {
      const readme = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

      expect(readme).toContain('`83-multi-contract-transaction`');
      expect(readme).toContain('npm run run-example 83-multi-contract-transaction');
    });

    it('is excluded from automated validation with a documented reason', () => {
      const config = JSON.parse(
        readFileSync(
          path.join(__dirname, '..', 'src', 'validation', 'validation.config.json'),
          'utf8',
        ),
      );

      const entry = config.exclusions.find(
        (exclusion: { match: string }) => exclusion.match === '83-multi-contract-transaction',
      );

      expect(entry).toBeDefined();
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.length).toBeGreaterThan(0);
    });
  });
});
