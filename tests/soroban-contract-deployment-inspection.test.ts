import { xdr } from '@stellar/stellar-sdk';

import {
  isValidContractId,
  buildContractInstanceKey,
  buildContractCodeKey,
  extractCodeHash,
  classifyContractState,
  inspectContractDeployment,
  DeploymentInspectionReport,
} from '../src/examples/191-soroban-contract-deployment-inspection';
import { examples } from '../src/runner/catalog';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_ID = 'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';
const FAKE_HASH = 'ab'.repeat(32); // 64-char hex = 32 bytes
const NETWORK = 'https://soroban-testnet.stellar.org';

// Helper: build a minimal fake ContractInstance ledger entry with a WASM executable
function makeFakeInstanceEntry(codeHashHex: string, liveUntilLedgerSeq = 2000): any {
  const hashBytes = Buffer.from(codeHashHex, 'hex');
  const executable = xdr.ContractExecutable.contractExecutableWasm(hashBytes);
  const instance = new xdr.ScContractInstance({ executable, storage: null });
  const scVal = xdr.ScVal.scvContractInstance(instance);
  const contractDataEntry = new xdr.ContractDataEntry({
    ext: xdr.ExtensionPoint.v0(),
    contract: xdr.ScAddress.scAddressTypeContract(Buffer.alloc(32)),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: scVal,
  });
  const ledgerEntry = new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 900,
    data: xdr.LedgerEntryData.contractData(contractDataEntry),
    ext: xdr.LedgerEntryExt.v0(),
  });
  return { val: ledgerEntry, lastModifiedLedgerSeq: 900, liveUntilLedgerSeq };
}

function makeServer(overrides: Partial<{
  getLatestLedger: () => Promise<any>;
  getLedgerEntries: (...args: any[]) => Promise<any>;
}> = {}): any {
  return {
    getLatestLedger: overrides.getLatestLedger ?? (async () => ({ sequence: 1000 })),
    getLedgerEntries: overrides.getLedgerEntries ?? (async () => ({ entries: [] })),
  };
}

// ---------------------------------------------------------------------------
// isValidContractId
// ---------------------------------------------------------------------------
describe('isValidContractId', () => {
  it('accepts a valid 56-char Stellar C-address', () => {
    expect(isValidContractId(VALID_ID)).toBe(true);
  });

  it('rejects an address that is too short', () => {
    expect(isValidContractId('CDSHORT')).toBe(false);
  });

  it('rejects an address starting with G (account)', () => {
    expect(isValidContractId('G' + VALID_ID.slice(1))).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidContractId('')).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(isValidContractId(null as any)).toBe(false);
  });

  it('rejects lowercase', () => {
    expect(isValidContractId(VALID_ID.toLowerCase())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildContractInstanceKey
// ---------------------------------------------------------------------------
describe('buildContractInstanceKey', () => {
  it('returns a contractData LedgerKey', () => {
    const key = buildContractInstanceKey(VALID_ID);
    expect(key.switch()).toBe(xdr.LedgerEntryType.contractData());
  });

  it('uses persistent durability', () => {
    const key = buildContractInstanceKey(VALID_ID);
    expect(key.contractData().durability()).toBe(xdr.ContractDataDurability.persistent());
  });

  it('uses scvLedgerKeyContractInstance as the data key', () => {
    const key = buildContractInstanceKey(VALID_ID);
    expect(key.contractData().key().switch()).toBe(xdr.ScValType.scvLedgerKeyContractInstance());
  });
});

// ---------------------------------------------------------------------------
// buildContractCodeKey
// ---------------------------------------------------------------------------
describe('buildContractCodeKey', () => {
  it('returns a contractCode LedgerKey', () => {
    const key = buildContractCodeKey(FAKE_HASH);
    expect(key.switch()).toBe(xdr.LedgerEntryType.contractCode());
  });

  it('sets the hash bytes correctly', () => {
    const key = buildContractCodeKey(FAKE_HASH);
    expect(key.contractCode().hash().toString('hex')).toBe(FAKE_HASH);
  });
});

// ---------------------------------------------------------------------------
// extractCodeHash
// ---------------------------------------------------------------------------
describe('extractCodeHash', () => {
  it('returns the code hash from a valid WASM instance entry', () => {
    const entry = makeFakeInstanceEntry(FAKE_HASH);
    expect(extractCodeHash(entry)).toBe(FAKE_HASH);
  });

  it('returns null for a non-contract-data entry shape', () => {
    const mockEntry = { val: { data: () => { throw new Error('bad shape'); } } } as any;
    expect(extractCodeHash(mockEntry)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyContractState
// ---------------------------------------------------------------------------
describe('classifyContractState', () => {
  it('returns active when well before expiry', () => {
    expect(classifyContractState(5000, 1000)).toBe('active');
  });

  it('returns expiring_soon when fewer than 1000 ledgers remain', () => {
    expect(classifyContractState(1500, 1000)).toBe('expiring_soon');
  });

  it('returns expired when liveUntil <= current', () => {
    expect(classifyContractState(999, 1000)).toBe('expired');
    expect(classifyContractState(1000, 1000)).toBe('expired');
  });

  it('returns unknown when liveUntilLedger is null', () => {
    expect(classifyContractState(null, 1000)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// inspectContractDeployment — unit tests with mocked RPC server
// ---------------------------------------------------------------------------
describe('inspectContractDeployment', () => {
  it('reports RPC error when getLatestLedger fails', async () => {
    const server = makeServer({
      getLatestLedger: async () => { throw new Error('network timeout'); },
    });
    const report = await inspectContractDeployment(server, VALID_ID, NETWORK);
    expect(report.error).toMatch(/RPC failure fetching latest ledger/);
    expect(report.currentLedger).toBe(0);
    expect(report.contractLedgerState).toBe('error');
  });

  it('reports not_found when instance entry is missing', async () => {
    const server = makeServer({
      getLedgerEntries: async () => ({ entries: [] }),
    });
    const report = await inspectContractDeployment(server, VALID_ID, NETWORK);
    expect(report.contractLedgerState).toBe('not_found');
    expect(report.error).toMatch(/not found/i);
  });

  it('reports RPC error when getLedgerEntries throws for instance', async () => {
    const server = makeServer({
      getLedgerEntries: async () => { throw new Error('rpc down'); },
    });
    const report = await inspectContractDeployment(server, VALID_ID, NETWORK);
    expect(report.error).toMatch(/RPC failure fetching contract instance/);
    expect(report.contractLedgerState).toBe('error');
  });

  it('detects archived state from error message', async () => {
    const server = makeServer({
      getLedgerEntries: async () => { throw new Error('entry is archived and expired'); },
    });
    const report = await inspectContractDeployment(server, VALID_ID, NETWORK);
    expect(report.contractLedgerState).toBe('archived');
    expect(report.error).toMatch(/archived/i);
  });

  it('detects archived state from expired TTL', async () => {
    const instanceEntry = makeFakeInstanceEntry(FAKE_HASH, 500); // expired vs current=1000
    let callCount = 0;
    const server = makeServer({
      getLedgerEntries: async () => {
        callCount++;
        if (callCount === 1) return { entries: [instanceEntry] };
        return { entries: [] };
      },
    });
    const report = await inspectContractDeployment(server, VALID_ID, NETWORK);
    expect(report.contractLedgerState).toBe('archived');
    expect(report.contractActive).toBe('expired');
  });

  it('retrieves network (RPC URL) in report', async () => {
    const instanceEntry = makeFakeInstanceEntry(FAKE_HASH, 5000);
    let callCount = 0;
    const server = makeServer({
      getLedgerEntries: async () => {
        callCount++;
        if (callCount === 1) return { entries: [instanceEntry] };
        return { entries: [] };
      },
    });
    const report = await inspectContractDeployment(server, VALID_ID, NETWORK);
    expect(report.network).toBe(NETWORK);
  });

  it('extracts instance metadata from a valid entry', async () => {
    const instanceEntry = makeFakeInstanceEntry(FAKE_HASH, 5000);
    let callCount = 0;
    const server = makeServer({
      getLedgerEntries: async () => {
        callCount++;
        if (callCount === 1) return { entries: [instanceEntry] };
        return { entries: [] };
      },
    });
    const report = await inspectContractDeployment(server, VALID_ID, NETWORK);
    expect(report.contractLedgerState).toBe('found');
    expect(report.instanceLastModifiedLedger).toBe(900);
    expect(report.instanceLiveUntilLedger).toBe(5000);
    expect(report.codeHash).toBe(FAKE_HASH);
    expect(report.instanceXdr).toBeTruthy();
    expect(report.contractActive).toBe('active');
  });

  it('classifies contract as expiring_soon', async () => {
    const instanceEntry = makeFakeInstanceEntry(FAKE_HASH, 1500); // 500 ledgers left
    let callCount = 0;
    const server = makeServer({
      getLedgerEntries: async () => {
        callCount++;
        if (callCount === 1) return { entries: [instanceEntry] };
        return { entries: [] };
      },
    });
    const report = await inspectContractDeployment(server, VALID_ID, NETWORK);
    expect(report.contractActive).toBe('expiring_soon');
  });

  it('retrieves code entry metadata when available', async () => {
    const instanceEntry = makeFakeInstanceEntry(FAKE_HASH, 5000);
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
    const report = await inspectContractDeployment(server, VALID_ID, NETWORK);
    expect(report.codeLastModifiedLedger).toBe(800);
    expect(report.codeLiveUntilLedger).toBe(3000);
    expect(report.codeXdr).toBeTruthy();
  });

  it('handles code entry RPC failure gracefully', async () => {
    const instanceEntry = makeFakeInstanceEntry(FAKE_HASH, 5000);
    let callCount = 0;
    const server = makeServer({
      getLedgerEntries: async () => {
        callCount++;
        if (callCount === 1) return { entries: [instanceEntry] };
        throw new Error('code lookup failed');
      },
    });
    const report = await inspectContractDeployment(server, VALID_ID, NETWORK);
    // Instance was retrieved successfully
    expect(report.contractLedgerState).toBe('found');
    expect(report.error).toMatch(/RPC failure fetching contract code entry/);
    expect(report.codeHash).toBe(FAKE_HASH);
  });

  it('stores raw instance XDR as a base64 string', async () => {
    const instanceEntry = makeFakeInstanceEntry(FAKE_HASH, 5000);
    let callCount = 0;
    const server = makeServer({
      getLedgerEntries: async () => {
        callCount++;
        if (callCount === 1) return { entries: [instanceEntry] };
        return { entries: [] };
      },
    });
    const report = await inspectContractDeployment(server, VALID_ID, NETWORK);
    expect(typeof report.instanceXdr).toBe('string');
    expect(report.instanceXdr).toBeTruthy();
  });

  it('returns a JSON-serializable report', async () => {
    const instanceEntry = makeFakeInstanceEntry(FAKE_HASH, 5000);
    let callCount = 0;
    const server = makeServer({
      getLedgerEntries: async () => {
        callCount++;
        if (callCount === 1) return { entries: [instanceEntry] };
        return { entries: [] };
      },
    });
    const report = await inspectContractDeployment(server, VALID_ID, NETWORK);
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  it('handles malformed/empty RPC response gracefully', async () => {
    const server = makeServer({
      getLedgerEntries: async () => ({ entries: null }),
    });
    const report = await inspectContractDeployment(server, VALID_ID, NETWORK);
    expect(report.contractLedgerState).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// Runner registration
// ---------------------------------------------------------------------------
describe('runner catalog registration', () => {
  it('registers 191-soroban-contract-deployment-inspection in the catalog', () => {
    expect(examples['191-soroban-contract-deployment-inspection']).toBeDefined();
    expect(typeof examples['191-soroban-contract-deployment-inspection'].run).toBe('function');
    expect(examples['191-soroban-contract-deployment-inspection'].description).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// README documentation
// ---------------------------------------------------------------------------
describe('README catalog entry', () => {
  it('documents 191-soroban-contract-deployment-inspection in README.md', () => {
    const fs = require('fs');
    const readme = fs.readFileSync('README.md', 'utf8');
    expect(readme).toContain('191-soroban-contract-deployment-inspection');
  });
});
