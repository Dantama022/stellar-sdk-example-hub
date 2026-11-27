import { Address, Keypair, StrKey, Transaction, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  AuthSigner,
  PreflightReport,
  TransferRequest,
  TransferRpcClient,
  buildTransferTransaction,
  executeTransfer,
  inspectAuthEntries,
  keypairAuthSigner,
  parseAmount,
  runPreflight,
  signAuthEntries,
  submitTransaction,
  summarizeSimulation,
  transferArgs,
  validateTransferRequest,
} from './index';

const TESTNET = 'Test SDF Network ; September 2015';
const MAINNET = 'Public Global Stellar Network ; September 2015';
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 7));
const SENDER_KEY = Keypair.random();
const SOURCE_KEY = Keypair.random(); // separate fee payer for the "address credentials" scenario
const RECIPIENT = Keypair.random().publicKey();
const SENDER = SENDER_KEY.publicKey();
const AMOUNT = 123456789012345678901234567890n; // far beyond 2^53
const LATEST = 1000;

const baseRequest = (over: Partial<TransferRequest> = {}): TransferRequest => ({
  network: 'testnet',
  token: TOKEN,
  sender: SENDER,
  recipient: RECIPIENT,
  amount: AMOUNT,
  ...over,
});

// ---- Mock simulation data ---------------------------------------------------------------

function authEntry(
  signerAddress: string | null,
  over: { amount?: bigint; fn?: string; token?: string; subInvocations?: boolean } = {}
): xdr.SorobanAuthorizationEntry {
  const args = transferArgs({
    sender: SENDER,
    recipient: RECIPIENT,
    amount: over.amount ?? AMOUNT,
  });
  const call = new xdr.InvokeContractArgs({
    contractAddress: new Address(over.token ?? TOKEN).toScAddress(),
    functionName: over.fn ?? 'transfer',
    args,
  });
  const sub = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
    subInvocations: [],
  });
  const root = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
    subInvocations: over.subInvocations ? [sub] : [],
  });
  const credentials = signerAddress
    ? xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(signerAddress).toScAddress(),
          nonce: xdr.Int64.fromString('42'),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        })
      )
    : xdr.SorobanCredentials.sorobanCredentialsSourceAccount();
  return new xdr.SorobanAuthorizationEntry({ credentials, rootInvocation: root });
}

function simSuccess(auth: xdr.SorobanAuthorizationEntry[]): rpc.Api.SimulateTransactionResponse {
  const { SorobanDataBuilder } = jest.requireActual('@stellar/stellar-sdk');
  return {
    id: '1',
    latestLedger: LATEST,
    events: [],
    _parsed: true,
    transactionData: new SorobanDataBuilder().setResources(1_000_000, 2000, 1000),
    minResourceFee: '50000',
    result: { auth, retval: xdr.ScVal.scvVoid() },
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

const simError = (error: string): rpc.Api.SimulateTransactionResponse =>
  ({ id: '1', latestLedger: LATEST, events: [], _parsed: true, error }) as never;

const txResult = (code: string) => ({ result: () => ({ switch: () => ({ name: code }) }) }) as never;

interface MockOptions {
  passphrase?: string;
  /** Simulation response (the same one is returned for every call). */
  sim?: rpc.Api.SimulateTransactionResponse;
  send?: Partial<rpc.Api.SendTransactionResponse> | Error;
  /** Successive getTransaction responses; the last one repeats. */
  statuses?: Array<Record<string, unknown> | Error>;
  rpcDown?: boolean;
}

function mockClient(o: MockOptions = {}) {
  let polls = 0;
  const client = {
    getNetwork: jest.fn(async () => {
      if (o.rpcDown) throw new Error('connect ECONNREFUSED');
      return { passphrase: o.passphrase ?? TESTNET };
    }),
    getLatestLedger: jest.fn(async () => ({ sequence: LATEST })),
    getSequence: jest.fn(async () => '100'),
    simulateTransaction: jest.fn(async () => o.sim ?? simSuccess([authEntry(null)])),
    sendTransaction: jest.fn(async () => {
      if (o.send instanceof Error) throw o.send;
      return { status: 'PENDING', hash: 'ignored', latestLedger: LATEST, ...o.send };
    }),
    getTransaction: jest.fn(async () => {
      const list = o.statuses ?? [{ status: 'NOT_FOUND' }];
      const next = list[Math.min(polls++, list.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  return client as unknown as TransferRpcClient & typeof client;
}

const noSleep = { attempts: 3, intervalMs: 0, sleep: async () => undefined };

/** Scenario A: sender is the source. Authorization is covered by the envelope signature. */
const sourceAccountDeps = (client: TransferRpcClient) => ({
  client,
  envelopeSigner: SENDER_KEY,
  submit: noSleep,
});

/** Scenario B: a separate source pays fees; the sender signs its own authorization entry. */
const addressAuthRequest = (): TransferRequest => baseRequest({ source: SOURCE_KEY.publicKey() });
const addressAuthDeps = (client: TransferRpcClient, over: object = {}) => ({
  client,
  authSigner: keypairAuthSigner(SENDER_KEY),
  envelopeSigner: SOURCE_KEY,
  submit: noSleep,
  ...over,
});
const addressAuthSim = () => simSuccess([authEntry(SENDER)]);

const failedIds = (r: PreflightReport) => r.checks.filter((c) => !c.passed).map((c) => c.id);

// ---- 1. Configuration and validation -------------------------------------------------------

describe('configuration and validation', () => {
  it('accepts a valid transfer and keeps large amounts exact', () => {
    const cfg = validateTransferRequest(baseRequest({ amount: '123456789012345678901234567890' }));
    expect(cfg.amount).toBe(AMOUNT);
    expect(cfg.networkPassphrase).toBe(TESTNET);
    expect(cfg.source).toBe(SENDER);
  });

  it('requires an explicit, known network', () => {
    expect(() => validateTransferRequest(baseRequest({ network: undefined }))).toThrow(
      expect.objectContaining({ code: 'NETWORK_REQUIRED' })
    );
    expect(() => validateTransferRequest(baseRequest({ network: 'futurenet' }))).toThrow(
      expect.objectContaining({ code: 'INVALID_NETWORK' })
    );
    expect(() => validateTransferRequest(baseRequest({ network: 'mainnet' }))).toThrow(
      expect.objectContaining({ code: 'INVALID_NETWORK' }) // mainnet needs an explicit rpcUrl
    );
  });

  it.each([
    ['sender', { sender: 'GNOTANADDRESS' }, 'INVALID_SENDER'],
    ['recipient', { recipient: 'nope' }, 'INVALID_RECIPIENT'],
    ['muxed recipient', { recipient: 'M' + 'A'.repeat(68) }, 'INVALID_RECIPIENT'],
    ['same sender and recipient', { recipient: SENDER }, 'INVALID_RECIPIENT'],
    ['token is not a contract', { token: SENDER }, 'INVALID_TOKEN_CONTRACT'],
    ['token is garbage', { token: 'C123' }, 'INVALID_TOKEN_CONTRACT'],
  ])('rejects invalid %s', (_name, over, code) => {
    expect(() => validateTransferRequest(baseRequest(over as Partial<TransferRequest>))).toThrow(
      expect.objectContaining({ code })
    );
  });

  it('rejects a contract sender without a classic source account', () => {
    expect(() =>
      validateTransferRequest(baseRequest({ sender: StrKey.encodeContract(Buffer.alloc(32, 9)) }))
    ).toThrow(expect.objectContaining({ code: 'INVALID_SOURCE' }));
  });

  it.each([['0'], ['-5'], [0n], [-1n], ['1.5'], ['abc'], [''], [10 ** 6], [1n << 127n]])(
    'rejects invalid amount %p',
    (amount) => {
      expect(() => parseAmount(amount)).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT' }));
    }
  );

  it('encodes the amount as an exact i128', () => {
    const [, , amount] = transferArgs({ sender: SENDER, recipient: RECIPIENT, amount: AMOUNT });
    expect(amount.switch().name).toBe('scvI128');
    expect(scValToNative(amount)).toBe(AMOUNT);
  });

  it('builds an unsigned invokeContract transaction for token.transfer', () => {
    const cfg = validateTransferRequest(baseRequest());
    const tx = buildTransferTransaction(cfg, '100');
    expect(tx.signatures).toHaveLength(0);
    expect(tx.sequence).toBe('101');
    expect(tx.networkPassphrase).toBe(TESTNET);
  });
});

// ---- 2. Simulation -------------------------------------------------------------------------

describe('simulation', () => {
  it('summarizes a successful simulation', () => {
    const s = summarizeSimulation(simSuccess([authEntry(SENDER)]));
    expect(s.minResourceFee).toBe(50000n);
    expect(s.resources).toEqual({ instructions: 1_000_000, readBytes: 2000, writeBytes: 1000 });
    expect(s.authEntries).toHaveLength(1);
  });

  it.each([
    ['HostError: Error(Contract, #10) balance is not sufficient to spend', 'INSUFFICIENT_BALANCE'],
    ['HostError: Error(Budget, ExceededLimit) cpu budget exceeded', 'INSUFFICIENT_RESOURCES'],
    ['HostError: Error(Auth, InvalidAction)', 'SIMULATION_FAILED'],
  ])('classifies failed simulation "%s"', (message, code) => {
    expect(() => summarizeSimulation(simError(message))).toThrow(expect.objectContaining({ code }));
  });

  it('requires restoring archived entries instead of ignoring them', () => {
    const restore = {
      ...(simSuccess([authEntry(null)]) as object),
      restorePreamble: { minResourceFee: '1', transactionData: {} },
    } as unknown as rpc.Api.SimulateTransactionResponse;
    expect(() => summarizeSimulation(restore)).toThrow(
      expect.objectContaining({ code: 'RESTORE_REQUIRED' })
    );
  });
});

// ---- 3. Authorization ----------------------------------------------------------------------

describe('authorization', () => {
  const cfg = () => validateTransferRequest(addressAuthRequest());

  it('inspects entries and signs the sender entry', async () => {
    const entries = [authEntry(SENDER)];
    expect(inspectAuthEntries(entries, cfg())).toEqual([
      expect.objectContaining({ kind: 'address', address: SENDER, signed: false, matchesTransfer: true }),
    ]);

    const [signed] = await signAuthEntries(entries, cfg(), keypairAuthSigner(SENDER_KEY), LATEST + 100);
    const [req] = inspectAuthEntries([signed], cfg());
    expect(req).toMatchObject({ signed: true, expiresAtLedger: LATEST + 100 });
    // Input was not mutated.
    expect(inspectAuthEntries(entries, cfg())[0].signed).toBe(false);
  });

  it('treats source-account entries as covered by the envelope signature', async () => {
    const entries = [authEntry(null)];
    const out = await signAuthEntries(entries, cfg(), undefined, LATEST + 100);
    expect(out[0]).toBe(entries[0]);
    expect(inspectAuthEntries(out, cfg())[0]).toMatchObject({ kind: 'source-account', signed: true });
  });

  it('leaves entries for other addresses unsigned', async () => {
    const other = Keypair.random();
    const entries = [authEntry(SENDER)];
    const out = await signAuthEntries(entries, cfg(), keypairAuthSigner(other), LATEST + 100);
    expect(inspectAuthEntries(out, cfg())[0].signed).toBe(false);
  });

  it('reports a signer that throws as AUTH_SIGNING_FAILED', async () => {
    const signer: AuthSigner = {
      publicKey: SENDER,
      sign: async () => {
        throw new Error('hardware wallet disconnected');
      },
    };
    await expect(signAuthEntries([authEntry(SENDER)], cfg(), signer, LATEST + 100)).rejects.toMatchObject({
      code: 'AUTH_SIGNING_FAILED',
    });
  });

  it('rejects a signature that does not match the payload as INVALID_SIGNATURE', async () => {
    const signer: AuthSigner = { publicKey: SENDER, sign: async () => Buffer.alloc(64, 1) };
    await expect(signAuthEntries([authEntry(SENDER)], cfg(), signer, LATEST + 100)).rejects.toMatchObject({
      code: 'INVALID_SIGNATURE',
    });
  });

  it.each([
    ['a different amount', { amount: AMOUNT + 1n }],
    ['a different function', { fn: 'approve' }],
    ['a different contract', { token: StrKey.encodeContract(Buffer.alloc(32, 1)) }],
    ['nested invocations', { subInvocations: true }],
  ])('refuses to sign an entry with %s', async (_name, over) => {
    await expect(
      signAuthEntries([authEntry(SENDER, over)], cfg(), keypairAuthSigner(SENDER_KEY), LATEST + 100)
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_AUTHORIZATION' });
  });

  it('does not guess how to sign for a contract account', async () => {
    const contractAccount = StrKey.encodeContract(Buffer.alloc(32, 3));
    await expect(
      signAuthEntries(
        [authEntry(contractAccount)],
        cfg(),
        { publicKey: contractAccount, sign: async () => Buffer.alloc(64) },
        LATEST + 100
      )
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_AUTHORIZATION' });
  });
});

// ---- 4. Full workflow ----------------------------------------------------------------------

describe('workflow: preflight gates submission', () => {
  it('dry run (source == sender): passes preflight and sends nothing', async () => {
    const client = mockClient();
    const out = await executeTransfer(baseRequest(), sourceAccountDeps(client), { submit: false });
    expect(out.report.ok).toBe(true);
    expect(out.report.checks.map((c) => c.id)).toEqual([
      'network', 'sender', 'recipient', 'token', 'amount', 'simulation',
      'authorization', 'envelope-signature', 'resources-and-fee',
    ]);
    expect(client.sendTransaction).not.toHaveBeenCalled();
    expect(client.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(out.submission).toBeUndefined();
  });

  it('address credentials: signs the entry, re-simulates, and the envelope is signed separately', async () => {
    const client = mockClient({ sim: addressAuthSim() });
    const out = await executeTransfer(addressAuthRequest(), addressAuthDeps(client), { submit: false });
    expect(out.report.ok).toBe(true);
    expect(client.simulateTransaction).toHaveBeenCalledTimes(2);
    expect(out.authRequirements).toEqual([
      expect.objectContaining({ kind: 'address', address: SENDER, signed: true }),
    ]);
    const tx = new Transaction(out.transactionXdr!, TESTNET);
    expect(tx.source).toBe(SOURCE_KEY.publicKey());
    expect(tx.signatures).toHaveLength(1);
    // The signed entry made it into the transaction that will be submitted.
    const op = tx.operations[0] as { auth?: xdr.SorobanAuthorizationEntry[] };
    expect(op.auth).toHaveLength(1);
    expect(op.auth![0].credentials().address().signature().switch().name).toBe('scvVec');
  });

  it('submits after a clean preflight and confirms success', async () => {
    const client = mockClient({
      statuses: [{ status: 'NOT_FOUND' }, { status: 'SUCCESS', ledger: 1010, resultXdr: txResult('txSuccess') }],
    });
    const out = await executeTransfer(baseRequest(), sourceAccountDeps(client), { submit: true });
    expect(client.sendTransaction).toHaveBeenCalledTimes(1);
    expect(out.submission).toMatchObject({ outcome: 'success', ledger: 1010, resultCode: 'txSuccess' });
    expect(out.submission!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never submits after a failed simulation', async () => {
    const client = mockClient({ sim: simError('HostError: Error(Auth, InvalidAction)') });
    const out = await executeTransfer(baseRequest(), sourceAccountDeps(client), { submit: true });
    expect(out.error).toMatchObject({ code: 'SIMULATION_FAILED' });
    expect(failedIds(out.report)).toEqual(
      expect.arrayContaining(['simulation', 'amount', 'authorization', 'envelope-signature'])
    );
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });

  it('reports insufficient balance from simulation without submitting', async () => {
    const client = mockClient({ sim: simError('Error(Contract, #10) balance is not sufficient to spend') });
    const out = await executeTransfer(baseRequest(), sourceAccountDeps(client), { submit: true });
    expect(out.error?.code).toBe('INSUFFICIENT_BALANCE');
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });

  it('never submits when authorization is missing (no signer for the sender)', async () => {
    const client = mockClient({ sim: addressAuthSim() });
    const out = await executeTransfer(
      addressAuthRequest(),
      addressAuthDeps(client, { authSigner: undefined }),
      { submit: true }
    );
    expect(failedIds(out.report)).toEqual(['authorization']);
    expect(out.report.checks.find((c) => c.id === 'authorization')!.detail).toMatch(/unsigned/);
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });

  it('never submits when simulation returns no authorization at all', async () => {
    const client = mockClient({ sim: simSuccess([]) });
    const out = await executeTransfer(baseRequest(), sourceAccountDeps(client), { submit: true });
    expect(failedIds(out.report)).toEqual(['authorization']);
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });

  it('never submits when authorization signing fails', async () => {
    const client = mockClient({ sim: addressAuthSim() });
    const badSigner: AuthSigner = { publicKey: SENDER, sign: async () => Buffer.alloc(64, 2) };
    const out = await executeTransfer(addressAuthRequest(), addressAuthDeps(client, { authSigner: badSigner }), {
      submit: true,
    });
    expect(out.error).toMatchObject({ code: 'INVALID_SIGNATURE' });
    expect(out.report.ok).toBe(false);
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects an envelope signed by the wrong key', async () => {
    const client = mockClient();
    const out = await executeTransfer(
      baseRequest(),
      { ...sourceAccountDeps(client), envelopeSigner: Keypair.random() },
      { submit: true }
    );
    expect(failedIds(out.report)).toEqual(['envelope-signature']);
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects an unsigned envelope', async () => {
    const client = mockClient();
    const out = await executeTransfer(
      baseRequest(),
      { ...sourceAccountDeps(client), envelopeSigner: undefined },
      { submit: true }
    );
    expect(failedIds(out.report)).toEqual(['envelope-signature']);
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects an RPC endpoint on a different network before simulating', async () => {
    const client = mockClient({ passphrase: MAINNET });
    const out = await executeTransfer(baseRequest(), sourceAccountDeps(client), { submit: true });
    expect(failedIds(out.report)).toContain('network');
    expect(client.simulateTransaction).not.toHaveBeenCalled();
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects a fee above the caller limit', async () => {
    const client = mockClient();
    const out = await executeTransfer(
      baseRequest(),
      { ...sourceAccountDeps(client), maxFeeStroops: 1000n },
      { submit: true }
    );
    expect(failedIds(out.report)).toEqual(['resources-and-fee']);
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });

  it('reports RPC failure as RPC_UNAVAILABLE and submits nothing', async () => {
    const client = mockClient({ rpcDown: true });
    const out = await executeTransfer(baseRequest(), sourceAccountDeps(client), { submit: true });
    expect(out.error).toMatchObject({ code: 'RPC_UNAVAILABLE' });
    expect(out.report.ok).toBe(false);
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });

  it('reports RPC failure during simulation', async () => {
    const client = mockClient();
    client.simulateTransaction.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const out = await executeTransfer(baseRequest(), sourceAccountDeps(client), { submit: true });
    expect(out.error).toMatchObject({ code: 'RPC_UNAVAILABLE' });
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });
});

describe('runPreflight', () => {
  it('detects a transaction that does not encode the requested transfer', () => {
    const cfg = validateTransferRequest(baseRequest());
    const tampered = buildTransferTransaction({ ...cfg, amount: AMOUNT + 1n }, '100');
    const report = runPreflight({
      config: cfg,
      rpcPassphrase: TESTNET,
      latestLedger: LATEST,
      transaction: tampered,
      maxFeeStroops: 1n,
    });
    expect(failedIds(report)).toContain('amount');
  });
});

// ---- 5. Submission and confirmation -------------------------------------------------------

describe('submission', () => {
  const okReport: PreflightReport = { ok: true, checks: [] };
  const tx = (): Transaction => {
    const t = buildTransferTransaction(validateTransferRequest(baseRequest()), '100');
    t.sign(SENDER_KEY);
    return t;
  };

  it('refuses to call sendTransaction when the report has failures', async () => {
    const client = mockClient();
    const report: PreflightReport = {
      ok: false,
      checks: [{ id: 'simulation', description: 'x', passed: false, detail: 'y' }],
    };
    await expect(submitTransaction(client, tx(), report, noSleep)).rejects.toMatchObject({
      code: 'PREFLIGHT_FAILED',
    });
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });

  it('reports a failed execution distinctly from success', async () => {
    const client = mockClient({
      statuses: [{ status: 'FAILED', ledger: 1011, resultXdr: txResult('txFailed'), diagnosticEventsXdr: [] }],
    });
    const r = await submitTransaction(client, tx(), okReport, noSleep);
    expect(r).toMatchObject({ outcome: 'failed', ledger: 1011, resultCode: 'txFailed' });
  });

  it('reports an unresolved submission as pending, not failed', async () => {
    const client = mockClient({ statuses: [{ status: 'NOT_FOUND' }] });
    const r = await submitTransaction(client, tx(), okReport, noSleep);
    expect(r.outcome).toBe('pending');
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(client.getTransaction).toHaveBeenCalledTimes(3);
    expect(client.sendTransaction).toHaveBeenCalledTimes(1); // no automatic resubmission
  });

  it('tolerates transient polling errors and still reaches a result', async () => {
    const client = mockClient({
      statuses: [new Error('timeout'), { status: 'SUCCESS', ledger: 5, resultXdr: txResult('txSuccess') }],
    });
    expect((await submitTransaction(client, tx(), okReport, noSleep)).outcome).toBe('success');
  });

  it('stays pending (not failed) when polling keeps erroring after acceptance', async () => {
    const client = mockClient({ statuses: [new Error('rpc down')] });
    const r = await submitTransaction(client, tx(), okReport, noSleep);
    expect(r.outcome).toBe('pending');
    expect(r.message).toMatch(/rpc down/);
  });

  it('reports a rejected submission with its result code', async () => {
    const client = mockClient({ send: { status: 'ERROR', errorResult: txResult('txBadSeq') } });
    const r = await submitTransaction(client, tx(), okReport, noSleep);
    expect(r).toMatchObject({ outcome: 'rejected', resultCode: 'txBadSeq' });
    expect(client.getTransaction).not.toHaveBeenCalled();
  });

  it('does not poll or retry when the network says try again later', async () => {
    const client = mockClient({ send: { status: 'TRY_AGAIN_LATER' } });
    const r = await submitTransaction(client, tx(), okReport, noSleep);
    expect(r.outcome).toBe('not_accepted');
    expect(client.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('treats a failed submit request as unknown status, with the hash for follow-up', async () => {
    const client = mockClient({ send: new Error('socket hang up') });
    const r = await submitTransaction(client, tx(), okReport, noSleep);
    expect(r.outcome).toBe('unknown');
    expect(r.hash).toBe(tx().hash().toString('hex'));
    expect(r.message).toMatch(/before sending anything again/);
    expect(client.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('follows a DUPLICATE response by hash', async () => {
    const client = mockClient({
      send: { status: 'DUPLICATE' },
      statuses: [{ status: 'SUCCESS', ledger: 7, resultXdr: txResult('txSuccess') }],
    });
    expect((await submitTransaction(client, tx(), okReport, noSleep)).outcome).toBe('success');
  });

});
