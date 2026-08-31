import { createHash } from 'crypto';

import { xdr } from '@stellar/stellar-sdk';

import {
  hashWasm,
  isValidContractId,
  buildContractInstanceKey,
  buildContractCodeKey,
  extractCodeHash,
  inspectContractCode,
  ContractCodeReport,
} from '../src/examples/192-soroban-contract-code-inspection';

// ---------------------------------------------------------------------------
// hashWasm
// ---------------------------------------------------------------------------
describe('hashWasm', () => {
  it('returns a 64-char hex string', () => {
    const result = hashWasm(Buffer.from('hello'));
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('matches a manual SHA-256', () => {
    const wasm = Buffer.from('test-wasm-bytes');
    const expected = createHash('sha256').update(wasm).digest('hex');
    expect(hashWasm(wasm)).toBe(expected);
  });

  it('is deterministic', () => {
    const wasm = Buffer.from('deterministic');
    expect(hashWasm(wasm)).toBe(hashWasm(wasm));
  });

  it('returns different hashes for different inputs', () => {
    expect(hashWasm(Buffer.from('a'))).not.toBe(hashWasm(Buffer.from('b')));
  });
});

// ---------------------------------------------------------------------------
// isValidContractId
// ---------------------------------------------------------------------------
describe('isValidContractId', () => {
  const VALID_ID = 'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';

  it('accepts a valid 56-char Stellar contract address', () => {
    expect(isValidContractId(VALID_ID)).toBe(true);
  });

  it('rejects an address that is too short', () => {
    expect(isValidContractId('CDW6BR4A6MGGCW23SCAVBBBZ3')).toBe(false);
  });

  it('rejects an address that starts with G (account)', () => {
    const accountId = 'G' + VALID_ID.slice(1);
    expect(isValidContractId(accountId)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidContractId('')).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(isValidContractId(null as any)).toBe(false);
  });

  it('rejects a string with lowercase letters', () => {
    expect(isValidContractId(VALID_ID.toLowerCase())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildContractInstanceKey
// ---------------------------------------------------------------------------
describe('buildContractInstanceKey', () => {
  const CONTRACT_ID = 'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';

  it('returns an xdr.LedgerKey of type contractData', () => {
    const key = buildContractInstanceKey(CONTRACT_ID);
    expect(key.switch()).toBe(xdr.LedgerEntryType.contractData());
  });

  it('uses persistent durability', () => {
    const key = buildContractInstanceKey(CONTRACT_ID);
    const data = key.contractData();
    expect(data.durability()).toBe(xdr.ContractDataDurability.persistent());
  });

  it('uses scvLedgerKeyContractInstance as the data key', () => {
    const key = buildContractInstanceKey(CONTRACT_ID);
    const data = key.contractData();
    expect(data.key().switch()).toBe(xdr.ScValType.scvLedgerKeyContractInstance());
  });
});

// ---------------------------------------------------------------------------
// buildContractCodeKey
// ---------------------------------------------------------------------------
describe('buildContractCodeKey', () => {
  const HASH_HEX = 'a'.repeat(64); // 32-byte fake hash in hex

  it('returns an xdr.LedgerKey of type contractCode', () => {
    const key = buildContractCodeKey(HASH_HEX);
    expect(key.switch()).toBe(xdr.LedgerEntryType.contractCode());
  });

  it('sets the hash bytes correctly', () => {
    const key = buildContractCodeKey(HASH_HEX);
    const hash = key.contractCode().hash();
    expect(hash.toString('hex')).toBe(HASH_HEX);
  });
});

// ---------------------------------------------------------------------------
// extractCodeHash
// ---------------------------------------------------------------------------
describe('extractCodeHash', () => {
  it('returns null for a non-contract-data entry shape', () => {
    // Provide a minimal mock that will throw inside extractCodeHash
    const mockEntry = {
      val: { data: () => { throw new Error('not contract data'); } },
    } as any;
    expect(extractCodeHash(mockEntry)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// inspectContractCode — unit tests with mocked RPC server
// ---------------------------------------------------------------------------
describe('inspectContractCode', () => {
  const CONTRACT_ID = 'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';
  const FAKE_HASH = 'ab'.repeat(32); // 64-char hex = 32 bytes

  function makeServer(overrides: Partial<{
    getLatestLedger: () => Promise<any>;
    getLedgerEntries: (...args: any[]) => Promise<any>;
  }> = {}): any {
    return {
      getLatestLedger: overrides.getLatestLedger ?? (async () => ({ sequence: 1000 })),
      getLedgerEntries: overrides.getLedgerEntries ?? (async () => ({ entries: [] })),
    };
  }

  // Helper: build a minimal fake ContractInstance ledger entry with a WASM executable
  function makeFakeInstanceEntry(codeHashHex: string): any {
    const hashBytes = Buffer.from(codeHashHex, 'hex');
    const executable = xdr.ContractExecutable.contractExecutableWasm(hashBytes);
    const instance = new xdr.ScContractInstance({
      executable,
      storage: null,
    });
    const scVal = xdr.ScVal.scvContractInstance(instance);
    const contractDataEntry = new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: xdr.ScAddress.scAddressTypeContract(Buffer.alloc(32)),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: scVal,
    });
    const ledgerEntryData = xdr.LedgerEntryData.contractData(contractDataEntry);
    const ledgerEntry = new xdr.LedgerEntry({
      lastModifiedLedgerSeq: 900,
      data: ledgerEntryData,
      ext: xdr.LedgerEntryExt.v0(),
    });
    return {
      val: ledgerEntry,
      lastModifiedLedgerSeq: 900,
      liveUntilLedgerSeq: 2000,
    };
  }

  it('reports error when latest ledger fetch fails', async () => {
    const server = makeServer({
      getLatestLedger: async () => { throw new Error('network error'); },
    });
    const report = await inspectContractCode(server, CONTRACT_ID);
    expect(report.error).toMatch(/RPC failure fetching latest ledger/);
    expect(report.currentLedger).toBe(0);
  });

  it('reports error when contract instance is missing', async () => {
    const server = makeServer({
      getLedgerEntries: async () => ({ entries: [] }),
    });
    const report = await inspectContractCode(server, CONTRACT_ID);
    expect(report.error).toMatch(/not found/i);
    expect(report.codeHash).toBeNull();
  });

  it('reports error when getLedgerEntries throws for instance', async () => {
    const server = makeServer({
      getLedgerEntries: async () => { throw new Error('rpc down'); },
    });
    const report = await inspectContractCode(server, CONTRACT_ID);
    expect(report.error).toMatch(/RPC failure fetching contract instance/);
  });

  it('extracts code hash from a valid instance entry', async () => {
    const instanceEntry = makeFakeInstanceEntry(FAKE_HASH);
    let callCount = 0;
    const server = makeServer({
      getLedgerEntries: async () => {
        callCount++;
        if (callCount === 1) return { entries: [instanceEntry] };
        return { entries: [] }; // code entry not found
      },
    });
    const report = await inspectContractCode(server, CONTRACT_ID);
    expect(report.codeHash).toBe(FAKE_HASH);
    expect(report.instanceLastModifiedLedger).toBe(900);
    expect(report.instanceLiveUntilLedger).toBe(2000);
  });

  it('sets wasmHashComparison to match when hashes agree', async () => {
    const instanceEntry = makeFakeInstanceEntry(FAKE_HASH);
    let callCount = 0;
    const server = makeServer({
      getLedgerEntries: async () => {
        callCount++;
        if (callCount === 1) return { entries: [instanceEntry] };
        return { entries: [] };
      },
    });
    const report = await inspectContractCode(server, CONTRACT_ID, FAKE_HASH);
    expect(report.wasmHashComparison).toBe('match');
  });

  it('sets wasmHashComparison to mismatch when hashes differ', async () => {
    const instanceEntry = makeFakeInstanceEntry(FAKE_HASH);
    let callCount = 0;
    const server = makeServer({
      getLedgerEntries: async () => {
        callCount++;
        if (callCount === 1) return { entries: [instanceEntry] };
        return { entries: [] };
      },
    });
    const differentHash = 'cd'.repeat(32);
    const report = await inspectContractCode(server, CONTRACT_ID, differentHash);
    expect(report.wasmHashComparison).toBe('mismatch');
  });

  it('sets wasmHashComparison to not_supplied when no expected hash is given', async () => {
    const instanceEntry = makeFakeInstanceEntry(FAKE_HASH);
    let callCount = 0;
    const server = makeServer({
      getLedgerEntries: async () => {
        callCount++;
        if (callCount === 1) return { entries: [instanceEntry] };
        return { entries: [] };
      },
    });
    const report = await inspectContractCode(server, CONTRACT_ID);
    expect(report.wasmHashComparison).toBe('not_supplied');
  });

  it('sets wasmHashComparison to unable_to_verify when code entry lookup fails', async () => {
    const instanceEntry = makeFakeInstanceEntry(FAKE_HASH);
    let callCount = 0;
    const server = makeServer({
      getLedgerEntries: async () => {
        callCount++;
        if (callCount === 1) return { entries: [instanceEntry] };
        throw new Error('code lookup failed');
      },
    });
    const report = await inspectContractCode(server, CONTRACT_ID, FAKE_HASH);
    expect(report.wasmHashComparison).toBe('unable_to_verify');
    expect(report.error).toMatch(/RPC failure fetching contract code entry/);
  });

  it('captures code entry metadata when available', async () => {
    const instanceEntry = makeFakeInstanceEntry(FAKE_HASH);
    const codeEntry = {
      val: new xdr.LedgerEntry({
        lastModifiedLedgerSeq: 800,
        data: xdr.LedgerEntryData.contractCode(
          new xdr.ContractCodeEntry({
            ext: xdr.ContractCodeEntryExt.v0(),
            hash: Buffer.from(FAKE_HASH, 'hex'),
            code: Buffer.from('wasm-bytecode'),
          }),
        ),
        ext: xdr.LedgerEntryExt.v0(),
      }),
      lastModifiedLedgerSeq: 800,
      liveUntilLedgerSeq: 3000,
    };
    let callCount = 0;
    const server = makeServer({
      getLedgerEntries: async () => {
        callCount++;
        if (callCount === 1) return { entries: [instanceEntry] };
        return { entries: [codeEntry] };
      },
    });
    const report = await inspectContractCode(server, CONTRACT_ID);
    expect(report.codeLastModifiedLedger).toBe(800);
    expect(report.codeLiveUntilLedger).toBe(3000);
    expect(report.codeXdr).toBeTruthy();
  });

  it('stores raw XDR for the instance entry', async () => {
    const instanceEntry = makeFakeInstanceEntry(FAKE_HASH);
    let callCount = 0;
    const server = makeServer({
      getLedgerEntries: async () => {
        callCount++;
        if (callCount === 1) return { entries: [instanceEntry] };
        return { entries: [] };
      },
    });
    const report = await inspectContractCode(server, CONTRACT_ID);
    expect(report.instanceXdr).toBeTruthy();
    expect(typeof report.instanceXdr).toBe('string');
  });

  it('handles 0x-prefixed expected hash', async () => {
    const instanceEntry = makeFakeInstanceEntry(FAKE_HASH);
    let callCount = 0;
    const server = makeServer({
      getLedgerEntries: async () => {
        callCount++;
        if (callCount === 1) return { entries: [instanceEntry] };
        return { entries: [] };
      },
    });
    const report = await inspectContractCode(server, CONTRACT_ID, '0x' + FAKE_HASH);
    expect(report.wasmHashComparison).toBe('match');
  });
});

// ---------------------------------------------------------------------------
// Runner registration
// ---------------------------------------------------------------------------
describe('runner catalog registration', () => {
  it('registers 192-soroban-contract-code-inspection in the catalog', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { examples } = require('../src/runner/catalog');
    expect(examples['192-soroban-contract-code-inspection']).toBeDefined();
    expect(typeof examples['192-soroban-contract-code-inspection'].run).toBe('function');
    expect(examples['192-soroban-contract-code-inspection'].description).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// README documentation
// ---------------------------------------------------------------------------
describe('README catalog entry', () => {
  it('documents 192-soroban-contract-code-inspection in README.md', () => {
    const fs = require('fs');
    const readme = fs.readFileSync('README.md', 'utf8');
    expect(readme).toContain('192-soroban-contract-code-inspection');
  });
});
