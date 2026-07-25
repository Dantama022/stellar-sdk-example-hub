import { formatPathAssets } from '../src/examples/36-strict-receive-path-payment';

describe('Strict receive path payment helpers', () => {
  it('formats intermediate path assets for console output', () => {
    const formatted = formatPathAssets([
      { asset_type: 'native' },
      { asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: 'GABCDEFGHIJK' },
    ]);

    expect(formatted).toContain('XLM');
    expect(formatted).toContain('USD');
  });
});
