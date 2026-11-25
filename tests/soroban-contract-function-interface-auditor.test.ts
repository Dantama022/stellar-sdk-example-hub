import { StrKey } from '@stellar/stellar-sdk';

import {
  validateContractAddress,
  formatSignature,
  formatExpectedSignature,
  auditFunction,
  auditCompatibility,
  formatCompatibilityReport,
  getDefaultExpectedInterface,
  ExpectedFunction,
  ExpectedInterface,
  CompatibilityReport,
} from '../src/examples/262-soroban-contract-function-interface-auditor';
import type { ParsedFunction, ParsedContractSpec } from '../src/utils/spec-parser';

// ─── helpers ──────────────────────────────────────────────────────────────

function makeActual(
  name: string,
  inputs: Array<{ name: string; type: string }>,
  outputs: string[],
): ParsedFunction {
  return { name, inputs, outputs, documentation: '' };
}

function makeExpected(
  name: string,
  parameters: Array<{ name: string; type: string }>,
  returnTypes: string[],
  optional = false,
): ExpectedFunction {
  return { name, parameters, returnTypes, optional };
}

const VALID_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32));

// ─── validateContractAddress ──────────────────────────────────────────────

describe('validateContractAddress', () => {
  it('accepts a valid contract address', () => {
    expect(validateContractAddress(VALID_CONTRACT_ID)).toBe(VALID_CONTRACT_ID);
  });

  it('trims whitespace', () => {
    expect(validateContractAddress(`  ${VALID_CONTRACT_ID}  `)).toBe(VALID_CONTRACT_ID);
  });

  it('throws for an empty string', () => {
    expect(() => validateContractAddress('')).toThrow(/required/i);
  });

  it('throws for a non-contract address (G…)', () => {
    const accountId = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));
    expect(() => validateContractAddress(accountId)).toThrow(/not a valid/i);
  });

  it('throws for a truncated string', () => {
    expect(() => validateContractAddress('CABC')).toThrow(/not a valid/i);
  });
});

// ─── formatSignature ──────────────────────────────────────────────────────

describe('formatSignature', () => {
  it('formats a function with parameters and a return type', () => {
    const fn = makeActual('transfer', [{ name: 'from', type: 'address' }, { name: 'amount', type: 'i128' }], ['void']);
    expect(formatSignature(fn)).toBe('transfer(from: address, amount: i128) -> void');
  });

  it('outputs void when outputs array is empty', () => {
    const fn = makeActual('noop', [], []);
    expect(formatSignature(fn)).toBe('noop() -> void');
  });

  it('joins multiple return types with a comma', () => {
    const fn = makeActual('dual', [], ['u32', 'bool']);
    expect(formatSignature(fn)).toBe('dual() -> u32, bool');
  });
});

// ─── formatExpectedSignature ──────────────────────────────────────────────

describe('formatExpectedSignature', () => {
  it('formats an expected function correctly', () => {
    const fn = makeExpected('balance', [{ name: 'id', type: 'address' }], ['i128']);
    expect(formatExpectedSignature(fn)).toBe('balance(id: address) -> i128');
  });

  it('shows void for empty returnTypes', () => {
    const fn = makeExpected('reset', [], []);
    expect(formatExpectedSignature(fn)).toBe('reset() -> void');
  });
});

// ─── auditFunction ────────────────────────────────────────────────────────

describe('auditFunction', () => {
  const actualMap = new Map<string, ParsedFunction>([
    ['transfer', makeActual('transfer', [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'i128' }], [])],
    ['balance', makeActual('balance', [{ name: 'id', type: 'address' }], ['i128'])],
  ]);

  it('returns exact-match for a correct function', () => {
    const expected = makeExpected(
      'transfer',
      [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'i128' }],
      [],
    );
    const result = auditFunction(expected, actualMap);
    expect(result.status).toBe('exact-match');
  });

  it('returns missing for a required function that is absent', () => {
    const expected = makeExpected('mint', [{ name: 'to', type: 'address' }, { name: 'amount', type: 'i128' }], []);
    const result = auditFunction(expected, actualMap);
    expect(result.status).toBe('missing');
    expect(result.details).toMatch(/mint/);
  });

  it('returns optional-absent for an optional function that is absent', () => {
    const expected = makeExpected('total_supply', [], ['i128'], true);
    const result = auditFunction(expected, actualMap);
    expect(result.status).toBe('optional-absent');
  });

  it('returns arity-mismatch when parameter count differs', () => {
    // balance expects 2 params but actual has 1
    const expected = makeExpected('balance', [{ name: 'id', type: 'address' }, { name: 'extra', type: 'u32' }], ['i128']);
    const result = auditFunction(expected, actualMap);
    expect(result.status).toBe('arity-mismatch');
    expect(result.details).toMatch(/2/);
    expect(result.details).toMatch(/1/);
  });

  it('returns type-mismatch for wrong parameter type', () => {
    // balance returns i128 in actual, but we expect u64
    const expected = makeExpected('balance', [{ name: 'id', type: 'address' }], ['u64']);
    const result = auditFunction(expected, actualMap);
    expect(result.status).toBe('type-mismatch');
    expect(result.details).toMatch(/return type/);
  });

  it('returns type-mismatch for wrong parameter name-type pair', () => {
    const expected = makeExpected(
      'transfer',
      [{ name: 'from', type: 'u32' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'i128' }],
      [],
    );
    const result = auditFunction(expected, actualMap);
    expect(result.status).toBe('type-mismatch');
    expect(result.details).toMatch(/position 1/);
  });

  it('populates actualSignature only when function exists', () => {
    const present = makeExpected('balance', [{ name: 'id', type: 'address' }], ['i128']);
    const absent = makeExpected('ghost', [], []);
    expect(auditFunction(present, actualMap).actualSignature).toBeDefined();
    expect(auditFunction(absent, actualMap).actualSignature).toBeUndefined();
  });
});

// ─── auditCompatibility ───────────────────────────────────────────────────

describe('auditCompatibility', () => {
  const parsedSpec: ParsedContractSpec = {
    contractName: 'token',
    rawEntryCount: 3,
    functions: [
      makeActual('transfer', [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'i128' }], []),
      makeActual('balance', [{ name: 'id', type: 'address' }], ['i128']),
      makeActual('extras', [], ['u32']),
    ],
    structs: [],
    enums: [],
    unions: [],
    errorEnums: [],
  };

  const expectedInterface: ExpectedInterface = {
    functions: [
      makeExpected('transfer', [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'i128' }], []),
      makeExpected('balance', [{ name: 'id', type: 'address' }], ['i128']),
      makeExpected('mint', [{ name: 'to', type: 'address' }, { name: 'amount', type: 'i128' }], [], false),
      makeExpected('burn_from', [], [], true),
    ],
  };

  let report: CompatibilityReport;

  beforeEach(() => {
    report = auditCompatibility(VALID_CONTRACT_ID, 'testnet', parsedSpec, expectedInterface);
  });

  it('marks the report incompatible when a required function is missing', () => {
    expect(report.isCompatible).toBe(false);
  });

  it('reports correct summary counts', () => {
    expect(report.summary.exactMatches).toBe(2);
    expect(report.summary.missing).toBe(1); // mint
    expect(report.summary.optionalAbsent).toBe(1); // burn_from
    expect(report.summary.extra).toBe(1); // extras
  });

  it('lists undeclared functions that are present but not expected', () => {
    expect(report.undeclaredFunctions).toContain('extras');
  });

  it('is compatible when all required functions match', () => {
    const minimalSpec: ParsedContractSpec = {
      contractName: 'mini',
      rawEntryCount: 1,
      functions: [makeActual('ping', [], ['bool'])],
      structs: [],
      enums: [],
      unions: [],
      errorEnums: [],
    };
    const minimalInterface: ExpectedInterface = {
      functions: [makeExpected('ping', [], ['bool'])],
    };
    const r = auditCompatibility(VALID_CONTRACT_ID, 'testnet', minimalSpec, minimalInterface);
    expect(r.isCompatible).toBe(true);
    expect(r.summary.exactMatches).toBe(1);
  });

  it('sets contractId and network on the report', () => {
    expect(report.contractId).toBe(VALID_CONTRACT_ID);
    expect(report.network).toBe('testnet');
  });
});

// ─── formatCompatibilityReport ────────────────────────────────────────────

describe('formatCompatibilityReport', () => {
  it('contains the contract ID in the report', () => {
    const r = auditCompatibility(
      VALID_CONTRACT_ID,
      'testnet',
      {
        contractName: null,
        rawEntryCount: 0,
        functions: [],
        structs: [],
        enums: [],
        unions: [],
        errorEnums: [],
      },
      { functions: [] },
    );
    const text = formatCompatibilityReport(r);
    expect(text).toContain(VALID_CONTRACT_ID);
  });

  it('shows COMPATIBLE when no breaking issues exist', () => {
    const r = auditCompatibility(
      VALID_CONTRACT_ID,
      'testnet',
      {
        contractName: null,
        rawEntryCount: 1,
        functions: [makeActual('foo', [], ['u32'])],
        structs: [],
        enums: [],
        unions: [],
        errorEnums: [],
      },
      { functions: [makeExpected('foo', [], ['u32'])] },
    );
    expect(formatCompatibilityReport(r)).toContain('✓ COMPATIBLE');
  });

  it('shows INCOMPATIBLE when a function is missing', () => {
    const r = auditCompatibility(
      VALID_CONTRACT_ID,
      'testnet',
      {
        contractName: null,
        rawEntryCount: 0,
        functions: [],
        structs: [],
        enums: [],
        unions: [],
        errorEnums: [],
      },
      { functions: [makeExpected('required_fn', [], [])] },
    );
    expect(formatCompatibilityReport(r)).toContain('✗ INCOMPATIBLE');
    expect(formatCompatibilityReport(r)).toContain('required_fn');
  });

  it('lists undeclared functions', () => {
    const r = auditCompatibility(
      VALID_CONTRACT_ID,
      'testnet',
      {
        contractName: null,
        rawEntryCount: 1,
        functions: [makeActual('surprise', [], [])],
        structs: [],
        enums: [],
        unions: [],
        errorEnums: [],
      },
      { functions: [] },
    );
    expect(formatCompatibilityReport(r)).toContain('surprise');
  });
});

// ─── getDefaultExpectedInterface ─────────────────────────────────────────

describe('getDefaultExpectedInterface', () => {
  it('returns at least the core SEP-41 / token functions', () => {
    const iface = getDefaultExpectedInterface();
    const names = iface.functions.map((f) => f.name);
    expect(names).toContain('transfer');
    expect(names).toContain('balance');
    expect(names).toContain('allowance');
    expect(names).toContain('approve');
    expect(names).toContain('burn');
  });

  it('marks total_supply as optional', () => {
    const iface = getDefaultExpectedInterface();
    const totalSupply = iface.functions.find((f) => f.name === 'total_supply');
    expect(totalSupply?.optional).toBe(true);
  });

  it('contains only well-formed function definitions', () => {
    const iface = getDefaultExpectedInterface();
    for (const fn of iface.functions) {
      expect(typeof fn.name).toBe('string');
      expect(Array.isArray(fn.parameters)).toBe(true);
      expect(Array.isArray(fn.returnTypes)).toBe(true);
    }
  });
});
