import * as fs from 'fs';

import { examples } from '../src/runner/catalog';

const exampleNames = [
  '108-dynamic-contract-invocation',
  '109-soroban-transaction-preparation',
  '110-soroban-transaction-submission',
  '111-soroban-transaction-error-diagnosis',
];

function readExample(name: string): string {
  return fs.readFileSync(`src/examples/${name}.ts`, 'utf8');
}

describe('ISSUE-108: dynamic Soroban contract invocation', () => {
  const source = readExample('108-dynamic-contract-invocation');

  it('uses the isolated current-protocol Stellar SDK', () => {
    expect(source).toContain("from 'stellar-sdk-v16'");
  });

  it('discovers and uses the runtime contract specification', () => {
    expect(source).toContain('contract.Client.fromWasm');

    expect(source).toContain('spec.funcArgsToScVals');

    expect(source).toContain('spec.funcResToNative');
  });

  it('simulates the dynamically constructed invocation', () => {
    expect(source).toContain('simulateTransaction');

    expect(source).toContain('new Contract(contractId)');

    expect(source).toContain('targetContract.call');
  });
});

describe('ISSUE-109: Soroban transaction preparation', () => {
  const source = readExample('109-soroban-transaction-preparation');

  it('uses the isolated current-protocol Stellar SDK', () => {
    expect(source).toContain("from 'stellar-sdk-v16'");
  });

  it('simulates and assembles the transaction', () => {
    expect(source).toContain('simulateTransaction');

    expect(source).toContain('assembleTransaction');
  });

  it('documents the transaction lifecycle stages', () => {
    expect(source).toContain('BUILD');

    expect(source).toContain('SIMULATE');

    expect(source).toContain('PREPARE');

    expect(source).toContain('SIGN');

    expect(source).toContain('SUBMIT');
  });
});

describe('ISSUE-110: Soroban transaction submission', () => {
  const source = readExample('110-soroban-transaction-submission');

  it('uses the isolated current-protocol Stellar SDK', () => {
    expect(source).toContain("from 'stellar-sdk-v16'");
  });

  it('funds, signs, and submits a Testnet transaction', () => {
    expect(source).toContain('fundAddress');

    expect(source).toContain('.sign(');

    expect(source).toContain('sendTransaction');
  });

  it('polls for a terminal transaction result', () => {
    expect(source).toContain('getTransaction');

    expect(source).toContain('POLL_INTERVAL_MS');

    expect(source).toContain('POLL_TIMEOUT_MS');

    expect(source).toContain("'TIMEOUT'");

    expect(source).toContain("'UNAVAILABLE'");
  });
});

describe('ISSUE-111: Soroban transaction error diagnosis', () => {
  const source = readExample('111-soroban-transaction-error-diagnosis');

  it('uses the isolated current-protocol Stellar SDK', () => {
    expect(source).toContain("from 'stellar-sdk-v16'");
  });

  it('retrieves and diagnoses transaction failures', () => {
    expect(source).toContain('getTransaction');

    expect(source).toContain('extractOperationFailures');

    expect(source).toContain('parseDiagnosticEvents');

    expect(source).toContain('classifyFailure');
  });

  it('supports all requested error categories', () => {
    expect(source).toContain("'RPC error'");

    expect(source).toContain("'Transaction error'");

    expect(source).toContain("'Authorization error'");

    expect(source).toContain("'Resource/Fee error'");

    expect(source).toContain("'Contract execution error'");

    expect(source).toContain("'State/Archival error'");
  });

  it('handles missing diagnostic information gracefully', () => {
    expect(source).toContain('No diagnostic information was returned');
  });
});

describe('Runner registration for ISSUE-108 through ISSUE-111', () => {
  it('registers all four examples', () => {
    for (const name of exampleNames) {
      expect(examples[name]).toBeDefined();

      expect(examples[name].name).toBe(name);

      expect(typeof examples[name].run).toBe('function');
    }
  });
});

describe('README documentation for ISSUE-108 through ISSUE-111', () => {
  const readme = fs.readFileSync('README.md', 'utf8');

  it('documents all four examples', () => {
    for (const name of exampleNames) {
      expect(readme).toContain(name);
    }
  });
});

describe('SDK dependency isolation', () => {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
    dependencies: Record<string, string>;
  };

  it('keeps the repository SDK on its existing major version', () => {
    expect(packageJson.dependencies['@stellar/stellar-sdk']).toBe('^13.0.0');
  });

  it('provides SDK 16 only for the new Protocol 28 examples', () => {
    expect(packageJson.dependencies['stellar-sdk-v16']).toBe('npm:@stellar/stellar-sdk@16.2.0');
  });
});
