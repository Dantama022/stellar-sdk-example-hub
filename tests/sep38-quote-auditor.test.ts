import {
  auditSep38Quote,
  compareSep38Quotes,
  fetchSep38Quote,
  formatSep38AuditReport,
  Sep38QuoteResponse,
} from '../src/examples/267-sep38-quote-auditor';
import { examples } from '../src/runner/catalog';

const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const USDC = 'stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const USD = 'iso4217:USD';

function makeQuote(overrides: Partial<Sep38QuoteResponse> = {}): Sep38QuoteResponse {
  return {
    id: 'q-1',
    expires_at: new Date(NOW_MS + 300_000).toISOString(),
    price: '1.0000000',
    sell_asset: USD,
    sell_amount: '100.0000000',
    buy_asset: USDC,
    buy_amount: '100.0000000',
    fee: { total: '0.00', asset: USD },
    ...overrides,
  };
}

describe('267-sep38-quote-auditor', () => {
  it('audits a valid SEP-38 quote and calculates exact effective exchange rate', () => {
    const quote = makeQuote({
      price: '1.0200000',
      sell_amount: '102.0000000',
      buy_amount: '100.0000000',
      fee: { total: '2.00', asset: USD },
    });
    const audit = auditSep38Quote(quote, { anchorService: 'https://anchor.test', nowMs: NOW_MS });

    expect(audit.valid).toBe(true);
    expect(audit.calculatedEffectivePrice).toBe('1.0200000');
    expect(audit.priceDifferencePercent).toBe('0.0000');
    expect(audit.expiration.status).toBe('valid');
    expect(formatSep38AuditReport(audit)).toContain('Effective Price: 1.0200000');
  });

  it('rejects malformed quote responses and missing required fields', () => {
    expect(auditSep38Quote(null, { nowMs: NOW_MS }).valid).toBe(false);

    const missing = auditSep38Quote({ id: 'q-bad' }, { nowMs: NOW_MS });
    expect(missing.valid).toBe(false);
    expect(missing.errors.some((e) => e.includes('expires_at'))).toBe(true);
    expect(missing.errors.some((e) => e.includes('sell_amount'))).toBe(true);
  });

  it('detects expired quotes, approaching-expiration quotes, and invalid timestamps', () => {
    const expired = auditSep38Quote(
      makeQuote({ expires_at: new Date(NOW_MS - 1000).toISOString() }),
      { nowMs: NOW_MS },
    );
    expect(expired.valid).toBe(false);
    expect(expired.expiration.status).toBe('expired');

    const approaching = auditSep38Quote(
      makeQuote({ expires_at: new Date(NOW_MS + 30_000).toISOString() }),
      { nowMs: NOW_MS, expirationWarningThresholdMs: 60_000 },
    );
    expect(approaching.valid).toBe(true);
    expect(approaching.expiration.status).toBe('approaching_expiration');
    expect(approaching.warnings.some((w) => w.includes('expires in 30000 ms'))).toBe(true);

    const invalidTs = auditSep38Quote(makeQuote({ expires_at: 'not-a-date' }), { nowMs: NOW_MS });
    expect(invalidTs.valid).toBe(false);
    expect(invalidTs.expiration.status).toBe('invalid_or_missing');
  });

  it('warns on discrepancies between declared and calculated effective prices', () => {
    const discrepant = auditSep38Quote(
      makeQuote({
        price: '1.0000000',
        sell_amount: '105.0000000',
        buy_amount: '100.0000000',
      }),
      { nowMs: NOW_MS, priceDiscrepancyTolerancePercent: '1.0' },
    );

    expect(discrepant.calculatedEffectivePrice).toBe('1.0500000');
    expect(discrepant.warnings.some((w) => w.includes('differs from declared price'))).toBe(true);
  });

  it('compares multiple quotes including opposite asset directions and excludes invalid/expired quotes', () => {
    const qBetter = auditSep38Quote(
      makeQuote({
        id: 'q-better',
        price: '0.9800000',
        sell_asset: USD,
        sell_amount: '98.0000000',
        buy_asset: USDC,
        buy_amount: '100.0000000',
        fee: { total: '1.00', asset: USD },
      }),
      { nowMs: NOW_MS },
    );
    const qInverted = auditSep38Quote(
      makeQuote({
        id: 'q-inverted',
        price: '1.0100000',
        sell_asset: USDC,
        sell_amount: '101.0000000',
        buy_asset: USD,
        buy_amount: '100.0000000',
        fee: { total: '0.50', asset: USDC },
      }),
      { nowMs: NOW_MS },
    );
    const qExpired = auditSep38Quote(
      makeQuote({
        id: 'q-expired',
        expires_at: new Date(NOW_MS - 5000).toISOString(),
      }),
      { nowMs: NOW_MS },
    );

    const comparison = compareSep38Quotes([qInverted, qBetter, qExpired], USD, USDC);
    expect(comparison.mostFavorableQuoteId).toBe('q-better');
    expect(comparison.rankedQuotes.map((q) => [q.quoteId, q.originalDirection])).toEqual([
      ['q-better', 'same'],
      ['q-inverted', 'inverted'],
    ]);
    expect(comparison.excludedQuotes).toHaveLength(1);
    expect(comparison.excludedQuotes[0].quoteId).toBe('q-expired');
  });

  it('handles HTTP request failures when fetching quotes', async () => {
    await expect(
      fetchSep38Quote('https://anchor.test', 'q-404', async () => ({
        ok: false,
        status: 404,
        async json() {
          return {};
        },
      })),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('is registered in the example catalog', () => {
    expect(examples['267-sep38-quote-auditor']).toBeDefined();
  });
});
