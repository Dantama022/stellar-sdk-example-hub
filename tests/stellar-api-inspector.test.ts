import { runInspectorCli } from '../src/stellar-api-inspector';

describe('stellar-api-inspector CLI', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns code 1 for unknown subcommands', async () => {
    const code = await runInspectorCli(['unknown']);
    expect(code).toBe(1);
  });

  it('returns code 0 for successful Horizon checks', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        network_passphrase: 'Test SDF Network ; September 2015',
        current_protocol_version: 22,
        core_version: 'stellar-core 22.0.0',
        horizon_version: '2.30.0',
      }),
    } as Response);

    const code = await runInspectorCli(['horizon', '--url', 'https://horizon-testnet.stellar.org']);
    expect(code).toBe(0);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('returns code 1 for offline Horizon endpoint', async () => {
    jest
      .spyOn(global, 'fetch' as any)
      .mockRejectedValue(new Error('getaddrinfo ENOTFOUND horizon.invalid'));

    const code = await runInspectorCli(['horizon', '--url', 'https://horizon.invalid']);
    expect(code).toBe(1);
  });
});
