import { Account, Address, Keypair, rpc, StrKey, xdr } from '@stellar/stellar-sdk';
import {
  auditAuthorizationEntries,
  AuditContext,
  AuthRpc,
  decodeAuthEntries,
  formatReport,
  invocationPaths,
  invocationTree,
  runAuthorizationAudit,
} from '../src/examples/265-authorization-footprint-audit';

const PASSPHRASE = 'Test SDF Network ; September 2015';
const SOURCE = Keypair.random().publicKey();
const SIGNER = Keypair.random().publicKey();
const ROUTER = StrKey.encodeContract(Buffer.alloc(32, 1));
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 2));
const OTHER = StrKey.encodeContract(Buffer.alloc(32, 3));
const WALLET = StrKey.encodeContract(Buffer.alloc(32, 4));

const ctx = (currentLedger: number | null = 1000): AuditContext => ({
  network: PASSPHRASE,
  sourceAccount: SOURCE,
  contractId: ROUTER,
  currentLedger,
});

function call(
  contract: string,
  fn: string,
  children: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName: fn,
        args: [xdr.ScVal.scvU32(7)],
      }),
    ),
    subInvocations: children,
  });
}

function createContract(): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
      new xdr.CreateContractArgs({
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
          new xdr.ContractIdPreimageFromAddress({
            address: xdr.ScAddress.scAddressTypeAccount(
              Keypair.fromPublicKey(SIGNER).xdrAccountId(),
            ),
            salt: Buffer.alloc(32),
          }),
        ),
        executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 9)),
      }),
    ),
    subInvocations: [],
  });
}

function sourceEntry(root: xdr.SorobanAuthorizedInvocation): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: root,
  });
}

function addressEntry(
  root: xdr.SorobanAuthorizedInvocation,
  {
    signer = SIGNER,
    expiration = 0,
    signed = false,
  }: { signer?: string; expiration?: number; signed?: boolean } = {},
): xdr.SorobanAuthorizationEntry {
  const address = new Address(signer).toScAddress();
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address,
        nonce: xdr.Int64.fromString('42'),
        signatureExpirationLedger: expiration,
        signature: signed
          ? xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.alloc(64, 5))])
          : xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: root,
  });
}

const swap = () => call(ROUTER, 'swap', [call(TOKEN, 'transfer')]);
const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

describe('invocation tree', () => {
  it('decodes nested calls into root-to-leaf paths', () => {
    const tree = invocationTree(
      call(ROUTER, 'swap', [call(TOKEN, 'transfer'), call(OTHER, 'approve')]),
    );
    expect(tree).toMatchObject({
      kind: 'contract-call',
      contract: ROUTER,
      function: 'swap',
      argCount: 1,
    });
    expect(invocationPaths(tree)).toEqual([
      `${ROUTER}:swap > ${TOKEN}:transfer`,
      `${ROUTER}:swap > ${OTHER}:approve`,
    ]);
  });
});

describe('auditAuthorizationEntries', () => {
  const rules = { expectedContracts: [ROUTER, TOKEN], expectedFunctions: ['swap', 'transfer'] };

  it('passes a source-account entry matching the expected footprint, reporting expiration as transaction-bound', () => {
    const r = auditAuthorizationEntries([sourceEntry(swap())], ctx(), rules);
    expect(r.status).toBe('pass');
    expect(r.entries[0]).toMatchObject({
      credentialType: 'source-account',
      authorizer: SOURCE,
      signature: 'not-applicable',
      expiration: { model: 'transaction-bound' },
    });
    expect(codes(r.findings)).toContain('expiration-unavailable');
    expect(r.unexpected).toEqual([]);
  });

  it('identifies address credentials and an unsigned (unset) expiration', () => {
    const r = auditAuthorizationEntries([addressEntry(swap())], ctx(), rules);
    expect(r.entries[0]).toMatchObject({
      credentialType: 'address',
      authorizer: SIGNER,
      authorizerKind: 'account',
      signature: 'absent',
    });
    expect(r.entries[0].expiration).toMatchObject({
      model: 'ledger',
      expirationLedger: 0,
      status: 'unset',
    });
    expect(codes(r.findings)).toContain('expiration-unset');
    expect(r.credentialTypes).toEqual(['address:account']);
  });

  it('fails expired signatures, warns on soon-to-expire ones, accepts valid ones', () => {
    expect(
      auditAuthorizationEntries(
        [addressEntry(swap(), { expiration: 999, signed: true })],
        ctx(),
        rules,
      ).status,
    ).toBe('fail');
    const soon = auditAuthorizationEntries(
      [addressEntry(swap(), { expiration: 1050, signed: true })],
      ctx(),
      rules,
    );
    expect(soon.status).toBe('pass-with-warnings');
    expect(soon.entries[0].expiration).toMatchObject({
      status: 'expiring-soon',
      ledgersRemaining: 50,
    });
    const valid = auditAuthorizationEntries(
      [addressEntry(swap(), { expiration: 5000, signed: true })],
      ctx(),
      rules,
    );
    expect(valid.status).toBe('pass');
    expect(codes(valid.findings)).toContain('signature-unverified');
  });

  it('honours a custom expiration warning window', () => {
    const r = auditAuthorizationEntries(
      [addressEntry(swap(), { expiration: 1050, signed: true })],
      ctx(),
      { ...rules, expirationWarningLedgers: 10 },
    );
    expect(r.entries[0].expiration).toMatchObject({ status: 'valid' });
  });

  it('cannot evaluate a set expiration without the current ledger', () => {
    const r = auditAuthorizationEntries(
      [addressEntry(swap(), { expiration: 5000, signed: true })],
      ctx(null),
      rules,
    );
    expect(codes(r.findings)).toContain('expiration-unknown');
  });

  it('flags unexpected contracts and functions, nested ones included', () => {
    const r = auditAuthorizationEntries(
      [sourceEntry(call(ROUTER, 'swap', [call(OTHER, 'burn')]))],
      ctx(),
      rules,
    );
    expect(r.status).toBe('pass-with-warnings');
    expect(codes(r.findings)).toEqual(
      expect.arrayContaining(['unexpected-contract', 'unexpected-function']),
    );
    expect(r.unexpected).toEqual([`${OTHER}:burn`]);
  });

  it('turns mismatches into failures in strict mode', () => {
    const r = auditAuthorizationEntries([sourceEntry(call(OTHER, 'burn'))], ctx(), {
      ...rules,
      strict: true,
    });
    expect(r.status).toBe('fail');
  });

  it('compares exact invocation paths', () => {
    const allowed = [`${ROUTER}:swap > ${TOKEN}:transfer`];
    expect(
      auditAuthorizationEntries([sourceEntry(swap())], ctx(), { expectedPaths: allowed }).status,
    ).toBe('pass');
    const r = auditAuthorizationEntries([sourceEntry(call(TOKEN, 'transfer'))], ctx(), {
      expectedPaths: allowed,
    });
    expect(codes(r.findings)).toContain('unexpected-path');
    expect(r.unexpected).toEqual([`${TOKEN}:transfer`]);
  });

  it('flags contract-creation authorization and repeated requirements', () => {
    const r = auditAuthorizationEntries(
      [addressEntry(createContract()), addressEntry(swap()), addressEntry(swap())],
      ctx(),
      rules,
    );
    expect(codes(r.findings)).toEqual(
      expect.arrayContaining(['create-contract-auth', 'repeated-authorization']),
    );
    expect(r.invocationPaths).toContain('create-contract');
  });

  it('notes that contract credentials depend on __check_auth', () => {
    const r = auditAuthorizationEntries([addressEntry(swap(), { signer: WALLET })], ctx(), rules);
    expect(r.entries[0].authorizerKind).toBe('contract');
    expect(codes(r.findings)).toContain('contract-credential');
  });

  it('reports no authorization and a missing expected footprint as information', () => {
    const r = auditAuthorizationEntries([], ctx());
    expect(r.status).toBe('pass');
    expect(codes(r.findings)).toEqual(['no-authorization', 'no-expected-footprint']);
    expect(auditAuthorizationEntries([], ctx(), { strict: true }).status).toBe('fail');
  });
});

describe('decodeAuthEntries', () => {
  it('decodes base64 entries and reports malformed ones', () => {
    const { entries, findings } = decodeAuthEntries([
      sourceEntry(swap()).toXDR('base64'),
      'not-xdr',
    ]);
    expect(entries).toHaveLength(1);
    expect(findings).toEqual([
      expect.objectContaining({ code: 'malformed-auth-xdr', entry: 1, severity: 'fail' }),
    ]);
  });
});

describe('runAuthorizationAudit', () => {
  const server = (sim: object): AuthRpc => ({
    getAccount: jest.fn(async (id: string) => new Account(id, '1')),
    simulateTransaction: jest.fn(async () => sim as unknown as rpc.Api.SimulateTransactionResponse),
  });
  const config = {
    sourceAccount: SOURCE,
    contractId: ROUTER,
    method: 'swap',
    networkPassphrase: PASSPHRASE,
  };

  it('audits the auth entries returned by simulation at the latest ledger', async () => {
    const rpcMock = server({
      id: '1',
      latestLedger: 2000,
      events: [],
      _parsed: true,
      transactionData: {},
      minResourceFee: '100',
      result: {
        auth: [addressEntry(swap(), { expiration: 1999, signed: true })],
        retval: xdr.ScVal.scvVoid(),
      },
    });
    const r = await runAuthorizationAudit(rpcMock, config, { expectedContracts: [ROUTER, TOKEN] });
    expect(rpcMock.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(r.currentLedger).toBe(2000);
    expect(r.status).toBe('fail');
    expect(codes(r.findings)).toContain('expired-authorization');
  });

  it('turns a simulation error into a failed audit', async () => {
    const r = await runAuthorizationAudit(
      server({
        id: '1',
        latestLedger: 2000,
        events: [],
        _parsed: true,
        error: 'HostError: Error(Auth, InvalidAction)\nmore',
      }),
      config,
    );
    expect(r.status).toBe('fail');
    expect(r.findings[0]).toMatchObject({
      code: 'simulation-failed',
      message: 'Simulation failed: HostError: Error(Auth, InvalidAction)',
    });
    expect(codes(r.findings)).not.toContain('no-authorization');
  });

  it('rejects an invalid contract id without calling RPC', async () => {
    const rpcMock = server({});
    const r = await runAuthorizationAudit(rpcMock, { ...config, contractId: 'nope' });
    expect(r.status).toBe('fail');
    expect(rpcMock.getAccount).not.toHaveBeenCalled();
  });
});

describe('formatReport', () => {
  it('prints authorizers, paths and findings without argument values or signature bytes', () => {
    const entry = addressEntry(swap(), { expiration: 5000, signed: true });
    const text = formatReport(
      auditAuthorizationEntries([entry], ctx(), { expectedContracts: [ROUTER, TOKEN] }),
    );
    expect(text).toContain(`address by ${SIGNER}`);
    expect(text).toContain(`${ROUTER}:swap > ${TOKEN}:transfer`);
    expect(text).toContain('nothing was signed, verified or submitted');
    expect(text).not.toContain(Buffer.alloc(64, 5).toString('base64'));
    expect(text).not.toContain(entry.toXDR('base64'));
  });
});
