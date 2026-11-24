import {
  buildSponsorshipGraph,
  buildSponsorshipReport,
  formatTextReport,
  readSponsorshipFields,
  toJson,
  validateAccountId,
} from '../src/examples/358-sponsorship-dependency-analyzer';

const INSPECTED = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const SPONSOR = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const OTHER = 'GBH3KZIVHI3TKR2XRIJES5LUQMQFC22Y3MUFYPAFHUJVOS55O2MQFUYQ';

function fields(overrides: Record<string, unknown> = {}) {
  return readSponsorshipFields({
    account_id: INSPECTED,
    num_sponsoring: 0,
    num_sponsored: 0,
    ...overrides,
  } as never);
}

describe('Issue #358: sponsorship dependency analyzer', () => {
  it('validates account public keys', () => {
    expect(validateAccountId(INSPECTED)).toBe(INSPECTED);
    expect(() => validateAccountId('not-a-key')).toThrow(/valid Stellar/);
  });

  it('handles an account with no sponsorship relationships', () => {
    const accountFields = fields();
    const graph = buildSponsorshipGraph(INSPECTED, accountFields, [], { effectsComplete: true });
    const report = buildSponsorshipReport(graph, accountFields);
    expect(report.edges).toHaveLength(0);
    expect(report.complete).toBe(true);
    expect(report.summary.definitiveReserveXlm).toBeNull();
    expect(formatTextReport(report)).toContain('No sponsorship relationships');
  });

  it('distinguishes incoming and outgoing relationships and entry types', () => {
    const accountFields = fields({ sponsor: SPONSOR, num_sponsored: 2, num_sponsoring: 1 });
    const graph = buildSponsorshipGraph(
      INSPECTED,
      accountFields,
      [
        { type: 'trustline_sponsorship_created', account: OTHER, sponsor: INSPECTED },
        { type: 'data_entry_sponsorship_created', account: OTHER, sponsor: INSPECTED },
      ],
      { effectsComplete: true },
    );
    expect(graph.edges.map((edge) => edge.direction).sort()).toEqual(['incoming', 'outgoing', 'outgoing']);
    expect(graph.edges.find((edge) => edge.entryType === 'trustline')?.source).toBe('horizon-effect');
    expect(graph.edges.find((edge) => edge.entryType === 'account')?.from).toBe(SPONSOR);
    expect(graph.nodes).toContain(OTHER);
  });

  it('deduplicates repeated relationships across pages', () => {
    const effect = { type: 'offer_sponsorship_created', account: OTHER, sponsor: INSPECTED };
    const accountFields = fields({ num_sponsoring: 1 });
    const graph = buildSponsorshipGraph(INSPECTED, accountFields, [effect, effect, { ...effect }], {
      effectsComplete: true,
    });
    expect(graph.edges).toHaveLength(1);
    expect(buildSponsorshipReport(graph, accountFields).summary.entriesByType).toEqual({ offer: 1 });
  });

  it('marks incomplete retrieval and missing fields explicitly', () => {
    const incomplete = fields({ num_sponsoring: undefined });
    const graph = buildSponsorshipGraph(INSPECTED, incomplete, [], { effectsComplete: false });
    expect(graph.complete).toBe(false);
    expect(graph.warnings.join(' ')).toMatch(/not exhaustive/);
    expect(graph.warnings.join(' ')).toMatch(/num_sponsoring/);
    expect(buildSponsorshipReport(graph, incomplete).summary.reserveUnitsSponsoring).toBeNull();
  });

  it('emits valid JSON that still flags incomplete results', () => {
    const accountFields = fields();
    const graph = buildSponsorshipGraph(INSPECTED, accountFields, [], { effectsComplete: false });
    const parsed = JSON.parse(toJson(buildSponsorshipReport(graph, accountFields)));
    expect(parsed.complete).toBe(false);
    expect(parsed.summary.definitiveReserveXlm).toBeNull();
    expect(Array.isArray(parsed.warnings)).toBe(true);
  });
});
