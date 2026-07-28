import { readFileSync } from 'fs';
import path from 'path';

import * as ex66 from '../src/examples/66-ledger-effects';
import { examples } from '../src/runner/catalog';

describe('ISSUE-066: Ledger Effects', () => {
  // A realistic mainnet-scale sequence: above ledger 2097152 the operation TOID
  // no longer fits in a double, which is what `parseEffectId` has to survive.
  const LEDGER = 56123456;
  const accountA = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
  const accountB = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

  /**
   * Builds a Horizon effect ID: the operation's TOID followed by the effect's
   * index within that operation.
   */
  const effectId = (ledger: number, tx: number, op: number, index: number): string =>
    `${(BigInt(ledger) << 32n) | (BigInt(tx) << 12n) | BigInt(op)}-${index}`;

  const buildEffect = (overrides: Partial<ex66.LedgerEffectLike> = {}): ex66.LedgerEffectLike => ({
    id: effectId(LEDGER, 1, 1, 1),
    type: 'account_credited',
    account: accountA,
    created_at: '2026-07-28T10:00:00Z',
    asset_type: 'native',
    amount: '100.0000000',
    ...overrides,
  });

  const buildHeader = (
    overrides: Partial<ex66.LedgerHeaderSummary> = {},
  ): ex66.LedgerHeaderSummary => ({
    sequence: LEDGER,
    closedAt: '2026-07-28T10:00:00Z',
    successfulTransactionCount: 2,
    failedTransactionCount: 0,
    operationCount: 3,
    ...overrides,
  });

  describe('ledger sequence validation', () => {
    it('accepts positive integers as numbers and strings', () => {
      expect(ex66.normalizeLedgerSequence(1234567)).toBe(1234567);
      expect(ex66.normalizeLedgerSequence('1234567')).toBe(1234567);
      expect(ex66.normalizeLedgerSequence('  1234567  ')).toBe(1234567);
      // The genesis ledger is the lowest valid sequence.
      expect(ex66.normalizeLedgerSequence(1)).toBe(1);
    });

    it('rejects blank input with guidance instead of querying Horizon', () => {
      expect(() => ex66.normalizeLedgerSequence('')).toThrow(/Missing ledger sequence/);
      expect(() => ex66.normalizeLedgerSequence('   ')).toThrow(/Missing ledger sequence/);
    });

    it('rejects non-numeric and fractional sequences', () => {
      expect(() => ex66.normalizeLedgerSequence('not-a-ledger')).toThrow(/Invalid ledger sequence/);
      // Number('12abc') is NaN, but a lenient parse would truncate to 12 and
      // silently query the wrong ledger.
      expect(() => ex66.normalizeLedgerSequence('12abc')).toThrow(/Invalid ledger sequence/);
      expect(() => ex66.normalizeLedgerSequence('1.5')).toThrow(/Invalid ledger sequence/);
      expect(() => ex66.normalizeLedgerSequence(1.5)).toThrow(/Invalid ledger sequence/);
      expect(() => ex66.normalizeLedgerSequence(Number.NaN)).toThrow(/Invalid ledger sequence/);
    });

    it('rejects zero, negative, and out-of-range sequences', () => {
      expect(() => ex66.normalizeLedgerSequence(0)).toThrow(/start at 1/);
      expect(() => ex66.normalizeLedgerSequence(-5)).toThrow(/start at 1/);
      expect(() => ex66.normalizeLedgerSequence('-5')).toThrow(/Invalid ledger sequence/);
      // Horizon reads the sequence as a signed 32-bit integer: above this it
      // wraps negative and answers 410 Gone, as if the ledger were pruned.
      expect(ex66.normalizeLedgerSequence(2147483647)).toBe(2147483647);
      expect(() => ex66.normalizeLedgerSequence(2147483648)).toThrow(/32-bit/);
      expect(() => ex66.normalizeLedgerSequence('4294967296')).toThrow(/32-bit/);
    });

    it('identifies a Horizon 404 for a ledger that does not exist', () => {
      const notFound = new Error('Not found');
      notFound.name = 'NotFoundError';

      expect(ex66.isHorizonNotFoundError(notFound)).toBe(true);
      expect(ex66.isHorizonNotFoundError({ response: { status: 404 } })).toBe(true);
      expect(ex66.isHorizonNotFoundError({ status: 404 })).toBe(true);
      expect(ex66.isHorizonNotFoundError({ response: { status: 500 } })).toBe(false);
      expect(ex66.isHorizonNotFoundError(new Error('socket hang up'))).toBe(false);
      expect(ex66.isHorizonNotFoundError(null)).toBe(false);
    });

    it('separates a pruned ledger (410) from one that has not closed yet (404)', () => {
      // Horizon answers a ledger below its retained history with 410 Gone, and
      // one above the latest with 404. The two need different advice.
      expect(ex66.isHorizonGoneError({ response: { status: 410 } })).toBe(true);
      expect(ex66.isHorizonGoneError({ status: 410 })).toBe(true);
      expect(ex66.isHorizonGoneError({ response: { status: 404 } })).toBe(false);
      expect(ex66.isHorizonNotFoundError({ response: { status: 410 } })).toBe(false);
      expect(ex66.isHorizonGoneError(new Error('socket hang up'))).toBe(false);
    });

    it('reads the ledger sequence from params, env, or argv in that order', () => {
      const originalEnv = process.env.LEDGER_SEQUENCE;
      const originalArgv = process.argv;

      try {
        process.env.LEDGER_SEQUENCE = '222';
        process.argv = ['node', 'runner', '66-ledger-effects', '333'];

        expect(ex66.resolveLedgerInput({ ledgerSequence: '111' })).toBe('111');
        // A blank runner prompt must fall through rather than count as input.
        expect(ex66.resolveLedgerInput({ ledgerSequence: '  ' })).toBe('222');

        delete process.env.LEDGER_SEQUENCE;
        expect(ex66.resolveLedgerInput({})).toBe('333');

        process.argv = ['node', 'runner', '66-ledger-effects'];
        expect(ex66.resolveLedgerInput({})).toBeUndefined();
      } finally {
        process.argv = originalArgv;
        if (originalEnv === undefined) {
          delete process.env.LEDGER_SEQUENCE;
        } else {
          process.env.LEDGER_SEQUENCE = originalEnv;
        }
      }
    });
  });

  describe('effect ID decoding', () => {
    it('decodes ledger, transaction, and operation position from a real effect ID', () => {
      // Horizon zero-pads effect IDs to `%019d-%010d`. This TOID is ledger 3,
      // transaction 1, operation 1.
      expect(ex66.parseEffectId('0000000012884905985-0000000001')).toEqual({
        operationId: '0000000012884905985',
        ledgerSequence: 3,
        transactionOrder: 1,
        operationIndex: 1,
        effectIndex: 1,
      });
    });

    it('decodes positions that exceed 53-bit float precision', () => {
      // The TOID for any real ledger is far beyond Number.MAX_SAFE_INTEGER, so
      // a Number-based parse would drop exactly the transaction and operation
      // bits being read here.
      const id = effectId(LEDGER, 17, 3, 2);
      expect(Number(id.split('-')[0])).toBeGreaterThan(Number.MAX_SAFE_INTEGER);

      expect(ex66.parseEffectId(id)).toMatchObject({
        ledgerSequence: LEDGER,
        transactionOrder: 17,
        operationIndex: 3,
        effectIndex: 2,
      });
    });

    it('returns null for malformed or missing IDs instead of throwing', () => {
      expect(ex66.parseEffectId(undefined)).toBeNull();
      expect(ex66.parseEffectId('')).toBeNull();
      expect(ex66.parseEffectId('no-toid-here')).toBeNull();
      expect(ex66.parseEffectId('12884905985')).toBeNull();
      expect(ex66.parseEffectId('12884905985-')).toBeNull();
      expect(ex66.parseEffectId('-1')).toBeNull();
    });
  });

  describe('effect categorization', () => {
    it('maps effect types to broad categories', () => {
      expect(ex66.categorizeEffectType('account_credited')).toBe(ex66.EFFECT_CATEGORIES.ACCOUNT);
      expect(ex66.categorizeEffectType('sequence_bumped')).toBe(ex66.EFFECT_CATEGORIES.ACCOUNT);
      expect(ex66.categorizeEffectType('signer_created')).toBe(ex66.EFFECT_CATEGORIES.SIGNER);
      expect(ex66.categorizeEffectType('trustline_created')).toBe(ex66.EFFECT_CATEGORIES.TRUSTLINE);
      expect(ex66.categorizeEffectType('offer_created')).toBe(ex66.EFFECT_CATEGORIES.DEX);
      expect(ex66.categorizeEffectType('trade')).toBe(ex66.EFFECT_CATEGORIES.DEX);
      expect(ex66.categorizeEffectType('data_updated')).toBe(ex66.EFFECT_CATEGORIES.DATA);
      expect(ex66.categorizeEffectType('claimable_balance_claimed')).toBe(
        ex66.EFFECT_CATEGORIES.CLAIMABLE_BALANCE,
      );
      expect(ex66.categorizeEffectType('liquidity_pool_trade')).toBe(
        ex66.EFFECT_CATEGORIES.LIQUIDITY_POOL,
      );
      expect(ex66.categorizeEffectType('contract_credited')).toBe(ex66.EFFECT_CATEGORIES.CONTRACT);
      expect(ex66.categorizeEffectType('something_new')).toBe(ex66.EFFECT_CATEGORIES.OTHER);
    });

    it('categorizes sponsorship effects by sponsorship, not by the entry type', () => {
      // These share a prefix with the account and trustline categories but
      // describe who pays the reserve, not a change to the entry itself.
      expect(ex66.categorizeEffectType('account_sponsorship_created')).toBe(
        ex66.EFFECT_CATEGORIES.SPONSORSHIP,
      );
      expect(ex66.categorizeEffectType('trustline_sponsorship_removed')).toBe(
        ex66.EFFECT_CATEGORIES.SPONSORSHIP,
      );
      expect(ex66.categorizeEffectType('signer_sponsorship_updated')).toBe(
        ex66.EFFECT_CATEGORIES.SPONSORSHIP,
      );
    });
  });

  describe('affected party and asset resolution', () => {
    it('falls back through the fields that identify the affected party', () => {
      expect(ex66.describeEffectSubject(buildEffect())).toBe(accountA);
      expect(
        ex66.describeEffectSubject({ id: 'x', type: 'trustline_authorized', trustor: accountB }),
      ).toBe(accountB);
      expect(ex66.describeEffectSubject({ id: 'x', type: 'trade', seller: accountB })).toBe(
        accountB,
      );
      expect(
        ex66.describeEffectSubject({ id: 'x', type: 'contract_credited', contract: 'CABC' }),
      ).toBe('CABC');
      expect(
        ex66.describeEffectSubject({
          id: 'x',
          type: 'liquidity_pool_deposited',
          liquidity_pool: { id: 'pool123' },
        }),
      ).toBe('pool:pool123');
      expect(ex66.describeEffectSubject({ id: 'x', type: 'unknown' })).toBe('(none)');
    });

    it('renders native and credit assets', () => {
      expect(ex66.describeEffectAsset({ id: 'x', type: 't', asset_type: 'native' })).toBe('XLM');
      expect(
        ex66.describeEffectAsset({
          id: 'x',
          type: 't',
          asset_type: 'credit_alphanum4',
          asset_code: 'USD',
          asset_issuer: accountB,
        }),
      ).toBe(`USD:${accountB}`);
      expect(ex66.describeEffectAsset({ id: 'x', type: 't' })).toBeNull();
    });

    it('shows type, affected account, and ledger sequence on each line', () => {
      const line = ex66.formatEffectLine(buildEffect({ id: effectId(LEDGER, 4, 2, 1) }));

      expect(line).toContain('type=account_credited');
      expect(line).toContain(`account=${accountA}`);
      expect(line).toContain(`ledger=${LEDGER}`);
      expect(line).toContain('tx=#4');
      expect(line).toContain('op=#2');
      expect(line).toContain('asset=XLM');
      expect(line).toContain('amount=100.0000000');
    });

    it('reports an unknown ledger rather than a wrong one for a malformed ID', () => {
      expect(ex66.formatEffectLine(buildEffect({ id: 'malformed' }))).toContain('ledger=unknown');
    });

    it('prefers starting_balance when an effect carries no amount', () => {
      const line = ex66.formatEffectLine(
        buildEffect({ type: 'account_created', amount: undefined, starting_balance: '10.0000000' }),
      );

      expect(line).toContain('amount=10.0000000');
    });
  });

  describe('grouping by effect type', () => {
    it('groups effects by type and preserves application order within a group', () => {
      const effects = [
        buildEffect({ id: effectId(LEDGER, 1, 1, 1), type: 'account_debited' }),
        buildEffect({ id: effectId(LEDGER, 1, 1, 2), type: 'account_credited' }),
        buildEffect({ id: effectId(LEDGER, 2, 1, 1), type: 'account_debited' }),
      ];

      const groups = ex66.groupEffectsByType(effects);

      expect(Object.keys(groups).sort()).toEqual(['account_credited', 'account_debited']);
      expect(groups.account_debited).toHaveLength(2);
      expect(groups.account_debited.map((effect) => effect.id)).toEqual([
        effectId(LEDGER, 1, 1, 1),
        effectId(LEDGER, 2, 1, 1),
      ]);
      expect(groups.account_credited).toHaveLength(1);
    });

    it('buckets an effect with no type under "unknown" rather than dropping it', () => {
      const groups = ex66.groupEffectsByType([{ id: 'x', type: '' }]);
      expect(groups.unknown).toHaveLength(1);
    });

    it('returns no groups for an empty ledger', () => {
      expect(ex66.groupEffectsByType([])).toEqual({});
    });
  });

  describe('summary statistics', () => {
    const mixedEffects = (): ex66.LedgerEffectLike[] => [
      // Transaction 1, operation 1: a payment produces a debit and a credit.
      buildEffect({ id: effectId(LEDGER, 1, 1, 1), type: 'account_debited', account: accountA }),
      buildEffect({ id: effectId(LEDGER, 1, 1, 2), type: 'account_credited', account: accountB }),
      // Transaction 2, operation 1: an offer rests on the book.
      buildEffect({ id: effectId(LEDGER, 2, 1, 1), type: 'offer_created', account: accountA }),
      // Transaction 2, operation 2: a trustline is created.
      buildEffect({ id: effectId(LEDGER, 2, 2, 1), type: 'trustline_created', account: accountB }),
    ];

    it('counts effects by type, by category, and by participant', () => {
      const summary = ex66.summarizeLedgerEffects(mixedEffects());

      expect(summary.effectCount).toBe(4);
      expect(summary.countsByType).toEqual({
        account_debited: 1,
        account_credited: 1,
        offer_created: 1,
        trustline_created: 1,
      });
      expect(summary.countsByCategory).toEqual({
        [ex66.EFFECT_CATEGORIES.ACCOUNT]: 2,
        [ex66.EFFECT_CATEGORIES.DEX]: 1,
        [ex66.EFFECT_CATEGORIES.TRUSTLINE]: 1,
      });
      expect(summary.distinctTypeCount).toBe(4);
      expect(summary.accountCount).toBe(2);
    });

    it('derives operation and transaction counts from the effect IDs', () => {
      const summary = ex66.summarizeLedgerEffects(mixedEffects());

      // Three operations across two transactions produced the four effects.
      expect(summary.operationCount).toBe(3);
      expect(summary.transactionCount).toBe(2);
      expect(summary.ledgerSequences).toEqual([LEDGER]);
    });

    it('does not merge transactions that share an order across different ledgers', () => {
      const summary = ex66.summarizeLedgerEffects([
        buildEffect({ id: effectId(LEDGER, 1, 1, 1) }),
        buildEffect({ id: effectId(LEDGER + 1, 1, 1, 1) }),
      ]);

      expect(summary.transactionCount).toBe(2);
      expect(summary.ledgerSequences).toEqual([LEDGER, LEDGER + 1]);
    });

    it('returns a zeroed summary for an empty ledger', () => {
      const summary = ex66.summarizeLedgerEffects([]);

      expect(summary).toEqual({
        effectCount: 0,
        countsByType: {},
        countsByCategory: {},
        distinctTypeCount: 0,
        accountCount: 0,
        operationCount: 0,
        transactionCount: 0,
        ledgerSequences: [],
      });
    });

    it('ignores unidentifiable participants and IDs when counting', () => {
      const summary = ex66.summarizeLedgerEffects([
        { id: 'malformed', type: 'account_credited' },
        buildEffect(),
      ]);

      expect(summary.effectCount).toBe(2);
      expect(summary.accountCount).toBe(1);
      expect(summary.operationCount).toBe(1);
    });

    it('reduces a Horizon ledger record to the reported header fields', () => {
      expect(
        ex66.summarizeLedgerHeader({
          sequence: LEDGER,
          closed_at: '2026-07-28T10:00:00Z',
          successful_transaction_count: 5,
          failed_transaction_count: 2,
          operation_count: 9,
        }),
      ).toEqual({
        sequence: LEDGER,
        closedAt: '2026-07-28T10:00:00Z',
        successfulTransactionCount: 5,
        failedTransactionCount: 2,
        operationCount: 9,
      });
    });
  });

  describe('report formatting', () => {
    it('presents the ledger header, per-effect lines, groupings, and statistics', () => {
      const effects = [
        buildEffect({ id: effectId(LEDGER, 1, 1, 1), type: 'account_debited', account: accountA }),
        buildEffect({ id: effectId(LEDGER, 1, 1, 2), type: 'account_credited', account: accountB }),
        buildEffect({ id: effectId(LEDGER, 2, 1, 1), type: 'offer_created', account: accountA }),
      ];
      const report = ex66.formatLedgerEffectsReport(
        LEDGER,
        effects,
        ex66.summarizeLedgerEffects(effects),
        { limit: 25, header: buildHeader({ operationCount: 2 }) },
      );

      expect(report).toContain(`Ledger Sequence: ${LEDGER}`);
      expect(report).toContain('Closed At:       2026-07-28T10:00:00Z');
      expect(report).toContain('Transactions:    2 (2 successful, 0 failed)');
      expect(report).toContain('Effects Retrieved: 3');
      expect(report).toContain('Effects Grouped By Type:');
      expect(report).toContain('account_debited');
      expect(report).toContain('an account balance decreased');
      expect(report).toContain('Effects Grouped By Category:');
      expect(report).toContain(ex66.EFFECT_CATEGORIES.DEX);
      expect(report).toContain('Summary Statistics:');
      expect(report).toMatch(/Distinct types:\s+3/);
      expect(report).toMatch(/Accounts touched:\s+2/);
      expect(report).toMatch(/Operations involved:\s+2/);
      expect(report).toMatch(/Transactions involved:\s+2/);
      expect(report).toMatch(/Effects per operation:\s+1\.50/);
    });

    it('shows category shares as percentages of the retrieved effects', () => {
      const effects = [
        buildEffect({ id: effectId(LEDGER, 1, 1, 1), type: 'account_debited' }),
        buildEffect({ id: effectId(LEDGER, 1, 1, 2), type: 'account_credited' }),
        buildEffect({ id: effectId(LEDGER, 2, 1, 1), type: 'trade' }),
        buildEffect({ id: effectId(LEDGER, 2, 1, 2), type: 'trade' }),
      ];

      const report = ex66.formatLedgerEffectsReport(
        LEDGER,
        effects,
        ex66.summarizeLedgerEffects(effects),
        { limit: 25 },
      );

      expect(report).toContain('(50.0%)');
    });

    it('explains an empty ledger instead of reporting an error', () => {
      const report = ex66.formatLedgerEffectsReport(LEDGER, [], ex66.summarizeLedgerEffects([]), {
        limit: 25,
        header: buildHeader({
          successfulTransactionCount: 0,
          failedTransactionCount: 0,
          operationCount: 0,
        }),
      });

      expect(report).toContain('This ledger produced no effects.');
      expect(report).toContain('normal result, not an error');
      expect(report).toContain('every transaction in it');
      expect(report).not.toContain('Effect Records');
      expect(report).not.toContain('Summary Statistics');
    });

    it('flags a truncated report and names the limit that cut it short', () => {
      const effects = [buildEffect()];
      const report = ex66.formatLedgerEffectsReport(
        LEDGER,
        effects,
        ex66.summarizeLedgerEffects(effects),
        { limit: 1, truncated: true, header: buildHeader() },
      );

      expect(report).toContain('more than 1 effects');
      expect(report).toContain('Raise the limit');
      // The header reports more operations than were seen, but that gap is
      // explained by truncation here, not by effect-free operations.
      expect(report).not.toContain('produced no effects.');
    });

    it('explains operations that produced no effects on a complete report', () => {
      const effects = [buildEffect({ id: effectId(LEDGER, 1, 1, 1) })];
      const report = ex66.formatLedgerEffectsReport(
        LEDGER,
        effects,
        ex66.summarizeLedgerEffects(effects),
        { limit: 25, header: buildHeader({ operationCount: 3 }) },
      );

      expect(report).toContain("2 of the ledger's 3 operations produced no effects");
    });

    it('warns when effects decode to more than one ledger', () => {
      const effects = [
        buildEffect({ id: effectId(LEDGER, 1, 1, 1) }),
        buildEffect({ id: effectId(LEDGER + 1, 1, 1, 1) }),
      ];

      expect(
        ex66.formatLedgerEffectsReport(LEDGER, effects, ex66.summarizeLedgerEffects(effects), {
          limit: 25,
        }),
      ).toContain('WARNING: effects decoded to multiple ledgers');
    });

    it('renders without a ledger header', () => {
      const effects = [buildEffect()];
      const report = ex66.formatLedgerEffectsReport(
        LEDGER,
        effects,
        ex66.summarizeLedgerEffects(effects),
        { limit: 25, header: null },
      );

      expect(report).toContain(`Ledger Sequence: ${LEDGER}`);
      expect(report).not.toContain('Closed At:');
    });
  });

  describe('retrieval and result limits', () => {
    /**
     * Stands in for a Horizon server, serving effects from fixed pages and
     * recording the ledger and page size that were requested.
     */
    const buildServer = (pages: ex66.LedgerEffectLike[][]) => {
      const calls: Array<{ sequence: number | string; limit: number }> = [];

      const pageAt = (index: number): ex66.EffectsPageLike => ({
        records: pages[index] ?? [],
        next: index + 1 < pages.length ? async () => pageAt(index + 1) : undefined,
      });

      const server: ex66.LedgerEffectsServerLike = {
        effects: () => ({
          forLedger: (sequence) => ({
            limit: (count) => ({
              call: async () => {
                calls.push({ sequence, limit: count });
                return pageAt(0);
              },
            }),
          }),
        }),
      };

      return { server, calls };
    };

    const manyEffects = (count: number, startTx = 1): ex66.LedgerEffectLike[] =>
      Array.from({ length: count }, (_, index) =>
        buildEffect({ id: effectId(LEDGER, startTx + index, 1, 1) }),
      );

    it('requests the ledger and returns its effects', async () => {
      const { server, calls } = buildServer([manyEffects(3)]);

      const result = await ex66.retrieveLedgerEffects(server, LEDGER, 25);

      expect(calls).toEqual([{ sequence: LEDGER, limit: 26 }]);
      expect(result.effects).toHaveLength(3);
      expect(result.truncated).toBe(false);
    });

    it('returns an empty, non-truncated result for a ledger with no effects', async () => {
      const { server } = buildServer([[]]);

      expect(await ex66.retrieveLedgerEffects(server, LEDGER, 25)).toEqual({
        effects: [],
        truncated: false,
      });
    });

    it('trims to the limit and reports truncation when the ledger has more', async () => {
      const { server } = buildServer([manyEffects(10)]);

      const result = await ex66.retrieveLedgerEffects(server, LEDGER, 5);

      expect(result.effects).toHaveLength(5);
      expect(result.truncated).toBe(true);
    });

    it('does not report truncation when the ledger holds exactly the limit', async () => {
      const { server } = buildServer([manyEffects(5)]);

      const result = await ex66.retrieveLedgerEffects(server, LEDGER, 5);

      expect(result.effects).toHaveLength(5);
      expect(result.truncated).toBe(false);
    });

    it('follows pages when the limit exceeds the Horizon page maximum', async () => {
      const { server, calls } = buildServer([manyEffects(200), manyEffects(120, 201)]);

      const result = await ex66.retrieveLedgerEffects(server, LEDGER, 300);

      // Horizon caps a page at 200, so the requested limit+1 is clamped.
      expect(calls[0].limit).toBe(200);
      expect(result.effects).toHaveLength(300);
      expect(result.truncated).toBe(true);
    });

    it('stops on a short page rather than following the cursor past the end', async () => {
      const { server } = buildServer([manyEffects(200), manyEffects(30, 201), manyEffects(999)]);

      const result = await ex66.retrieveLedgerEffects(server, LEDGER, 500);

      expect(result.effects).toHaveLength(230);
      expect(result.truncated).toBe(false);
    });

    it('clamps the requested limit into the printable range', () => {
      expect(ex66.normalizeLimit(undefined)).toBe(25);
      expect(ex66.normalizeLimit('')).toBe(25);
      expect(ex66.normalizeLimit('not-a-number')).toBe(25);
      expect(ex66.normalizeLimit('100')).toBe(100);
      expect(ex66.normalizeLimit(100)).toBe(100);
      expect(ex66.normalizeLimit(0)).toBe(1);
      expect(ex66.normalizeLimit(-10)).toBe(1);
      expect(ex66.normalizeLimit(5000)).toBe(500);
    });
  });

  describe('runner and documentation registration', () => {
    it('registers the example with ledger sequence and limit parameters', () => {
      const entry = examples['66-ledger-effects'];

      expect(entry).toBeDefined();
      expect(entry.name).toBe('66-ledger-effects');
      expect(typeof entry.run).toBe('function');
      expect(entry.params?.map((param) => param.name)).toEqual(['ledgerSequence', 'limit']);
    });

    it('documents the example and the effect scopes in the README', () => {
      const readme = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

      expect(readme).toContain('`66-ledger-effects`');
      expect(readme).toContain('npm run run-example 66-ledger-effects');
      expect(readme).toContain(
        'Ledger effects differ from transaction effects and account effects',
      );
    });

    it('explains the ledger hierarchy and effect scopes in the source', () => {
      const source = readFileSync(
        path.join(__dirname, '..', 'src', 'examples', '66-ledger-effects.ts'),
        'utf8',
      );

      expect(source).toContain('Ledgers, transactions, operations, effects');
      expect(source).toContain('Ledger effects vs. transaction effects vs. account effects');
    });

    it('excludes the example from automated validation as it needs live data', () => {
      const config = JSON.parse(
        readFileSync(
          path.join(__dirname, '..', 'src', 'validation', 'validation.config.json'),
          'utf8',
        ),
      ) as { exclusions: Array<{ match: string; reason: string }> };

      expect(config.exclusions.some((entry) => entry.match === '66-ledger-effects')).toBe(true);
    });
  });
});
