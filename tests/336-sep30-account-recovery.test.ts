import { Keypair, Networks } from '@stellar/stellar-sdk';
import { makeMockFetch, Sep30Client, validateAccount, validateRegistration, validateSettings } from '../src/examples/336-sep30-account-recovery';
const account = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const signer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const settings = { baseUrl: 'https://mock.invalid', jwt: 'secret-mock-token', timeoutMs: 1000 };
import { demoUnsignedEnvelope } from '../src/examples/335-sep7-uri';
const body = { identities: [{ role: 'owner', auth_methods: [{ type: 'email' as const, value: 'example@example.invalid' }] }] };

test('register and read mock SEP-30 account without a live server', async () => {
  const fetchMock = jest.fn(makeMockFetch(account, signer));
  const client = new Sep30Client(settings, fetchMock);
  const registration = await client.register(account, body);
  expect(registration.signers[0].key).toBe(signer);
  expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
  expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({Authorization: `Bearer ${settings.jwt}`});
  expect((await client.getAccount(account)).address).toBe(account);
  const signed = await client.requestRecoverySignature(account, signer, demoUnsignedEnvelope(account));
  expect(signed.network_passphrase).toBe(Networks.TESTNET);
  expect(signed.signature).toHaveLength(88);
});

test('invalid config, identity and response rejected', () => {
  expect(() => validateSettings({ ...settings, jwt: '' })).toThrow('SEP30_JWT');
  expect(() => validateSettings({ ...settings, baseUrl: 'http://external.test' })).toThrow('HTTPS');
  expect(() => validateRegistration({ identities: [] })).toThrow('nonempty');
  expect(() => validateAccount({ address: account, identities: [], signers: [{ key: 'invalid' }] }, account)).toThrow('signers');
  expect(() => validateAccount({ address: 'other', identities: [], signers: [{ key: signer }] }, account)).toThrow('address');
});

test('HTTP errors and invalid JSON do not leak service response bodies', async () => {
  const forbidden = 'private-secret-token';
  const denied = new Sep30Client(settings, (async () => new Response(forbidden, {status:401})) as typeof fetch);
  await expect(denied.register(account, body)).rejects.toThrow('HTTP 401');
  const invalidJson = new Sep30Client(settings, (async () => new Response('{not json')) as typeof fetch);
  await expect(invalidJson.getAccount(account)).rejects.toThrow('invalid JSON');
});

test('timeout is reported separately and no retry occurs', async () => {
  const slow = jest.fn(async (_: RequestInfo | URL, options?: RequestInit) => {
    await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(Error('aborted'))));
    return new Response('{}');
  });
  const client = new Sep30Client({...settings, timeoutMs:100}, slow as typeof fetch);
  await expect(client.getAccount(account)).rejects.toThrow('timed out');
  expect(slow).toHaveBeenCalledTimes(1);
});


test('recovery request validates unsigned XDR and the service response', async () => {
  const client = new Sep30Client(settings, (async () => new Response(JSON.stringify({ signature: 'not-signature' }), {status:200})) as typeof fetch);
  await expect(client.requestRecoverySignature(account, signer, 'bad')).rejects.toThrow('transaction');
  await expect(client.requestRecoverySignature(account, signer, demoUnsignedEnvelope(account))).rejects.toThrow('signing response');
});
