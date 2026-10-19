import { Asset } from '@stellar/stellar-sdk';
import {
  describeAsset,
  describeHop,
  describePath,
  formatQuoteValidation,
  validateStrictReceiveQuote,
} from '../src/examples/259-strict-receive-path-payment';

const native = Asset.native();
const issuer = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const issued = new Asset('RCVAST', issuer);

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    sourceAmount: '5',
    destinationAmount: '10',
    requestedDestinationAmount: '10',
    sendMax: '10',
    sendAsset: native,
    destAsset: issued,
    path: [{ asset_type: 'native' }],
    ...overrides,
  } as Parameters<typeof validateStrictReceiveQuote>[0];
}

describe('ISSUE-308: pathfinding and strict-receive validation', () => {
  it('describes native and issued assets', () => {
    expect(describeAsset(native)).toBe('XLM');
    expect(describeAsset(issued)).toBe(`RCVAST:${issuer}`);
    expect(describeAsset(undefined)).toBe('unknown');
  });

  it('describes a single path hop', () => {
    expect(describeHop({ asset_type: 'native' })).toBe('XLM');
    expect(
      describeHop({ asset_type: 'credit_alphanum4', asset_code: 'RCVAST', asset_issuer: issuer }),
    ).toBe(`RCVAST:${issuer}`);
  });

  it('converts a quoted path into hops', () => {
    const hops = describePath([
      { asset_type: 'native' },
      { asset_type: 'credit_alphanum4', asset_code: 'RCVAST', asset_issuer: issuer },
    ]);
    expect(hops).toEqual([{ code: 'XLM' }, { code: 'RCVAST', issuer }]);
  });

  it('accepts a valid quote', () => {
    const validation = validateStrictReceiveQuote(baseParams());
    expect(validation.valid).toBe(true);
    expect(validation.problems).toEqual([]);
    expect(validation.sendAsset).toBe('XLM');
    expect(validation.destAsset).toBe(`RCVAST:${issuer}`);
    expect(validation.path).toEqual([{ code: 'XLM' }]);
  });

  it('rejects a quote whose source amount exceeds sendMax', () => {
    const validation = validateStrictReceiveQuote(
      baseParams({ sourceAmount: '25', sendMax: '10' }),
    );
    expect(validation.valid).toBe(false);
    expect(validation.problems.join(' ')).toContain('exceeds the configured sendMax');
    expect(validation.nextSteps.join(' ')).toContain('Raise sendMax');
  });

  it('rejects a quote that does not guarantee the exact destination amount', () => {
    const validation = validateStrictReceiveQuote(baseParams({ destinationAmount: '9.99' }));
    expect(validation.valid).toBe(false);
    expect(validation.problems.join(' ')).toContain('guarantees 9.99 but 10 was requested');
    expect(validation.nextSteps.join(' ')).toContain('exact requested amount');
  });

  it('warns when no path was quoted', () => {
    const validation = validateStrictReceiveQuote(baseParams({ path: [] }));
    expect(validation.valid).toBe(false);
    expect(validation.problems.join(' ')).toContain('no path');
  });

  it('rejects a quote whose path ends in the wrong asset', () => {
    const validation = validateStrictReceiveQuote(
      baseParams({
        path: [{ asset_type: 'credit_alphanum4', asset_code: 'OTHER', asset_issuer: issuer }],
      }),
    );
    expect(validation.valid).toBe(false);
    expect(validation.problems.join(' ')).toContain('quoted path ends in');
  });

  it('rejects a path that repeats an asset', () => {
    const validation = validateStrictReceiveQuote(
      baseParams({
        path: [
          { asset_type: 'credit_alphanum4', asset_code: 'RCVAST', asset_issuer: issuer },
          { asset_type: 'native' },
          { asset_type: 'credit_alphanum4', asset_code: 'RCVAST', asset_issuer: issuer },
        ],
      }),
    );
    expect(validation.valid).toBe(false);
    expect(validation.problems.join(' ')).toContain('repeats the asset');
  });

  it('reports a missing source amount', () => {
    const validation = validateStrictReceiveQuote(baseParams({ sourceAmount: undefined }));
    expect(validation.valid).toBe(false);
    expect(validation.problems.join(' ')).toContain('did not include a source amount');
  });

  it('renders a validation report with problems and next steps', () => {
    const text = formatQuoteValidation(
      validateStrictReceiveQuote(baseParams({ sourceAmount: '25' })),
    );
    expect(text).toContain('Valid: no');
    expect(text).toContain('Send asset: XLM');
    expect(text).toContain('Problems:');
    expect(text).toContain('Next steps:');
    expect(text).toContain('exceeds the configured sendMax');
  });

  it('renders a valid report without a problems section', () => {
    const text = formatQuoteValidation(validateStrictReceiveQuote(baseParams()));
    expect(text).toContain('Valid: yes');
    expect(text).not.toContain('Problems:');
  });
});
