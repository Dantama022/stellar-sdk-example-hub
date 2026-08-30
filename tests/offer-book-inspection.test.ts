import { Asset, Horizon } from '@stellar/stellar-sdk';

import {
  describeOfferBookAsset,
  describeRawOfferAsset,
  fetchActiveOffers,
  formatOfferBookRecord,
  formatOfferBookReport,
  getOfferBookErrorStatus,
  isInvalidOfferBookQueryError,
  normalizeOfferBookLimit,
  parseOfferBookAsset,
  parseOfferBookPrice,
  parseOfferBookRecord,
  parseOfferBookNumber,
  summarizeOfferBook,
  type ParsedOfferBookRecord,
  type RawOfferBookRecord,
} from '../src/examples/65-offer-book-inspection';

const ISSUER_ONE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

const ISSUER_TWO = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBDV';

function createParsedOffer(overrides: Partial<ParsedOfferBookRecord> = {}): ParsedOfferBookRecord {
  return {
    id: '1001',
    seller: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCGD',
    sellingAsset: 'XLM (native)',
    buyingAsset: `USDC:${ISSUER_ONE}`,
    assetPair: `XLM (native) → USDC:${ISSUER_ONE}`,
    amount: 100,
    price: 0.25,
    priceNumerator: 1,
    priceDenominator: 4,
    approximateBuyingAmount: 25,
    lastModifiedLedger: 123456,
    lastModifiedTime: '2026-07-29T12:00:00Z',
    selfUrl: 'https://horizon-testnet.stellar.org/offers/1001',
    ...overrides,
  };
}

describe('Example 65: Horizon offer book inspection helpers', () => {
  describe('normalizeOfferBookLimit', () => {
    it('uses the default for missing and invalid values', () => {
      expect(normalizeOfferBookLimit()).toBe(10);
      expect(normalizeOfferBookLimit('invalid')).toBe(10);
    });

    it('clamps limits to the Horizon range', () => {
      expect(normalizeOfferBookLimit(0)).toBe(1);
      expect(normalizeOfferBookLimit(-10)).toBe(1);
      expect(normalizeOfferBookLimit(25)).toBe(25);
      expect(normalizeOfferBookLimit('50')).toBe(50);
      expect(normalizeOfferBookLimit(500)).toBe(200);
    });
  });

  describe('parseOfferBookAsset', () => {
    it('parses native and XLM aliases', () => {
      expect(parseOfferBookAsset('native').isNative()).toBe(true);
      expect(parseOfferBookAsset(' XLM ').isNative()).toBe(true);
    });

    it('parses an issued asset', () => {
      const asset = parseOfferBookAsset(`USDC:${ISSUER_ONE}`);

      expect(asset.isNative()).toBe(false);
      expect(asset.getCode()).toBe('USDC');
      expect(asset.getIssuer()).toBe(ISSUER_ONE);
    });

    it('rejects an asset code without an issuer', () => {
      expect(() => parseOfferBookAsset('USDC')).toThrow('Issued assets require CODE:ISSUER');
    });

    it('rejects malformed issued assets', () => {
      expect(() => parseOfferBookAsset('USDC:INVALID_ISSUER')).toThrow('Invalid asset');
    });

    it('rejects an empty filter', () => {
      expect(() => parseOfferBookAsset('   ')).toThrow('Missing asset');
    });
  });

  describe('asset formatting', () => {
    it('formats SDK assets', () => {
      expect(describeOfferBookAsset(Asset.native())).toBe('XLM (native)');

      expect(describeOfferBookAsset(new Asset('USDC', ISSUER_ONE))).toBe(`USDC:${ISSUER_ONE}`);
    });

    it('formats raw native and issued Horizon assets', () => {
      expect(
        describeRawOfferAsset({
          asset_type: 'native',
        }),
      ).toBe('XLM (native)');

      expect(
        describeRawOfferAsset({
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: ISSUER_ONE,
        }),
      ).toBe(`USDC:${ISSUER_ONE}`);
    });
  });

  describe('numeric parsing', () => {
    it('parses valid numeric strings safely', () => {
      expect(parseOfferBookNumber('25.5000000')).toBe(25.5);
      expect(parseOfferBookNumber()).toBe(0);
      expect(parseOfferBookNumber('invalid')).toBe(0);
    });

    it('prefers the exact rational price', () => {
      expect(
        parseOfferBookPrice({
          price: '99.0000000',
          price_r: {
            n: 1,
            d: 4,
          },
        }),
      ).toEqual({
        price: 0.25,
        numerator: 1,
        denominator: 4,
      });
    });

    it('falls back to the decimal price when the ratio is invalid', () => {
      expect(
        parseOfferBookPrice({
          price: '2.5000000',
          price_r: {
            n: 5,
            d: 0,
          },
        }),
      ).toEqual({
        price: 2.5,
      });
    });
  });

  describe('parseOfferBookRecord', () => {
    it('parses offer identity, assets, amount, price, and ledger', () => {
      const rawOffer: RawOfferBookRecord = {
        id: '1001',
        seller: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCGD',
        selling: {
          asset_type: 'native',
        },
        buying: {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: ISSUER_ONE,
        },
        amount: '100.0000000',
        price: '0.2500000',
        price_r: {
          n: 1,
          d: 4,
        },
        last_modified_ledger: 123456,
        last_modified_time: '2026-07-29T12:00:00Z',
        _links: {
          self: {
            href: 'https://horizon-testnet.stellar.org/offers/1001',
          },
        },
      };

      expect(parseOfferBookRecord(rawOffer)).toEqual(createParsedOffer());
    });

    it('uses safe defaults for incomplete records', () => {
      const offer = parseOfferBookRecord({
        paging_token: '2002',
      });

      expect(offer.id).toBe('2002');
      expect(offer.seller).toBe('Unknown');
      expect(offer.sellingAsset).toBe('XLM (native)');
      expect(offer.buyingAsset).toBe('XLM (native)');
      expect(offer.amount).toBe(0);
      expect(offer.price).toBe(0);
      expect(offer.approximateBuyingAmount).toBe(0);
    });
  });

  describe('fetchActiveOffers', () => {
    function createOfferQueryMock() {
      const call = jest.fn().mockResolvedValue({
        records: [
          {
            id: '1001',
          },
        ],
      });

      const query = {
        selling: jest.fn(),
        buying: jest.fn(),
        order: jest.fn(),
        limit: jest.fn(),
        call,
      };

      query.selling.mockReturnValue(query);
      query.buying.mockReturnValue(query);
      query.order.mockReturnValue(query);
      query.limit.mockReturnValue(query);

      const offers = jest.fn().mockReturnValue(query);

      const server = {
        offers,
      } as unknown as Horizon.Server;

      return {
        server,
        offers,
        query,
        call,
      };
    }

    it('retrieves active offers without asset filters', async () => {
      const { server, offers, query, call } = createOfferQueryMock();

      const records = await fetchActiveOffers(server, undefined, undefined, 10);

      expect(offers).toHaveBeenCalledTimes(1);
      expect(query.selling).not.toHaveBeenCalled();
      expect(query.buying).not.toHaveBeenCalled();
      expect(query.order).toHaveBeenCalledWith('desc');
      expect(query.limit).toHaveBeenCalledWith(10);
      expect(call).toHaveBeenCalledTimes(1);
      expect(records).toEqual([
        {
          id: '1001',
        },
      ]);
    });

    it('applies a selling-asset filter', async () => {
      const { server, query } = createOfferQueryMock();
      const sellingAsset = Asset.native();

      await fetchActiveOffers(server, sellingAsset, undefined, 25);

      expect(query.selling).toHaveBeenCalledWith(sellingAsset);
      expect(query.buying).not.toHaveBeenCalled();
      expect(query.limit).toHaveBeenCalledWith(25);
    });

    it('applies a buying-asset filter', async () => {
      const { server, query } = createOfferQueryMock();
      const buyingAsset = new Asset('USDC', ISSUER_ONE);

      await fetchActiveOffers(server, undefined, buyingAsset, 20);

      expect(query.selling).not.toHaveBeenCalled();
      expect(query.buying).toHaveBeenCalledWith(buyingAsset);
    });

    it('applies both selling and buying filters', async () => {
      const { server, query } = createOfferQueryMock();
      const sellingAsset = Asset.native();
      const buyingAsset = new Asset('USDC', ISSUER_ONE);

      await fetchActiveOffers(server, sellingAsset, buyingAsset, 30);

      expect(query.selling).toHaveBeenCalledWith(sellingAsset);
      expect(query.buying).toHaveBeenCalledWith(buyingAsset);
      expect(query.order).toHaveBeenCalledWith('desc');
      expect(query.limit).toHaveBeenCalledWith(30);
    });
  });

  describe('summarizeOfferBook', () => {
    it('summarizes offers, sellers, pairs, and asset totals', () => {
      const first = createParsedOffer();

      const second = createParsedOffer({
        id: '1002',
        seller: 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA',
        sellingAsset: `EURC:${ISSUER_TWO}`,
        buyingAsset: 'XLM (native)',
        assetPair: `EURC:${ISSUER_TWO} → XLM (native)`,
        amount: 50,
        price: 2,
        priceNumerator: 2,
        priceDenominator: 1,
        approximateBuyingAmount: 100,
      });

      const third = createParsedOffer({
        id: '1003',
        amount: 20,
        approximateBuyingAmount: 5,
      });

      expect(summarizeOfferBook([first, second, third])).toEqual({
        totalOffers: 3,
        uniqueSellers: 2,
        uniqueAssetPairs: 2,
        totalSellingAmounts: {
          'XLM (native)': 120,
          [`EURC:${ISSUER_TWO}`]: 50,
        },
        approximateBuyingAmounts: {
          [`USDC:${ISSUER_ONE}`]: 30,
          'XLM (native)': 100,
        },
      });
    });
  });

  describe('formatOfferBookRecord', () => {
    it('formats active offer information clearly', () => {
      const output = formatOfferBookRecord(createParsedOffer(), 0);

      expect(output).toContain('[1] Active Offer');
      expect(output).toContain('Offer ID:                 1001');
      expect(output).toContain('Selling Asset:            XLM (native)');
      expect(output).toContain(`Buying Asset:             USDC:${ISSUER_ONE}`);
      expect(output).toContain('Selling Amount:           100.0000000 XLM (native)');
      expect(output).toContain(
        `Price:                    0.2500000 USDC:${ISSUER_ONE} per 1 XLM (native)`,
      );
      expect(output).toContain('Last Modified Ledger:     123456');
    });
  });

  describe('formatOfferBookReport', () => {
    it('formats offers and summary statistics', () => {
      const report = formatOfferBookReport('XLM (native)', `USDC:${ISSUER_ONE}`, 10, [
        createParsedOffer(),
      ]);

      expect(report).toContain('Selling Filter: XLM (native)');
      expect(report).toContain(`Buying Filter:  USDC:${ISSUER_ONE}`);
      expect(report).toContain('Offers Found:   1');
      expect(report).toContain('Total active offers: 1');
      expect(report).toContain('Unique sellers:      1');
      expect(report).toContain('Offer: one seller’s remaining open intention');
      expect(report).toContain('Trade: a completed exchange already recorded');
      expect(report).toContain('Liquidity pool: AMM reserves');
    });

    it('handles an empty result gracefully', () => {
      const report = formatOfferBookReport('XLM (native)', `MISSING:${ISSUER_ONE}`, 10, []);

      expect(report).toContain('No active offers matched the selected filters.');
      expect(report).toContain('valid empty result');
      expect(report).toContain('Offers are open seller-owned trading intentions.');
      expect(report).toContain('Trades are completed historical executions.');
      expect(report).toContain('Liquidity pools are AMM reserves');
    });

    it('supports browsing without filters', () => {
      const report = formatOfferBookReport(undefined, undefined, 5, []);

      expect(report).toContain('Selling Filter: None — any selling asset');
      expect(report).toContain('Buying Filter:  None — any buying asset');
      expect(report).toContain('Result Limit:   5');
    });
  });

  describe('Horizon query errors', () => {
    it('extracts HTTP response status values', () => {
      expect(
        getOfferBookErrorStatus({
          response: {
            status: 400,
          },
        }),
      ).toBe(400);

      expect(getOfferBookErrorStatus(new Error('Failure'))).toBeUndefined();
    });

    it('detects invalid filter responses', () => {
      expect(
        isInvalidOfferBookQueryError({
          response: {
            status: 400,
          },
        }),
      ).toBe(true);

      expect(
        isInvalidOfferBookQueryError({
          response: {
            status: 422,
          },
        }),
      ).toBe(true);

      expect(
        isInvalidOfferBookQueryError({
          response: {
            status: 500,
          },
        }),
      ).toBe(false);
    });
  });
});
