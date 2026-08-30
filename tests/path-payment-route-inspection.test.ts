import {
  buildRouteReport,
  calculateEffectiveRate,
  formatAsset,
  formatPath,
  parseAssetDefinition,
  rankRoutesByEfficiency,
  type HorizonPathRecord,
  type RouteReport,
} from '../src/examples/131-path-payment-route-inspection';
import { examples } from '../src/runner/catalog';

const ISSUER = 'GBH3KZIVHI3TKR2XRIJES5LUQMQFC22Y3MUFYPAFHUJVOS55O2MQFUYQ';

describe('131-path-payment-route-inspection', () => {
  describe('formatAsset / formatPath', () => {
    it('formats the native asset as XLM', () => {
      expect(formatAsset({ asset_type: 'native' })).toBe('XLM');
    });

    it('formats an issued asset with a truncated issuer', () => {
      expect(
        formatAsset({ asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: ISSUER }),
      ).toBe(`USD:${ISSUER.slice(0, 8)}…`);
    });

    it('formats a full path of hops', () => {
      const path = [
        { asset_type: 'native' },
        { asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: ISSUER },
      ];
      expect(formatPath(path)).toEqual(['XLM', `USD:${ISSUER.slice(0, 8)}…`]);
    });
  });

  describe('calculateEffectiveRate', () => {
    it('computes destination units received per source unit', () => {
      expect(calculateEffectiveRate('10', '25')).toBe('2.5000000');
    });

    it('returns n/a for a zero or invalid source amount', () => {
      expect(calculateEffectiveRate('0', '25')).toBe('n/a');
      expect(calculateEffectiveRate('not-a-number', '25')).toBe('n/a');
    });
  });

  describe('buildRouteReport', () => {
    const record: HorizonPathRecord = {
      source_asset_type: 'native',
      source_amount: '10',
      destination_asset_type: 'credit_alphanum4',
      destination_asset_code: 'USD',
      destination_asset_issuer: ISSUER,
      destination_amount: '25',
      path: [],
    };

    it('builds a full route report with hops and effective rate', () => {
      const report = buildRouteReport(record);
      expect(report.hops).toEqual(['XLM', `USD:${ISSUER.slice(0, 8)}…`]);
      expect(report.intermediateAssets).toEqual([]);
      expect(report.sourceAmount).toBe('10');
      expect(report.destinationAmount).toBe('25');
      expect(report.effectiveRate).toBe('2.5000000');
    });
  });

  describe('rankRoutesByEfficiency', () => {
    it('sorts ascending by source amount', () => {
      const routes: RouteReport[] = [
        {
          hops: [],
          intermediateAssets: [],
          sourceAmount: '20',
          destinationAmount: '25',
          effectiveRate: '1',
        },
        {
          hops: [],
          intermediateAssets: [],
          sourceAmount: '10',
          destinationAmount: '25',
          effectiveRate: '2',
        },
      ];
      const ranked = rankRoutesByEfficiency(routes);
      expect(ranked[0].sourceAmount).toBe('10');
      expect(ranked[1].sourceAmount).toBe('20');
    });

    it('does not mutate the original array', () => {
      const routes: RouteReport[] = [
        {
          hops: [],
          intermediateAssets: [],
          sourceAmount: '20',
          destinationAmount: '25',
          effectiveRate: '1',
        },
        {
          hops: [],
          intermediateAssets: [],
          sourceAmount: '10',
          destinationAmount: '25',
          effectiveRate: '2',
        },
      ];
      rankRoutesByEfficiency(routes);
      expect(routes[0].sourceAmount).toBe('20');
    });
  });

  describe('parseAssetDefinition', () => {
    it('parses "native" and "xlm" as the native asset', () => {
      expect(parseAssetDefinition('native').isNative()).toBe(true);
      expect(parseAssetDefinition('XLM').isNative()).toBe(true);
    });

    it('parses "CODE:ISSUER" into an Asset', () => {
      const asset = parseAssetDefinition(`USD:${ISSUER}`);
      expect(asset.getCode()).toBe('USD');
      expect(asset.getIssuer()).toBe(ISSUER);
    });

    it('throws for an invalid definition', () => {
      expect(() => parseAssetDefinition('')).toThrow();
      expect(() => parseAssetDefinition('USD')).toThrow(/Invalid asset definition/);
    });
  });

  describe('runner registration', () => {
    it('registers 131-path-payment-route-inspection in the catalog', () => {
      expect(examples['131-path-payment-route-inspection']).toBeDefined();
      expect(typeof examples['131-path-payment-route-inspection'].run).toBe('function');
    });
  });
});
