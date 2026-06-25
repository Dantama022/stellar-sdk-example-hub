import {
  extractHorizonMetadata,
  inspectHorizonEndpoint,
  InvalidHorizonUrlError,
  HorizonOfflineError,
} from '../src/inspector/horizon';

describe('Horizon inspector', () => {
  it('handles successful Horizon connection and metadata extraction', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        network_passphrase: 'Test SDF Network ; September 2015',
        current_protocol_version: 22,
        core_version: 'stellar-core 22.0.0',
        horizon_version: '2.30.0',
      }),
    });

    const result = await inspectHorizonEndpoint('https://horizon-testnet.stellar.org', {
      fetchImpl,
      now: (() => {
        const points = [1000, 1088];
        return () => points.shift() ?? 1088;
      })(),
    });

    expect(result.endpoint).toBe('https://horizon-testnet.stellar.org');
    expect(result.latencyMs).toBe(88);
    expect(result.metadata.networkPassphrase).toContain('Test SDF Network');
    expect(result.metadata.protocolVersion).toBe('22');
    expect(result.metadata.coreVersion).toContain('stellar-core');
    expect(result.metadata.horizonVersion).toBe('2.30.0');
  });

  it('handles invalid URL input', async () => {
    await expect(inspectHorizonEndpoint('not-a-url')).rejects.toBeInstanceOf(
      InvalidHorizonUrlError,
    );
  });

  it('handles offline endpoint and exits with connectivity error semantics', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(
      inspectHorizonEndpoint('https://localhost:31337', {
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(HorizonOfflineError);
  });

  it('handles non-200 endpoint as offline diagnostic', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    await expect(
      inspectHorizonEndpoint('https://horizon-testnet.stellar.org', {
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(HorizonOfflineError);
  });

  it('extracts protocol version from fallback field', () => {
    const metadata = extractHorizonMetadata({
      network_passphrase: 'Public Global Stellar Network ; September 2015',
      protocol_version: 21,
      core_version: 'stellar-core 21.2.0',
      horizon_version: '2.29.0',
    });

    expect(metadata.protocolVersion).toBe('21');
  });
});
