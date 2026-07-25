import {
  computeReconnectDelay,
  formatConnectionStatus,
} from '../src/examples/44-resilient-horizon-stream';

describe('Resilient Horizon stream helpers', () => {
  it('applies exponential backoff with a ceiling', () => {
    expect(computeReconnectDelay(1, 1000, 5000)).toBe(1000);
    expect(computeReconnectDelay(2, 1000, 5000)).toBe(2000);
    expect(computeReconnectDelay(3, 1000, 5000)).toBe(4000);
    expect(computeReconnectDelay(4, 1000, 5000)).toBe(5000);
  });

  it('formats connection status messages', () => {
    expect(formatConnectionStatus('connected', { cursor: 'now' })).toContain('cursor=now');
    expect(
      formatConnectionStatus('reconnecting', { cursor: '123', attempt: 2, delayMs: 4000 }),
    ).toContain('attempt 2');
  });
});
